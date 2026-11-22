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
      const cls = flip(frame.read(frame.resolvedFbo, 1), W, H);
      frames[tag] = { color: base64(color), cls: base64(cls), depth: base64(new Uint8Array(renderer.readDepth().buffer)) };
      if (tag === 'full') show(color, W, H);
    }
    out[name] = frames;
  }
  return { frames: out, glError: gl.getError() };
};

window.fidelityReady = true;
