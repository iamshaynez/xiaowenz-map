// 首页的地球：一颗和城里的地图说同一种话的星球。同一份调色板，同一个五级色阶（暗部偏紫、亮部偏暖，
// style/core.js 的 rampOf），同一种 Bayer 抖动，光也像城里那样固定在画面的左上方。画法是老实的：
// 烘一张等距柱状的贴图，每帧在低分辨率画布上逐像素做正交投影的采样，再靠 CSS 放大成大而糙的像素。
//
// 球态是两个角：spin（自转，往东转）和 tilt（倾角，北极往观者这边倾）。哪座城的纬度、经度正对观者，
// 就是 tilt = 纬度、spin = -经度——潜入动画的第一段只是这两个角的缓动。角度的约定在 paint 的
// 推导里：世界经纬 (φ, λ) 落在屏幕上是先加 spin 再倾 tilt，所以采样时按原路退回去。
import { rampOf, channels, noise, bayerAt } from '../style/core.js';

const TEX_W = 720, TEX_H = 360;              // 0.5 度一格的贴图
const mod = (v, m) => ((v % m) + m) % m;
const LIGHT = (() => { const [x, y, z] = [-0.62, 0.52, 0.72], l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; })();   // 左上方：x 向左、y 向上、z 向观者

// 贴图：每个格一个颜色序号。陆地点阵说哪里是陆地，气候带按纬度铺（边界由噪声揉碎，免得整圈地球
// 一道刀切的线），沙漠是回归线附近一块块的而不是一圈。收尾两笔：海岸的海深一档，极地的海结冰。
function bakeTexture(land, colours) {
  const seat = name => {
    if (!Object.hasOwn(colours, name)) throw new Error(`调色板里没有 ${name}`);
    return colours[name];
  };
  const mix = (a, b, k) => [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * k));
  const ink = [28, 27, 25];
  const ocean = seat('glass_blue'), coast = seat('water_lake'), ice = seat('snow');
  const grid = [ocean, coast, ice], oceanAt = 0, coastAt = 1, iceAt = 2;
  const seatOf = colour => {
    const at = grid.findIndex(c => c === colour);
    if (at >= 0) return at;
    grid.push(colour);
    return grid.length - 1;
  };
  const band = (lat, lon) => {
    const a = Math.abs(lat), wobble = (noise(lon * 0.9 + 8, lat * 0.9) - 0.5) * 10;
    const arid = noise(lon * 1.7 + 40, lat * 1.7);
    if (a > 61 + wobble) return seatOf(seat('snow'));
    if (a > 52 + wobble) return seatOf(seat('rock'));
    if (a < 15 + wobble) return seatOf(seat('forest'));
    if (a > 17 && a < 34 && arid > 0.72) return seatOf(seat('sand'));
    if (a > 17 && a < 34 && arid > 0.62) return seatOf(seat('grass_dry'));
    return seatOf(seat('grass'));
  };
  // 陆地点阵（tools/bake/globe-land.mjs）：行是纬度（行首是行中心），行内一位一个点
  const landAt = (lon, lat) => {
    const row = land.rows[Math.max(0, Math.min(179, Math.floor(lat + 90)))];
    const cols = row[1], col = Math.min(cols - 1, Math.max(0, Math.floor((lon + 180) / 360 * cols)));
    const nibble = parseInt(row[2][Math.floor(col / 4)] ?? '0', 16);
    return ((nibble >> (col % 4)) & 1) === 1;
  };
  const isLand = new Uint8Array(TEX_W * TEX_H);
  const texture = new Uint8Array(TEX_W * TEX_H);
  for (let ty = 0; ty < TEX_H; ty++) {
    const lat = 90 - (ty + 0.5) * 180 / TEX_H;
    for (let tx = 0; tx < TEX_W; tx++) {
      const lon = (tx + 0.5) * 360 / TEX_W - 180;
      const at = ty * TEX_W + tx;
      isLand[at] = landAt(lon, lat) ? 1 : 0;
      texture[at] = isLand[at] ? band(lat, lon) : oceanAt;
    }
  }
  for (let ty = 0; ty < TEX_H; ty++) {
    const lat = 90 - (ty + 0.5) * 180 / TEX_H;
    for (let tx = 0; tx < TEX_W; tx++) {
      const lon = (tx + 0.5) * 360 / TEX_W - 180;
      const at = ty * TEX_W + tx;
      if (isLand[at]) continue;
      const west = ty * TEX_W + (tx + TEX_W - 1) % TEX_W, east = ty * TEX_W + (tx + 1) % TEX_W;
      const south = Math.max(0, at - TEX_W), north = Math.min(TEX_W * TEX_H - 1, at + TEX_W);
      if (isLand[west] || isLand[east] || isLand[south] || isLand[north]) texture[at] = coastAt;
      else if (Math.abs(lat) > 71 && noise(lon * 3 + 90, lat * 3) > 0.44) texture[at] = iceAt;
      else {
        // 经纬网：三十度一格，虚线；赤道那一道最重
        const dotted = (Math.floor(lat * 2) + Math.floor(lon * 2)) % 2 === 0;
        if (Math.abs(lat) < 0.26) texture[at] = seatOf(mix(ocean, ink, 0.24));
        else if (dotted && (mod(lon, 30) < 0.26 || mod(lat, 30) < 0.26)) texture[at] = seatOf(mix(ocean, ink, 0.16));
      }
    }
  }
  return { texture, grid };
}

export function createGlobe({ canvas, land, colours, holdStill = false }) {
  const ctx = canvas.getContext('2d');
  const { texture, grid } = bakeTexture(land, colours);
  // 色阶表：每个颜色按 pixel-plays 的规则生成五级。一帧的每个像素查一次表就出颜色
  const ramps = grid.map(colour => rampOf(colour).map(channels));
  let D = 0, cssScale = 1, image = null, pixels = null, sampler = null;
  let normal = null, level = null;             // 每个像素固定的东西：法线、亮度定的色阶级别
  let spin = -120 * Math.PI / 180;             // 起笔对着亚欧大陆
  let tilt = 22 * Math.PI / 180;
  let idle = 0.0068;                           // 自转，弧度每秒（约 0.4 度）
  let velocity = 0, tiltVelocity = 0;          // 手放开后的余劲
  let dive = null;                             // { t0, approach, then, tiltFrom, tiltTo, spinFrom, spinDelta }

  function resize(cssSize, pixelScale) {
    cssScale = pixelScale;
    D = Math.max(96, Math.round(cssSize / pixelScale));
    canvas.width = D;
    canvas.height = D;
    canvas.style.width = `${D * pixelScale}px`;
    canvas.style.height = `${D * pixelScale}px`;
    image = ctx.createImageData(D, D);
    pixels = image.data;
    const r = D / 2, inDisc = [];
    normal = new Float32Array(D * D * 3);
    level = new Uint8Array(D * D);
    for (let y = 0; y < D; y++) {
      for (let x = 0; x < D; x++) {
        const dx = (x + 0.5 - r) / r, dy = (y + 0.5 - r) / r, d2 = dx * dx + dy * dy;
        if (d2 > 1) continue;                  // 盘外的像素不进采样表，留着透明
        const at = y * D + x, z = Math.sqrt(1 - d2);
        normal[at * 3] = dx; normal[at * 3 + 1] = -dy; normal[at * 3 + 2] = z;
        // 亮度定级别：0 是背光的暗紫，4 是向光面的暖色。抖动按 pixel-plays 的规矩在像素中心做
        const b = dx * LIGHT[0] - dy * LIGHT[1] + z * LIGHT[2];
        const shade = b * 0.5 + 0.56;
        level[at] = Math.max(0, Math.min(4, Math.floor(shade * 4.4 + 0.2 + (bayerAt(x, y) - 0.5) * 0.9)));
        inDisc.push(at);
      }
    }
    sampler = inDisc;
    return { internal: D, css: D * pixelScale };
  }

  function paint(now) {
    // 球态往前走：自转、余劲、潜入的第一段
    const dt = Math.min(0.1, Math.max(0, (now - (paint.at ?? now)) / 1000));
    paint.at = now;
    if (dive) {
      const t = Math.min(1, (now - dive.t0) / dive.approach), e = t * t * (3 - 2 * t);
      tilt = dive.tiltFrom + (dive.tiltTo - dive.tiltFrom) * e;
      spin = dive.spinFrom + dive.spinDelta * e;
      if (t >= 1) {
        const done = dive;
        dive = null;
        if (done.then) done.then();
      }
    } else {
      spin += (idle + velocity) * dt;
      tilt = Math.max(-1.25, Math.min(1.25, tilt + tiltVelocity * dt));
      velocity *= Math.pow(0.02, dt);
      tiltVelocity *= Math.pow(0.02, dt);
      if (Math.abs(velocity) < 0.008) velocity = 0;
      if (Math.abs(tiltVelocity) < 0.008) tiltVelocity = 0;
    }
    if (holdStill || (!dive && !idle && !velocity && !tiltVelocity)) return false;   // 一动不动就不重画
    const cs = Math.cos(spin), ss = Math.sin(spin), ct = Math.cos(tilt), st = Math.sin(tilt);
    for (const at of sampler) {
      const nx = normal[at * 3], ny = normal[at * 3 + 1], nz = normal[at * 3 + 2];
      // 退回世界：先退倾角，再退自转（paint 头上的注释里有推导）
      const wy = ny * ct + nz * st, z1 = -ny * st + nz * ct;
      const wx = nx * cs - z1 * ss, wz = nx * ss + z1 * cs;
      const lat = Math.asin(Math.max(-1, Math.min(1, wy)));
      const tx = Math.floor((Math.atan2(wx, wz) / Math.PI + 1) * 0.5 * TEX_W) % TEX_W;
      const ty = Math.min(TEX_H - 1, Math.max(0, Math.floor((0.5 - lat / Math.PI) * TEX_H)));
      const shade = ramps[texture[ty * TEX_W + tx]][level[at]];
      const at4 = at * 4;
      pixels[at4] = shade[0]; pixels[at4 + 1] = shade[1]; pixels[at4 + 2] = shade[2]; pixels[at4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return true;
  }

  // 一座城（纬度、经度）在画面上的位置，内部像素。z 是朝向观者的分量：越小越靠球缘，负了就是背过去了
  function project(lat, lon) {
    const r = D / 2;
    const φ = lat * Math.PI / 180, λ = lon * Math.PI / 180 + spin;
    const x = Math.cos(φ) * Math.sin(λ), y0 = Math.sin(φ), z0 = Math.cos(φ) * Math.cos(λ);
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const y = y0 * ct - z0 * st, z = y0 * st + z0 * ct;
    return { x: r + x * r, y: r - y * r, z, facing: z > 0.12 };
  }

  // 盘心此刻对着哪块地（读数栏的字就从这里来），和球态的两个角（仪器环的刻度随它们转）
  const facing = () => ({ lat: tilt * 180 / Math.PI, lon: -spin * 180 / Math.PI });
  const angles = () => ({ spin, tilt });

  // 潜入的第一段：把一座城转到正对观者（见文件头的角度约定），转完把页面交回给下一段
  function diveTo(lat, lon, approachSeconds, then) {
    dive = {
      t0: performance.now(), approach: approachSeconds * 1000, then,
      tiltFrom: tilt, tiltTo: Math.max(-1.2, Math.min(1.2, lat * Math.PI / 180)),
      spinFrom: spin, spinDelta: (() => { let d = (-lon * Math.PI / 180 - spin) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; })(),
    };
    velocity = tiltVelocity = 0;
  }

  return {
    resize, paint, project, facing, angles, diveTo,
    get internal() { return D; },
    get cssScale() { return cssScale; },
    nudge: (dSpin, dTilt) => { spin += dSpin; tilt = Math.max(-1.25, Math.min(1.25, tilt + dTilt)); },
    fling: (vSpin, vTilt) => { velocity = vSpin; tiltVelocity = vTilt; },
    set spin(value) { spin = value; },
    set tilt(value) { tilt = Math.max(-1.25, Math.min(1.25, value)); },
    hold: still => { idle = still || holdStill ? 0 : 0.0068; },   // 手指搭在一座城上时，球停下来等你
  };
}
