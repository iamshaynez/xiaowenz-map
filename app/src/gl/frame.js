import { rgba8, r8, depth24, framebuffer } from './context.js';

// The render targets of one frame.
//   scene buffers: supersampled colour, class and depth that the geometry is drawn into
//   resolved buffers: one low-resolution colour, class and depth per pixel
//   working targets: two colours to ping-pong the per-pixel passes through, and two shadow masks
export class Frame {
  constructor(gl, W, H, SS) {
    this.gl = gl;
    this.W = W;
    this.H = H;
    this.SS = SS;
    const sw = W * SS, sh = H * SS;
    this.sceneColor = rgba8(gl, sw, sh);
    this.sceneClass = rgba8(gl, sw, sh);
    this.sceneDepth = depth24(gl, sw, sh);
    this.sceneFbo = framebuffer(gl, [this.sceneColor, this.sceneClass], this.sceneDepth);

    this.color = rgba8(gl, W, H);
    this.class = rgba8(gl, W, H);
    this.depth = depth24(gl, W, H);
    this.resolvedFbo = framebuffer(gl, [this.color, this.class], this.depth);

    this.workA = rgba8(gl, W, H);
    this.workAFbo = framebuffer(gl, [this.workA]);
    this.workB = rgba8(gl, W, H);
    this.workBFbo = framebuffer(gl, [this.workB]);

    // the resolved class buffer of the static scene, kept for the occlusion pass once moving things are drawn
    this.classStatic = rgba8(gl, W, H);
    this.classStaticFbo = framebuffer(gl, [this.classStatic]);

    this.maskStatic = r8(gl, W, H);
    this.maskStaticFbo = framebuffer(gl, [this.maskStatic]);
    this.maskMoving = r8(gl, W, H);
    this.maskMovingFbo = framebuffer(gl, [this.maskMoving]);

    this.packedDepth = rgba8(gl, W, H);
    this.packedDepthFbo = framebuffer(gl, [this.packedDepth]);
  }

  bindScene() {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, this.W * this.SS, this.H * this.SS);
  }

  bindLow(fbo) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, this.W, this.H);
  }

  read(fbo, attachment = 0) {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0 + attachment);
    const out = new Uint8Array(this.W * this.H * 4);
    gl.readPixels(0, 0, this.W, this.H, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out; // bottom-up rows, RGBA
  }

  // engine depth of the resolved buffers as top-down rows of floats
  depthValues() {
    const { gl } = this;
    const bytes = this.read(this.packedDepthFbo);
    const { W, H } = this;
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const src = ((H - 1 - y) * W + x) * 4;
      const z = (bytes[src] + bytes[src + 1] * 256 + bytes[src + 2] * 65536) / 16777215;
      out[y * W + x] = 1000 - z * 2000; // mirrors uDepth = [1000, -1000]
    }
    return out;
  }
}
