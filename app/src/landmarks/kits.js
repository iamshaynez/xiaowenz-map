// How a landmark is built: a few kinds of solid put together with the hands, in metres, on the spot where
// the map says it stands. Nothing is drawn here; the parts come out in the form of the buildings of a tile
// (vertices x, y, z, normal x, normal y, part; and nine properties per part), so a landmark is drawn by the
// buildings' shader like any house: the same light, outlines and shadows, its walls with the same storeys
// and windows at street level.
//
// A "part" is one material: a wall colour and a roof colour from the palette, and an archetype that says
// how its walls look close up (8 is the temple: red columns and lattice windows).

const cos = Math.cos, sin = Math.sin;

export class Kit {
  constructor() {
    this.vertices = [];
    this.parts = [];
  }

  // a new material; -> its number, to be given to every solid made of it
  part(wall, roof, archetype = 0, flags = 0) {
    this.parts.push({ wall, roof, archetype, flags, low: Infinity, high: -Infinity });
    return this.parts.length - 1;
  }

  // a flat face: four corners in order around it, and its normal's level part (a wall: a unit vector; flat: 0)
  quad(part, corners, nx, ny) {
    const [a, b, c, d] = corners;
    for (const p of [a, b, c, a, c, d]) this.vertices.push(p[0], p[1], p[2], nx, ny, part);
    const info = this.parts[part];
    for (const p of corners) {
      info.low = Math.min(info.low, p[2]);
      info.high = Math.max(info.high, p[2]);
    }
  }

  // a triangle
  tri(part, a, b, c, nx, ny) {
    for (const p of [a, b, c]) this.vertices.push(p[0], p[1], p[2], nx, ny, part);
    const info = this.parts[part];
    for (const p of [a, b, c]) {
      info.low = Math.min(info.low, p[2]);
      info.high = Math.max(info.high, p[2]);
    }
  }

  // an upright box; w and d along two axes turned by `angle` from the map's. Walls and top; no bottom.
  box(part, cx, cy, z0, w, d, h, angle = 0) {
    const ux = cos(angle) * w / 2, uy = sin(angle) * w / 2, vx = -sin(angle) * d / 2, vy = cos(angle) * d / 2;
    const p = [[cx - ux - vx, cy - uy - vy], [cx + ux - vx, cy + uy - vy], [cx + ux + vx, cy + uy + vy], [cx - ux + vx, cy - uy + vy]];
    const wall = (a, b, nx, ny) => this.quad(part, [[p[a][0], p[a][1], z0], [p[b][0], p[b][1], z0], [p[b][0], p[b][1], z0 + h], [p[a][0], p[a][1], z0 + h]], nx, ny);
    wall(0, 1, sin(angle), -cos(angle));
    wall(1, 2, cos(angle), sin(angle));
    wall(2, 3, -sin(angle), cos(angle));
    wall(3, 0, -cos(angle), -sin(angle));
    this.quad(part, [[p[0][0], p[0][1], z0 + h], [p[1][0], p[1][1], z0 + h], [p[2][0], p[2][1], z0 + h], [p[3][0], p[3][1], z0 + h]], 0, 0);
  }

  // a point on a regular polygon of `radius` around (cx, cy): corner number k of `sides`
  static corner(cx, cy, radius, sides, k, phase = 0) {
    const a = phase + 2 * Math.PI * k / sides;
    return [cx + radius * cos(a), cy + radius * sin(a)];
  }

  // the upright walls of a regular polygon
  prism(part, cx, cy, z0, z1, radius, sides, phase = 0) {
    for (let k = 0; k < sides; k++) {
      const a = Kit.corner(cx, cy, radius, sides, k, phase), b = Kit.corner(cx, cy, radius, sides, k + 1, phase);
      const mx = (a[0] + b[0]) / 2 - cx, my = (a[1] + b[1]) / 2 - cy, length = Math.hypot(mx, my);
      this.quad(part, [[a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]], mx / length, my / length);
    }
  }

  // a flat regular polygon
  cap(part, cx, cy, z, radius, sides, phase = 0) {
    for (let k = 0; k < sides; k++) {
      const a = Kit.corner(cx, cy, radius, sides, k, phase), b = Kit.corner(cx, cy, radius, sides, k + 1, phase);
      this.tri(part, [cx, cy, z], [a[0], a[1], z], [b[0], b[1], z], 0, 0);
    }
  }

  // a ring between two regular polygons of the same kind, as a roof slope: from the eave (radius `rOut`,
  // height `zOut`) up to the wall (radius `rIn`, height `zIn`). An eave has its outer edge lower; a conical
  // roof is the same with rIn = 0.
  ring(part, cx, cy, rIn, zIn, rOut, zOut, sides, phase = 0) {
    const run = rOut - rIn, rise = zIn - zOut, slope = Math.hypot(run, rise);
    for (let k = 0; k < sides; k++) {
      const o0 = Kit.corner(cx, cy, rOut, sides, k, phase), o1 = Kit.corner(cx, cy, rOut, sides, k + 1, phase);
      const i0 = rIn ? Kit.corner(cx, cy, rIn, sides, k, phase) : [cx, cy], i1 = rIn ? Kit.corner(cx, cy, rIn, sides, k + 1, phase) : [cx, cy];
      const mx = (o0[0] + o1[0]) / 2 - cx, my = (o0[1] + o1[1]) / 2 - cy, length = Math.hypot(mx, my) || 1;
      const corners = rIn
        ? [[o0[0], o0[1], zOut], [o1[0], o1[1], zOut], [i1[0], i1[1], zIn], [i0[0], i0[1], zIn]]
        : [[o0[0], o0[1], zOut], [o1[0], o1[1], zOut], [cx, cy, zIn]];
      if (rIn) this.quad(part, corners, mx / length * run / slope, my / length * run / slope);
      else this.tri(part, ...corners, mx / length * run / slope, my / length * run / slope);
    }
  }

  // a roof of two slopes over a rectangle (a hip roof: `hip` true, its ends slope too; else gable ends)
  hipRoof(part, cx, cy, z0, w, d, rise, hip = true, angle = 0) {
    const a = w / 2, b = d / 2;
    const turn = ([x, y]) => [cx + x * cos(angle) - y * sin(angle), cy + x * sin(angle) + y * cos(angle)];
    const p0 = turn([-a, -b]), p1 = turn([a, -b]), p2 = turn([a, b]), p3 = turn([-a, b]);
    const ridge = hip ? Math.max(a - b, 0) : a;
    const r1 = turn([-ridge, 0]), r2 = turn([ridge, 0]);
    const slope = Math.hypot(b, rise);
    const nb = [sin(angle) * rise / slope, -cos(angle) * rise / slope], nu = [cos(angle) * rise / slope, sin(angle) * rise / slope];
    const top = z0 + rise;
    this.quad(part, [[...p0, z0], [...p1, z0], [...r2, top], [...r1, top]], nb[0], nb[1]);       // the slope on the -y side looks towards -y
    this.quad(part, [[...p3, z0], [...p2, z0], [...r2, top], [...r1, top]], -nb[0], -nb[1]);
    if (hip) {
      this.tri(part, [...p1, z0], [...p2, z0], [...r2, top], nu[0], nu[1]);
      this.tri(part, [...p3, z0], [...p0, z0], [...r1, top], -nu[0], -nu[1]);
    } else {
      this.tri(part, [...p1, z0], [...p2, z0], [...r2, top], nu[0], nu[1]);
      this.tri(part, [...p3, z0], [...p0, z0], [...r1, top], -nu[0], -nu[1]);
    }
  }

  // -> { vertices, indices, props } in the form of a tile's buildings, with heights filled in per part
  finish() {
    const vertices = new Float32Array(this.vertices);
    const indices = new Uint32Array(this.vertices.length / 6);
    for (let k = 0; k < indices.length; k++) indices[k] = k;
    const props = new Float32Array(this.parts.length * 9);
    this.parts.forEach((p, k) => {
      props.set([p.low, Math.max(p.high - p.low, 0.1), Math.max(1, Math.round((p.high - p.low) / 3)), p.archetype, 0, p.wall, p.roof, k * 37 % 255, p.flags], k * 9);
    });
    return { vertices, indices, props, count: this.parts.length };
  }
}
