// Cuts a piece out of a screenshot and enlarges it in whole pixels, so that a vision model (or a person) can
// look at street level. Usage: node tools/review/crop.cjs <in.png> <out.png> <x> <y> <width> <height> [times]
const fs = require('fs');
const { readPNG, encodePNG } = require('./png.cjs');

const [input, output, x, y, width, height, times = '1'] = process.argv.slice(2);
const image = readPNG(input), t = Number(times);
const out = new Uint8Array(width * t * height * t * 4);
for (let j = 0; j < height * t; j++) for (let i = 0; i < width * t; i++) {
  const src = ((Math.min(image.h - 1, +y + (j / t | 0))) * image.w + Math.min(image.w - 1, +x + (i / t | 0))) * 4;
  out.set(image.data.subarray(src, src + 4), (j * width * t + i) * 4);
}
fs.writeFileSync(output, encodePNG(width * t, height * t, out));
console.log(output, `${width * t}x${height * t}`);
