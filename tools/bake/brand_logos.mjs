// The chain brands' signboard pictures: each brand's real logo, taken from the reference image in
// logo-refs/<brand>.png (searched and picked by hand; the sources are the Wikipedia logo files and
// news/brand-design pages, recorded in wiki-picks notes in the repo history), cut to its subject,
// squared, downsampled to 32×32, quantized to at most ten colours of its own, and laid over the brand's
// board colour. The result is written as app/src/landmarks/brandmarks.js — one RGBA picture a brand,
// which the page's atlas (shaders-brands.js) samples whole.
//
// The order of BRANDS is the order of pixelcity/brands.py's TABLE — the bake writes brand ids in that
// order; the page checks its copy against index.json's brandMarks at boot. The board colours here are
// brands.py's own (`colour`), duplicated: a mismatch would only repaint the background.
//
// Usage: node tools/bake/brand_logos.mjs      (from the repository root; writes brandmarks.js in place)
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from '../review/png.cjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const S = 32;
const BOARDS = {                       // 与 pixelcity/brands.py 的 TABLE.colour 一致
  mcd: 'brand_red', kfc: 'brand_red', pizza_hut: 'brand_red', burger_king: 'brand_orange', tastien: 'brand_gold',
  starbucks: 'brand_green', luckin: 'brand_navy', cotti: 'brand_red', heytea: 'panel_white', nayuki: 'panel_white',
  mixue: 'brand_red', chabaidao: 'brand_orange', chagee: 'glass_teal', haidilao: 'brand_red',
  familymart: 'brand_blue', seven_eleven: 'brand_orange', lawson: 'brand_blue', hema: 'brand_blue',
  sam: 'glass_teal', walmart: 'brand_blue', rtmart: 'brand_orange', uniqlo: 'brand_red', miniso: 'brand_red',
  ultraman: 'window_dark',
};
const BRANDS = Object.keys(BOARDS);
// 有些参考图构图不干净：手动给出裁剪框（参考图自己的像素坐标），只取其中干净的主体。
const CROPS = {
  chabaidao: { x: 60, y: 55, w: 260, h: 420 },       // 最左边那只干净的熊猫
  haidilao: { x: 55, y: 42, w: 165, h: 155 },        // 左上角的红色 Hi 印
};
// 没有干净参考的品牌，就地程序化画（塔斯汀的海报图裁不出干净主体；罗森的参考太淡——
// 它的招牌本来就是蓝底白牛奶瓶，画一只）
function drawLawson() {
  const rgba = new Uint8Array(S * S * 4);
  const blue = palette.brand_blue, white = palette.panel_white;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = (y * S + x) * 4;
    rgba[o] = blue[0]; rgba[o + 1] = blue[1]; rgba[o + 2] = blue[2]; rgba[o + 3] = 255;
  }
  const inBottle = (x, y) => (y >= 3 && y <= 7 && x >= 12 && x <= 19)          // the cap
    || (y >= 8 && y <= 11 && x >= 13 && x <= 18)                                // the neck
    || (y >= 12 && y <= 28 && x >= 9 && x <= 22 && !(y > 25 && (x < 11 || x > 20))); // the body, rounded below
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (inBottle(x, y)) {
      const o = (y * S + x) * 4;
      rgba[o] = white[0]; rgba[o + 1] = white[1]; rgba[o + 2] = white[2];
    }
  }
  return rgba;
}
function drawTastien() {
  const rgba = new Uint8Array(S * S * 4);
  const seat = palette.brand_gold, red = palette.brand_red, white = palette.panel_white;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const o = (y * S + x) * 4;
    const dx = Math.max(6 - x, 0, x - 25), dy = Math.max(6 - y, 0, y - 25);
    const inside = dx * dx + dy * dy <= 25;
    const c = inside ? (y >= 13 && y <= 18 ? white : red) : seat;
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
  }
  return rgba;
}
// 奥特曼：汀岸芷兰轩 11# 楼顶大牌的那张"照片"（初代奥特曼的半身像——银身红纹、金眼、胸前彩色计时器），
// 夜色板上一尊正面立像。没有干净的参考图可裁，就地按形制画。
function drawUltraman() {
  const rgba = new Uint8Array(S * S * 4);
  const night = palette.window_dark, silver = palette.metal_pale, shade = palette.concrete_grey,
        red = palette.brand_red, eye = palette.gild, timer = palette.glass_blue, white = palette.panel_white;
  const put = (x0, y0, x1, y1, c) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const o = (y * S + x) * 4;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
    }
  };
  put(0, 0, 31, 31, night);
  put(15, 0, 16, 2, silver);                       // 头顶的鳍
  put(12, 2, 19, 9, silver);                       // 头
  put(10, 4, 21, 7, silver);                       // 头展宽的一截
  put(12, 10, 13, 10, shade); put(18, 10, 19, 10, shade);   // 两颊的暗面
  put(12, 5, 14, 7, eye); put(17, 5, 19, 7, eye);           // 一双金眼
  put(12, 5, 12, 5, white); put(19, 7, 19, 7, white);       // 眼里的光
  put(14, 9, 17, 11, silver);                      // 颈
  put(9, 12, 22, 26, silver);                      // 躯干
  put(9, 12, 12, 13, red); put(19, 12, 22, 13, red);        // 红的肩甲
  put(10, 15, 11, 22, red); put(20, 15, 21, 22, red);       // 两道红纹顺着躯干下去
  put(15, 14, 16, 15, timer); put(15, 14, 15, 14, white);   // 胸口的彩色计时器
  put(6, 14, 8, 24, silver); put(23, 14, 25, 24, silver);   // 两臂
  put(6, 18, 8, 19, red); put(23, 18, 25, 19, red);         // 臂上的红箍
  put(5, 25, 8, 27, silver); put(23, 25, 26, 27, silver);   // 拳头
  put(10, 24, 21, 25, red);                        // 腰间的红带
  return rgba;
}
const SPECIAL = { tastien: () => drawTastien(), lawson: () => drawLawson(), ultraman: () => drawUltraman() };

const palette = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/palette.json'), 'utf8')).colours;

// the picture's subject: the box of pixels that are not the background. A reference with alpha keeps
// everything alpha admits; an opaque one is trimmed against its corner colour.
function subject(img) {
  const alpha = img.data.some((v, i) => i % 4 === 3 && v < 200);
  const bg = alpha ? null : corner(img);
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 4;
    const keep = alpha ? img.data[i + 3] >= 40 : (Math.abs(img.data[i] - bg[0]) > 24 || Math.abs(img.data[i + 1] - bg[1]) > 24 || Math.abs(img.data[i + 2] - bg[2]) > 24);
    if (!keep) continue;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error('the reference is one flat colour');
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function corner(img) {
  const picks = [0, img.w - 1, (img.h - 1) * img.w, (img.h * img.w - 1)].map(i => [img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
  return picks[0];
}

// box-average downsample with alpha weighted in, then the board behind it
function downsample(img, box, board) {
  // 字标类是横的、徽章类是方的：先把主体框放成正方形（短边留白），缩放后不变形
  const side = Math.max(box.w, box.h);
  const square = {
    x0: box.x0 - Math.floor((side - box.w) / 2),
    y0: box.y0 - Math.floor((side - box.h) / 2),
    w: side, h: side,
  };
  const rgba = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const sx0 = square.x0 + Math.floor(square.w * x / S), sx1 = Math.max(sx0 + 1, square.x0 + Math.floor(square.w * (x + 1) / S));
    const sy0 = square.y0 + Math.floor(square.h * y / S), sy1 = Math.max(sy0 + 1, square.y0 + Math.floor(square.h * (y + 1) / S));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const inPic = sx >= 0 && sy >= 0 && sx < img.w && sy < img.h;
      const i = (sy * img.w + sx) * 4;
      const al = inPic ? img.data[i + 3] / 255 : 0;
      r += (inPic ? img.data[i] : board[0]) * al; g += (inPic ? img.data[i + 1] : board[1]) * al; b += (inPic ? img.data[i + 2] : board[2]) * al; a += al; n++;
    }
    const cover = a / Math.max(n, 1);
    const o = (y * S + x) * 4;
    if (cover < 0.4) { rgba.set([...board, 255], o); continue; }
    rgba[o] = Math.round(r / a); rgba[o + 1] = Math.round(g / a); rgba[o + 2] = Math.round(b / a); rgba[o + 3] = 255;
  }
  return rgba;
}

// a pixel picture keeps at most ten colours of its own: round to 32-steps, drop the rare, snap the rest
function quantize(rgba, most = 10) {
  const buckets = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const key = [rgba[i], rgba[i + 1], rgba[i + 2]].map(v => Math.min(31, Math.round(v / 8))).join(',');
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let seats = [...buckets.keys()].map(key => ({ key: key.split(',').map(Number), n: buckets.get(key) }));
  seats.sort((a, b) => b.n - a.n);
  while (seats.length > most) {
    const last = seats[seats.length - 1];
    let bestAt = 0, bestD = Infinity;
    for (let k = 0; k < seats.length - 1; k++) {
      const d = last.key.reduce((sum, v, c) => sum + (v - seats[k].key[c]) ** 2, 0);
      if (d < bestD) { bestD = d; bestAt = k; }
    }
    seats[bestAt].n += last.n;
    seats.splice(seats.length - 1, 1);
  }
  for (let i = 0; i < rgba.length; i += 4) {
    const key = [rgba[i], rgba[i + 1], rgba[i + 2]].map(v => Math.min(31, Math.round(v / 8)));
    let best = seats[0], bestD = Infinity;
    for (const seat of seats) {
      const d = key.reduce((sum, v, c) => sum + (v - seat.key[c]) ** 2, 0);
      if (d < bestD) { bestD = d; best = seat; }
    }
    rgba[i] = Math.min(255, best.key[0] * 8 + 4); rgba[i + 1] = Math.min(255, best.key[1] * 8 + 4); rgba[i + 2] = Math.min(255, best.key[2] * 8 + 4);
  }
  return rgba;
}

function buildLogo(brand) {
  if (SPECIAL[brand]) return { brand, board: BOARDS[brand], rgba: Buffer.from(SPECIAL[brand]()).toString('base64') };
  const ref = path.join(ROOT, 'tools/bake/logo-refs', `${brand}.png`);
  const img = readPNG(ref);
  const board = palette[BOARDS[brand]];
  const crop = CROPS[brand];
  const box0 = crop
    ? { x0: crop.x, y0: crop.y, w: crop.w, h: crop.h }
    : subject(img);
  const box = { ...box0, w: Math.min(box0.w, img.w - box0.x0), h: Math.min(box0.h, img.h - box0.y0) };
  const rgba = quantize(downsample(img, box, board));
  return { brand, board: BOARDS[brand], rgba: Buffer.from(rgba).toString('base64') };
}

const logos = BRANDS.map(buildLogo);

const header = `// The chain brands' signboard pictures: each brand's real logo, downsampled to 32×32 from the
// reference in tools/bake/logo-refs/<brand>.png by tools/bake/brand_logos.mjs (which re-creates this
// file). One RGBA picture a brand, the board colour already behind it; the atlas (below) is sampled
// whole by shaders-brands.js. The order is pixelcity/brands.py's TABLE — index.json's brandMarks
// carries it and the page checks the two against each other at boot.
export const BRAND_LOGOS = [`;
const body = logos.map(l => `  { brand: '${l.brand}', board: '${l.board}', rgba: '${l.rgba}' },`).join('\n');
const tail = `];

// 每个品牌一张 32×32 的纹理，按 BRAND_LOGOS 的顺序（=品牌的编号）排好；绘制时按编号取用。
export function brandTextures(gl) {
  const size = 32;
  const textures = BRAND_LOGOS.map((logo, i) => {
    const bytes = Uint8Array.from(atob(logo.rgba), c => c.charCodeAt(0));
    if (bytes.length !== size * size * 4) throw new Error(logo.brand + ' 的招牌画不是 ' + size + '×' + size);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return texture;
  });
  return { textures, count: textures.length };
}
`;
const out = path.join(ROOT, 'app/src/landmarks/brandmarks.js');
fs.writeFileSync(out, `${header}\n${body}\n${tail}`, 'utf8');
console.log(`-> ${out} (${fs.statSync(out).size} bytes)`);
