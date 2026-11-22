// Test page for the style engine: renders the reference scene from each exported camera position with the
// GPU and hands back raw buffers (colour, class, depth) for comparison with the CPU reference.
import { createContext } from '../../app/src/gl/context.js';
import { StyleRenderer } from '../../app/src/render/style.js';
import { buildStari } from '../../app/src/scene/stari.js';

const canvas = document.createElement('canvas'); // offscreen: the visible one shows the result through a 2D context
const preview = document.getElementById('c');

function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(out);
}

// readPixels returns bottom-up rows; the reference uses top-down
function flip(bytes, W, H) {
  const out = new Uint8Array(bytes.length), row = W * 4;
  for (let y = 0; y < H; y++) out.set(bytes.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  return out;
}

function show(rgba, W, H) {
  preview.width = W;
  preview.height = H;
  preview.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0);
}

// every case is rendered twice: the static scene alone, and the full frame with moving things and edges
window.runFidelity = ({ W = 360, H = 280, SS = 2, constants, cases }) => {
  const gl = createContext(canvas);
  const renderer = new StyleRenderer(gl, W, H, SS);
  const { frame } = renderer;
  const out = {};
  for (const [name, data] of Object.entries(cases)) {
    renderer.setCamera({ ...data.camera, originY: constants.originY });
    const scene = buildStari(gl, constants, data, renderer.palette, W, H);
    renderer.updatePalette();
    const frames = {};
    for (const [tag, options] of [['static', { dynamic: false, edges: false }], ['full', {}]]) {
      const fbo = renderer.render(scene, options);
      const color = flip(frame.read(fbo), W, H);
      // the same frame without the edge pass, so the edges the GPU actually drew can be recovered
      const plain = options.edges === false ? null : flip(frame.read(renderer.render(scene, { ...options, edges: false })), W, H);
      const cls = flip(frame.read(frame.resolvedFbo, 1), W, H);
      frames[tag] = { color: base64(color), plain: plain ? base64(plain) : null, cls: base64(cls), depth: base64(new Uint8Array(renderer.readDepth().buffer)) };
      if (tag === 'full') show(color, W, H);
    }
    out[name] = frames;
  }
  return { frames: out, glError: gl.getError() };
};

// only the static spheres (trunks and rocks), alone on an empty buffer, for an isolated comparison
window.runSpheresOnly = ({ W = 360, H = 280, SS = 2, constants, cases, name }) => {
  const gl = createContext(canvas);
  const renderer = new StyleRenderer(gl, W, H, SS);
  const { frame } = renderer;
  const data = cases[name];
  renderer.setCamera({ ...data.camera, originY: constants.originY });
  const scene = buildStari(gl, constants, data, renderer.palette, W, H);
  renderer.updatePalette();
  frame.bindScene();
  const g = renderer.gl;
  g.disable(gl.BLEND);
  g.depthMask(true);
  g.enable(gl.DEPTH_TEST);
  g.depthFunc(gl.ALWAYS);
  g.clearBufferfv(gl.COLOR, 0, [1, 1, 1, 1]);
  g.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
  g.clearBufferfv(gl.DEPTH, 0, [1]);
  g.depthFunc(gl.LESS);
  renderer.drawQuads(scene.staticSpheres, 'spheres');
  renderer.resolve();
  return { color: base64(flip(frame.read(frame.resolvedFbo), W, H)), depth: base64(new Uint8Array(renderer.readDepth().buffer)) };
};

// debug: what the surfaces pass draws at each pixel: material in r, colour index in g, base in b
window.runMaterialDebug = ({ W = 360, H = 280, SS = 1, constants, cases, name }) => {
  const gl = createContext(canvas);
  const renderer = new StyleRenderer(gl, W, H, SS);
  const { frame } = renderer;
  const data = cases[name];
  renderer.setCamera({ ...data.camera, originY: constants.originY });
  const scene = buildStari(gl, constants, data, renderer.palette, W, H);
  renderer.updatePalette();
  frame.bindScene();
  g0(gl);
  renderer.drawMesh(scene.surfaces, { ...scene.surfaceUniforms, uDebug: 1 });
  renderer.resolve();
  return { color: base64(flip(frame.read(frame.resolvedFbo), W, H)), palette: renderer.palette.colors.map(c => c.join(',')) };
};
function g0(gl) {
  gl.disable(gl.BLEND); gl.depthMask(true); gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.ALWAYS);
  gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]); gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]); gl.clearBufferfv(gl.DEPTH, 0, [1]);
  gl.depthFunc(gl.LESS);
}

window.fidelityReady = true;
