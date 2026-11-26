import { Program, texture, vertexBuffer, instanceBuffer } from '../gl/context.js';
import { SHADERS } from '../gl/shaders.js';
import { hashTable, tuftTable, HASH_SIZE } from '../gl/tables.js';
import { Frame } from '../gl/frame.js';
import { Palette } from '../style/palette.js';

const HASH_UNIT = 0, RAMP_UNIT = 1, FIRST_FREE_UNIT = 2;
const WHITE = [1, 1, 1, 1], CLEAR = [0, 0, 0, 0], FAR = [1];
export const NEAREST_DEPTH = 1000, FARTHEST_DEPTH = -1000;
const EDGE_PX = 2.8; // shadeEdges() calls an edge where the depth jumps by 0.28 units, i.e. 2.8 pixels at 10 px per unit
export const MODES = { plain: 0, rough: 1, gloss: 2, solid: 3 };

// pixel-plays' project() in double precision, for things placed on the CPU (water streaks). One departure
// from the reference: the ground's far axis runs up the page (the way the ground recedes towards the
// horizon of a tilted view), not down it — the reference's tiny island read fine either way, a real city does not.
export function project(cam, x, y, z, W, H) {
  const yawC = Math.cos(cam.yaw), yawS = Math.sin(cam.yaw), sinP = Math.sin(cam.pitch), cosP = Math.cos(cam.pitch);
  const rx = x * yawC - y * yawS, ry = x * yawS + y * yawC;
  const u = (rx - ry) / Math.SQRT2, v = (rx + ry) / Math.SQRT2;
  const OX = W / 2 + (cam.panX || 0), OY = H / 2 + (cam.originY || 0) * cam.scale / 10 + (cam.panY || 0);
  return { sx: OX + u * cam.scale, sy: OY - (v * sinP + z * cosP) * cam.scale, d: z * sinP - v * cosP };
}

export const toUnit = c => [c[0] / 255, c[1] / 255, c[2] / 255];

// The style engine: draws a scene the way pixel-plays does, with the GPU and from any camera.
export class StyleRenderer {
  constructor(gl, W, H, SS = 2) {
    this.gl = gl;
    this.W = W;
    this.H = H;
    this.SS = SS;
    this.frame = new Frame(gl, W, H, SS);
    this.palette = new Palette();
    this.programs = {};
    for (const [name, s] of Object.entries(SHADERS)) this.programs[name] = new Program(gl, s.vs, s.fs, name);
    this.hashTexture = texture(gl, gl.R32F, gl.RED, gl.FLOAT, HASH_SIZE, HASH_SIZE, hashTable());
    this.tuftTexture = texture(gl, gl.RGBA32F, gl.RGBA, gl.FLOAT, W, H, tuftTable(W, H));
    this.rampTexture = null;
    gl.bindVertexArray(gl.createVertexArray()); // full-screen passes use gl_VertexID only
    this.setCamera({ yaw: 0, pitch: Math.PI / 6, scale: 10, panX: 0, panY: 0, originY: 0 });
  }

  // call after a scene has registered new colours
  updatePalette() {
    const { gl } = this;
    if (this.rampTexture) gl.deleteTexture(this.rampTexture);
    this.rampTexture = texture(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 5, this.palette.colors.length, this.palette.bytes());
  }

  setCamera(cam) {
    this.camera = cam;
  }

  applyCamera(prog) {
    const { gl, W, H, SS } = this, c = this.camera;
    prog.set('uView', [W, H, SS, c.scale])
      .set('uAngles', [Math.cos(c.yaw), Math.sin(c.yaw), Math.sin(c.pitch), Math.cos(c.pitch)])
      .set('uOrigin', [W / 2 + (c.panX || 0), H / 2 + (c.originY || 0) * c.scale / 10 + (c.panY || 0)])
      .set('uDepth', [NEAREST_DEPTH, FARTHEST_DEPTH]);
    gl.activeTexture(gl.TEXTURE0 + HASH_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.hashTexture);
    prog.set('uHash', HASH_UNIT);
    gl.activeTexture(gl.TEXTURE0 + RAMP_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.rampTexture);
    prog.set('uRamp', RAMP_UNIT);
  }

  // --- drawing helpers ---------------------------------------------------------------
  fullscreen(name, fbo, textures = {}, uniforms = {}, { depthWrite = true } = {}) {
    const { gl, frame } = this;
    const prog = this.programs[name].use();
    this.applyCamera(prog);
    let unit = FIRST_FREE_UNIT;
    for (const [key, tex] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      prog.set(key, unit++);
    }
    for (const [key, value] of Object.entries(uniforms)) prog.set(key, value);
    // a depth buffer is only written while the depth test is on, so passes that set gl_FragDepth use ALWAYS
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.disable(gl.BLEND);
    gl.depthMask(depthWrite);
    gl.colorMask(true, true, true, true);
    frame.bindLow(fbo);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  drawMesh(buffer, uniforms = {}) {
    const { gl } = this;
    if (!buffer || !buffer.count) return;
    const prog = this.programs.surfaces.use();
    this.applyCamera(prog);
    for (const [key, value] of Object.entries(uniforms)) prog.set(key, value);
    gl.bindVertexArray(buffer.vao);
    gl.drawArrays(gl.TRIANGLES, 0, buffer.count);
    gl.bindVertexArray(null);
  }

  // instanced quads (billboards): four strip vertices per instance
  drawQuads(buffer, program, uniforms = {}) {
    const { gl } = this;
    if (!buffer || !buffer.count) return;
    const prog = this.programs[program].use();
    this.applyCamera(prog);
    for (const [key, value] of Object.entries(uniforms)) prog.set(key, value);
    gl.bindVertexArray(buffer.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, buffer.count);
    gl.bindVertexArray(null);
  }

  // castShadow ellipses into a mask, the largest strength winning
  discs(buffer, fbo, shadowDir) {
    const { gl, frame } = this;
    frame.bindLow(fbo);
    gl.disable(gl.DEPTH_TEST);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 1]);
    if (!buffer || !buffer.count) return;
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    this.drawQuads(buffer, 'discs', { uShadowDir: shadowDir });
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }

  // --- one frame ------------------------------------------------------------------------
  // scene: { shape, ground, tufts, water, shadowDir, surfaces, surfaceUniforms, staticSpheres, staticDiscs,
  //          people, leaves, movingDiscs, streaks(camera) }
  // Returns the framebuffer that holds the finished picture.
  render(scene, { dynamic = true, edges = true } = {}) {
    const { gl, frame, camera: c } = this;
    const beginScene = () => {
      frame.bindScene();
      gl.disable(gl.BLEND);
      gl.depthMask(true);
    };
    // 1. the static scene, supersampled: ground first, then geometry with the nearest sample winning
    beginScene();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.ALWAYS);
    gl.clearBufferfv(gl.COLOR, 0, WHITE);
    gl.clearBufferfv(gl.COLOR, 1, CLEAR);
    gl.clearBufferfv(gl.DEPTH, 0, FAR);
    const ground = this.programs.ground.use();
    this.applyCamera(ground);
    for (const [key, value] of Object.entries(scene.ground)) ground.set(key, value);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.colorMask(true, true, true, true, false, false, true, true); // keep the ground-kind channel
    // 2. static shadows and the occlusion they sit next to
    const staticPasses = () => {
      this.resolve();
      this.discs(scene.staticDiscs, frame.maskStaticFbo, scene.shadowDir);
      this.copyClass();
      this.fullscreen('groundTint', frame.workAFbo, { uColor: frame.color, uClass: frame.class, uMask: frame.maskStatic, uStaticClass: frame.classStatic }, { uAO: 1 });
    };
    this.drawMesh(scene.surfaces, scene.surfaceUniforms);
    this.drawQuads(scene.staticSpheres, 'spheres');
    staticPasses();
    if (!dynamic) return frame.workAFbo;
    // 3. moving things, drawn over the same scene buffers and resolved again
    beginScene();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.colorMask(true, true, true, true, false, false, true, true);
    this.drawQuads(scene.people, 'spheres');
    this.drawQuads(scene.leaves, 'spheres');
    staticPasses();
    this.fullscreen('tufts', frame.workBFbo, { uColor: frame.workA, uClass: frame.class, uMask: frame.maskStatic, uTuft: this.tuftTexture }, scene.tufts);
    this.water(scene.streaks(c), scene.water);
    this.discs(scene.movingDiscs, frame.maskMovingFbo, scene.shadowDir);
    this.fullscreen('groundTint', frame.workAFbo, { uColor: frame.workB, uClass: frame.class, uMask: frame.maskMoving, uStaticClass: frame.classStatic }, { uAO: 0 });
    // 4. edges read from the final depth buffer
    if (!edges) return frame.workAFbo;
    this.fullscreen('edges', frame.workBFbo, { uColor: frame.workA, uClass: frame.class, uDepthTex: frame.depth },
      { uGradientY: Math.cos(c.pitch) / (c.scale * Math.sin(c.pitch)), uEdge: EDGE_PX / c.scale });
    return frame.workBFbo;
  }

  resolve() {
    const { frame } = this;
    this.fullscreen('resolve', frame.resolvedFbo, { uColor: frame.sceneColor, uClass: frame.sceneClass, uDepthTex: frame.sceneDepth });
  }

  // keep the static scene's class buffer: the occlusion pass reads it after moving things are drawn
  copyClass() {
    const { gl, frame, W, H } = this;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frame.resolvedFbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT1); // the class buffer is the second colour attachment
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frame.classStaticFbo);
    gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  water(buffer, uniforms) {
    const { gl, frame } = this;
    if (!buffer || !buffer.count) return;
    const prog = this.programs.water.use();
    this.applyCamera(prog);
    gl.activeTexture(gl.TEXTURE0 + FIRST_FREE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, frame.class);
    prog.set('uClass', FIRST_FREE_UNIT);
    gl.activeTexture(gl.TEXTURE0 + FIRST_FREE_UNIT + 1);
    gl.bindTexture(gl.TEXTURE_2D, frame.maskStatic);
    prog.set('uMask', FIRST_FREE_UNIT + 1);
    for (const [key, value] of Object.entries(uniforms)) prog.set(key, value);
    frame.bindLow(frame.workBFbo);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(buffer.vao);
    gl.drawArrays(gl.POINTS, 0, buffer.count);
    gl.bindVertexArray(null);
  }

  // engine depth of the resolved buffers, one value per pixel in top-left row order
  readDepth() {
    this.fullscreen('packDepth', this.frame.packedDepthFbo, { uDepthTex: this.frame.depth });
    return this.frame.depthValues();
  }
}

// instance records: [x y z r | colour index mode 0 0 | shiftX shiftY]
export function sphereBuffer(gl, list, palette, shifts) {
  const data = new Float32Array(list.length * 10);
  list.forEach((s, i) => {
    const o = i * 10;
    data[o] = s.x; data[o + 1] = s.y; data[o + 2] = s.z; data[o + 3] = s.r;
    data[o + 4] = palette.id(s.c);
    data[o + 5] = MODES[s.mode] ?? 0;
    if (shifts) { data[o + 8] = shifts[i * 2]; data[o + 9] = shifts[i * 2 + 1]; }
  });
  return instanceBuffer(gl, data, [[1, 4], [2, 4], [3, 2]]);
}

// disc records: [x y z r | strength dither]
export function discBuffer(gl, list) {
  const data = new Float32Array(list.length * 6);
  list.forEach((d, i) => data.set([d.x, d.y, d.z, d.r, d.strength, d.dither], i * 6));
  return instanceBuffer(gl, data, [[1, 4], [2, 2]]);
}

export function meshBuffer(gl, data) {
  return vertexBuffer(gl, data, [[0, 3], [1, 4], [2, 3]]);
}

// water streaks: [sx sy | kind], one point each
export function pointBuffer(gl, data) {
  return vertexBuffer(gl, data, [[0, 2], [1, 1]]);
}
