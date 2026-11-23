// The landmarks themselves, each put together from the solids of Kit. Sizes are the real ones where they
// are known; where only the outline is mapped (a pagoda's footprint, a bridge's length) the rest follows
// the manner of the building. Every function takes `c`, the landmark's palette indices by role, and its
// own dimensions, and returns a Kit standing on the origin with its foot at z = 0.
import { Kit } from './kits.js';

const OCTAGON = Math.PI / 8;
const BODY = 0.62;          // a storey's walls as a share of its eave's radius: the eaves fly out well past them

// A pagoda: a stone platform, storeys that narrow as they rise, each with its walls, a balcony and a roof
// of dark tiles whose eaves fly out past them, and at the top a cone with a spire.
export function pagoda(c, { storeys, width, storeyHeight, taper = 0.08, eave = 0.6, spire = 8, sides = 8, platform = 2.5 }) {
  const k = new Kit();
  const stone = k.part(c.stone, c.stone), wall = k.part(c.wall, c.tile, 8), tiles = k.part(c.tile, c.tile), wood = k.part(c.wood, c.tile, 8), metal = k.part(c.metal, c.metal);
  k.prism(stone, 0, 0, 0, platform, width * 0.66, sides, OCTAGON);
  k.cap(stone, 0, 0, platform, width * 0.66, sides, OCTAGON);
  let z = platform;
  const rise = storeyHeight * eave;
  for (let i = 0; i < storeys; i++) {
    const r = width / 2 * (1 - taper * i), next = width / 2 * (1 - taper * (i + 1));
    k.prism(wall, 0, 0, z, z + storeyHeight, r * BODY, sides, OCTAGON);
    k.ring(wood, 0, 0, r * BODY, z + storeyHeight, r * 0.86, z + storeyHeight - 0.1, sides, OCTAGON);       // the balcony
    k.ring(tiles, 0, 0, next * BODY, z + storeyHeight + rise, r, z + storeyHeight, sides, OCTAGON);         // the eave, lowest at its outer edge
    z += storeyHeight + rise;
  }
  const top = width / 2 * (1 - taper * (storeys - 1));
  k.ring(tiles, 0, 0, 0, z + top * 0.55, top, z, sides, OCTAGON);                                            // the crown
  z += top * 0.55;
  k.prism(metal, 0, 0, z - 0.5, z + spire, 0.7, 6);
  k.cap(metal, 0, 0, z + spire, 0.7, 6);
  return k;
}

// A tower of pavilions, as the pavilion on Wu Hill: broad storeys with heavy eaves, wider than a pagoda's
// and fewer of them, a balcony around each, and a small crown.
export function pavilionTower(c, { storeys, width, storeyHeight, taper = 0.14, eave = 0.55, sides = 8 }) {
  const k = new Kit();
  const stone = k.part(c.stone, c.stone), wall = k.part(c.wall, c.tile, 8), tiles = k.part(c.tile, c.tile), red = k.part(c.red, c.tile, 8), wood = k.part(c.wood, c.tile, 8);
  k.prism(stone, 0, 0, 0, 3, width * 0.7, sides, OCTAGON);
  k.cap(stone, 0, 0, 3, width * 0.7, sides, OCTAGON);
  let z = 3;
  const rise = storeyHeight * eave;
  for (let i = 0; i < storeys; i++) {
    const r = width / 2 * (1 - taper * i), next = width / 2 * (1 - taper * (i + 1));
    k.prism(red, 0, 0, z, z + storeyHeight * 0.12, r * 0.9, sides, OCTAGON);                                // a colonnade under the floor
    k.ring(wood, 0, 0, r * 0.72, z + storeyHeight * 0.12, r * 0.98, z + storeyHeight * 0.12, sides, OCTAGON); // the gallery's floor
    k.prism(wall, 0, 0, z + storeyHeight * 0.12, z + storeyHeight, r * 0.72, sides, OCTAGON);
    k.prism(wood, 0, 0, z + storeyHeight * 0.12, z + storeyHeight * 0.12 + 1.1, r * 0.98, sides, OCTAGON);  // the gallery's railing
    k.ring(tiles, 0, 0, next * 0.72, z + storeyHeight + rise, r, z + storeyHeight, sides, OCTAGON);
    z += storeyHeight + rise;
  }
  const top = width / 2 * (1 - taper * (storeys - 1));
  k.ring(tiles, 0, 0, 0, z + top * 0.5, top * 0.9, z, sides, OCTAGON);
  return k;
}

// A stone arch bridge along the map's x axis: its deck rises in an arc from bank to bank, the walls under
// the deck follow the same arc above and the arch below, and a low parapet runs along each side.
// `arches` are the shares of the length that are open water under the bridge, innermost first.
export function archBridge(c, { length, width, rise, thickness = 1.0, parapet = 1.1, segments = 32, arches = [[0.3, 0.7]] }) {
  const k = new Kit();
  const stone = k.part(c.stone, c.stone), top = k.part(c.path, c.stone);
  const deck = t => rise * (1 - (2 * t - 1) * (2 * t - 1));                   // 0 at the banks, `rise` in the middle
  const under = t => {                                                        // the underside of the bridge at t: the arch where there is one
    let lowest = 0;
    for (const [a, b] of arches) if (t > a && t < b) {
      const mid = (a + b) / 2, half = (b - a) / 2, q = (t - mid) / half;
      lowest = Math.max(lowest, deck(mid) * 0.9 * Math.sqrt(Math.max(0, 1 - q * q)));
    }
    return lowest;
  };
  const half = width / 2;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments, t1 = (i + 1) / segments, x0 = (t0 - 0.5) * length, x1 = (t1 - 0.5) * length;
    const d0 = deck(t0), d1 = deck(t1), u0 = under(t0), u1 = under(t1);
    k.quad(top, [[x0, -half, d0], [x1, -half, d1], [x1, half, d1], [x0, half, d0]], 0, 0);                      // the way across
    for (const side of [-1, 1]) {                                                                                 // the two walls, deck to arch
      const y = side * half;
      k.quad(stone, side < 0 ? [[x0, y, u0], [x1, y, u1], [x1, y, d1], [x0, y, d0]] : [[x0, y, d0], [x1, y, d1], [x1, y, u1], [x0, y, u0]], 0, side);
      const py = side * (half - 0.25);
      k.quad(stone, [[x0, py - 0.25, d0], [x1, py - 0.25, d1], [x1, py - 0.25, d1 + parapet], [x0, py - 0.25, d0 + parapet]], 0, -1);
      k.quad(stone, [[x0, py + 0.25, d0], [x1, py + 0.25, d1], [x1, py + 0.25, d1 + parapet], [x0, py + 0.25, d0 + parapet]], 0, 1);
      k.quad(stone, [[x0, py - 0.25, d0 + parapet], [x1, py - 0.25, d1 + parapet], [x1, py + 0.25, d1 + parapet], [x0, py + 0.25, d0 + parapet]], 0, 0);
    }
  }
  return k;
}

// A steel truss bridge on the old pattern: a level deck on piers, and along each side a truss of posts,
// a top chord and diagonals crossing bay by bay.
export function trussBridge(c, { length, width, deckHeight, truss = 10, bay = 12, piers = 15 }) {
  const k = new Kit();
  const steel = k.part(c.steel, c.steel), deck = k.part(c.deck, c.steel), stone = k.part(c.stone, c.stone);
  k.box(deck, 0, 0, deckHeight, length, width, 1.4);
  const half = width / 2 - 0.5, bays = Math.round(length / bay), step = length / bays;
  for (const side of [-1, 1]) {
    const y = side * half;
    for (let i = 0; i <= bays; i++) k.box(steel, -length / 2 + i * step, y, deckHeight + 1.4, 0.7, 0.7, truss);
    k.box(steel, 0, y, deckHeight + 1.4 + truss, length, 0.8, 0.8);                     // the top chord
    for (let i = 0; i < bays; i++) {                                                    // diagonals, crossing
      const x0 = -length / 2 + i * step, x1 = x0 + step, low = deckHeight + 1.4, high = low + truss;
      const lean = i % 2 ? [[x0 - 0.35, y, high], [x0 + 0.35, y, high], [x1 + 0.35, y, low], [x1 - 0.35, y, low]] : [[x0 - 0.35, y, low], [x0 + 0.35, y, low], [x1 + 0.35, y, high], [x1 - 0.35, y, high]];
      k.quad(steel, lean, 0, side);
    }
  }
  const count = Math.max(1, Math.round(length / 160));
  for (let i = 0; i < count - 1; i++) {                                                 // piers standing in the water
    const x = -length / 2 + (i + 1) * length / count;
    k.box(stone, x, 0, -2, 6, width - 4, deckHeight + 2);
  }
  return k;
}

// A stadium like a lotus in flower: a bowl of stands under a ring of petals that lean out and up, with
// the middle open to the sky. a and b: the bowl's half axes.
export function lotus(c, { a, b, petals = 28, height = 40 }) {
  const k = new Kit();
  const bowl = k.part(c.concrete, c.white), petal = k.part(c.white, c.white), field = k.part(c.grass, c.grass);
  const on = (t, da, db) => [da * Math.cos(t), db * Math.sin(t)];
  for (let i = 0; i < petals; i++) {
    const t0 = 2 * Math.PI * i / petals, t1 = 2 * Math.PI * (i + 1) / petals, tm = (t0 + t1) / 2;
    // a slice of the bowl: its outer wall, leaning in towards the top
    const o0 = on(t0, a + 6, b + 6), o1 = on(t1, a + 6, b + 6), i0 = on(t0, a - 24, b - 24), i1 = on(t1, a - 24, b - 24), m = on(tm, 1, 1);
    const length = Math.hypot(o1[0] - o0[0], o1[1] - o0[1]) || 1, nx = (o0[1] - o1[1]) / length, ny = (o1[0] - o0[0]) / length;
    const outward = (nx * m[0] + ny * m[1]) >= 0 ? 1 : -1;
    k.quad(bowl, [[o0[0], o0[1], 0], [o1[0], o1[1], 0], [o1[0], o1[1], height * 0.62], [o0[0], o0[1], height * 0.62]], nx * outward, ny * outward);
    k.quad(bowl, [[o0[0], o0[1], height * 0.62], [o1[0], o1[1], height * 0.62], [i1[0], i1[1], height * 0.5], [i0[0], i0[1], height * 0.5]], 0, 0);   // the roof
    k.quad(bowl, [[i0[0], i0[1], 1], [i1[0], i1[1], 1], [i1[0], i1[1], height * 0.5], [i0[0], i0[1], height * 0.5]], -nx * outward, -ny * outward);
    // the petal over it: a slab from the rim leaning out
    const p0 = on(t0, a + 4, b + 4), p1 = on(t1, a + 4, b + 4), q0 = on(t0 + 0.3 / petals * 6.28, a + 22, b + 22), q1 = on(t1 - 0.3 / petals * 6.28, a + 22, b + 22);
    k.quad(petal, [[p0[0], p0[1], height * 0.6], [p1[0], p1[1], height * 0.6], [q1[0], q1[1], height], [q0[0], q0[1], height]], nx * outward, ny * outward);
    k.tri(field, [0, 0, 0.2], [...on(t0, a - 26, b - 26), 0.2], [...on(t1, a - 26, b - 26), 0.2], 0, 0);     // the field inside
  }
  return k;
}

// A ball: latitude bands of facets, each face's normal the horizontal part of its outward direction (the
// shader builds the vertical part from it, as it does for a roof slope). Faceted on purpose: it is a
// pixel map, and a faceted ball shades like the originals' domes do.
function ball(k, part, cx, cy, cz, radius, bands = 6, sides = 12) {
  const ringAt = b => {
    const phi = Math.PI * (b / bands - 0.5), r = Math.max(radius * Math.cos(phi), radius * 0.015), z = cz + radius * Math.sin(phi);
    return { r, z, corners: Array.from({ length: sides }, (_, s) => Kit.corner(cx, cy, r, sides, s)) };
  };
  for (let b = 0; b < bands; b++) {
    const lo = ringAt(b), hi = ringAt(b + 1);
    const shade = Math.cos(Math.PI * ((b + 0.5) / bands - 0.5));       // the face normal's horizontal share
    for (let s = 0; s < sides; s++) {
      const lam = 2 * Math.PI * (s + 0.5) / sides;
      k.quad(part, [[lo.corners[s][0], lo.corners[s][1], lo.z], [lo.corners[(s + 1) % sides][0], lo.corners[(s + 1) % sides][1], lo.z],
                    [hi.corners[(s + 1) % sides][0], hi.corners[(s + 1) % sides][1], hi.z], [hi.corners[s][0], hi.corners[s][1], hi.z]],
             Math.cos(lam) * shade, Math.sin(lam) * shade);
    }
  }
}

// A square-section prism leaning from one point to another: three slanted legs hold the Oriental Pearl up.
function leaningPrism(k, part, from, to, half) {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const ux = (to[0] - from[0]) / len, uy = (to[1] - from[1]) / len, uz = (to[2] - from[2]) / len;
  let s1x = -uy, s1y = ux;                                             // the horizontal side, across the lean
  const l1 = Math.hypot(s1x, s1y) || 1;
  s1x /= l1; s1y /= l1;
  const s2x = uy * 0 - uz * s1y, s2y = uz * s1x - ux * 0, s2z = ux * s1y - uy * s1x;   // the axis across s1
  const at = (p, a, b) => [p[0] + s1x * half * a + s2x * half * b, p[1] + s1y * half * a + s2y * half * b, p[2] + s2z * half * b];
  const ends = [from, to].map(p => [at(p, -1, -1), at(p, 1, -1), at(p, 1, 1), at(p, -1, 1)]);
  const [P, Q] = ends;
  for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
    const mx = (P[i][0] + P[j][0] + Q[i][0] + Q[j][0]) / 4 - (from[0] + to[0]) / 2;
    const my = (P[i][1] + P[j][1] + Q[i][1] + Q[j][1]) / 4 - (from[1] + to[1]) / 2;
    const ml = Math.hypot(mx, my) || 1;
    k.quad(part, [[P[i][0], P[i][1], P[i][2]], [P[j][0], P[j][1], P[j][2]], [Q[j][0], Q[j][1], Q[j][2]], [Q[i][0], Q[i][1], Q[i][2]]], mx / ml, my / ml);
  }
}

// The Oriental Pearl: three slanted legs holding a great lower sphere, three columns threading a string of
// small balls up to the great upper sphere, and a capsule with the antenna above. The public numbers are
// the tower's own: 468 m to the antenna's tip, the lower sphere 50 m across about 49 m up, the upper sphere
// 45 m across at 263–295 m, the capsule 16 m at 350 m, the mast 118 m. The small balls' diameters (12 m)
// and their 13 m spacing are by eye and by manner.
export function pearlTower(c, { height = 468, lower = 50, upper = 45, capsule = 16, smalls = 5 }) {
  const k = new Kit();
  const concrete = k.part(c.concrete, c.concrete), glass = k.part(c.white, c.white), rose = k.part(c.rose, c.rose), white = k.part(c.white, c.white), metal = k.part(c.metal, c.metal);
  for (let i = 0; i < 3; i++) {
    const a = 2 * Math.PI * i / 3, ux = Math.cos(a), uy = Math.sin(a);
    leaningPrism(k, concrete, [ux * 44, uy * 44, 0], [ux * 9, uy * 9, 62], 3.2);       // the slanted legs
  }
  ball(k, glass, 0, 0, 49, lower / 2, 8, 16);                                          // the lower sphere
  for (let i = 0; i < 3; i++) {
    const p = Kit.corner(0, 0, 11, 1, 0, 2 * Math.PI * i / 3 + Math.PI / 6);
    k.prism(concrete, p[0], p[1], 55, 263, 4, 8);                                      // the three columns
  }
  for (let i = 0; i < smalls; i++) ball(k, rose, 0, 0, 118 + i * 13, 6, 4, 10);        // the small balls
  ball(k, glass, 0, 0, 279, upper / 2, 8, 16);                                         // the upper sphere
  k.prism(concrete, 0, 0, 295, 342, 3.2, 8);                                           // the mast below the capsule
  ball(k, white, 0, 0, 350, capsule / 2, 5, 12);                                       // the capsule
  k.prism(metal, 0, 0, 358, height, 2.2, 6);                                           // the antenna
  k.cap(metal, 0, 0, height, 2.2, 6);
  return k;
}
