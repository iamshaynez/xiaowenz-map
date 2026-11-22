// The city renderer: the style engine of the reference (style.js) driven by a movable camera over baked
// data. What it adds is the scene: terrain, and either the boxes of the overview tier or the building
// meshes of the district tier. Everything after the scene (resolve, occlusion, edges) is the reference's
// own code and its own shaders.
import { Program } from '../gl/context.js';
import { CITY_SHADERS } from '../gl/city-shaders.js';
import { CityCamera } from '../gl/city-camera.js';
import { DISTRICT_SCALE, TALLEST } from '../world/store.js';
import { StyleRenderer } from './style.js';

const WHITE = [1, 1, 1, 1], CLEAR = [0, 0, 0, 0], FAR = [1];
const EDGE_PX = 2.8;                     // shadeEdges() calls an edge where the depth jumps by 2.8 pixels' worth
const HASH_UNIT = 0, RAMP_UNIT = 1, FIRST_FREE_UNIT = 2;

export class CityRenderer extends StyleRenderer {
  constructor(gl, width, height, ss = 2) {
    super(gl, width, height, ss);
    for (const [name, s] of Object.entries(CITY_SHADERS)) this.programs[name] = new Program(gl, s.vs, s.fs, name);
    this.city = new CityCamera();
    this.city.width = width;
    this.city.height = height;
    this.city.ss = ss;
    this.ground = [0, 0, 0];             // palette indices: grass, wood, rock; set once the palette is known
    this.emptyMask = this.blackTexture();
    this.drawn = { tiles: 0, triangles: 0 };
  }

  // an empty shadow mask: a single black texel
  blackTexture() {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return texture;
  }

  // Both uniform contracts are filled: the one of the shared per-pixel passes, which project from the
  // world origin, and the one of the city shaders, which work relative to the camera centre.
  applyCamera(prog) {
    const { gl, W, H, SS } = this, c = this.city;
    const [near, far] = c.depthRange(TALLEST);
    prog.set('uView', [W, H, SS, c.scale])
      .set('uAngles', [c.cos, c.sin, c.sinPitch, c.cosPitch])
      .set('uOrigin', c.origin())
      .set('uDepth', [near, far])
      .set('uCentre', [c.x, c.y, c.cos, c.sin])
      .set('uTilt', [c.sinPitch, c.cosPitch, c.scale, SS])
      .set('uFrame', [W, H]);
    gl.activeTexture(gl.TEXTURE0 + HASH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.hashTexture);
    prog.set('uHash', HASH_UNIT);
    gl.activeTexture(gl.TEXTURE0 + RAMP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    prog.set('uRamp', RAMP_UNIT);
  }

  // -> the framebuffer holding the finished picture
  render(world, { edges = true } = {}) {
    const { gl, frame, city } = this;
    const district = city.scale >= DISTRICT_SCALE;
    frame.bindScene();
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.clearBufferfv(gl.COLOR, 0, WHITE);
    gl.clearBufferfv(gl.COLOR, 1, CLEAR);
    gl.clearBufferfv(gl.DEPTH, 0, FAR);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.colorMask(true, true, true, true, false, false, true, true);
    this.drawn = { tiles: 0, triangles: 0 };
    if (world.overview) this[district ? 'drawDistrict' : 'drawOverview'](world);
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

  terrain(grid, heights, x0, y0) {
    const { gl, city } = this;
    const prog = this.programs.terrain.use();
    this.applyCamera(prog);
    gl.activeTexture(gl.TEXTURE0 + FIRST_FREE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, heights);
    prog.set('uHeights', FIRST_FREE_UNIT)
      .set('uGridSize', [grid.nx, grid.ny])
      .set('uCell', grid.cell)
      .set('uOffset', [x0 - city.x, y0 - city.y])
      .set('uGround', this.ground);
    return prog;
  }

  drawOverview(world) {
    const { gl, city } = this;
    const o = world.overview;
    this.terrain(o.grid, o.heights, o.grid.x0, o.grid.y0);
    gl.bindVertexArray(o.mesh.vao);
    gl.drawElements(gl.TRIANGLES, o.mesh.count, gl.UNSIGNED_INT, 0);
    const boxes = this.programs.boxes.use();
    this.applyCamera(boxes);
    boxes.set('uOffset', [-city.x, -city.y]).set('uHalf', 25);
    gl.bindVertexArray(o.boxes.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 30, o.cells);
    gl.bindVertexArray(null);
    this.drawn.triangles = o.mesh.count / 3 + o.cells * 10;
  }

  drawDistrict(world) {
    const { gl, city } = this;
    for (const { tx, ty, x0, y0 } of world.visible(city)) {
      const tile = world.tiles.get(`${tx}_${ty}`);
      if (!tile) continue;
      this.drawn.tiles++;
      if (tile.heights) {
        this.terrain(tile.grid, tile.heights, x0, y0);
        gl.bindVertexArray(world.tileMesh.vao);
        gl.drawElements(gl.TRIANGLES, world.tileMesh.count, gl.UNSIGNED_INT, 0);
        this.drawn.triangles += world.tileMesh.count / 3;
      }
      if (tile.buildings) {
        const prog = this.programs.buildings.use();
        this.applyCamera(prog);
        gl.activeTexture(gl.TEXTURE0 + FIRST_FREE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, tile.props);
        prog.set('uProps', FIRST_FREE_UNIT).set('uOffset', [x0 - city.x, y0 - city.y]);
        gl.bindVertexArray(tile.buildings.vao);
        gl.drawElements(gl.TRIANGLES, tile.indexCount, gl.UNSIGNED_INT, 0);
        this.drawn.triangles += tile.indexCount / 3;
      }
    }
    gl.bindVertexArray(null);
  }
}
