// The city renderer: the style engine of the reference (style.js) driven by a movable camera over baked
// data. What it adds is the scene, in two tiers: the overview tier draws the land, the main roads and
// railways as strips and one box per built-over cell; the district tier draws every tile's terrain,
// ground, buildings and trees, with the shadows they cast. The per-pixel passes after the scene
// (occlusion, edges) are the reference's own code and its own shaders.
import { Program, depth24, framebuffer } from '../gl/context.js';
import { CITY_SHADERS } from '../gl/city-shaders.js';
import { TREE_SHADERS } from '../gl/shaders-trees.js';
import { SHADOW_SHADERS } from '../gl/shaders-shadow.js';
import { CityCamera } from '../gl/city-camera.js';
import { BOX_SCALE, DISTRICT_SCALE, SHADOW_SCALE, TALLEST, TREE_SCALE } from '../world/store.js';
import { StyleRenderer } from './style.js';

const WHITE = [1, 1, 1, 1], CLEAR = [0, 0, 0, 0], FAR = [1];
const EDGE_PX = 2.8;                     // shadeEdges() calls an edge where the depth jumps by 2.8 pixels' worth
const HASH_UNIT = 0, RAMP_UNIT = 1, FIRST_FREE_UNIT = 2, SHADOW_UNIT = 7;
const SHADOW_SIZE = 1024;                // the sun's picture, in texels
// Where the sun is, in the camera's frame: the foot of a shadow moves SHADOW[0] metres across the screen
// and SHADOW[1] metres towards the viewer for every metre of height. These are the reference's 1.3 and
// -0.12 seen through its camera, so a shadow points the same way as in the reference at every zoom.
export const SHADOW = [1.004, 0.834];
const SHADOW_SLACK_M = 0.05;             // how much nearer the sun something must stand than a point to shade it
const ISLAND_CORNER_M = 7000, ISLAND_BAND_M = 1500;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class CityRenderer extends StyleRenderer {
  constructor(gl, width, height, ss = 2) {
    super(gl, width, height, ss);
    for (const [name, s] of Object.entries({ ...CITY_SHADERS, ...TREE_SHADERS, ...SHADOW_SHADERS })) {
      this.programs[name] = new Program(gl, s.vs, s.fs, name);
    }
    this.city = new CityCamera();
    this.city.width = width;
    this.city.height = height;
    this.city.ss = ss;
    this.time = 0;                       // seconds; the wind and the water move with it
    this.detailScale = 2.5;              // from this zoom up a tree shows its trunk
    this.emptyMask = this.blackTexture();
    this.shadowMap = depth24(gl, SHADOW_SIZE, SHADOW_SIZE);
    this.shadowFbo = framebuffer(gl, [], this.shadowMap);
    this.shadowOn = 0;
    this.shadowBias = 0;
    this.light = { dir: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], box: [0, 0, 1, 1], depth: [0, 1] };
    this.drawn = { tiles: 0, triangles: 0, trees: 0 };
  }

  // an empty shadow mask: a single black texel; it also stands in for textures a shader does not read
  blackTexture() {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  // What the baked data refers to by name or by number: the palette index behind every ground class,
  // tree species and tone of the overview. `place` is a colour name -> palette index.
  setLook(index, place) {
    this.groundPal = new Array(24).fill(0);
    for (const [id, info] of Object.entries(index.groundClasses)) this.groundPal[Number(id)] = place(info.colour);
    this.species = Object.keys(index.treeSpecies).sort((a, b) => a - b).map(id => place(index.treeSpecies[id].name));
    this.bark = place('bark');
    this.treeCell = index.treeCell;
    this.tones = [place('urban_ground'), place('roof_flat_grey'), place('glass_grey')];
    // the island is the region itself, turned as it stands on the ground; its edge wanders up to 600 m
    // out (the tiles reach almost a kilometre beyond the region) and bites up to two kilometres in
    const r = index.island;
    this.island = [r.cx, r.cy, r.halfWidth, r.halfHeight];
    this.island2 = [r.cos, r.sin, ISLAND_CORNER_M, ISLAND_BAND_M];
  }

  // Every uniform contract is filled: the one of the shared per-pixel passes, which project from the
  // world origin; the one of the city shaders, which work relative to the camera centre; and the sun's.
  // While the sun's picture is being drawn it must not be bound as a texture (see castShadows).
  applyCamera(prog, { shadowMap = true } = {}) {
    const { gl, W, H, SS } = this, c = this.city;
    const [near, far] = c.depthRange(TALLEST);
    prog.set('uView', [W, H, SS, c.scale])
      .set('uAngles', [c.cos, c.sin, c.sinPitch, c.cosPitch])
      .set('uOrigin', c.origin())
      .set('uDepth', [near, far])
      .set('uCentre', [c.x, c.y, c.cos, c.sin])
      .set('uTilt', [c.sinPitch, c.cosPitch, c.scale, SS])
      .set('uFrame', [W, H])
      .set('uIsland', this.island)
      .set('uIsland2', this.island2)
      .set('uLightDir', this.light.dir)
      .set('uLightRight', this.light.right)
      .set('uLightUp', this.light.up)
      .set('uShadowBox', this.light.box)
      .set('uShadowDepth', this.light.depth)
      .set('uShadowOn', this.shadowOn)
      .set('uShadowBias', this.shadowBias);
    gl.activeTexture(gl.TEXTURE0 + HASH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.hashTexture);
    prog.set('uHash', HASH_UNIT);
    gl.activeTexture(gl.TEXTURE0 + RAMP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    prog.set('uRamp', RAMP_UNIT);
    if (shadowMap) {
      gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.shadowMap);
      prog.set('uShadowMap', SHADOW_UNIT);
    }
  }

  bind(unit, texture) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    return unit;
  }

  // -> the framebuffer holding the finished picture
  render(world, { edges = true, shadows = true } = {}) {
    const { gl, frame, city } = this;
    const district = city.scale >= DISTRICT_SCALE;
    const tiles = district && world.overview ? this.visibleTiles(world) : [];
    // shadows belong to the district tier: farther out they are smaller than a pixel
    this.shadowOn = district && shadows && world.overview && city.scale >= SHADOW_SCALE ? 1 : 0;
    if (this.shadowOn) this.castShadows(tiles);      // changes the framebuffer and the colour masks; the scene sets its own
    frame.bindScene();
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearBufferfv(gl.COLOR, 0, WHITE);
    gl.clearBufferfv(gl.COLOR, 1, CLEAR);
    gl.clearBufferfv(gl.DEPTH, 0, FAR);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.colorMask(true, true, true, true, false, false, true, true);
    this.drawn = { tiles: tiles.length, triangles: 0, trees: 0 };
    if (world.overview) {
      if (district) this.drawDistrict(tiles, world, city.scale >= TREE_SCALE);
      else this.drawOverview(world);
    }
    this.resolve();
    this.fullscreen('groundTint', frame.workAFbo, { uColor: frame.color, uClass: frame.class, uMask: this.emptyMask, uStaticClass: frame.class }, { uAO: 1 });
    if (!edges) return frame.workAFbo;
    this.fullscreen('edges', frame.workBFbo, { uColor: frame.workA, uClass: frame.class, uDepthTex: frame.depth },
      { uGradientY: city.gradientY, uEdge: EDGE_PX / city.scale });
    return frame.workBFbo;
  }

  // copy a finished frame to the canvas
  present(fbo) {
    const { gl, W, H } = this;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  // ---- the scene ------------------------------------------------------------------------------------------
  visibleTiles(world) {
    const tiles = [];
    for (const { tx, ty } of world.visible(this.city)) {
      const tile = world.tiles.get(`${tx}_${ty}`);
      if (tile) tiles.push(tile);
    }
    return tiles;
  }

  // cover and built: the overview's cell grids ({ x0, y0, cell, texture }), when far is set
  terrain(grid, heights, x0, y0, { base = this.emptyMask, far = 0, cover = null, built = null } = {}) {
    const { gl, city } = this;
    const prog = this.programs.terrain.use();
    this.applyCamera(prog);
    prog.set('uHeights', this.bind(FIRST_FREE_UNIT, heights))
      .set('uGridSize', [grid.nx, grid.ny])
      .set('uCell', grid.cell)
      .set('uOffset', [x0 - city.x, y0 - city.y])
      .set('uBase', this.bind(FIRST_FREE_UNIT + 1, base))
      .set('uCells', grid.nx - 1)
      .set('uFar', far)
      .set('uGroundPal', this.groundPal)
      .set('uCity', this.tones);
    if (far) {
      prog.set('uCover', this.bind(FIRST_FREE_UNIT + 2, cover.texture))
        .set('uBuilt', this.bind(FIRST_FREE_UNIT + 3, built.texture))
        .set('uCoverGrid', [cover.x0, cover.y0, cover.cell, 0]);
    }
    return prog;
  }

  drawOverview(world) {
    const { gl, city } = this;
    const o = world.overview;
    this.terrain(o.grid, o.heights, o.grid.x0, o.grid.y0, { far: 1, cover: o.cover, built: o.built });
    gl.bindVertexArray(o.mesh.vao);
    gl.drawElements(gl.TRIANGLES, o.mesh.count, gl.UNSIGNED_INT, 0);
    this.drawn.triangles += o.mesh.count / 3;
    if (o.ribbons) {
      const ribbons = this.programs.ribbon.use();
      this.applyCamera(ribbons);
      ribbons.set('uOffset', [-city.x, -city.y]).set('uMinPx', 1).set('uGroundPal', this.groundPal);
      gl.bindVertexArray(o.ribbons.vao);
      gl.drawElements(gl.TRIANGLES, o.ribbons.count, gl.UNSIGNED_INT, 0);
      this.drawn.triangles += o.ribbons.count / 3;
    }
    if (city.scale >= BOX_SCALE) {
      const boxes = this.programs.boxes.use();
      this.applyCamera(boxes);
      boxes.set('uOffset', [-city.x, -city.y]).set('uHalf', o.cell * 0.5);
      gl.bindVertexArray(o.boxes.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, o.cells);
      this.drawn.triangles += o.cells * 10;
    }
    gl.bindVertexArray(null);
  }

  drawDistrict(tiles, world, withTrees) {
    const { gl, city } = this;
    for (const tile of tiles) {
      if (!tile.heights) continue;
      this.terrain(tile.grid, tile.heights, tile.x0, tile.y0, { base: tile.base });
      gl.bindVertexArray(world.tileMesh.vao);
      gl.drawElements(gl.TRIANGLES, world.tileMesh.count, gl.UNSIGNED_INT, 0);
      this.drawn.triangles += world.tileMesh.count / 3;
    }
    const ground = this.programs.ground.use();
    this.applyCamera(ground);
    ground.set('uGroundPal', this.groundPal).set('uTime', this.time);
    for (const tile of tiles) {
      ground.set('uOffset', [tile.x0 - city.x, tile.y0 - city.y]);
      for (const mesh of Object.values(tile.ground)) {
        gl.bindVertexArray(mesh.vao);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
        this.drawn.triangles += mesh.count / 3;
      }
    }
    const buildings = this.programs.buildings.use();
    this.applyCamera(buildings);
    for (const tile of tiles) {
      if (!tile.buildings) continue;
      buildings.set('uProps', this.bind(FIRST_FREE_UNIT, tile.props)).set('uOffset', [tile.x0 - city.x, tile.y0 - city.y]);
      gl.bindVertexArray(tile.buildings.vao);
      gl.drawElements(gl.TRIANGLES, tile.buildings.count, gl.UNSIGNED_INT, 0);
      this.drawn.triangles += tile.buildings.count / 3;
    }
    if (withTrees) this.drawTrees(tiles);
    gl.bindVertexArray(null);
  }

  // ---- shadows --------------------------------------------------------------------------------------------
  // The sun's picture: where the camera's light comes from, and the piece of the world the picture
  // must hold for that view (the ground the camera sees, and the height of what stands on it).
  aimLight(tiles) {
    const city = this.city;
    const length = Math.hypot(SHADOW[0], SHADOW[1], 1);
    const u = -SHADOW[0] / length, v = -SHADOW[1] / length;                 // towards the sun, in the screen's two ground axes, per unit of height
    const rx = (u + v) * Math.SQRT1_2, ry = (v - u) * Math.SQRT1_2;        // the same in the camera's frame
    const dir = [rx * city.cos + ry * city.sin, -rx * city.sin + ry * city.cos, 1 / length];
    const flat = Math.hypot(dir[0], dir[1]);
    const right = [-dir[1] / flat, dir[0] / flat, 0];                        // across the sun's picture, level with the ground
    const up = cross(dir, right);

    const halfU = this.W / (2 * city.scale) + 64, halfV = this.H / (2 * city.scale * city.sinPitch) + 64;
    let low = Infinity, high = -Infinity;
    for (const tile of tiles) {
      low = Math.min(low, tile.floor);
      high = Math.max(high, tile.top);
    }
    if (!Number.isFinite(low)) { low = 0; high = TALLEST; }
    const reach = Math.min(TALLEST, high - low + 20) * Math.hypot(SHADOW[0], SHADOW[1]);   // how far the shade of the tallest thing reaches
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    let near = -Infinity, far = Infinity;
    // a point of the screen's ground axes (metres from the camera centre) and a height -> world axes
    const add = (su, sv, z) => {
      const ax = (su + sv) * Math.SQRT1_2, ay = (sv - su) * Math.SQRT1_2;
      const q = [ax * city.cos + ay * city.sin, -ax * city.sin + ay * city.cos, z];
      const x = q[0] * right[0] + q[1] * right[1];
      const y = q[0] * up[0] + q[1] * up[1] + q[2] * up[2];
      const d = q[0] * dir[0] + q[1] * dir[1] + q[2] * dir[2];
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
      near = Math.max(near, d); far = Math.min(far, d);
    };
    // whatever shades the visible ground stands towards the sun from it: up and to the left on the screen
    for (const su of [-halfU - reach, halfU]) for (const sv of [-halfV - reach, halfV]) for (const z of [low, high]) add(su, sv, z);
    this.light = { dir, right, up, box: [box[0], box[1], 1 / (box[2] - box[0]), 1 / (box[3] - box[1])], depth: [far, 1 / (near - far)] };
    this.shadowBias = SHADOW_SLACK_M / (near - far);
  }

  // draw the buildings and trees of the tiles as the sun sees them, depth only
  castShadows(tiles) {
    const { gl, city } = this;
    this.aimLight(tiles);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_SIZE, SHADOW_SIZE);
    gl.colorMask(false, false, false, false);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.GREATER);                  // in the sun's picture the larger depth is the nearer to the sun, as in the scene
    gl.disable(gl.BLEND);
    // empty ground is the farthest thing the sun could see; nothing drawn there shades anything
    gl.clearDepth(0);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.clearDepth(1);

    // a texture that is being drawn to must not be bound for reading: the casters do not read it
    gl.activeTexture(gl.TEXTURE0 + SHADOW_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const buildings = this.programs.shadowBuildings.use();
    this.applyCamera(buildings, { shadowMap: false });
    for (const tile of tiles) {
      if (!tile.buildings) continue;
      buildings.set('uOffset', [tile.x0 - city.x, tile.y0 - city.y]);
      gl.bindVertexArray(tile.buildings.vao);
      gl.drawElements(gl.TRIANGLES, tile.buildings.count, gl.UNSIGNED_INT, 0);
    }
    if (city.scale >= TREE_SCALE) {
      const runs = this.treeRuns(tiles);
      const trees = this.programs.shadowTrees.use();
      this.applyCamera(trees, { shadowMap: false });
      trees.set('uDetail', city.scale >= this.detailScale ? 1 : 0);
      for (const run of runs) {
        trees.set('uOffset', [run.tile.x0 - city.x, run.tile.y0 - city.y]);
        this.treeRecord(run);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.count);
      }
    }
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);
    // the scene pass sets its own framebuffer, depth range and colour masks
  }

  // ---- trees ----------------------------------------------------------------------------------------------
  // the trees of the tiles in view, one run per 250 m cell, leaving out the cells that cannot be seen
  treeRuns(tiles) {
    const { city, W, H } = this;
    const cellM = this.treeCell, half = cellM * Math.SQRT1_2;
    const margin = 14 * city.scale + 2;
    const limitU = W / 2 + half * city.scale + margin;
    const limitV = H / 2 + half * city.scale + margin + 16 * city.scale * city.cosPitch;
    const runs = [];
    for (const tile of tiles) {
      if (!tile.trees) continue;
      const { cells, starts } = tile.trees;
      for (let cy = 0; cy < cells; cy++) for (let cx = 0; cx < cells; cx++) {
        const a = starts[cy * cells + cx], b = starts[cy * cells + cx + 1];
        if (a === b) continue;
        const c = city.axes(tile.x0 + (cx + 0.5) * cellM, tile.y0 + (cy + 0.5) * cellM);
        if (Math.abs(c.u) * city.scale > limitU || Math.abs(c.v) * city.sinPitch * city.scale > limitV) continue;
        runs.push({ tile, a, count: b - a });
      }
    }
    return runs;
  }

  // point the tree attributes at one cell's run of 16-byte records
  treeRecord(run) {
    const { gl } = this;
    gl.bindVertexArray(run.tile.treeMesh.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, run.tile.treeMesh.buffers[1]);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 16, run.a * 16);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, false, 16, run.a * 16 + 12);
  }

  drawTrees(tiles) {
    const { gl, city } = this;
    const runs = this.treeRuns(tiles);
    if (!runs.length) return;
    const trees = this.programs.trees.use();
    this.applyCamera(trees);
    trees.set('uTime', this.time)
      .set('uSpecies', this.species)
      .set('uBark', this.bark)
      .set('uDetail', city.scale >= this.detailScale ? 1 : 0);
    for (const part of city.scale >= this.detailScale ? [0, 1] : [0]) {
      trees.set('uPart', part);
      for (const run of runs) {
        trees.set('uOffset', [run.tile.x0 - city.x, run.tile.y0 - city.y]);
        this.treeRecord(run);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, run.count);
      }
    }
    this.drawn.trees = runs.reduce((sum, run) => sum + run.count, 0);
  }
}
