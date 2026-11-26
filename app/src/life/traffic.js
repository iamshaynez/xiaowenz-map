// What moves: cars and buses in the streets, boats on the canals, the river and the lake, people on the
// pavements. Nothing here is drawn; this works out, for one moment, where everything visible is, and the
// renderer draws each thing as a box (shaders-life.js).
//
// Everything moves along the lines the bake stored (the PATH section of a tile: centrelines of streets,
// waterways, and routes across West Lake). Where a thing is at a moment follows from its line, its number
// and the time alone: nothing is remembered from one frame to the next, so the traffic needs no state,
// looks the same every time the clock reads the same, and never has to be handed over between tiles.
//
// How much of it there is, and how fast it goes, is invented: the lines are real, the traffic on them is
// a guess at a busy afternoon.

// classes of lines, as the bake wrote them: the street classes of the ground, and three for boats
export const CANAL = 200, RIVER = 201, LAKE = 202;
const MAJOR = 5, SECONDARY = 6, MINOR = 7, SERVICE = 8, PEDESTRIAN = 9, PATH = 10;

export const KIND = { CAR: 0, VAN: 1, BUS: 2, CANAL_BOAT: 3, RIVER_BOAT: 4, LAKE_BOAT: 5, ROW_BOAT: 6, LEGS: 7, BODY: 8, HEAD: 9, LASER: 10, GLOW: 11, LAMP_HEAD: 12 };
// by kind: length along the line, width across it, height: metres
const SIZE = [
  [4.4, 1.8, 1.5],      // car
  [6.2, 2.2, 2.6],      // van or small truck
  [11.5, 2.5, 3.2],     // bus
  [42, 7.5, 2.8],       // a cargo boat of the canals
  [62, 12, 4.5],        // a cargo boat of the river
  [20, 5.5, 2.4],       // a tour boat of West Lake
  [5, 1.8, 0.7],        // a rowing boat
  [0.3, 0.42, 0.55],    // a person's legs: dark, under the body
  [0.32, 0.52, 0.75],    // the body, wide across the way of walking
  [0.36, 0.38, 0.34],   // the head on it: at least two pixels across once people are drawn at all
];
// by class of line: metres between vehicles in each direction, their speed, and what they are
const STREETS = {
  [MAJOR]: { spacing: 50, speed: 11, mix: [[KIND.CAR, 0.86], [KIND.VAN, 0.08], [KIND.BUS, 0.06]] },
  [SECONDARY]: { spacing: 75, speed: 9.5, mix: [[KIND.CAR, 0.9], [KIND.VAN, 0.05], [KIND.BUS, 0.05]] },
  [MINOR]: { spacing: 120, speed: 8, mix: [[KIND.CAR, 0.92], [KIND.VAN, 0.08]] },
  [SERVICE]: { spacing: 240, speed: 7, mix: [[KIND.CAR, 1]] },
};
const WATERS = {
  [CANAL]: { spacing: 650, speed: 3.2, mix: [[KIND.CANAL_BOAT, 1]] },
  [RIVER]: { spacing: 1500, speed: 4, mix: [[KIND.RIVER_BOAT, 1]] },
  [LAKE]: { spacing: 110, speed: 2.2, mix: [[KIND.LAKE_BOAT, 0.3], [KIND.ROW_BOAT, 0.7]] },
};
// metres between people, by class of line
const PEOPLE = { [MAJOR]: 26, [SECONDARY]: 30, [MINOR]: 38, [SERVICE]: 60, [PEDESTRIAN]: 14, [PATH]: 20 };
const WALK = 1.3;                       // metres a second

// colours are palette indices, given by the renderer (colour names are its business)
export const TRAFFIC_COLOURS = ['car_white', 'car_silver', 'car_dark', 'car_red', 'car_blue', 'taxi_yellow', 'bus_green', 'hull_dark',
  'cabin_white', 'lake_boat_teal', 'skin', 'cloth_a', 'cloth_b', 'cloth_c', 'cloth_d', 'window_lit'];
const [WHITE, SILVER, DARK, RED, BLUE, TAXI, BUS, HULL, CABIN, TEAL, SKIN, CLOTH_A, CLOTH_B, CLOTH_C, CLOTH_D, WINDOW_LIT] = TRAFFIC_COLOURS.map((_, k) => k);
const CAR_COLOURS = [WHITE, WHITE, WHITE, SILVER, SILVER, DARK, DARK, RED, BLUE, TAXI];
const CLOTHES = [CLOTH_A, CLOTH_B, CLOTH_C, CLOTH_D, DARK, WHITE];

const RECORD = 12;                      // floats per box: x, y, z, heading x, heading y, half length, half width, height, wall, top, kind, spare

const fract = v => v - Math.floor(v);
const hash = (a, b) => fract(Math.sin(a * 127.1 + b * 311.7 + 53.7) * 43758.5453);

// the point of a line at a distance from its start, and the line's direction there. points: x, y, z, distance
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

export class Traffic {
  constructor() {
    this.boxes = new Float32Array(RECORD * 4096);   // vehicles, in the order they are met
    this.folks = new Float32Array(RECORD * 4096);   // people, each a body and a head
    this.count = 0;
    this.people = 0;
    this.spot = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
    this.drawn = { cars: 0, boats: 0, people: 0 };
    this.lampHeads = new Float32Array(64 * 3);      // where the lamps near the camera stand, for the pools of light
    this.lampCount = 0;
  }

  static grow(buffer, n) {
    let size = buffer.length;
    while (size < n * RECORD) size *= 2;
    if (size === buffer.length) return buffer;
    const bigger = new Float32Array(size);
    bigger.set(buffer);
    return bigger;
  }

  // one vehicle, as the renderer's shader reads it; `spare` carries the pitch (radians) of a beam
  // tilted out of the horizontal, which the life shader rotates its box by (walk.js's laser)
  box(x, y, z, tx, ty, length, width, height, wall, top, kind, spare = 0) {
    this.boxes = Traffic.grow(this.boxes, this.count + 1);
    const at = this.count * RECORD, b = this.boxes;
    b[at] = x; b[at + 1] = y; b[at + 2] = z; b[at + 3] = tx; b[at + 4] = ty;
    b[at + 5] = length / 2; b[at + 6] = width / 2; b[at + 7] = height; b[at + 8] = wall; b[at + 9] = top; b[at + 10] = kind;
    b[at + 11] = spare;
    this.count++;
  }

  // one person, in the buffer of people
  figure(x, y, z, tx, ty, length, width, height, wall, top, kind, spare = 0) {
    this.folks = Traffic.grow(this.folks, this.people + 1);
    const at = this.people * RECORD, b = this.folks;
    b[at] = x; b[at + 1] = y; b[at + 2] = z; b[at + 3] = tx; b[at + 4] = ty;
    b[at + 5] = length / 2; b[at + 6] = width / 2; b[at + 7] = height; b[at + 8] = wall; b[at + 9] = top; b[at + 10] = kind;
    b[at + 11] = spare;
    this.people++;
  }

  // -> { cars, boats, people }: how many were placed and are in view. Vehicles are in `boxes` (this.count of
  // them), people in `folks` (this.people). frame: { W, H, scale }; which: { cars, boats, people }.
  place(tiles, time, camera, frame, which, colours) {
    this.count = 0;
    this.people = 0;
    this.drawn = { cars: 0, boats: 0, people: 0, lamps: 0 };
    this.lampCount = 0;
    const { W, H, scale } = frame;
    this.camera = camera;
    if (camera.walking) {
      // walking: what moves is what stands within half a kilometre of the eye
      this.margin = { radius: 550 };
    } else {
      const halfU = W / (2 * scale), halfV = H / (2 * scale * camera.sinPitch);
      this.margin = { u: halfU + 30, v: halfV + 40 };
    }
    for (const tile of tiles) {
      const lines = tile.paths;
      if (!lines) continue;
      for (let n = 0; n < lines.length; n++) {
        const line = lines[n];
        // a line is drawn whole from its tile, so it is worth a look if it comes near the frame at all
        if (camera.walking) {
          const d = Math.hypot(tile.x0 + line.cx - camera.x, tile.y0 + line.cy - camera.y);
          if (d > this.margin.radius + line.reach) continue;
        } else {
          const c = camera.axes(tile.x0 + line.cx, tile.y0 + line.cy);
          const halfU = W / (2 * scale), halfV = H / (2 * scale * camera.sinPitch);
          if (Math.abs(c.u) > halfU + line.reach || Math.abs(c.v) > halfV + line.reach / camera.sinPitch) continue;
        }
        const street = STREETS[line.cls], water = WATERS[line.cls];
        if (street && which.cars) this.flow(line, n, street, time, tile, colours, 0.2, true);
        if (water && which.boats && (line.cls !== LAKE || which.lake)) this.flow(line, n, water, time, tile, colours, line.cls === LAKE ? 0.2 : 0, false);
        if (which.lamps && street) this.lamps(line, n, tile, colours, which.lit);
        if (which.people && PEOPLE[line.cls]) {
          // on the pavements of a street, to either side of it; along the middle of a pedestrian street or a path
          this.walk(line, n, PEOPLE[line.cls], time, tile, colours, line.cls === PEDESTRIAN || line.cls === PATH ? 0.3 : 1);
        }
      }
    }
    return this.drawn;
  }

  // whether a point of the world (metres) is in the frame or just outside it
  near(x, y) {
    if (this.camera.walking) return Math.hypot(x - this.camera.x, y - this.camera.y) <= this.margin.radius;
    const c = this.camera.axes(x, y);
    return Math.abs(c.u) <= this.margin.u && Math.abs(c.v) <= this.margin.v;
  }

  // vehicles along a line, in both directions, each on its own side of it
  flow(line, n, rule, time, tile, colours, side, isStreet) {
    const { spacing, speed, mix } = rule;
    const count = Math.max(1, Math.round(line.length / spacing));
    for (let k = 0; k < count; k++) {
      for (const dir of [1, -1]) {
        const r = hash(n * 7 + 1, k * 2 + (dir > 0 ? 1 : 2));
        // what it is: the first of the line's kinds, or now and then the second
        const kind = mix.length > 1 && hash(k * 3 + 2, n * 5 + dir) < mix[1][1] ? mix[1][0] : mix[0][0];
        const s = (((r * line.length + dir * speed * (0.8 + 0.4 * hash(k, n + 9)) * time) % line.length) + line.length) % line.length;
        const p = this.spot;
        along(line.points, s, p);
        const tx = p.tx * dir, ty = p.ty * dir;
        const lane = side * line.width;                      // to the right of the way it is going
        const x = tile.x0 + p.x + ty * lane, y = tile.y0 + p.y - tx * lane;
        if (!this.near(x, y)) continue;                      // the line runs on beyond the frame; what is out there is not drawn
        const [length, width, height] = SIZE[kind];
        const h = hash(k * 11 + 3, n * 13 + dir);
        if (isStreet) {
          this.box(x, y, p.z + 0.1, tx, ty, length, width, height, colours[CAR_COLOURS[Math.floor(h * CAR_COLOURS.length)]], colours[SILVER], kind);
          // four dark wheels under the corners of the body, half of each showing past its side
          const ax = tx * (length * 0.30), ay = ty * (length * 0.30);
          const bx2 = ty * (width * 0.5), by2 = -tx * (width * 0.5);
          for (const [cx2, cy2] of [[ax + bx2, ay + by2], [ax - bx2, ay - by2], [-ax + bx2, -ay + by2], [-ax - bx2, -ay - by2]]) {
            this.box(x + cx2, y + cy2, p.z + 0.1, tx, ty, 0.62, 0.24, 0.36, colours[DARK], colours[DARK], KIND.CAR);
          }
          this.drawn.cars++;
        } else {
          this.boat(kind, x, y, p.z, tx, ty, h, colours);
          this.drawn.boats++;
        }
      }
    }
  }

  // street lamps along a line: every twenty-eight metres, either side of the road in turn — a pole, an
  // arm reaching over the carriageway, and the lamp on the end of it. By day the lamp is a pale box;
  // at night it shines (a kind of its own, which the shader lights at its brightest step) and the page
  // draws the pool it casts on the ground. The heads near the camera are remembered for that pool.
  lamps(line, n, tile, colours, lit) {
    const count = Math.max(1, Math.round(line.length / 28));
    for (let k = 0; k < count; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const s = Math.min(line.length - 4, (k + hash(n * 3 + 1, k * 5) * 0.5) * 28);
      if (s <= 0) continue;
      const p = this.spot;
      along(line.points, s, p);
      const lane = side * (line.width + 0.9);
      const x = tile.x0 + p.x + p.ty * lane, y = tile.y0 + p.y - p.tx * lane;
      if (!this.near(x, y)) continue;
      const dark = colours[DARK];
      const headX = x - side * p.ty * 1.4, headY = y + side * p.tx * 1.4, headZ = p.z + 5.34;
      this.box(x, y, p.z + 0.14, p.tx, p.ty, 0.14, 0.14, 5.3, dark, dark, 0);                                        // the pole
      this.box(x - side * p.ty * 0.9, y + side * p.tx * 0.9, p.z + 5.32, p.tx, p.ty, 1.1, 0.1, 0.1, dark, dark, 0);  // the arm over the road
      this.box(headX, headY, p.z + 5.26, p.tx, p.ty, 0.55, 0.24, 0.16, lit ? colours[WINDOW_LIT] : colours[CABIN], lit ? colours[WINDOW_LIT] : colours[CABIN], lit ? KIND.LAMP_HEAD : 0);
      if (this.lampCount < 64) {
        const at = this.lampCount * 3;
        this.lampHeads[at] = headX - this.camera.x;
        this.lampHeads[at + 1] = headY - this.camera.y;
        this.lampHeads[at + 2] = headZ;
        this.lampCount++;
      }
      this.drawn.lamps++;
    }
  }

  // a boat is a hull and, unless it is a rowing boat, a cabin on it
  boat(kind, x, y, z, tx, ty, h, colours) {
    const [length, width, height] = SIZE[kind];
    const hull = kind === KIND.ROW_BOAT ? colours[WHITE] : kind === KIND.LAKE_BOAT ? colours[WHITE] : colours[HULL];
    this.box(x, y, z + 0.05, tx, ty, length, width, height, hull, hull, kind);
    if (kind === KIND.ROW_BOAT) return;
    const cabin = kind === KIND.LAKE_BOAT ? [length * 0.7, width * 0.8, 1.9] : [length * (0.3 + 0.2 * h), width * 0.7, kind === KIND.RIVER_BOAT ? 2.6 : 1.9];
    const back = kind === KIND.LAKE_BOAT ? 0 : (h - 0.5) * length * 0.3;
    this.box(x + tx * back, y + ty * back, z + height, tx, ty, cabin[0], cabin[1], cabin[2], colours[CABIN], kind === KIND.LAKE_BOAT ? colours[TEAL] : colours[CABIN], kind);
  }

  // people along a line: on the pavements of a street, to either side of it; along the middle of a path
  walk(line, n, spacing, time, tile, colours, side) {
    const count = Math.max(1, Math.round(line.length / spacing));
    for (let k = 0; k < count; k++) {
      const dir = hash(k * 5 + 1, n * 3) < 0.5 ? 1 : -1;
      const r = hash(n * 17 + 2, k * 19 + 4);
      const s = (((r * line.length + dir * WALK * time) % line.length) + line.length) % line.length;
      const p = this.spot;
      along(line.points, s, p);
      const tx = p.tx * dir, ty = p.ty * dir;
      const lane = side * line.width * (0.5 + 0.25 * hash(k, n + 3));
      const x = tile.x0 + p.x + ty * lane, y = tile.y0 + p.y - tx * lane;
      if (!this.near(x, y)) continue;
      const cloth = colours[CLOTHES[Math.floor(hash(k * 7, n + 5) * CLOTHES.length)]];
      // two legs swinging as the person walks, the body on them, the head on that: four boxes make a figure
      const [ll, lw, lh] = SIZE[KIND.LEGS], [bl, bw, bh] = SIZE[KIND.BODY], [hl, hw, hh] = SIZE[KIND.HEAD];
      const stride = 0.12 * Math.sin(time * 5 + k * 2.3 + n * 1.7);
      this.figure(x + tx * stride, y + ty * stride, p.z + 0.1, tx, ty, ll * 0.7, lw * 0.48, lh, colours[DARK], colours[DARK], KIND.LEGS);
      this.figure(x - tx * stride, y - ty * stride, p.z + 0.1, tx, ty, ll * 0.7, lw * 0.48, lh, colours[DARK], colours[DARK], KIND.LEGS);
      this.figure(x, y, p.z + 0.1 + lh, tx, ty, bl, bw, bh, cloth, cloth, KIND.BODY);
      this.figure(x, y, p.z + 0.1 + lh + bh, tx, ty, hl, hw, hh, colours[SKIN], colours[DARK], KIND.HEAD);
      this.drawn.people++;
    }
  }
}
