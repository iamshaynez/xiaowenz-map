// What the streets draw on top of their own asphalt: centre-line dashes and crossing zebras, worked out
// from the tile's baked PATH lines (the same centrelines the traffic moves along, app/src/life/traffic.js)
// and cached on the tile. No bake came in for this: a tile's markings follow from its lines, their widths
// and their classes alone, so both cities get them the moment the page runs.
//
// A stripe instance is 8 floats: x, y, z (relative to the tile's corner), heading x, heading y,
// half length, half width, colour. The z stands a hand's width above the line's own height, which is
// where the road surface is, so the quad wins the depth test against the road and still takes its shadow.

import { assemble } from './store.js';

// the corner of a unit quad, as a triangle list
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

// by class of street: metres between the centres of the centre-line's dashes, and how long a dash is
const DASHES = { 5: { spacing: 9, length: 3.2 }, 6: { spacing: 12, length: 3.2 } };
const DASH_WIDTH = 0.35;
const ZEBRA_FROM = 2.4;        // metres from the junction's centre to where the zebra begins
const ZEBRA_LENGTH = 2.6;      // metres along the road
const ZEBRA_BAR = 0.45;        // metres across the road
const ZEBRA_GAP = 0.55;        // metres between bars, middle to middle

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

// a dashed centre line down one street. Instances are tile-relative: the draw adds the tile's corner
function dashes(line, tile, mark, clearances, out) {
  const rule = DASHES[line.cls];
  const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
  const phase = hash(tile.x0 + line.cx, tile.y0 + line.cy) * rule.spacing;
  const n = Math.max(0, Math.floor((line.length - rule.length) / rule.spacing));
  for (let k = 0; k <= n; k++) {
    const s = Math.min(line.length - rule.length / 2 - 0.2, phase + k * rule.spacing + rule.length / 2);
    along(line.points, s, p);
    const x = tile.x0 + p.x, y = tile.y0 + p.y;
    if (clearances.some(([cx, cy, r]) => (x - cx) * (x - cx) + (y - cy) * (y - cy) < r * r)) continue;
    out.push(p.x, p.y, p.z + 0.14, p.tx, p.ty, rule.length / 2, DASH_WIDTH / 2, mark);
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
    out.push(p.x - p.ty * across, p.y + p.tx * across, p.z + 0.14, p.tx, p.ty, ZEBRA_LENGTH / 2, ZEBRA_BAR / 2, mark);
  }
}

// every crossing of two streets of the tile: a zebra on each of the four arms
function zebras(streets, tile, mark, clearances, out, seen) {
  const hit = [0, 0];
  for (let i = 0; i < streets.length; i++) {
    const a = streets[i];
    for (let j = i + 1; j < streets.length; j++) {
      const b = streets[j];
      // two lines of the same road run in parallel and never meet; the boxes of far-apart lines never touch
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
          zebra(a, onA.s - b.width - ZEBRA_FROM, tile, mark, clearances, out);
          zebra(a, onA.s + b.width + ZEBRA_FROM, tile, mark, clearances, out);
          zebra(b, onB.s - a.width - ZEBRA_FROM, tile, mark, clearances, out);
          zebra(b, onB.s + a.width + ZEBRA_FROM, tile, mark, clearances, out);
        }
      }
    }
  }
}

// -> { mesh, count }: the tile's markings as an instanced quad mesh, remembered on the tile itself
export function buildStripes(gl, tile, clearances, mark) {
  const out = [];
  const streets = (tile.paths || []).filter(line => DASHES[line.cls]);
  for (const line of streets) dashes(line, tile, mark, clearances, out);
  const seen = new Set();
  zebras(streets, tile, mark, clearances, out, seen);
  const count = out.length / 8;
  const mesh = count ? assemble(gl, [
    { data: QUAD, layout: [[0, 2]] },
    { data: new Float32Array(out), stride: 32, layout: [[1, 4, gl.FLOAT, 0], [2, 4, gl.FLOAT, 16]], divisor: 1 },
  ]) : null;
  return { mesh, count };
}
