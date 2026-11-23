// Compare two folders of still frames (from frames.cjs) pixel for pixel.
//
// Usage: node tools/tests/frames-diff.cjs <before-dir> <after-dir> [--allow 0.005]
//   --allow: the share of a frame's pixels that may differ before the frame counts as changed (default 0.002)
const fs = require('fs');
const path = require('path');
const { readPNG } = require('../review/png.cjs');

const [before, after] = [process.argv[2], process.argv[3]].map(d => path.resolve(d));
const args = process.argv.slice(4);
const allow = args.includes('--allow') ? Number(args[args.indexOf('--allow') + 1]) : 0.002;
if (!before || !after) { console.log('usage: frames-diff.cjs <before-dir> <after-dir> [--allow share]'); process.exit(2); }
const names = fs.readdirSync(before).filter(f => f.endsWith('.png')).sort();
let worst = null, changed = 0, total = 0, differing = 0, missing = 0;
for (const name of names) {
  const file = path.join(after, name);
  if (!fs.existsSync(file)) { missing++; continue; }
  const a = readPNG(path.join(before, name)), b = readPNG(file);
  if (a.w !== b.w || a.h !== b.h) { console.log(`${name}: sizes differ (${a.w}x${a.h} against ${b.w}x${b.h})`); changed++; continue; }
  let diff = 0, max = 0, sum = 0;
  for (let k = 0; k < a.w * a.h; k++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[k * 4 + c] - b.data[k * 4 + c]));
    if (d) { diff++; sum += d; if (d > max) max = d; }
  }
  total += a.w * a.h; differing += diff;
  const share = diff / (a.w * a.h);
  const row = { name, diff, share, max, mean: diff ? sum / diff : 0 };
  if (!worst || row.share > worst.share) worst = row;
  if (share > allow) { changed++; console.log(`${name.padEnd(20)} ${(100 * share).toFixed(2).padStart(6)}% of pixels differ, largest difference ${max}, mean ${row.mean.toFixed(1)}`); }
}
console.log(`${names.length} frames compared: ${changed} changed by more than ${(100 * allow).toFixed(2)}% of their pixels, ${missing} missing; pixels that differ at all: ${(100 * differing / total).toFixed(3)}% of everything;`);
if (worst) console.log(`the frame with the most differences: ${worst.name}, ${(100 * worst.share).toFixed(3)}% of its pixels, largest difference ${worst.max}, mean ${worst.mean.toFixed(1)}`);
process.exitCode = changed || missing ? 1 : 0;
