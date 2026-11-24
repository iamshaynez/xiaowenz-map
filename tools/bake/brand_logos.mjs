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
const SPECIAL = { tastien: () => drawTastien(), lawson: () => drawLawson() };

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

// the atlas: every picture packed side by side, row 0 the top, nearest sampled. Column n of the atlas
// is the logo of the n-th brand of pixelcity/brands.py's TABLE.
export function brandAtlas(gl) {
  const size = 32, columns = BRAND_LOGOS.length;
  const rgba = new Uint8Array(size * size * columns * 4);
  BRAND_LOGOS.forEach((logo, column) => {
    const bin = atob(logo.rgba);
    if (bin.length !== size * size * 4) throw new Error(\`\${logo.brand} 的招牌画不是 \${size}×\${size}\`);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    rgba.set(bytes, column * size * size * 4);
  });
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size * columns, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { texture, columns, size };
}
`;
const out = path.join(ROOT, 'app/src/landmarks/brandmarks.js');
fs.writeFileSync(out, `${header}\n${body}\n${tail}`, 'utf8');
console.log(`-> ${out} (${fs.statSync(out).size} bytes)`);
