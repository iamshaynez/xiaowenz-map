// What the streets draw on top of their own asphalt: centre-line paint, edge lines, crossing zebras,
// stop lines, straight-ahead arrows, and the tactile pads at crossing ends — worked out from the tile's
// baked PATH lines (the same centrelines the traffic moves along, app/src/life/traffic.js) and cached on
// the tile. No bake came in for this: a tile's markings follow from its lines, their widths and their
// classes alone, so both cities get them the moment the page runs.
//
// A stripe instance is 8 floats: x, y, z (relative to the tile's corner), heading x, heading y,
// half length, half width, colour. Paint sits a hand's width above the line's own height (where the
// road surface is), each kind a hair higher than the last so that two overlapping paints never fight
// over the depth buffer — and every one of them still takes its road's shadow. Lines break at junctions
// the way real paint does: it does not run through a crossing it cannot cross.

import { assemble } from './store.js';

// the corner of a unit quad, as a triangle list
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

// by class of street: how the centre is painted — a double yellow line on the great roads, dashes on
// the lesser — and which classes wear edge lines, stop lines and arrows
const CENTRE = {
  5: { double: true, edges: true, stops: true },
  6: { spacing: 12, length: 3.2, edges: true, stops: true },
};
const DASH_WIDTH = 0.35;
const PAINT_WIDTH = 0.12;                    // a solid line's own width
const EDGE_IN = 0.45;                        // how far the edge line sits in from the carriageway's edge
const BREAK_AT = 3.2;                        // paint breaks this far short of a crossing on each side
const ZEBRA_FROM = 2.4;        // metres from the junction's centre to where the zebra begins
const ZEBRA_LENGTH = 2.6;      // metres along the road
const ZEBRA_BAR = 0.45;        // metres across the road
const ZEBRA_GAP = 0.55;        // metres between bars, middle to middle
const STOP_AFTER = 0.7;        // metres past the zebra's far edge where the stop line lies
const STOP_WIDTH = 0.4;
const ARROW_AFTER = 9.0;       // metres further out, the straight-ahead arrow
const ARROW_STEM = 1.5, ARROW_HEAD = 0.55, ARROW_HALF = 0.11;
const TACTILE_AFTER = 0.9;     // metres past the zebra where the tactile pad begins, on the pavement side
const TACTILE_OUT = 2.2;       // how long a pad runs along the street
const TACTILE_LIFT = 1.2;      // how far the pad's centre stands out of the carriageway, on the pavement

// heights above the road, one hair apart: paint never fights paint for the depth buffer
const LIFT = { yellow: 0.12, edge: 0.13, dash: 0.14, zebra: 0.15, stop: 0.16, arrow: 0.17, tactile: 0.18 };

const fract = v => v - Math.floor(v);
const hash = (a, b) => fract(Math.sin(a * 127.1 + b * 311.7 + 53.7) * 43758.5453);

// the point of a line at a distance from its start, and the line's direction there (traffic.js keeps its own)
function along(points, s, out) {
  const n = points.length / 4;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4, b = a + 4;
    const from = points[a + 3], to = points[b + 3];
    if (s <= to || i === n - 2) {
      const t = to > from ? Math.min(1, Math.max(0, (s - from) / (to - from))) : 0;
      const dx = points[b] - points[a], dy = points[b + 1] - points[a + 1];
      const length = Math.hypot(dx, dy);
      out.x = points[a] + dx * t;
      out.y = points[a + 1] + dy * t;
      out.z = points[a + 2] + (points[b + 2] - points[a + 2]) * t;
      out.tx = length > 1e-6 ? dx / length : 1;
      out.ty = length > 1e-6 ? dy / length : 0;
      return;
    }
  }
}

// where a distance s along the line sits (tile-relative metres) — for projecting a point onto the line
function project(line, x, y) {
  const p = line.points;
  let best = Infinity, at = 0, px = p[0], py = p[1], pz = p[2], tx = 1, ty = 0;
  for (let i = 0; i < p.length / 4 - 1; i++) {
    const a = i * 4, b = a + 4;
    const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1];
    const dx = bx - ax, dy = by - ay;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    const qx = ax + dx * t, qy = ay + dy * t;
    const d = (x - qx) * (x - qx) + (y - qy) * (y - qy);
    if (d < best) {
      best = d;
      at = p[a + 3] + (p[b + 3] - p[a + 3]) * t;
      px = qx; py = qy; pz = p[a + 2] + (p[b + 2] - p[a + 2]) * t;
      const length = Math.hypot(dx, dy);
      tx = length > 1e-6 ? dx / length : 1;
      ty = length > 1e-6 ? dy / length : 0;
    }
  }
  return { s: at, x: px, y: py, z: pz, tx, ty };
}

// -> 0 or 1: whether two segments cross, and where, in `hit`
function crossing(a, b, c, d, hit) {
  const x1 = a[0], y1 = a[1], x2 = b[0], y2 = b[1], x3 = c[0], y3 = c[1], x4 = d[0], y4 = d[1];
  const dx1 = x2 - x1, dy1 = y2 - y1, dx2 = x4 - x3, dy2 = y4 - y3;
  const den = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((x3 - x1) * dy2 - (y3 - y1) * dx2) / den;
  const u = ((x3 - x1) * dy1 - (y3 - y1) * dx1) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return false;
  hit[0] = x1 + dx1 * t;
  hit[1] = y1 + dy1 * t;
  return true;
}

// one painted quad: its middle at distance s along the line, offset `lateral` to the line's left, a bar
// of half length (along the road) and half width (across it), running the road's own way
function paint(line, s, lateral, half, wide, mark, lift, out) {
  const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
  along(line.points, Math.max(0.2, Math.min(line.length - 0.2, s)), p);
  out.push(p.x - p.ty * lateral, p.y + p.tx * lateral, p.z + lift, p.tx, p.ty, half, wide, mark);
}

// a solid line between two distances of the line, one quad per polyline segment (the corners bend with
// the road), held in from the kerbs by `lateral`
function solid(line, s0, s1, lateral, half, mark, lift, out) {
  const pts = line.points, n = pts.length / 4;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4, b = a + 4;
    const from = pts[a + 3], to = pts[b + 3];
    const lo = Math.max(from, s0), hi = Math.min(to, s1);
    if (hi - lo < 0.05) continue;
    const dx = pts[b] - pts[a], dy = pts[b + 1] - pts[a + 1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const k0 = (lo - from) / (to - from || 1), k1 = (hi - from) / (to - from || 1);
    const x0 = pts[a] + dx * k0, y0 = pts[a + 1] + dy * k0, z0 = pts[a + 2] + (pts[b + 2] - pts[a + 2]) * k0;
    const x1 = pts[a] + dx * k1, y1 = pts[a + 1] + dy * k1, z1 = pts[a + 2] + (pts[b + 2] - pts[a + 2]) * k1;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
    out.push(cx - uy * lateral, cy + ux * lateral, cz + lift, ux, uy, Math.hypot(x1 - x0, y1 - y0) / 2, half, mark);
  }
}

// a dashed centre line down one street, between `from` and `to`. Instances are tile-relative: the draw
// adds the tile's corner
function dashes(line, tile, mark, clearances, out, from, to) {
  const rule = CENTRE[line.cls];
  const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
  const phase = hash(tile.x0 + line.cx, tile.y0 + line.cy) * rule.spacing;
  const first = Math.max(0, Math.floor((from - rule.length / 2 - phase) / rule.spacing));
  const last = Math.min(Math.floor((to - phase - rule.length / 2) / rule.spacing),
    Math.floor((line.length - rule.length / 2 - 0.2 - phase) / rule.spacing));
  for (let k = Math.max(0, first); k <= last; k++) {
    const s = phase + k * rule.spacing + rule.length / 2;
    if (s < from + 0.4 || s > to - 0.4) continue;
    along(line.points, s, p);
    const x = tile.x0 + p.x, y = tile.y0 + p.y;
    if (clearances.some(([cx, cy, r]) => (x - cx) * (x - cx) + (y - cy) * (y - cy) < r * r)) continue;
    out.push(p.x, p.y, p.z + LIFT.dash, p.tx, p.ty, rule.length / 2, DASH_WIDTH / 2, mark);
  }
}

// a zebra across one street, just outside the junction with the other
function zebra(line, s, tile, mark, clearances, out) {
  const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
  const bars = Math.max(3, Math.min(7, Math.floor((line.width * 2 - 1.4) / ZEBRA_GAP)));
  for (let k = 0; k < bars; k++) {
    const across = -line.width + 0.7 + ZEBRA_GAP * (k + 0.5) * ((line.width * 2 - 1.4) / (bars * ZEBRA_GAP));
    along(line.points, Math.max(1, Math.min(line.length - 1, s)), p);
    const x = tile.x0 + p.x - p.ty * across, y = tile.y0 + p.y + p.tx * across;
    if (clearances.some(([cx, cy, r]) => (x - cx) * (x - cx) + (y - cy) * (y - cy) < r * r)) continue;
    out.push(p.x - p.ty * across, p.y + p.tx * across, p.z + LIFT.zebra, p.tx, p.ty, ZEBRA_LENGTH / 2, ZEBRA_BAR / 2, mark);
  }
}

// every crossing of two streets of the tile, worked out once and shared by every kind of paint that
// lives at a crossing. -> [{ a, b, sa, sb, x, y }]: the two lines and, along each, where they meet.
// Same-street parallels never meet; far-apart boxes never touch.
export function crossings(streets) {
  const hit = [0, 0], found = [];
  const seen = new Set();
  for (let i = 0; i < streets.length; i++) {
    const a = streets[i];
    for (let j = i + 1; j < streets.length; j++) {
      const b = streets[j];
      const gap = Math.hypot(a.cx - b.cx, a.cy - b.cy);
      if (gap > a.reach + b.reach || gap < Math.min(a.width, b.width) * 1.5) continue;
      const pa = a.points, pb = b.points;
      for (let m = 0; m < pa.length / 4 - 1; m++) {
        const s1 = [pa[m * 4], pa[m * 4 + 1]], e1 = [pa[m * 4 + 4], pa[m * 4 + 5]];
        for (let o = 0; o < pb.length / 4 - 1; o++) {
          if (!crossing(s1, e1, [pb[o * 4], pb[o * 4 + 1]], [pb[o * 4 + 4], pb[o * 4 + 5]], hit)) continue;
          const key = `${Math.round(hit[0] / 8)},${Math.round(hit[1] / 8)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const onA = project(a, hit[0], hit[1]), onB = project(b, hit[0], hit[1]);
          found.push({ a, b, sa: onA.s, sb: onB.s, x: hit[0], y: hit[1] });
        }
      }
    }
  }
  return found;
}

// where the paint of one line breaks for its crossings: for each junction the line takes part in, a
// span of the line around the meeting point is left bare (the crossing mouth)
function gapsFor(line, junctions) {
  const gaps = [];
  for (const junction of junctions) {
    if (junction.a !== line && junction.b !== line) continue;
    const s = junction.a === line ? junction.sa : junction.sb;
    const other = junction.a === line ? junction.b : junction.a;
    const half = Math.min(other.width + BREAK_AT, 14);
    gaps.push([Math.max(0, s - half), Math.min(line.length, s + half)]);
  }
  return gaps;
}

// the runs of a line its paint may cover: the whole way less the gaps its crossings ask for
function runs(line, junctions) {
  const gaps = gapsFor(line, junctions).sort((p, q) => p[0] - q[0]);
  const out = [];
  let at = 0;
  for (const [g0, g1] of gaps) {
    if (g0 > at) out.push([at, Math.min(g0, line.length)]);
    at = Math.max(at, g1);
  }
  if (at < line.length) out.push([at, line.length]);
  return out;
}

// one junction's paint on every arm of it: the zebra, the stop line behind it, the straight-ahead
// arrow further out, and the tactile pad that waits on the pavement beside it
function junctionPaint(junction, tile, marks, clearances, out) {
  const { a, b, sa, sb } = junction;
  if (clearances.some(([cx, cy, r]) => (tile.x0 + junction.x - cx) * (tile.x0 + junction.x - cx) + (tile.y0 + junction.y - cy) * (tile.y0 + junction.y - cy) < r * r)) return;
  for (const [line, s, other] of [[a, sa, b], [b, sb, a]]) {
    const rule = CENTRE[line.cls];
    for (const dir of [1, -1]) {
      const near = s + dir * (other.width + ZEBRA_FROM);           // the zebra's near edge
      if (near < 1 || near > line.length - 1) continue;
      zebra(line, near, tile, marks.white, clearances, out);
      const far = near + dir * ZEBRA_LENGTH;
      if (rule?.stops) {
        // the stop line across the way, just past the zebra's far edge
        paint(line, far + dir * STOP_AFTER, 0, STOP_WIDTH / 2, line.width - EDGE_IN, marks.white, LIFT.stop, out);
        // the straight-ahead arrow on the way out, stem and two wings
        const stem = far + dir * ARROW_AFTER;
        if (stem > 2 && stem < line.length - 2) {
          paint(line, stem - dir * ARROW_STEM / 2, 0, ARROW_STEM / 2, ARROW_HALF, marks.white, LIFT.arrow, out);
          const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
          along(line.points, stem, p);
          for (const wing of [-1, 1]) {
            const ang = Math.atan2(p.ty * dir, p.tx * dir) + wing * 0.62;
            const hx = Math.cos(ang), hy = Math.sin(ang);
            out.push(p.x + hx * ARROW_HEAD * 0.8, p.y + hy * ARROW_HEAD * 0.8, p.z + LIFT.arrow, hx, hy, ARROW_HEAD, ARROW_HALF, marks.white);
          }
        }
      }
      // the tactile pads on both pavements: a strip each side of the crossing mouth
      if (marks.tactile) {
        const s0 = far + dir * TACTILE_AFTER, s1 = s0 + dir * TACTILE_OUT;
        solid(line, Math.min(s0, s1), Math.max(s0, s1), line.width + TACTILE_LIFT, 0.15, marks.tactile, LIFT.tactile, out);
        solid(line, Math.min(s0, s1), Math.max(s0, s1), -(line.width + TACTILE_LIFT), 0.15, marks.tactile, LIFT.tactile, out);
      }
    }
  }
}

// every kind of paint one tile wears: centre lines and edge lines between its crossings, and whatever
// stands at the crossings themselves
export function buildStripes(gl, tile, clearances, marks) {
  const out = [];
  const streets = (tile.paths || []).filter(line => CENTRE[line.cls]);
  const junctions = crossings(streets);
  for (const line of streets) {
    const rule = CENTRE[line.cls];
    for (const [from, to] of runs(line, junctions)) {
      if (rule.spacing) dashes(line, tile, marks.white, clearances, out, from, to);
      else if (rule.double) {
        // 双黄实线：主路中央两条并行的黄线，随线转弯
        solid(line, from, to, -0.13, PAINT_WIDTH / 2, marks.yellow, LIFT.yellow, out);
        solid(line, from, to, 0.13, PAINT_WIDTH / 2, marks.yellow, LIFT.yellow, out);
      }
      if (rule.edges) {
        // 白色的边线：沿路缘一条实线
        solid(line, from, to, -(line.width - EDGE_IN), PAINT_WIDTH / 2, marks.white, LIFT.edge, out);
        solid(line, from, to, line.width - EDGE_IN, PAINT_WIDTH / 2, marks.white, LIFT.edge, out);
      }
    }
  }
  for (const junction of junctions) junctionPaint(junction, tile, marks, clearances, out);
  const count = out.length / 8;
  const mesh = count ? assemble(gl, [
    { data: QUAD, layout: [[0, 2]] },
    { data: new Float32Array(out), stride: 32, layout: [[1, 4, gl.FLOAT, 0], [2, 4, gl.FLOAT, 16]], divisor: 1 },
  ]) : null;
  return { mesh, count };
}
