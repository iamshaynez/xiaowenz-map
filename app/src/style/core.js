// Numbers shared by the CPU reference (pixel-plays' engine.js) and the GPU port. They are kept bit-for-bit
// identical so the two renderers can be compared pixel by pixel. The GPU never recomputes the hash and the
// ramps in single precision, where they would come out different: it reads them from lookup textures
// filled by these functions (see gl/tables.js).

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = t => t * t * (3 - 2 * t);

export function hash(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = ease(x - ix), fy = ease(y - iy);
  return lerp(lerp(hash(ix, iy), hash(ix + 1, iy), fx), lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), fx), fy);
}

export const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayerAt = (ix, iy) => (BAYER[(iy & 3) * 4 + (ix & 3)] + 0.5) / 16;

// shadows drift to violet, lights to warm yellow
export const COOL = [46, 38, 84], WARM = [255, 232, 180];
export const INK = [28, 27, 25], PAPER = [255, 255, 255];

// 0xAABBGGRR, the layout pixel-plays' pixel buffer uses
export const pack = (r, g, b) => (255 << 24 | Math.min(255, b | 0) << 16 | Math.min(255, g | 0) << 8 | Math.min(255, r | 0)) >>> 0;
export const channels = c => [c & 255, c >> 8 & 255, c >> 16 & 255];

export function rampOf(c) {
  const mix = (m, tint, k) => pack(lerp(c[0] * m, tint[0], k), lerp(c[1] * m, tint[1], k), lerp(c[2] * m, tint[2], k));
  return [mix(.4, COOL, .34), mix(.62, COOL, .18), mix(.84, COOL, .05), mix(1, WARM, 0), mix(1.1, WARM, .22)];
}

export const tint = (c, r, g, b) => pack((c & 255) * r, (c >> 8 & 255) * g, (c >> 16 & 255) * b);

// one lighting value to one of the five ramp levels, with or without ordered dithering
export const levelOf = (l, ix, iy, dithered) => dithered
  ? clamp(Math.floor(l * 4.4 + .2 + (bayerAt(ix, iy) - .5) * .7), 0, 4)
  : clamp(Math.floor(l * 4.4 + .2), 1, 4);
