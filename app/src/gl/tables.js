import { hash } from '../style/core.js';

// Values the shaders read instead of recomputing: the engine's hash in double precision, and per-pixel
// fields for the grass tufts. All are sampled with nearest filtering at integer coordinates.

export const HASH_SIZE = 1024, HASH_OFFSET = 256; // hash(i, j) lives at texel (i + 256, j + 256) for i, j in [-256, 768)

export function hashTable() {
  const data = new Float32Array(HASH_SIZE * HASH_SIZE);
  for (let j = 0; j < HASH_SIZE; j++) for (let i = 0; i < HASH_SIZE; i++) data[j * HASH_SIZE + i] = hash(i - HASH_OFFSET, j - HASH_OFFSET);
  return data;
}

// per pixel, in the reference's top-left indexing:
//   r: hash(ix * 3, iy * 5) decides whether a tuft grows here
//   g: hash(ix, iy * 2) its height
//   b: hash(ix * 7, iy) whether it carries a flower
//   a: hash(ix, iy) its phase in the wind
export function tuftTable(W, H) {
  const data = new Float32Array(W * H * 4);
  for (let iy = 0; iy < H; iy++) for (let ix = 0; ix < W; ix++) {
    const o = (iy * W + ix) * 4;
    data[o] = hash(ix * 3, iy * 5);
    data[o + 1] = hash(ix, iy * 2);
    data[o + 2] = hash(ix * 7, iy);
    data[o + 3] = hash(ix, iy);
  }
  return data;
}
