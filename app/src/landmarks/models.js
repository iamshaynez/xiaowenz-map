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
  ball(k, glass, 0, 0, 49, lower / 2, 8, 24);                                          // the lower sphere
  for (let i = 0; i < 3; i++) {
    const p = Kit.corner(0, 0, 11, 1, 0, 2 * Math.PI * i / 3 + Math.PI / 6);
    k.prism(concrete, p[0], p[1], 55, 263, 4, 8);                                      // the three columns
  }
  for (let i = 0; i < smalls; i++) ball(k, rose, 0, 0, 118 + i * 13, 6, 5, 12);        // the small balls
  ball(k, glass, 0, 0, 279, upper / 2, 8, 24);                                         // the upper sphere
  k.prism(concrete, 0, 0, 295, 342, 3.2, 8);                                           // the mast below the capsule
  ball(k, white, 0, 0, 350, capsule / 2, 6, 16);                                       // the capsule
  k.prism(metal, 0, 0, 358, height, 2.2, 6);                                           // the antenna
  k.cap(metal, 0, 0, height, 2.2, 6);
  return k;
}

// The Waibaidu Bridge: a steel deck on stone piers, and over each of its two spans a through truss whose
// top chord arcs like a bow. length runs along the map's x axis (the bake turns it the way the bridge is
// mapped); the spans, the deck's height and the arcs' rise are the bridge's own as far as the record
// gives, the posts' rhythm by manner.
export function waibaidu(c, { length = 104, width = 18.5, deck = 6, rise = 9.5, spans = [52.4, 49.6] }) {
  const k = new Kit();
  const steel = k.part(c.steel, c.steel), walk = k.part(c.deck, c.steel), stone = k.part(c.stone, c.stone);
  const half = width / 2 - 0.9;
  k.box(walk, 0, 0, deck - 0.5, length, width, 0.5);                                   // the way across
  for (const side of [-1, 1]) k.box(steel, 0, side * (half - 0.3), deck, length, 0.3, 1.1);   // the railings
  let x = -length / 2;
  const piers = [x];
  for (const span of spans) {
    const x0 = x, x1 = x + span; x = x1;
    piers.push(x1);
    const posts = Math.max(6, Math.round(span / 6.5));
    for (const side of [-1, 1]) {
      const y = side * half;
      let prev = null;
      for (let i = 0; i <= posts; i++) {
        const t = i / posts, px = x0 + span * t, top = deck + 1.1 + rise * Math.sin(Math.PI * t);
        if (i > 0) leaningPrism(k, steel, [prev.px, y, prev.top], [px, y, top], 0.45); // the arched top chord
        k.box(steel, px, y, deck + 0.4, 0.45, 0.45, top - deck - 0.4);                 // the post, deck to chord
        prev = { px, top };
      }
    }
    for (let i = 1; i < posts; i++) {                                                  // struts tying the two trusses
      const t = i / posts, px = x0 + span * t, top = deck + 1.1 + rise * Math.sin(Math.PI * t);
      k.box(steel, px, 0, top, 0.45, half * 2 - 0.6, 0.45);
    }
  }
  for (const px of piers) k.box(stone, px, 0, -2, 6.5, width + 1.5, deck + 2);         // the piers
  return k;
}

// A flatiron: a slab that tapers to a rounded prow where the streets meet at an angle — the Huaihai Road
// corner of the Normandie Apartments. A brick ground floor, cream galleries above, the prow round with a
// railed balcony all the way round. length and prow follow the block; height and floors are the
// building's own.
export function flatiron(c, { length = 83, width = 19, prow = 14, height = 30, ground = 6, floors = 8 }) {
  const k = new Kit();
  const brick = k.part(c.brick, c.brick, 2), cream = k.part(c.cream, c.cream, 2), rail = k.part(c.concrete, c.cream);
  const l = length / 2 - prow, hw = width / 2;
  const pts = [[-l + 2, -hw], [-l, -hw], [-l, hw], [-l + 2, hw]];
  for (let i = 1; i <= 8; i++) {                                                       // the rounded prow
    const a = Math.PI / 2 - Math.PI * i / 8;
    const w = hw * (0.62 + 0.38 * Math.sin(Math.abs(a)) / 1) * (0.72 + 0.28 * Math.sin(Math.abs(a)));
    pts.push([l - prow + prow * Math.cos(a), hw * (0.62 + 0.38 * Math.sin(a))]);
  }
  pts.push([l - prow, -hw * 0.62]);
  const floor = (z0, z1, part) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, ml = Math.hypot(mx, my) || 1;
      k.quad(part, [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], mx / ml, my / ml);
    }
    k.tri(part, [0, 0, z1], ...pts.map(p => [p[0], p[1], z1]), 0, 0);
  };
  floor(0, ground, brick);                                                             // the brick ground floor
  floor(ground, height, cream);                                                        // the galleries above
  const mid = height * 0.62;
  for (let i = 0; i < pts.length; i++) {                                               // the prow's balcony rail
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, ml = Math.hypot(mx, my) || 1;
    k.quad(rail, [[a[0], a[1], mid], [b[0], b[1], mid], [b[0], b[1], mid + 1.1], [a[0], a[1], mid + 1.1]], mx / ml, my / ml);
  }
  return k;
}

// A castle hall for the Yangshupu Waterworks: a long red-brick range with a jutting mid risalit and four
// round turret towers with conical caps, after the manner of the 1880s buildings there. The real range's
// measures are not published; these follow the photographs.
export function castleHall(c, { length = 88, depth = 15, height = 17, turret = 7, turretHeight = 26 }) {
  const k = new Kit();
  const brick = k.part(c.brick, c.brick, 2), tile = k.part(c.tile, c.tile), cream = k.part(c.cream, c.cream, 2), metal = k.part(c.metal, c.metal);
  k.box(brick, 0, 0, 0, length, depth, height);                                        // the main range
  k.box(brick, 0, depth * 0.35, 0, length * 0.32, depth * 0.62, height + 3.5);         // the mid risalit
  k.box(cream, 0, depth * 0.35, height + 3.5, length * 0.3, depth * 0.55, 2.2);        // its cornice
  const at = [[-length / 2 + turret * 0.8, -depth / 2 + turret * 0.8], [length / 2 - turret * 0.8, -depth / 2 + turret * 0.8],
              [-length / 2 + turret * 0.8, depth / 2 - turret * 0.8], [length / 2 - turret * 0.8, depth / 2 - turret * 0.8]];
  for (const [tx, ty] of at) {
    k.prism(brick, tx, ty, 0, turretHeight, turret / 2, 8);
    k.ring(tile, tx, ty, 0, turretHeight + 6, turret / 2 + 1, turretHeight, 8);        // the conical cap
    k.prism(metal, tx, ty, turretHeight + 6, turretHeight + 7.5, 0.35, 6);             // the flag mast
  }
  return k;
}

// The Crown of the China Art Museum: four great columns and a stack of red plates flaring out as they
// rise — the dougong crown of the 2010 China Pavilion — over a low platform. The 63 m height and the
// flaring are the building's own; the plates' count and their thin gaps are by manner.
export function pavilionCrown(c, { height = 63, podium = 14, base = 96, top = 150, plates = 8, column = 16 }) {
  const k = new Kit();
  const red = k.part(c.red, c.red), deep = k.part(c.brick, c.brick, 2), grey = k.part(c.concrete, c.concrete);
  k.box(deep, 0, 0, 0, top + 26, top - 10, podium);                                    // the platform (the data has it too; the crown clears it)
  const z1 = height - 2.4, step = (z1 - podium) / plates;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) k.box(grey, sx * base * 0.34, sy * base * 0.34, podium - 4, column, column, podium + 6);
  for (let i = 0; i < plates; i++) {
    const w = base + (top - base) * (i / (plates - 1));
    k.box(red, 0, 0, podium + i * step, w, w, step * 0.72);
  }
  k.box(red, 0, 0, z1, top, top, 2.4);                                                 // the cap
  return k;
}

// The Exhibition Centre's tower: a cream shaft in three tiers drawing in as it rises, a gilded cone and
// the star on top. The 110 m to the star's tip is the record's own; the tiers' heights follow the
// photographs.
export function spireHall(c, { height = 110, tiers = [[42, 30], [72, 24], [92, 18]] }) {
  const k = new Kit();
  const cream = k.part(c.cream, c.cream, 2), gold = k.part(c.gold, c.gold);
  let z = 0;
  for (const [w, h] of tiers) { k.prism(cream, 0, 0, z, z + h, w / 2, 4); z += h; }
  k.ring(gold, 0, 0, 0, height, tiers[tiers.length - 1][1] / 2 + 1.5, z, 4);           // the gilded cone
  k.box(gold, 0, 0, height + 1.5, 2.4, 0.35, 2.4);                                     // the star, two crossed fins
  k.box(gold, 0, 0, height + 1.5, 0.35, 2.4, 2.4);
  return k;
}

// The Shanghai World Financial Centre: a shaft of grey glass drawing in as it rises, and at its head the
// trapezoid aperture that earned it the name of a bottle opener — two horns with the sky between them,
// each horn's top rising towards its own shoulder. The 492 m to the tip, the 58 m face and the crown
// beginning about 417 m up are the tower's own; the aperture's width and the slope of the horns' tops
// follow the photographs. Along the map's x axis the aperture shows as the gap it is; across it the two
// horns pass for one.
export function openerTower(c, { height = 492, width = 58, shaft = 417, top = 474, aperture = 22 }) {
  const k = new Kit();
  const glass = k.part(c.silver, c.silver, 5), dark = k.part(c.dark, c.silver, 5), metal = k.part(c.metal, c.metal);
  const halfTop = width * 0.36, tiers = 6;
  let z = 0;
  for (let i = 0; i < tiers; i++) {
    const w = width / 2 + (halfTop - width / 2) * (i + 1) / tiers;
    k.prism(glass, 0, 0, z, z + shaft / tiers, w, 4);
    z += shaft / tiers;
  }
  const d = width * 0.15, inner = top - 9, outer = top + 1;       // the horn's half depth; its sloping top
  for (const side of [-1, 1]) {
    const xi = side * aperture / 2, xo = side * halfTop;
    for (const face of [-1, 1]) {                                                       // the two long walls
      const y = face * d;
      k.quad(glass, [[xi, y, shaft], [xo, y, shaft], [xo, y, outer], [xi, y, inner]], 0, face);
    }
    k.quad(glass, [[xo, -d, shaft], [xo, d, shaft], [xo, d, outer], [xo, -d, outer]], side, 0);       // the shoulder
    k.quad(dark, [[xi, -d, shaft], [xi, d, shaft], [xi, d, inner], [xi, -d, inner]], -side, 0);       // into the aperture
    k.quad(metal, [[xi, -d, inner], [xi, d, inner], [xo, d, outer], [xo, -d, outer]], 0, 0);          // the slope up to it
  }
  k.prism(metal, 0, 0, top + 1, height, 1.6, 6);
  k.cap(metal, 0, 0, height, 1.6, 6);
  return k;
}

// Jin Mao: a pale stone shaft that steps in tier by tier, pagoda-fashion, and ends in a spire. The 421 m
// to the spire's tip is the tower's own; the count of the tiers and their heights follow the photographs.
export function tierTower(c, { height = 421, width = 41, podium = 24, spire = 58, tiers = 9 }) {
  const k = new Kit();
  const stone = k.part(c.cream, c.cream, 4), glass = k.part(c.silver, c.silver, 5), metal = k.part(c.metal, c.metal);
  k.box(stone, 0, 0, 0, width * 1.2, width * 1.2, podium * 0.4);
  k.box(glass, 0, 0, podium * 0.4, width * 1.05, width * 1.05, podium * 0.6);
  let z = podium, w = width;
  const rise = (height - spire - podium) / tiers;
  for (let i = 0; i < tiers; i++) {
    k.prism(i % 2 ? glass : stone, 0, 0, z, z + rise, w / 2, 4);
    z += rise;
    w *= 0.87;
  }
  k.prism(metal, 0, 0, z, height, 1.4, 6);
  k.cap(metal, 0, 0, height, 1.4, 6);
  return k;
}

// The Grand Theatre: a glass hall under one white shell that sweeps up from its front edge to a crest
// over the back, like a wave about to break. The 40 m the crest reaches and the glass footing are the
// building's own; the shell's curve follows the photographs.
export function archTheatre(c, { width = 110, depth = 68, height = 40, sill = 12, slices = 14 }) {
  const k = new Kit();
  const glass = k.part(c.glass, c.glass, 5), shell = k.part(c.white, c.white);
  k.box(glass, 0, 0, 0, width, depth, sill + 1);
  // the shell: a band of quads across the hall, its height an arc that starts at the front edge and
  // crests two thirds of the way back; at the back a wall closes it down to the glass
  const crest = 0.62;
  const at = t => sill + (height - sill) * Math.pow(Math.sin(Math.PI * Math.min(t / crest, 1) / 2), 0.9);
  for (let i = 0; i < slices; i++) {
    const y0 = (i / slices - 0.5) * depth, y1 = ((i + 1) / slices - 0.5) * depth;
    const h0 = at((i + 0.5) / slices), h1 = at((i + 1.5) / slices);
    k.quad(shell, [[-width / 2, y0, h0], [width / 2, y0, h0], [width / 2, y1, h1], [-width / 2, y1, h1]], 0, 0);
  }
  k.quad(shell, [[-width / 2, depth / 2, sill], [width / 2, depth / 2, sill], [width / 2, depth / 2, at(1)], [-width / 2, depth / 2, at(1)]], 0, 1);
  return k;
}

// The General Post Office: a long grey-stone range with a jutting middle and two green-bronze domes on
// its face corners, after the manner of the 1924 building. The range's measures are not published; these
// follow the photographs.
export function domedHall(c, { length = 96, depth = 24, height = 26, dome = 10 }) {
  const k = new Kit();
  const stone = k.part(c.grey, c.grey, 4), cream = k.part(c.cream, c.cream, 4), verd = k.part(c.verdigris, c.verdigris), steel = k.part(c.steel, c.steel);
  k.box(stone, 0, 0, 0, length, depth, height);
  k.box(cream, 0, 0, height, length * 0.96, depth * 0.94, 2.0);                    // the cornice
  k.box(stone, 0, depth * 0.3, 0, length * 0.3, depth * 0.6, height + 4);          // the middle, jutting
  for (const side of [-1, 1]) {
    const x = side * (length / 2 - dome), y = depth / 2 - dome * 0.7;
    k.prism(stone, x, y, 0, height + 3, dome * 0.7, 8);                            // the corner drum
    ball(k, verd, x, y, height + 5, dome * 0.62, 4, 12);                            // the dome, half of it sunk in the drum
    k.prism(steel, x, y, height + 5 + dome * 0.62, height + 7 + dome * 0.62, 0.3, 6);
  }
  return k;
}

// The Basilica of St Ignatius: a grey-stone hall with a steep gable, a transept, and two square towers
// whose pinnacles carry the 59 m the church is known by. The towers' height is the record's own; the
// nave's measures follow the photographs.
export function gothicChurch(c, { length = 66, width = 26, nave = 18, tower = 38, spire = 21, towerWidth = 9 }) {
  const k = new Kit();
  const stone = k.part(c.grey, c.grey, 4), slate = k.part(c.slate, c.slate), cross = k.part(c.dark, c.dark);
  k.box(stone, -length * 0.1, 0, 0, length * 0.8, width, nave);
  k.hipRoof(slate, -length * 0.1, 0, nave, length * 0.8, width, width * 0.3, false);
  k.box(stone, 0, 0, 0, width * 0.8, width * 1.6, nave * 0.85);                    // the transept
  k.hipRoof(slate, 0, 0, nave * 0.85, width * 0.8, width * 1.6, width * 0.22, true);
  for (const side of [-1, 1]) {
    const x = length * 0.35, y = side * (width / 2 - towerWidth / 2 - 0.5);
    k.prism(stone, x, y, 0, tower, towerWidth / 2, 4);
    k.ring(slate, x, y, 0.4, tower + spire, towerWidth / 2 + 0.8, tower, 4);       // the pinnacle
    k.box(cross, x, y, tower + spire, 0.4, 0.4, 1.6);
    k.box(cross, x, y, tower + spire + 1.0, 1.6, 0.35, 0.4);
  }
  return k;
}

// Hangzhou's International Conference Centre: a great gilded ball seated in a round podium, the "golden
// ball" of the Qianjiang new town. The 90 m it stands and the ball's bulk follow the photographs; no
// measures of it are published.
export function globeHall(c, { height = 90, globe = 52, podium = 30 }) {
  const k = new Kit();
  const stone = k.part(c.grey, c.grey, 4), gold = k.part(c.gold, c.gold), glass = k.part(c.glass, c.glass, 5);
  k.prism(stone, 0, 0, 0, 8, podium, 16);
  k.prism(glass, 0, 0, 8, 15, podium * 0.8, 16);
  ball(k, gold, 0, 0, 15 + globe * 0.42, globe / 2, 8, 20);
  k.prism(gold, 0, 0, 15 + globe * 0.42 + globe / 2, height, 2.0, 6);
  return k;
}

// Chengdu's Anshun bridge: a stone arch bridge carrying a wooden gallery the length of its deck, with a
// two-storey pavilion standing at its middle and a small perch at each bank. The 70 m and two arches
// follow the bridge as mapped; the gallery's measures are by manner of the Sichuan covered bridges.
export function corridorBridge(c, { length = 70, width = 10, rise = 3.2, gallery = 3.2 }) {
  const k = new Kit();
  const stone = k.part(c.stone, c.stone), deck = k.part(c.path, c.stone), wood = k.part(c.wood, c.wood), tiles = k.part(c.slate, c.slate),
        red = k.part(c.red, c.red), woodRoof = k.part(c.slate, c.slate), gold = k.part(c.gold, c.gold);
  const half = width / 2;
  const deckAt = t => rise * (1 - (2 * t - 1) * (2 * t - 1));
  const arch = (t, a, b) => { const mid = (a + b) / 2, halfW = (b - a) / 2, q = (t - mid) / halfW; return deckAt(mid) * 0.9 * Math.sqrt(Math.max(0, 1 - q * q)); };
  const under = t => Math.max(t > 0.18 && t < 0.46 ? arch(t, 0.18, 0.46) : 0, t > 0.54 && t < 0.82 ? arch(t, 0.54, 0.82) : 0);
  const segs = 32;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs, x0 = (t0 - 0.5) * length, x1 = (t1 - 0.5) * length;
    const d0 = deckAt(t0), d1 = deckAt(t1), u0 = under(t0), u1 = under(t1);
    k.quad(deck, [[x0, -half, d0], [x1, -half, d1], [x1, half, d1], [x0, half, d0]], 0, 0);
    for (const side of [-1, 1]) {
      const y = side * half;
      k.quad(stone, side < 0 ? [[x0, y, u0], [x1, y, u1], [x1, y, d1], [x0, y, d0]] : [[x0, y, d0], [x1, y, d1], [x1, y, u1], [x0, y, u0]], 0, side);
    }
  }
  // the gallery, from the first perch to the last: wooden walls and a slate gable roof following the arc
  const g0 = 0.05, g1 = 0.95, gSegs = 20;
  for (let i = 0; i < gSegs; i++) {
    const t0 = g0 + (g1 - g0) * i / gSegs, t1 = g0 + (g1 - g0) * (i + 1) / gSegs;
    const x0 = (t0 - 0.5) * length, x1 = (t1 - 0.5) * length;
    const b0 = deckAt(t0), b1 = deckAt(t1), r0 = b0 + gallery, r1 = b1 + gallery;
    const ridge0 = b0 + gallery + 1.6, ridge1 = b1 + gallery + 1.6;
    for (const side of [-1, 1]) {
      const y = side * (half - 0.6);
      k.quad(wood, [[x0, y, b0], [x1, y, b1], [x1, y, r1], [x0, y, r0]], 0, side);
      k.quad(woodRoof, [[x0, y, r0], [x1, y, r1], [x1, y - side * 1.2, ridge1], [x0, y - side * 1.2, ridge0]], side * 0.8, side * 0.4);
    }
    k.quad(woodRoof, [[x0, -half + 1.2, ridge0], [x1, -half + 1.2, ridge0], [x1, half - 1.2, ridge1], [x0, half - 1.2, ridge1]], 0, 0);
    for (const side of [-1, 1]) {                       // the gable at each segment's start: the triangle between eave and ridge
      const y = side * (half - 0.6), yi = side * (half - 1.2);
      k.tri(wood, [x0, y, r0], [x0, yi, ridge0], [x0, y, ridge0], side, 0);
    }
  }
  // the pavilion at the middle, two storeys of red columns under flying eaves, and a perch at each bank
  const mid = deckAt(0.5);
  k.prism(red, 0, 0, mid + gallery, mid + gallery + 3.6, 5.6, 4);
  k.ring(tiles, 0, 0, 4.4, mid + gallery + 3.6, 7.4, mid + gallery + 2.6, 4);
  k.prism(red, 0, 0, mid + gallery + 3.6 + 0.9, mid + gallery + 3.6 + 4.5, 4.4, 4);
  k.ring(tiles, 0, 0, 3.2, mid + gallery + 3.6 + 4.5 + 1.4, 6.6, mid + gallery + 3.6 + 4.5, 4);
  k.prism(gold, 0, 0, mid + gallery + 3.6 + 5.4, mid + gallery + 3.6 + 7.4, 0.5, 6);
  for (const t of [g0, g1]) {
    const x = (t - 0.5) * length, b = deckAt(t);
    k.prism(stone, x, 0, b + gallery, b + gallery + 2.2, half - 0.8, 4);
    k.ring(tiles, x, 0, half - 1.4, b + gallery + 2.2 + 1.2, half - 0.4, b + gallery + 2.2, 4);
  }
  return k;
}

// The New Century Global Centre: five hundred metres of hall under a roof that rolls like the sea it
// keeps indoors — six swells from a forty-metre eave to hundred-metre crests. The length, depth and the
// wave's reach are the building's own; the count of the swells follows the photographs.
export function waveHall(c, { length = 500, depth = 110, sill = 40, crest = 100, waves = 6, segments = 60 }) {
  const k = new Kit();
  const glass = k.part(c.glass, c.glass, 5), roof = k.part(c.silver, c.silver), metal = k.part(c.metal, c.metal);
  const amp = crest - sill;
  const at = t => sill + amp * 0.5 * (1 - Math.cos(2 * Math.PI * waves * t));
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments, t1 = (i + 1) / segments, x0 = (t0 - 0.5) * length, x1 = (t1 - 0.5) * length;
    const h0 = at(t0), h1 = at(t1);
    k.quad(roof, [[x0, -depth / 2, h0], [x1, -depth / 2, h1], [x1, depth / 2, h1], [x0, depth / 2, h0]], 0, 0);
    for (const side of [-1, 1]) {
      const y = side * depth / 2;
      k.quad(glass, [[x0, y, 0], [x1, y, 0], [x1, y, h1], [x0, y, h0]], 0, side);
    }
  }
  for (const end of [-1, 1]) {
    const x = end * length / 2, h = at(end < 0 ? 0 : 1);
    k.quad(glass, [[x, -depth / 2, 0], [x, depth / 2, 0], [x, depth / 2, h], [x, -depth / 2, h]], -end, 0);
    k.box(metal, x, 0, h - 4, 2, depth * 0.7, 2.5);
  }
  return k;
}

// 故宫: the compound of walls, gates and halls — nine hundred metres of red walls crowned in gold tiles,
// seas of white marble terraces, and roofs of gold. The walls' 961 m by 753 m and the halls' measures are
// the record's own (太和殿 is 64 m across, 37 m deep and 27 m tall on its own, standing on a three-tier
// terrace 8.13 m high); the pavilions' detail follows the photographs. `angle` turns the whole compound:
// the walls stand by the Ming surveyors, a degree or two off the map's north.
export function forbiddenCity(c, { length = 961, width = 753, angle = 0 }) {
  const k = new Kit();
  const red = k.part(c.red, c.red, 8), gold = k.part(c.gold, c.gold), white = k.part(c.stone, c.stone, 4),
        wood = k.part(c.wood, c.wood), cream = k.part(c.cream, c.cream, 8), slate = k.part(c.slate, c.slate);
  const HX = length / 2, HY = width / 2, wallH = 9, wallT = 4, tileT = 1.6;

  // a hall of red walls with a gold hipped roof; doubleEave adds the lower, wider eave at mid height
  const hall = (x, y, z, w, d, wallH2, rise, doubleEave = false) => {
    k.box(red, x, y, z, doubleEave ? w * 0.9 : w, doubleEave ? d * 0.9 : d, wallH2);
    if (doubleEave) {
      k.hipRoof(gold, x, y, z + wallH2, w, d * 0.94, rise * 0.55, true, Math.PI / 2);
      k.box(red, x, y, z + wallH2 + rise * 0.55, w * 0.72, d * 0.7, rise * 0.45);
      k.hipRoof(gold, x, y, z + wallH2 + rise, w * 0.8, d * 0.75, rise * 0.9, true, Math.PI / 2);
    } else {
      k.hipRoof(gold, x, y, z + wallH2, w, d * 0.94, rise, true, Math.PI / 2);
    }
  };
  // a corner tower: three stacked eaves over a stone base, the tower the walls turn to
  const cornerTower = (x, y) => {
    k.box(white, x, y, 0, 12, 12, 3.5);
    let z = 3.5, r = 7.5;
    for (let i = 0; i < 3; i++) {
      k.prism(red, x, y, z, z + 4.2, r * 0.62, 4);
      k.ring(gold, x, y, r * 0.66, z + 4.2, r, z + 4.2 - 1.4, 4);
      z += 4.2;
      r *= 0.78;
    }
    k.prism(gold, x, y, z, z + 5, 0.6, 6);
  };

  // the four walls, red with a strip of gold tiles on top, and a tower at each corner
  k.box(red, 0, -HY, 0, HX * 2 + wallT, wallT, wallH);
  k.box(red, 0, HY, 0, HX * 2 + wallT, wallT, wallH);
  k.box(red, -HX, 0, 0, wallT, HY * 2 + wallT, wallH);
  k.box(red, HX, 0, 0, wallT, HY * 2 + wallT, wallH);
  for (const y of [-HY, HY]) k.box(gold, 0, y, wallH, HX * 2 + wallT, wallT + 0.6, tileT);
  for (const x of [-HX, HX]) k.box(gold, x, 0, wallH, wallT + 0.6, HY * 2 + wallT, tileT);
  for (const [x, y] of [[-HX, -HY], [HX, -HY], [-HX, HY], [HX, HY]]) cornerTower(x, y);

  // 午门, the south gate: a great platform with two wings reaching north, five pavilions on top
  const gateY = -HY + wallT / 2, gateH = 24;
  k.box(red, -HX + gateH * 0.6, gateY, 0, gateH * 1.4, width * 0.17, gateH);            // the platform, straddling the wall
  k.box(red, -HX + gateH * 0.6 + 26, gateY - width * 0.062, 0, gateH * 0.7, width * 0.1, gateH * 0.42);   // the west wing
  k.box(red, -HX + gateH * 0.6 + 26, gateY + width * 0.062, 0, gateH * 0.7, width * 0.1, gateH * 0.42);   // the east wing
  k.prism(red, -HX + gateH * 0.6, gateY, gateH, gateH + 9, 14, 4);
  k.ring(gold, -HX + gateH * 0.6, gateY, 9.5, gateH + 9, 17.5, gateH + 6.5, 4);
  k.prism(gold, -HX + gateH * 0.6, gateY, gateH + 9, gateH + 12, 0.5, 6);
  for (const side of [-1, 1]) {                                                          // the four pavilions of the wings
    const x = -HX + gateH * 0.6 + 26, y = gateY + side * width * 0.088;
    k.prism(red, x, y, gateH * 0.42, gateH * 0.42 + 6, 5.5, 4);
    k.ring(gold, x, y, 4.4, gateH * 0.42 + 6, 7.6, gateH * 0.42 + 4.4, 4);
  }

  // 神武门, the north gate; 东华门 and 西华门, the side gates — lower platforms with a pavilion each
  k.box(red, HX - gateH * 0.6, gateY, 0, gateH * 1.1, width * 0.14, gateH * 0.8);
  k.prism(red, HX - gateH * 0.6, gateY, gateH * 0.8, gateH * 0.8 + 7, 10, 4);
  k.ring(gold, HX - gateH * 0.6, gateY, 7, gateH * 0.8 + 7, 13, gateH * 0.8 + 4.8, 4);
  for (const side of [-1, 1]) {
    const x = side * (HX - wallT / 2);
    k.box(red, x, 0, 0, gateH * 0.8, width * 0.1, gateH * 0.5);
    k.prism(red, x, 0, gateH * 0.5, gateH * 0.5 + 5.5, 7, 4);
    k.ring(gold, x, 0, 5, gateH * 0.5 + 5.5, 9.5, gateH * 0.5 + 3.6, 4);
  }

  // 太和门, the gate of the outer court, in front of the terraces
  hall(-HX + gateH * 2.6, 0, 0, 58, 18, 17, 6);

  // the three great halls on their mountains of white marble: three tiers, each a step narrower
  const terraceX = -HX + gateH * 2.6 + 160;
  k.box(white, terraceX, 0, 0, 230, 130, 2.7);
  k.box(white, terraceX, 0, 2.7, 208, 112, 2.7);
  k.box(white, terraceX, 0, 5.4, 186, 94, 2.7);
  const zTerrace = 8.1;
  hall(terraceX - 62, 0, zTerrace, 64, 37, 20, 9, true);          // 太和殿, the greatest hall
  k.prism(gold, terraceX - 62, 0, zTerrace + 20 + 14.4, zTerrace + 20 + 17.4, 0.5, 6);
  k.box(red, terraceX + 8, 0, zTerrace, 26, 26, 17);               // 中和殿, square, with a pyramidal cap
  k.ring(gold, terraceX + 8, 0, 0, zTerrace + 17 + 8, 16.5, zTerrace + 17, 4);
  k.prism(gold, terraceX + 8, 0, zTerrace + 17 + 8, zTerrace + 17 + 11, 0.5, 6);
  hall(terraceX + 68, 0, zTerrace, 52, 30, 17, 8, true);           // 保和殿

  // 乾清门, the gate into the inner court, low and wide
  hall(terraceX + 145, 0, 0, 42, 13, 12, 5);

  // the inner court: 乾清宫, 交泰殿 and 坤宁宫 in a row on one terrace
  k.box(white, terraceX + 235, 0, 0, 185, 80, 2.7);
  const zIn = 2.7;
  hall(terraceX + 190, 0, zIn, 48, 26, 17, 8, true);               // 乾清宫
  k.box(red, terraceX + 250, 0, zIn, 20, 20, 15);                   // 交泰殿
  k.ring(gold, terraceX + 250, 0, 0, zIn + 15 + 7, 13.5, zIn + 15, 4);
  k.prism(gold, terraceX + 250, 0, zIn + 15 + 7, zIn + 15 + 10, 0.4, 6);
  hall(terraceX + 305, 0, zIn, 36, 22, 14, 7);                      // 坤宁宫

  // the six courts of the east and west, two rows of three courtyard blocks each
  for (const side of [-1, 1]) {
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const x = terraceX + 120 + col * 72, y = side * (95 + row * 105);
        k.box(cream, x, y, 0, 44, 36, 7.5);
        k.hipRoof(slate, x, y, 7.5, 44, 36, 4, true);
      }
    }
  }

  // the whole compound stands by the Ming surveyors: turn it to the walls' own bearing
  if (angle) {
    const cA = Math.cos(angle), sA = Math.sin(angle);
    for (let i = 0; i < k.vertices.length; i += 6) {
      const x = k.vertices[i], y = k.vertices[i + 1];
      k.vertices[i] = x * cA - y * sA;
      k.vertices[i + 1] = x * sA + y * cA;
    }
  }
  return k;
}

// 祈年殿, the Hall of Prayer for Good Harvests: three drums of red under three eaves of blue glazed
// tiles sweeping out and down, a round hall thirty metres across and thirty-eight metres tall on two
// tiers of white marble. The measures are the record's own; the roofs' blue is the nearest tile in the
// palette to the glazed 靛蓝.
export function qiNianDian(c, { height = 38, diameter = 30 }) {
  const k = new Kit();
  const white = k.part(c.stone, c.stone, 4), red = k.part(c.red, c.red, 8), blue = k.part(c.verdigris, c.verdigris), gold = k.part(c.gold, c.gold);
  k.prism(white, 0, 0, 0, 2.6, diameter * 0.75, 24);
  k.prism(white, 0, 0, 2.6, 5.2, diameter * 0.6, 24);
  const tiers = 3, each = (height - 5.2 - 5) / tiers;
  let r = diameter / 2, z = 5.2;
  for (let i = 0; i < tiers; i++) {
    k.prism(red, 0, 0, z, z + each * 0.68, r * 0.5, 24);
    k.ring(blue, 0, 0, r * 0.54, z + each * 0.68, r, z + each * 0.3, 24);
    z += each * 0.68;
    r *= 0.74;
  }
  k.ring(gold, 0, 0, 0, z + 4.5, r * 0.52, z, 24);
  k.prism(gold, 0, 0, z + 4.5, z + 7.5, 0.4, 6);
  return k;
}

// 天安门, the gate tower of the Imperial City: a deep platform of stone carrying a red hall with two
// eaves of gold, over the passage the crowds walk through. The 66 m of the platform and its height are
// the record's own; the pavilion's measures follow the photographs.
export function gateTower(c, { width = 66, depth = 22, wallH = 13 }) {
  const k = new Kit();
  const white = k.part(c.stone, c.stone, 4), red = k.part(c.red, c.red, 8), gold = k.part(c.gold, c.gold);
  k.box(white, 0, 0, 0, width, depth, wallH);
  k.box(red, 0, 0, wallH, width * 0.82, depth * 0.82, 8);
  k.hipRoof(gold, 0, 0, wallH + 8, width * 0.92, depth * 0.95, 3.2, true);
  k.box(red, 0, 0, wallH + 8 + 3.2, width * 0.64, depth * 0.72, 4);
  k.hipRoof(gold, 0, 0, wallH + 8 + 3.2 + 4, width * 0.76, depth * 0.86, 4.5, true);
  return k;
}

// 国家大剧院, the National Centre for the Performing Arts: a titanium ellipsoid — a hundred and ten
// steps of it, each a little narrower than the last — sitting in its pool of water. The 212 m of
// length, 144 m of depth and 46 m of height are the record's own; the steps are the pixel map's way
// of a smooth shell.
export function eggHall(c, { width = 212, depth = 144, height = 46, steps = 14 }) {
  const k = new Kit();
  const glass = k.part(c.glass, c.glass, 5), metal = k.part(c.silver, c.silver);
  for (let i = 0; i < steps; i++) {
    const z = i * height / steps;
    const t = z / height;
    k.box(i % 2 ? glass : metal, 0, 0, z, width * Math.sqrt(1 - t * t), depth * Math.sqrt(1 - t * t), height / steps);
  }
  return k;
}
