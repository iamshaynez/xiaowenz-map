// The city renderer: the style engine of the reference (style.js) driven by a movable camera over baked
// data. What it adds is the scene, in two tiers: the overview tier draws the land, the main roads and
// railways as strips and one box per built-over cell; the district tier draws every tile's terrain,
// ground, buildings and trees, with the shadows they cast. The per-pixel passes after the scene
// (occlusion, edges) are the reference's own code and its own shaders.
import { Program, depth24, framebuffer } from '../gl/context.js';
import { CITY_SHADERS } from '../gl/city-shaders.js';
import { TREE_SHADERS } from '../gl/shaders-trees.js';
import { BRAND_SHADERS } from '../gl/shaders-brands.js';
import { SHADOW_SHADERS } from '../gl/shaders-shadow.js';
import { LIFE_SHADERS } from '../gl/shaders-life.js';
import { DEBUG_SHADERS } from '../gl/shaders-debug.js';
import { brandTextures } from '../landmarks/brandmarks.js';
import { Traffic, TRAFFIC_COLOURS } from '../life/traffic.js';
import { assemble, BOX_SCALE, DISTRICT_SCALE, LIFE_SCALE, ROOF_SCALE, SHADOW_SCALE, TALLEST, TREE_SCALE, UNIT_BOX } from '../world/store.js';
import { buildStripes } from '../world/streets.js';
import { CityCamera } from '../gl/city-camera.js';
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
const CAR_SCALE = 1.2, PERSON_SCALE = 5, LAKE_BOAT_SCALE = 0.8;   // from these zooms up: cars, people, the lake's own boats
const STRIPE_SCALE = 0.55;             // from this zoom up the streets wear their markings (a pixel is under 2 m)
const BRAND_SCALE = 0.8;               // from this zoom up a brand's flag is drawn (a pixel is 1.25 m), logo and all
const BRAND_UNIT = 6;                  // the atlas texture's own unit (FIRST_FREE_UNIT and up are handed out per draw)
const RECORD = 12;                        // floats per moving box, as traffic.js writes them
const ISLAND_CORNER_M = 7000, ISLAND_BAND_M = 1500;

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export class CityRenderer extends StyleRenderer {
  constructor(gl, width, height, ss = 2) {
    super(gl, width, height, ss);
    for (const [name, s] of Object.entries({ ...CITY_SHADERS, ...TREE_SHADERS, ...BRAND_SHADERS, ...SHADOW_SHADERS, ...LIFE_SHADERS, ...DEBUG_SHADERS })) {
      this.programs[name] = new Program(gl, s.vs, s.fs, name);
    }
    this.city = new CityCamera();
    this.city.width = width;
    this.city.height = height;
    this.city.ss = ss;
    this.time = 0;                       // seconds; the wind and the water move with it
    this.bare = 0;                       // winter: 1 once the deciduous trees have lost their leaves
    this.snow = 0;                       // 1 where snow lies
    this.snowColour = [1, 1, 1];
    this.detailScale = 2.5;              // from this zoom up a tree shows its trunk
    this.emptyMask = this.blackTexture();
    // what moves: two instance buffers (vehicles, people) filled afresh every frame
    this.traffic = new Traffic();
    this.lifeMesh = this.lifeMeshOf(this.traffic.boxes);
    this.folkMesh = this.lifeMeshOf(this.traffic.folks);
    this.shadowMap = depth24(gl, SHADOW_SIZE, SHADOW_SIZE);
    this.shadowFbo = framebuffer(gl, [], this.shadowMap);
    this.shadowOn = 0;
    this.shadowBias = 0;
    this.light = { dir: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0], box: [0, 0, 1, 1], depth: [0, 1] };
    this.drawn = { tiles: 0, triangles: 0, trees: 0 };
    this.landmarks = [];              // set by the page: the list from landmarks/index.js
  }

  lifeMeshOf(data) {
    const { gl } = this;
    return assemble(gl, [
      { data: UNIT_BOX, layout: [[0, 3], [1, 2]] },
      { data, stride: RECORD * 4, layout: [[2, 4, gl.FLOAT, 0], [3, 4, gl.FLOAT, 16], [4, 4, gl.FLOAT, 32]], divisor: 1 },
    ]);
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
    this.groundPal = new Array(25).fill(0);
    for (const [id, info] of Object.entries(index.groundClasses)) this.groundPal[Number(id)] = place(info.colour);
    this.species = Object.keys(index.treeSpecies).sort((a, b) => a - b).map(id => place(index.treeSpecies[id].name));
    this.bark = place('bark');
    this.barkPale = place('bark_pale');
    this.snowIndex = place('snow');
    this.window = place('window_dark');
    this.wood = place('wood_dark');
    this.red = place('temple_red');
    this.mark = place('road_mark');
    this.trafficColours = TRAFFIC_COLOURS.map(name => place(name));
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
    const walking = this.walkActive();
    const [near, far] = walking ? [c.near, c.far] : c.depthRange(TALLEST);
    this.depthRange = [near, far];
    prog.set('uView', [W, H, SS, c.scale])
      .set('uAngles', [c.cos, c.sin, c.sinPitch, c.cosPitch])
      .set('uOrigin', c.origin())
      .set('uDepth', [near, far])
      .set('uCentre', [c.x, c.y, c.cos, c.sin])
      .set('uTilt', [c.sinPitch, c.cosPitch, walking ? c.textureScale : c.scale, SS])
      .set('uWalk', walking ? [1, c.fov, c.eyeZ, 0] : [0, 0, 0, 0])
      .set('uFrame', [W, H])
      .set('uIsland', this.island)
      .set('uIsland2', this.island2)
      .set('uLightDir', this.light.dir)
      .set('uLightRight', this.light.right)
      .set('uLightUp', this.light.up)
      .set('uShadowBox', this.light.box)
      .set('uShadowDepth', this.light.depth)
      .set('uShadowOn', this.shadowOn)
      .set('uShadowBias', this.shadowBias)
      .set('uBare', this.bare)
      .set('uSnow', this.snow)
      .set('uSnowColour', this.snowColour)
      .set('uSnowIndex', this.snowIndex);
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

  // The season: `colours` is the season's table (every colour the map uses, by name, in the palette's own
  // order); `winter` says whether the leaves are down and snow lies.
  setSeason(colours, winter = {}) {
    this.palette.seat(colours);
    this.updatePalette();
    this.bare = winter.bare ? 1 : 0;
    this.snow = winter.snow ? 1 : 0;
    const white = colours[this.snowIndex];
    this.snowColour = [white[0] / 255, white[1] / 255, white[2] / 255];
  }

  bind(unit, texture) {
    this.gl.activeTexture(this.gl.TEXTURE0 + unit);
    this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
    return unit;
  }

  // -> the framebuffer holding the finished picture
  render(world, { edges = true, shadows = true } = {}) {
    const { gl, frame, city } = this;
    this.frames = (this.frames || 0) + 1;
    const walking = this.walkActive();
    const district = walking || city.scale >= DISTRICT_SCALE;
    const tiles = district && world.overview ? (walking
      ? world.visibleAround(city, 1500).map(d => world.tiles.get(`${d.tx}_${d.ty}`)).filter(Boolean)
      : this.visibleTiles(world)) : [];
    // shadows belong to the district tier: farther out they are smaller than a pixel
    this.drawn = { tiles: tiles.length, triangles: 0, trees: 0, landmarks: 0 };
    this.shadowOn = district && shadows && world.overview && (walking || city.scale >= SHADOW_SCALE) ? 1 : 0;
    const life = district && world.overview && (walking || city.scale >= LIFE_SCALE);
    if (life) this.updateLife(tiles);
    if (this.shadowOn) this.castShadows(tiles, life && (walking || city.scale >= CAR_SCALE));   // changes the framebuffer and the colour masks; the scene sets its own
    frame.bindScene();
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearBufferfv(gl.COLOR, 0, WHITE);
    gl.clearBufferfv(gl.COLOR, 1, CLEAR);
    gl.clearBufferfv(gl.DEPTH, 0, FAR);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.colorMask(true, true, true, true, false, false, true, true);
    if (world.overview) {
      if (district) this.drawDistrict(tiles, world, walking || city.scale >= TREE_SCALE, life);
      else this.drawOverview(world);
    }
    this.resolve();
    this.fullscreen('groundTint', frame.workAFbo, { uColor: frame.color, uClass: frame.class, uMask: this.emptyMask, uStaticClass: frame.class }, { uAO: 1 });
    // the ground's own seams: kerbs, banks, the edges of paths (city-side; the reference scene has none)
    this.fullscreen('seams', frame.workBFbo, { uColor: frame.workA, uClass: frame.class }, { uSnow: this.snow });
    if (!edges) return frame.workBFbo;
    this.fullscreen('edges', frame.workAFbo, { uColor: frame.workB, uClass: frame.class, uDepthTex: frame.depth },
      walking ? { uGradientY: 0, uEdge: 0.35 } : { uGradientY: city.gradientY, uEdge: EDGE_PX / city.scale });
    if (walking) {
      // the haze: what stands beyond the loaded tiles melts into the page's white before its edge could be seen
      this.fullscreen('walkFog', frame.workBFbo, { uColor: frame.workA, uDepthTex: frame.depth },
        { uFog: [this.walkFogStart ?? 620, this.walkFogEnd ?? 1250] });
      return frame.workBFbo;
    }
    return frame.workAFbo;
  }

  // whether the renderer is in the walking view (the page says so through `walk`)
  walkActive() {
    return !!(this.walk && this.walk.active);
  }

  // The engine depth of what the last frame shows at one of its pixels: the nearest thing drawn there,
  // or null where nothing is. A depth texture cannot be read back on its own, so the frame's depth is
  // packed into colours once per frame; a pixel of that is cheap to read, cheap enough for the zoom to ask
  // for the height under the cursor at every turn of the wheel.
  depthAt(sx, sy) {
    const { gl, frame, W, H } = this;
    if (!this.depthRange) return null;
    const x = Math.min(W - 1, Math.max(0, Math.floor(sx))), y = Math.min(H - 1, Math.max(0, Math.floor(sy)));
    if (this.packed !== this.frames) {
      this.fullscreen('packDepth', frame.packedDepthFbo, { uDepthTex: frame.depth });
      this.packed = this.frames;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, frame.packedDepthFbo);
    const bytes = this.depthPixel || (this.depthPixel = new Uint8Array(4));
    gl.readPixels(x, H - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    const z = (bytes[0] + bytes[1] * 256 + bytes[2] * 65536) / 16777215;
    if (z >= 0.99999) return null;                 // nothing drawn there: the depth is still cleared
    const [near, far] = this.depthRange;
    return near - z * (near - far);
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

  drawDistrict(tiles, world, withTrees, withLife) {
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
    if (this.walkActive() || city.scale >= STRIPE_SCALE) this.drawStripes(tiles);
    const buildings = this.programs.buildings.use();
    this.applyCamera(buildings);
    // facades once a pixel is under about 0.8 m: the shader draws them from half of uDetail on
    buildings.set('uDetail', Math.min(1, Math.max(0, city.scale - 0.6)))
      .set('uMid', Math.min(1, Math.max(0, city.scale - 0.3)))
      .set('uWindow', this.window).set('uWood', this.wood).set('uRed', this.red).set('uLift', 0);
    for (const tile of tiles) {
      if (!tile.buildings) continue;
      buildings.set('uProps', this.bind(FIRST_FREE_UNIT, tile.props)).set('uOffset', [tile.x0 - city.x, tile.y0 - city.y]);
      gl.bindVertexArray(tile.buildings.vao);
      gl.drawElements(gl.TRIANGLES, tile.buildings.count, gl.UNSIGNED_INT, 0);
      this.drawn.triangles += tile.buildings.count / 3;
    }
    if (city.scale >= ROOF_SCALE) this.drawRoofs(tiles);
    // (the roofs were drawn with their own shader: this one has to be chosen again)
    this.eachLandmark(buildings, (program, part, z) => {
      program.use().set('uProps', this.bind(FIRST_FREE_UNIT, part.props)).set('uLift', z).set('uOffset', [part.x - city.x, part.y - city.y]);
      gl.bindVertexArray(part.mesh.vao);
      gl.drawElements(gl.TRIANGLES, part.mesh.count, gl.UNSIGNED_INT, 0);
      this.drawn.triangles += part.mesh.count / 3;
    });
    if (withTrees) this.drawTrees(tiles);
    if (city.scale >= BRAND_SCALE) this.drawBrands(tiles);
    if (withLife) this.drawLife();
    gl.bindVertexArray(null);
  }

  // every part of a landmark that can be in view, with the height of the ground it stands on less what
  // of it is bedded in (a tower two metres, a bridge nothing: its deck meets the road)
  eachLandmark(program, draw) {
    const { city, W, H, groundAt } = this;
    this.drawn.landmarks = 0;
    if (!groundAt) return;
    const walking = this.walkActive();
    for (const landmark of this.landmarks) {
      for (const part of landmark.parts) {
        if (walking) {
          if (Math.hypot(part.x - city.x, part.y - city.y) > 1500 + part.reach) continue;
        } else {
          const c = city.axes(part.x, part.y), scale = city.scale;
          if (Math.abs(c.u) * scale > W / 2 + (part.reach + 10) * scale) continue;
          if (Math.abs(c.v) * city.sinPitch * scale > H / 2 + (part.reach + 10) * scale + part.top * city.cosPitch * scale) continue;
        }
        draw(program, part, groundAt(part.x, part.y) - part.bed);
        this.drawn.landmarks++;
      }
    }
  }

  // For tests: how much of a landmark is in the frame just made, and how much of that can be seen. Its
  // parts are drawn again in one flat colour into the scene's own buffers: once against the depth the
  // scene left (what is not hidden behind something else), once over everything (what is in the frame at
  // all). The scene's colour is spoilt by this; the next frame is drawn afresh anyway.
  // -> { all, seen, box, lift, cover }: counts of the frame's pixels; box = [x0, y0, x1, y1] of what
  //    can be seen, from the top-left corner; lift = the height the landmark stands at; cover = per
  //    pixel, 2 seen, 1 hidden, 0 nothing there
  landmarkMask(id) {
    const { gl, frame, city, W, H, SS, groundAt } = this;
    const landmark = this.landmarks.find(item => item.id === id);
    if (!landmark || !landmark.parts.length || !groundAt) return { all: 0, seen: 0, box: null, lift: 0 };
    const prog = this.programs.mask.use();
    this.applyCamera(prog, { shadowMap: false });
    frame.bindScene();
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true, false, false, false, false);
    const bytes = new Uint8Array(W * SS * H * SS * 4);
    let lift = 0;
    const measure = against => {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(against ? gl.LEQUAL : gl.ALWAYS);
      gl.depthMask(false);
      gl.clearBufferfv(gl.COLOR, 0, CLEAR);
      for (const part of landmark.parts) {
        lift = groundAt(part.x, part.y) - part.bed;
        prog.set('uOffset', [part.x - city.x, part.y - city.y]).set('uLift', lift);
        gl.bindVertexArray(part.mesh.vao);
        gl.drawElements(gl.TRIANGLES, part.mesh.count, gl.UNSIGNED_INT, 0);
      }
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, W * SS, H * SS, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
      const hit = new Uint8Array(W * H);
      let count = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const row = (H - 1 - y) * SS, col = x * SS;
        let on = 0;
        for (let sy = 0; sy < SS && !on; sy++) {
          const at = ((row + sy) * W * SS + col) * 4;
          for (let sx = 0; sx < SS; sx++) if (bytes[at + sx * 4]) { on = 1; break; }
        }
        if (!on) continue;
        hit[y * W + x] = 1;
        count++;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      return { count, box: count ? [x0, y0, x1, y1] : null, hit };
    };
    const seen = measure(true), all = measure(false);
    // per pixel of the frame, in rows from the top: 2 what can be seen, 1 what is hidden, 0 nothing there
    const cover = new Uint8Array(W * H);
    for (let k = 0; k < cover.length; k++) cover[k] = all.hit[k] ? (seen.hit[k] ? 2 : 1) : 0;
    gl.depthMask(true);
    gl.depthFunc(gl.LESS);
    gl.colorMask(true, true, true, true, false, false, true, true);
    gl.bindVertexArray(null);
    return { all: all.count, seen: seen.count, box: seen.box, boxAll: all.box, lift, cover };
  }

  // what stands on flat roofs, drawn once it is more than a pixel
  drawRoofs(tiles) {
    const { gl, city } = this;
    const boxes = this.programs.roofBoxes.use();
    this.applyCamera(boxes);
    for (const tile of tiles) {
      if (!tile.roofs) continue;
      boxes.set('uOffset', [tile.x0 - city.x, tile.y0 - city.y]);
      gl.bindVertexArray(tile.roofs.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, tile.roofs.count);
      this.drawn.triangles += tile.roofs.count * 10;
    }
  }

  // the streets' own markings: centre-line dashes and crossing zebras, worked out from the tile's PATH
  // lines and cached on the tile (world/streets.js). Around a hand-built landmark nothing is painted:
  // the same clearing that moved the real buildings aside keeps the paint off the model's ground.
  drawStripes(tiles) {
    const { gl, city } = this;
    const clearances = (this.clearances ??= (() => {
      const list = [];
      for (const landmark of this.landmarks) {
        const radius = landmark.clear || 0;
        if (!radius) continue;
        for (const part of landmark.parts) list.push([part.x, part.y, radius]);
      }
      return list;
    })());
    const stripes = this.programs.stripes.use();
    this.applyCamera(stripes);
    let drawn = 0;
    for (const tile of tiles) {
      if (!tile.paths) continue;
      if (!tile.stripes) tile.stripes = buildStripes(gl, tile, clearances, this.mark);
      if (!tile.stripes.count) continue;
      stripes.set('uOffset', [tile.x0 - city.x, tile.y0 - city.y]);
      gl.bindVertexArray(tile.stripes.mesh.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, tile.stripes.count);
      drawn += tile.stripes.count;
    }
    gl.bindVertexArray(null);
    this.drawn.stripes = drawn;
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

    const halfU = this.walkActive() ? 300 : this.W / (2 * city.scale) + 64, halfV = this.walkActive() ? 300 : this.H / (2 * city.scale * city.sinPitch) + 64;
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
  castShadows(tiles, withLife) {
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
    buildings.set('uLift', 0);
    for (const tile of tiles) {
      if (!tile.buildings) continue;
      buildings.set('uProps', this.bind(FIRST_FREE_UNIT, tile.props)).set('uOffset', [tile.x0 - city.x, tile.y0 - city.y]);
      gl.bindVertexArray(tile.buildings.vao);
      gl.drawElements(gl.TRIANGLES, tile.buildings.count, gl.UNSIGNED_INT, 0);
    }
    this.eachLandmark(buildings, (program, part, z) => {
      program.set('uProps', this.bind(FIRST_FREE_UNIT, part.props)).set('uLift', z).set('uOffset', [part.x - city.x, part.y - city.y]);
      gl.bindVertexArray(part.mesh.vao);
      gl.drawElements(gl.TRIANGLES, part.mesh.count, gl.UNSIGNED_INT, 0);
    });
    if (city.scale >= ROOF_SCALE) {
      const boxes = this.programs.shadowBoxes.use();
      this.applyCamera(boxes, { shadowMap: false });
      for (const tile of tiles) {
        if (!tile.roofs) continue;
        boxes.set('uOffset', [tile.x0 - city.x, tile.y0 - city.y]);
        gl.bindVertexArray(tile.roofs.vao);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, tile.roofs.count);
      }
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
    if (withLife && this.traffic.count) {
      const life = this.programs.shadowLife.use();
      this.applyCamera(life, { shadowMap: false });
      gl.bindVertexArray(this.lifeMesh.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, this.traffic.count);
    }
    gl.bindVertexArray(null);
    gl.colorMask(true, true, true, true);
    // the scene pass sets its own framebuffer, depth range and colour masks
  }

  // ---- what moves -------------------------------------------------------------------------------------------
  // where everything is at this moment, and its boxes uploaded
  updateLife(tiles) {
    const { gl, city, W, H } = this;
    const walking = this.walkActive();
    const which = walking ? { cars: true, boats: true, lake: true, people: true }
      : { cars: city.scale >= CAR_SCALE, boats: true, lake: city.scale >= LAKE_BOAT_SCALE, people: city.scale >= PERSON_SCALE };
    this.drawn.life = this.traffic.place(tiles, this.time, city, { W, H, scale: city.scale }, which, this.trafficColours);
    if (walking) this.walk.place(this.traffic, this.trafficColours);   // the player walks among them
    const { count, people, boxes, folks } = this.traffic;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lifeMesh.buffers[1]);
    gl.bufferData(gl.ARRAY_BUFFER, count ? boxes.subarray(0, count * RECORD) : new Float32Array(0), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.folkMesh.buffers[1]);
    gl.bufferData(gl.ARRAY_BUFFER, people ? folks.subarray(0, people * RECORD) : new Float32Array(0), gl.DYNAMIC_DRAW);
  }

  drawLife() {
    const { gl } = this;
    const boxes = this.programs.lifeBoxes.use();
    this.applyCamera(boxes);
    boxes.set('uWindow', this.window);
    for (const [mesh, count] of [[this.lifeMesh, this.traffic.count], [this.folkMesh, this.traffic.people]]) {
      if (!count) continue;
      gl.bindVertexArray(mesh.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, count);
    }
  }

  // ---- trees ----------------------------------------------------------------------------------------------
  // the trees of the tiles in view, one run per 250 m cell, leaving out the cells that cannot be seen
  treeRuns(tiles) {
    const { city, W, H } = this;
    const cellM = this.treeCell, half = cellM * Math.SQRT1_2;
    const walking = this.walkActive();
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
        const cxw = tile.x0 + (cx + 0.5) * cellM, cyw = tile.y0 + (cy + 0.5) * cellM;
        if (walking) {
          if (Math.hypot(cxw - city.x, cyw - city.y) > 620 + half) continue;
        } else {
          const c = city.axes(cxw, cyw);
          if (Math.abs(c.u) * city.scale > limitU || Math.abs(c.v) * city.sinPitch * city.scale > limitV) continue;
        }
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
      .set('uBarkPale', this.barkPale)
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

  // the chain brands' flags: each shop's board painted with its brand's own picture
  drawBrands(tiles, { throughWalls = false } = {}) {
    const { gl, city } = this;
    const shops = tiles.filter(tile => tile.brandDraws);
    if (!shops.length) return;
    if (!this.brandTextures) this.brandTextures = brandTextures(gl);
    const brands = this.programs.brands.use();
    this.applyCamera(brands);
    brands.set('uMark', BRAND_UNIT);
    let drawn = 0;
    for (const tile of shops) {
      for (const draw of tile.brandDraws) {
        gl.activeTexture(gl.TEXTURE0 + BRAND_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, this.brandTextures.textures[draw.brand]);
        brands.set('uOffset', [tile.x0 - city.x, tile.y0 - city.y]);
        gl.bindVertexArray(draw.mesh.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, draw.count);
        drawn += draw.count;
      }
    }
    if (throughWalls) gl.enable(gl.DEPTH_TEST);
    this.drawn.brands = drawn;
  }
}
