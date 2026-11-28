// 街具：路口的交通灯与路名牌、主路的中央隔离栏与路边的配电箱、公交站的候车亭、人行道边的
// 长椅与垃圾桶、候车亭与路口旁的共享单车、运河两岸的石栏。全部由瓦片已烘的 PATH 线按规矩派生
// （路口用的是 world/streets.js 的同一套 crossing 检测；M2 烘上 OSM 的真点后按点替换），按瓦片
// 缓存成两份实例网格：白天的一份，和夜里亮起来的那一份（信号灯的灯色）。盒子与生命体走同一个
// 着色器（shaders-life.js 的 lifeBoxes），所以光、描边、影子都和车、人一样。
//
// 记录的格式与 life/traffic.js 的 RECORD 相同：x, y, z, 车头 x, 车头 y, 半长, 半宽, 高, 墙色,
// 顶色, 类, 俯仰（街具的俯仰恒为 0）。类取 3..9 之间，避开生命体自己的风挡与发光段。

import { assemble } from '../world/store.js';
import { UNIT_BOX } from '../world/store.js';
import { crossings } from '../world/streets.js';

const RECORD = 12;
const KIND = 6;                          // 一个普通盒子：不发光、没有风挡
const LIT_KIND = 6;
const MAX_INSTANCES = 4000;              // 一块瓦片的街具上限，超了就不再加

const fract = v => v - Math.floor(v);
const hash = (a, b) => fract(Math.sin(a * 127.1 + b * 311.7 + 53.7) * 43758.5453);

// 线上某一点的位置与方向（points: x, y, z, 距离；答案相对瓦片角）
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

// 一次积木：在地上、路缘外 lateral 米处，立一个沿路向的盒子
class Emitter {
  constructor(colours, tile, out) {
    this.c = colours;
    this.tile = tile;
    this.out = out;
  }
  get full() { return this.out.length / RECORD >= MAX_INSTANCES; }
  // x, y 已是世界米（瓦片角另算），z 是地面高；along/across 沿盒子自己的头
  box(x, y, z, tx, ty, half, wide, height, wall, top = wall, kind = KIND) {
    if (this.full) return;
    this.out.push(x, y, z, tx, ty, half, wide, height, wall, top, kind, 0);
  }
  // 沿一条线放盒子：s 是沿线距离，lateral 往线的左侧偏，heading 可以反
  at(line, tile, s, lateral, dir, half, wide, height, wall, top, lift = 0) {
    const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
    along(line.points, Math.max(0.2, Math.min(line.length - 0.2, s)), p);
    const x = tile.x0 + p.x - p.ty * lateral, y = tile.y0 + p.y + p.tx * lateral;
    const z = this.tile.surfaceAt ? this.tile.surfaceAt(x, y) + lift : p.z + lift;
    this.box(x, y, z, p.tx * dir, p.ty * dir, half, wide, height, wall, top);
    return p;
  }
}

// 主路口的交通灯：对角两根杆（各管一条路的来车方向），横臂伸进路口上空，灯箱里三个灯色。
// 夜里亮的灯色单独记一份
function signals(junctions, tile, colours, clearances, out, lit) {
  for (const junction of junctions) {
    const { a, b, sa, sb } = junction;
    if (a.cls !== 5 && a.cls !== 6) continue;
    if (clearances.some(([cx, cy, r]) => (tile.x0 + junction.x - cx) * (tile.x0 + junction.x - cx) + (tile.y0 + junction.y - cy) * (tile.y0 + junction.y - cy) < r * r)) continue;
    const e = new Emitter(colours, tile, out), f = new Emitter(colours, tile, lit);
    // 两根对角的杆：a 的杆立在路口上行的左侧、臂逆着 a 指向路口；b 的杆在下行右侧，臂顺着 b
    for (const [line, s, other, side, dir] of [[a, sa, b, 1, -1], [b, sb, a, -1, 1]]) {
      const arm = s + (other.width + 1.2);
      if (arm < 2 || arm > line.length - 2) continue;
      const lateral = side * (line.width + 1.3);
      const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
      along(line.points, arm, p);
      const x = tile.x0 + p.x - p.ty * lateral, y = tile.y0 + p.y + p.tx * lateral;
      const z = tile.surfaceAt ? tile.surfaceAt(x, y) : p.z;
      e.box(x, y, z, p.tx, p.ty, 0.07, 0.07, 4.3, colours.dark);                             // 杆
      // 横臂伸向路口：头对准路口中心的方向
      e.box(x, y, z + 4.0, p.tx * dir, p.ty * dir, 1.3, 0.06, 0.09, colours.dark);
      // 灯箱挂在臂头：竖着的三格，格子朝路口错出半个箱深
      const hx = x + p.tx * dir * 2.2, hy = y + p.ty * dir * 2.2;
      const fx = -p.ty * dir * 0.16, fy = p.tx * dir * 0.16;        // 往路口一侧错一点
      e.box(hx + fx, hy + fy, z + 3.35, p.tx, p.ty, 0.12, 0.23, 1.05, colours.dark);
      for (const [k, colour] of [[0, colours.red], [1, colours.yellow], [2, colours.green]]) {
        e.box(hx + fx * 2.2, hy + fy * 2.2, z + 3.52 + k * 0.33, p.tx, p.ty, 0.10, 0.19, 0.20, colour);
      }
      // 夜里只亮一格绿：从灯箱面上再探出一点，盖住白天那格的灯色
      f.box(hx + fx * 2.6, hy + fy * 2.6, z + 3.52 + 2 * 0.33, p.tx, p.ty, 0.10, 0.19, 0.20, colours.lit, colours.lit, LIT_KIND);
    }
  }
}

// 路口的路名牌：一根杆、一块蓝板，立在高级那条路的一侧
function nameBoards(junctions, tile, colours, clearances, out) {
  let boards = 0;
  for (const junction of junctions) {
    if (boards > 26) return;
    const { a, b, sa } = junction;
    if (clearances.some(([cx, cy, r]) => (tile.x0 + junction.x - cx) * (tile.x0 + junction.x - cx) + (tile.y0 + junction.y - cy) * (tile.y0 + junction.y - cy) < r * r)) continue;
    const s = sa + b.width + 1.6;
    if (s < 2 || s > a.length - 2) continue;
    const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
    along(a.points, s, p);
    const e = new Emitter(colours, tile, out);
    const lateral = a.width + 1.1;
    const x = tile.x0 + p.x - p.ty * lateral, y = tile.y0 + p.y + p.tx * lateral;
    const z = tile.surfaceAt ? tile.surfaceAt(x, y) : p.z;
    e.box(x, y, z, p.tx, p.ty, 0.05, 0.05, 2.35, colours.metal);            // 杆
    e.box(x, y, z + 1.95, p.tx, p.ty, 0.46, 0.03, 0.24, colours.navy);      // 板
    boards++;
  }
}

// 公交站的候车亭：站台板、顶棚、两根柱，一块站牌；顺路每五百来米一座，两侧轮换
function shelters(tile, colours, out) {
  const streets = (tile.paths || []).filter(line => line.cls === 5 || line.cls === 6);
  for (const line of streets) {
    const count = Math.max(1, Math.round(line.length / 520));
    for (let k = 0; k < count; k++) {
      const e = new Emitter(colours, tile, out);
      const side = k % 2 === 0 ? 1 : -1;
      const s = Math.min(line.length - 12, (k + hash(tile.x0 + line.cx + k, tile.y0 + line.cy) * 0.4) * (line.length / count) + 8);
      if (s < 8) continue;
      const lateral = side * (line.width + 1.9);
      const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
      along(line.points, s, p);
      const bx = tile.x0 + p.x - p.ty * lateral, by = tile.y0 + p.y + p.tx * lateral;
      const bz = (tile.surfaceAt ? tile.surfaceAt(bx, by) : p.z);
      e.box(bx, by, bz, p.tx, p.ty, 2.0, 0.9, 0.14, colours.pale);                       // 站台
      for (const end of [-1.75, 1.75]) {
        e.box(bx + p.tx * end, by + p.ty * end, bz + 0.14, p.tx, p.ty, 0.06, 0.06, 2.45, colours.metal);   // 柱
      }
      e.box(bx, by, bz + 2.59, p.tx, p.ty, 1.95, 0.7, 0.09, colours.silver, colours.silver);          // 顶棚
      const signX = bx + p.tx * 2.9 + p.ty * side * 0.5, signY = by + p.ty * 2.9 - p.tx * side * 0.5;
      const sz = tile.surfaceAt ? tile.surfaceAt(signX, signY) : p.z;
      e.box(signX, signY, sz, p.tx, p.ty, 0.05, 0.05, 2.6, colours.metal);
      e.box(signX, signY, sz + 2.2, p.tx, p.ty, 0.27, 0.03, 0.5, colours.blue);
    }
  }
}

// 主路的中央隔离栏：一段一段的灰白护栏，路口处让开
function barriers(tile, colours, junctions, clearances, out) {
  const streets = (tile.paths || []).filter(line => line.cls === 5);
  for (const line of streets) {
    const gaps = [];
    for (const junction of junctions) {
      if (junction.a !== line && junction.b !== line) continue;
      const s = junction.a === line ? junction.sa : junction.sb;
      gaps.push([s - 16, s + 16]);
    }
    gaps.sort((p, q) => p[0] - q[0]);
    const e = new Emitter(colours, tile, out);
    for (let s = 2.0; s < line.length - 2.0; s += 4.0) {
      if (gaps.some(([g0, g1]) => s > g0 && s < g1)) continue;
      e.at(line, tile, s, 0, 1, 1.9, 0.05, 0.82, colours.pale, colours.pale, 0.1);
    }
  }
}

// 路边的配电箱与通信箱，主路和次路上每两三百米一只
function cabinets(tile, colours, out) {
  const streets = (tile.paths || []).filter(line => line.cls === 5 || line.cls === 6);
  for (const line of streets) {
    const count = Math.max(1, Math.round(line.length / 260));
    for (let k = 0; k < count; k++) {
      const e = new Emitter(colours, tile, out);
      const side = k % 2 === 0 ? 1 : -1;
      const s = (k + hash(k * 3 + 1, tile.x0 + line.cy) * 0.7) * (line.length / count) + 20;
      if (s < 4 || s > line.length - 6) continue;
      e.at(line, tile, s, side * (line.width + 0.9), 1, 0.5, 0.23, 1.15, colours.cabinet);
    }
  }
}

// 人行道与小径边的长椅和垃圾桶：步行街与游步道上隔四五十米一对
function benches(tile, colours, out) {
  const ways = (tile.paths || []).filter(line => line.cls === 9 || line.cls === 10);
  for (const line of ways) {
    const count = Math.max(1, Math.round(line.length / 48));
    for (let k = 0; k < count; k++) {
      const e = new Emitter(colours, tile, out);
      const side = k % 2 === 0 ? 1 : -1;
      const s = Math.min(line.length - 6, (k + 0.5) * (line.length / count));
      const lateral = side * 1.1;
      const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
      along(line.points, s, p);
      const x = tile.x0 + p.x - p.ty * lateral, y = tile.y0 + p.y + p.tx * lateral;
      const z = tile.surfaceAt ? tile.surfaceAt(x, y) : p.z;
      e.box(x, y, z + 0.42, p.tx, p.ty, 0.75, 0.20, 0.09, colours.wood);                    // 座面
      e.box(x - p.ty * side * 0.22, y + p.tx * side * 0.22, z + 0.72, p.tx, p.ty, 0.75, 0.05, 0.38, colours.wood);   // 靠背
      const binX = x + p.tx * 1.6, binY = y + p.ty * 1.6;
      e.box(binX, binY, tile.surfaceAt ? tile.surfaceAt(binX, binY) : p.z, p.tx, p.ty, 0.18, 0.18, 0.82, colours.bin);
    }
  }
}

// 候车亭与路口旁的共享单车：一排三五辆，车头对着路，颜色以蓝绿为主、金色偶尔一辆
function bikes(tile, colours, out, anchors) {
  for (const [ax, ay] of anchors) {
    const e = new Emitter(colours, tile, out);
    const row = 3 + Math.floor(hash(ax, ay) * 3);
    const ang = hash(ay, ax) * Math.PI * 2;
    const hx = Math.cos(ang), hy = Math.sin(ang);
    const near = tile.paths && nearestPathPoint(tile, ax, ay, hx, hy);
    if (!near) continue;
    for (let k = 0; k < row; k++) {
      const x = ax + hy * 0.72 * k, y = ay - hx * 0.72 * k;
      const z = tile.surfaceAt ? tile.surfaceAt(x, y) : near.z;
      const r = hash(k * 3 + 1, ay + ax);
      const colour = r < 0.42 ? colours.blue : r < 0.84 ? colours.green : colours.gold;
      e.box(x, y, z + 0.18, hx, hy, 0.72, 0.16, 0.30, colours.dark);                        // 轮与低架
      e.box(x, y, z + 0.46, hx, hy, 0.60, 0.10, 0.34, colour);                              // 车身
    }
  }
}

// 一个点附近的路面（共享单车要停在人行道边上）：取瓦片里离得最近的 PATH 点
function nearestPathPoint(tile, x, y, hx, hy) {
  let best = null;
  for (const line of tile.paths || []) {
    if (line.cls < 5 || line.cls > 8) continue;
    const pts = line.points;
    for (let i = 0; i < pts.length / 4 - 1; i++) {
      const a = i * 4;
      const px = tile.x0 + pts[a], py = tile.y0 + pts[a + 1];
      const d = Math.hypot(px - x, py - y);
      if (!best || d < best.d) best = { d, z: pts[a + 2] };
      if (best.d < 4) return best;
    }
  }
  return best;
}

// 运河与江的两岸石栏：一段横栏、隔一段一根望柱，跟着岸弯
function railings(tile, colours, out) {
  const waters = (tile.paths || []).filter(line => line.cls === 200 || line.cls === 201);
  for (const line of waters) {
    for (const side of [1, -1]) {
      const lateral = side * (line.width + 0.7);
      const e = new Emitter(colours, tile, out);
      for (let s = 1.3; s < line.length - 1.3; s += 3.2) {
        const post = Math.floor(s / 3.2) % 4 === 0;
        const p = { x: 0, y: 0, z: 0, tx: 1, ty: 0 };
        along(line.points, s, p);
        const x = tile.x0 + p.x - p.ty * lateral, y = tile.y0 + p.y + p.tx * lateral;
        const z = tile.surfaceAt ? tile.surfaceAt(x, y) : p.z;
        if (post) e.box(x, y, z, p.tx, p.ty, 0.14, 0.14, 0.74, colours.pale);               // 望柱
        else e.box(x, y, z + 0.56, p.tx, p.ty, 1.6, 0.06, 0.09, colours.pale);              // 横栏
      }
    }
  }
}

// 行道树的树池：树脚一块深色的方篦子，从瓦片的行道树（TREE 段 kind=2）派生
function treePits(tile, colours, out) {
  const trees = tile.trees;
  if (!trees) return;
  const e = new Emitter(colours, tile, out);
  const view = new DataView(trees.records.buffer, trees.records.byteOffset, trees.records.byteLength);
  for (let k = 0; k < trees.count; k++) {
    const o = k * 16;
    if (trees.records[o + 15] !== 2) continue;             // kind 2: street trees only
    const x = tile.x0 + view.getFloat32(o, true), y = tile.y0 + view.getFloat32(o + 4, true), z = view.getFloat32(o + 8, true);
    e.box(x, y, z, 1, 0, 0.62, 0.62, 0.045, colours.bin);
  }
}

// -> { mesh, count, lit, litCount }: 一块瓦片的街具。夜里的那份只有信号灯的灯色
export function buildFurniture(gl, tile, clearances, colours) {
  const out = [], lit = [];
  const streets = (tile.paths || []).filter(line => line.cls === 5 || line.cls === 6);
  const junctions = crossings(streets);
  signals(junctions, tile, colours, clearances, out, lit);
  nameBoards(junctions, tile, colours, clearances, out);
  barriers(tile, colours, junctions, clearances, out);
  shelters(tile, colours, out);
  cabinets(tile, colours, out);
  benches(tile, colours, out);
  treePits(tile, colours, out);
  railings(tile, colours, out);
  const anchors = [];
  for (const junction of junctions) {
    if (junction.a.cls === 5) anchors.push([tile.x0 + junction.x, tile.y0 + junction.y]);
  }
  for (const line of streets) {
    const count = Math.max(1, Math.round(line.length / 520));
    for (let k = 0; k < count; k++) {
      const s = (k + 0.5) * (line.length / count);
      const pts = line.points;
      const i = Math.min(pts.length / 4 - 1, Math.max(0, Math.floor(s / (line.length / Math.max(1, pts.length / 4 - 1))))) * 4;
      anchors.push([tile.x0 + pts[i], tile.y0 + pts[i + 1]]);
    }
  }
  bikes(tile, colours, out, anchors.slice(0, 6));
  const mesh = out.length ? assemble(gl, [
    { data: UNIT_BOX, layout: [[0, 3], [1, 2]] },
    { data: new Float32Array(out), stride: RECORD * 4, layout: [[2, 4, gl.FLOAT, 0], [3, 4, gl.FLOAT, 16], [4, 4, gl.FLOAT, 32]], divisor: 1 },
  ]) : null;
  const litMesh = lit.length ? assemble(gl, [
    { data: UNIT_BOX, layout: [[0, 3], [1, 2]] },
    { data: new Float32Array(lit), stride: RECORD * 4, layout: [[2, 4, gl.FLOAT, 0], [3, 4, gl.FLOAT, 16], [4, 4, gl.FLOAT, 32]], divisor: 1 },
  ]) : null;
  return { mesh, count: out.length / RECORD, lit: litMesh, litCount: lit.length / RECORD };
}
