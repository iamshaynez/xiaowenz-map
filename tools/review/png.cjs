// Reading any 8-bit PNG (the browser writes RGB ones) and putting images side by side on a sheet.
const fs = require('fs');
const zlib = require('zlib');
const { encodePNG } = require('../tests/png.cjs');

function readPNG(file) {
  const b = fs.readFileSync(file);
  let at = 8, w, h, idat = [], bpp;
  while (at < b.length) {
    const len = b.readUInt32BE(at), type = b.toString('ascii', at + 4, at + 8), data = b.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9]];
      if (data[8] !== 8 || !bpp) throw new Error('only 8-bit PNGs without palettes');
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, rows = new Uint8Array(w * h * bpp);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), line = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, above = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a; else if (filter === 2) v += above; else if (filter === 3) v += (a + above) >> 1;
      else if (filter === 4) { const p = a + above - c, pa = Math.abs(p - a), pb = Math.abs(p - above), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? above : c; }
      else if (filter !== 0) throw new Error('unknown filter ' + filter);
      line[i] = v & 255;
    }
    rows.set(line, y * stride);
    prev = line;
  }
  const out = new Uint8Array(w * h * 4);
  for (let k = 0; k < w * h; k++) {
    const grey = bpp < 3;
    out[k * 4] = rows[k * bpp];
    out[k * 4 + 1] = grey ? rows[k * bpp] : rows[k * bpp + 1];
    out[k * 4 + 2] = grey ? rows[k * bpp] : rows[k * bpp + 2];
    out[k * 4 + 3] = bpp === 4 || bpp === 2 ? rows[k * bpp + (grey ? 1 : 3)] : 255;
  }
  return { w, h, data: out };
}

// nearest-neighbour resize
function resize(image, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const src = (Math.min(image.h - 1, (y * image.h / h) | 0) * image.w + Math.min(image.w - 1, (x * image.w / w) | 0)) * 4;
    out.set(image.data.subarray(src, src + 4), (y * w + x) * 4);
  }
  return { w, h, data: out };
}

// the middle of an image, cut to width x height without scaling
function crop(image, w, h) {
  const left = (image.w - w) >> 1, top = (image.h - h) >> 1, out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(image.data.subarray(((top + y) * image.w + left) * 4, ((top + y) * image.w + left + w) * 4), y * w * 4);
  return { w, h, data: out };
}

// images laid out in rows of `cols`, each cut to a cell of width x height (centre crop), on white
function sheet(images, cols, width, height) {
  const rows = Math.ceil(images.length / cols);
  const out = new Uint8Array(cols * width * rows * height * 4).fill(255);
  images.forEach((file, k) => {
    const image = readPNG(file);
    const scale = Math.max(width / image.w, height / image.h);         // cover the cell
    const w = Math.ceil(image.w * scale), h = Math.ceil(image.h * scale);
    const fitted = resize(image, w, h);
    const left = (w - width) >> 1, top = (h - height) >> 1;
    const cx = (k % cols) * width, cy = ((k / cols) | 0) * height;
    for (let y = 0; y < height; y++) {
      const src = ((top + y) * w + left) * 4, dst = ((cy + y) * cols * width + cx) * 4;
      out.set(fitted.data.subarray(src, src + width * 4), dst);
    }
  });
  return encodePNG(cols * width, rows * height, out);
}

module.exports = { readPNG, resize, crop, sheet, encodePNG };
