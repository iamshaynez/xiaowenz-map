import { sphereBuffer, discBuffer, meshBuffer, pointBuffer, project, toUnit } from '../render/style.js';
import { lerp, clamp } from '../style/core.js';

// The reference scene (pixel-plays' Stari Most) rebuilt as geometry for the GPU. The original draws it by
// plotting points; here every plotted surface becomes a mesh that carries the same material coordinates,
// so the same formulas can be evaluated per pixel. The numbers all come from the reference export.
//
// material ids: 1 masonry, 2 flat level, 3 ribbed deck, 4 roof slope, 5 round tower wall, 6 cone,
//               7 box() grain along a, 8 window with mullion, 9 near wall of the deck, 10 box() grain along b
const M = { MASONRY: 1, FLAT: 2, DECK_TOP: 3, ROOF: 4, CYLINDER: 5, CONE: 6, BOX: 7, WINDOW: 8, DECK_WALL: 9, BOX_SWAPPED: 10 };
const TAU = Math.PI * 2;

class Mesh {
  constructor() {
    this.data = [];
  }

  // p: [x, y, z]; info: [material, colour, base, extra]; c: [a, b, smooth] material coordinates
  quad(p, q, r, s, info, cp, cq, cr, cs) {
    for (const [v, c] of [[p, cp], [q, cq], [r, cr], [p, cp], [r, cr], [s, cs]]) this.data.push(v[0], v[1], v[2], ...info, ...c);
  }

  // a parametric surface; fn(u, v) returns { p, c, info } for u, v in [0, 1]
  surface(fn, nu, nv) {
    const at = (i, j) => fn(i / nu, j / nv);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      this.quad(a.p, b.p, c.p, d.p, a.info, a.c, b.c, c.c, d.c);
    }
  }

  // vertical wall at constant y; a runs along x, b is height
  wallY(y, x0, x1, z0, z1, colour, base) {
    this.surface((u, v) => { const x = lerp(x0, x1, u), z = lerp(z0, z1, v); return { p: [x, y, z], c: [x, z, 0], info: [M.MASONRY, colour, base, 0] }; }, 1, 1);
  }

  // vertical wall at constant x; a runs along y
  wallX(x, y0, y1, z0, z1, colour, base) {
    this.surface((u, v) => { const y = lerp(y0, y1, u), z = lerp(z0, z1, v); return { p: [x, y, z], c: [y, z, 0], info: [M.MASONRY, colour, base, 0] }; }, 1, 1);
  }
}

// box() of the engine: a lit top with grain along its long side, and four faces at fixed levels
function engineBox(m, x0, y0, z0, x1, y1, z1, colour, seed) {
  m.surface((u, v) => { const x = lerp(x0, x1, u), y = lerp(y0, y1, v); return { p: [x, y, z1], c: [x, y, 0], info: [x1 - x0 >= y1 - y0 ? M.BOX : M.BOX_SWAPPED, colour, 3.4, seed] }; }, 1, 1);
  // at(a, height) gives the world point of a face sample; a runs along the face, between a0 and a1
  const face = (base, at, a0, a1) => m.surface((u, v) => {
    const a = lerp(a0, a1, u), h = lerp(z0, z1, v);
    return { p: at(a, h), c: [a, h, 0], info: [M.BOX, colour, base, seed] };
  }, 1, 1);
  face(2.3, (x, h) => [x, y1, h], x0, x1);
  face(1.2, (y, h) => [x1, y, h], y0, y1);
  face(1, (x, h) => [x, y0, h], x0, x1);
  face(1.7, (y, h) => [x0, y, h], y0, y1);
}

function roof(m, x0, y0, x1, y1, z, rise, colour, stone) {
  const yc = (y0 + y1) / 2, half = (y1 - y0) / 2;
  // two slopes with alternating courses and the odd missing tile
  for (const [ya, yb] of [[y0, yc], [yc, y1]]) {
    m.surface((u, v) => { const x = lerp(x0, x1, u), y = lerp(ya, yb, v); return { p: [x, y, z + rise * (1 - Math.abs(y - yc) / half)], c: [x, y, 0], info: [M.ROOF, colour, half, yc] }; }, 1, 1);
  }
  // a gable at each end, filled with masonry
  for (const [x, base] of [[x1, 2], [x0, 1]]) {
    m.surface((u, v) => { const y = lerp(y0, y1, u), h = v * rise * (1 - Math.abs(y - yc) / half); return { p: [x, y, z + h], c: [y, z + h, 0], info: [M.MASONRY, stone, base, 0] }; }, 1, 1);
  }
}

function squareTower(m, x0, y0, x1, y1, z1, slate, stone, dark) {
  m.wallY(y1, x0, x1, 0, z1, stone, 3);
  m.wallX(x1, y0, y1, 0, z1, stone, 2);
  m.wallY(y0, x0, x1, 0, z1, stone, 1);
  m.wallX(x0, y0, y1, 0, z1, stone, 2);
  for (const [wx, wz] of [[.35, .3], [.65, .55], [.35, .78]]) {
    const cx = lerp(x0, x1, wx), cz = z1 * wz;
    m.surface((u, v) => ({ p: [lerp(cx - .22, cx + .22, u), y1 + .14, lerp(cz - .4, cz + .4, v)], c: [0, 0, 0], info: [M.FLAT, dark, 1, 0] }), 1, 1);
  }
  roof(m, x0 - .15, y0 - .15, x1 + .15, y1 + .15, z1, 1.4, slate, stone);
}

function roundTower(m, cx, cy, r, z1, slate, stone, dark) {
  // the wall is lit by its own normal: l varies continuously around the tower and travels as a smooth coordinate
  m.surface((u, v) => {
    const t = u * TAU, nx = Math.cos(t), ny = Math.sin(t), z = v * z1;
    return { p: [cx + nx * r, cy + ny * r, z], c: [t * r, z, -.5 * nx + .85 * ny], info: [M.CYLINDER, stone, 0, 0] };
  }, 160, 1);
  m.surface((u, v) => {
    const t = u * TAU, nx = Math.cos(t), ny = Math.sin(t), q = v, rr = (r + .2) * (1 - q);
    return { p: [cx + nx * rr, cy + ny * rr, z1 + q * 2.1], c: [-.5 * nx + .85 * ny, q, 0], info: [M.CONE, slate, 0, 0] };
  }, 160, 24);
  for (const [t, wz] of [[1.2, .45], [.5, .72]]) {
    m.surface((u, v) => {
      const a = lerp(t - .1, t + .1, u), z = lerp(z1 * wz - .4, z1 * wz + .4, v);
      return { p: [cx + Math.cos(a) * (r + .14), cy + Math.sin(a) * (r + .14), z], c: [0, 0, 0], info: [M.FLAT, dark, 1, 0] };
    }, 6, 1);
  }
}

function house(m, x0, y0, x1, y1, z1, colour, stone, dark) {
  m.wallY(y1, x0, x1, 0, z1, stone, 3);
  m.wallX(x1, y0, y1, 0, z1, stone, 2);
  m.wallY(y0, x0, x1, 0, z1, stone, 1);
  m.wallX(x0, y0, y1, 0, z1, stone, 2);
  const windows = Math.max(1, Math.floor((x1 - x0) / 1.6));
  for (let k = 0; k < windows; k++) {
    const cx = lerp(x0, x1, (k + .5) / windows);
    for (const y of [y1 + .14, y0 - .14]) {
      m.surface((u, v) => {
        const a = lerp(cx - .24, cx + .24, u);
        return { p: [a, y, lerp(z1 * .55, z1 * .55 + .8, v)], c: [a, 0, 0], info: [M.WINDOW, dark, 0, cx] };
      }, 1, 1);
    }
  }
  roof(m, x0 - .2, y0 - .2, x1 + .2, y1 + .2, z1, 1.3, colour, stone);
}

function bridge(m, K, stone) {
  const { ARCH_A: A, ARCH_C: C, ARCH_R: R, ARCH_BASE: B, DECK_END: DE, DECK_LOW: DL, DECK_TOP: DT, DECK_REACH: DR, HALF_W: HW, PARAPET: P } = K;
  const archZ = x => B + Math.sqrt(Math.max(0, R * R - (Math.abs(x) + C) ** 2));
  const deckZ = x => { const a = Math.abs(x); return a >= DE ? DL : DT - (DT - DL) * (a / DE) ** 1.6; };
  // underside of the arch, swept along each arc
  const crown = Math.acos(C / R);
  for (const side of [-1, 1]) {
    m.surface((u, v) => {
      const t = u * crown, a = R * Math.cos(t) - C, y = lerp(-HW, HW, v);
      return { p: [side * a, y, B + R * Math.sin(t)], c: [y + t * 4, t * 8, 0], info: [M.MASONRY, stone, side < 0 ? 2 : 1, 0] };
    }, 120, 1);
  }
  for (const side of [-1, 1]) {
    const x0 = side < 0 ? -A : A - 1.1;
    engineBox(m, x0, -HW - .3, 0, x0 + 1.1, HW + .3, B, stone, 40 + side);
  }
  // the deck, in three spans: the wall's lower edge drops from the arch to the ground at the ends of the arch
  for (const [xa, xb, overArch] of [[-DR, -A, false], [-A, A, true], [A, DR, false]]) {
    const nu = Math.max(2, Math.ceil((xb - xa) / 0.2));
    const zAt = (x, v) => { const top = deckZ(x), low = overArch ? archZ(x) : 0; return lerp(low, top, v); };
    m.surface((u, v) => { const x = lerp(xa, xb, u), z = zAt(x, v); return { p: [x, HW, z], c: [x, z, 0], info: [M.DECK_WALL, stone, 0, 0] }; }, nu, 8);
    m.surface((u, v) => { const x = lerp(xa, xb, u), z = zAt(x, v); return { p: [x, -HW, z], c: [x, z, 0], info: [M.MASONRY, stone, 1, 0] }; }, nu, 8);
    // ribbed deck: the old bridge is ridged for grip on its steep hump
    m.surface((u, v) => { const x = lerp(xa, xb, u), y = lerp(-HW, HW, v); return { p: [x, y, deckZ(x)], c: [x, y, 0], info: [M.DECK_TOP, stone, 0, 0] }; }, nu, 1);
    // parapets on both sides, an outer and an inner face and a pale cap
    for (const side of [-1, 1]) {
      const face = (yy, base) => m.surface((u, v) => { const x = lerp(xa, xb, u), top = deckZ(x), z = lerp(top, top + P, v); return { p: [x, yy, z], c: [x, z, 0], info: [M.MASONRY, stone, base, 0] }; }, nu, 1);
      face(side * HW, 3);
      face(side * (HW - .2), 2);
      m.surface((u, v) => { const x = lerp(xa, xb, u), top = deckZ(x); return { p: [x, side * lerp(HW - .2, HW, v), top + P], c: [0, 0, 0], info: [M.FLAT, stone, 4, 0] }; }, nu, 1);
    }
  }
}

// K: the reference export's constants; data: one exported case (static and dynamic spheres and discs)
export function buildStari(gl, K, data, palette, W, H) {
  const stone = palette.id(K.STONE), slate = palette.id(K.SLATE), tile = palette.id(K.TILE), dark = palette.id(K.DARK);
  const m = new Mesh();
  bridge(m, K, stone);
  squareTower(m, -12.4, -2, -10.2, 2, 10.2, slate, stone, dark);
  roundTower(m, 11.8, 0, 1.9, 9.4, slate, stone, dark);
  house(m, -14.6, -6.6, -11.4, -3.6, 3, slate, stone, dark);
  house(m, -13.8, 3.6, -10.6, 6.6, 3.4, tile, stone, dark);
  house(m, 11, -7, 14.2, -3.8, 3.2, tile, stone, dark);
  house(m, 10.2, 4.4, 13.2, 7, 2.8, slate, stone, dark);

  // tree leaves are drawn twice: at rest with the static scene, and shifted by the wind with the moving things
  const leaves = [], still = [], shift = [];
  let k = 0;
  for (const s of data.static.spheres) {
    if (s.leaf) {
      const leaf = K.leaves[k++], reach = clamp((leaf.z - 2.5) / 3, .3, 1);
      const sway = (Math.sin(leaf.x * .5 + leaf.z * .7) + .55 * Math.sin(leaf.k * 1.7)) * reach;
      shift.push(Math.round(sway * .9), Math.round(Math.sin(leaf.y + leaf.k) * reach * .45));
      leaves.push(s);
    } else still.push(s);
  }

  const scene = {
    shape: [15.6, 10.4],
    shadowDir: [K.SHADOW_X, K.SHADOW_Y],
    ground: {
      uShape: [15.6, 10.4],
      uWater: K.WATER_TONES.map(toUnit), uBeach: K.BEACH_TONES.map(toUnit), uGrass: K.GRASS.map(toUnit),
      uBeachLight: toUnit([240, 236, 220]), uBeachDark: toUnit([150, 142, 126]),
    },
    tufts: {
      uGrassLit: K.GRASS.map(toUnit),
      uGrassDark: K.GRASS.map(c => toUnit([c[0] * .54, c[1] * .52, c[2] * .72])),
      uBloomA: toUnit([250, 246, 226]), uBloomB: toUnit([240, 200, 84]),
    },
    water: { uLit: toUnit([150, 208, 180]), uSoft: toUnit([104, 180, 158]), uDim: toUnit([58, 112, 120]) },
    surfaceUniforms: { uArch: [K.ARCH_A, K.ARCH_C, K.ARCH_R, K.ARCH_BASE], uDeck: [K.DECK_END, K.DECK_LOW, K.DECK_TOP, 0] },
    surfaces: meshBuffer(gl, new Float32Array(m.data)),
    staticSpheres: sphereBuffer(gl, still, palette),
    leaves: sphereBuffer(gl, leaves, palette, shift),
    people: sphereBuffer(gl, data.dynamic.spheres, palette),
    staticDiscs: discBuffer(gl, data.static.discs),
    movingDiscs: discBuffer(gl, data.dynamic.discs),
    streaksCache: null,
    streaks(cam) {
      if (this.streaksCache && this.streaksCache.cam === cam) return this.streaksCache.buffer;
      const pts = [];
      for (const s of K.streaks) {
        const y = (s.y0 % 21) - 10.5; // wind time is frozen at 0
        for (let i = 0; i < s.len; i++) {
          const p = project(cam, s.x + Math.sin(y * .4 + s.y0) * .3, y + i * .11, 0, W, H);
          const ix = p.sx | 0, iy = p.sy | 0; // the reference's own truncation
          if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
          pts.push(ix + .5, iy + .5, s.bright ? 1 : 0);
        }
      }
      this.streaksCache = { cam, buffer: pointBuffer(gl, new Float32Array(pts)) };
      return this.streaksCache.buffer;
    },
  };
  return scene;
}
