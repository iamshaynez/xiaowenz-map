// Close views of the landmarks from the tour's frames, for looking at them without a magnifying glass:
// the middle of each landmark's first frame, enlarged, four to a sheet.
// Usage: node tools/review/focus.cjs
const fs = require('fs');
const path = require('path');
const { readPNG, resize, sheet, encodePNG } = require('./png.cjs');

const root = path.resolve(__dirname, '../..');
const frames = path.join(root, 'out/review/landmarks');
const out = path.join(root, 'out/review/focus');
const sheets = path.join(root, 'docs/REVIEW');
fs.mkdirSync(out, { recursive: true });
const ids = [...new Set(fs.readdirSync(frames).map(f => f.replace(/-\d\.png$/, '')))].sort();
const focus = ids.map(id => {
  const image = readPNG(path.join(frames, `${id}-0.png`));
  const cut = { w: 480, h: 270, data: new Uint8Array(480 * 270 * 4) };
  for (let y = 0; y < 270; y++) cut.data.set(image.data.subarray(((y + 90) * image.w + 240) * 4, ((y + 90) * image.w + 240) * 4 + 480 * 4), y * 480 * 4);
  const file = path.join(out, `${id}.png`);
  fs.writeFileSync(file, encodePNG(960, 540, resize(cut, 960, 540).data));
  return file;
});
for (let k = 0; k * 4 < focus.length; k++) {
  fs.writeFileSync(path.join(sheets, `focus-${k + 1}.png`), sheet(focus.slice(k * 4, k * 4 + 4), 2, 640, 360));
}
console.log(`${focus.length} close views; ${Math.ceil(focus.length / 4)} sheets`);
