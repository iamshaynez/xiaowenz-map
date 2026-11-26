// Shadows, checked against the sun's geometry rather than by looking at pictures.
//
// A made-up tile (flat ground, a few boxes, a tree) is drawn by the real renderer from
// tests/pages/shadows-page.js, once with shadows and once without: every pixel whose colour changes is
// in shade. For every ground pixel the test works out on its own whether the line towards the sun
// passes through one of the boxes, and the two must agree to within a couple of pixels (the shadow
// map has about one texel per pixel). Since D093 the walls and roofs take the shadows that fall on them
// (they never used to); how many of their own pixels end up shaded is reported, not gated — what stays
// gated is the ground's shadow against the analytic answer.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/shadows.cjs [out-dir]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { encodePNG } = require('./png.cjs');

const root = path.resolve(__dirname, '../..');
const outDir = path.resolve(root, process.argv[2] || 'out/shadows');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5396;
const W = 640, H = 400, SS = 2;
const TOLERANCE_PX = 2;
const DEGREES = Math.PI / 180;

const CAMERAS = {
  home: { x: 25, y: 0, yaw: 0, pitch: 30 * DEGREES, scale: 4 },
  turned: { x: 20, y: 20, yaw: 1.2, pitch: 55 * DEGREES, scale: 2 },
};
const CASES = [
  { name: 'one-tower', camera: CAMERAS.home, boxes: [{ x0: -10, y0: -10, x1: 10, y1: 10, base: 0, top: 30 }], trees: [] },
  { name: 'slab-and-shed-turned', camera: CAMERAS.turned, boxes: [
    { x0: -40, y0: -5, x1: 10, y1: 5, base: 0, top: 60 },
    { x0: 20, y0: -30, x1: 45, y1: -10, base: 0, top: 6 },
  ], trees: [] },
];

// the camera's projection, as the app has it
function unproject(cam, sx, sy) {
  const u = (sx - W / 2) / cam.scale, v = -(((sy - H / 2) / cam.scale) / Math.sin(cam.pitch));
  const rx = (u + v) * Math.SQRT1_2, ry = (v - u) * Math.SQRT1_2;
  return { x: cam.x + rx * Math.cos(cam.yaw) + ry * Math.sin(cam.yaw), y: cam.y - rx * Math.sin(cam.yaw) + ry * Math.cos(cam.yaw) };
}
function project(cam, x, y, z) {
  const dx = x - cam.x, dy = y - cam.y, rx = dx * Math.cos(cam.yaw) - dy * Math.sin(cam.yaw), ry = dx * Math.sin(cam.yaw) + dy * Math.cos(cam.yaw);
  const u = (rx - ry) * Math.SQRT1_2, v = (rx + ry) * Math.SQRT1_2;
  return { sx: W / 2 + u * cam.scale, sy: H / 2 - (v * Math.sin(cam.pitch) + z * Math.cos(cam.pitch)) * cam.scale };
}

// the sun in world axes for a camera: where the foot of a shadow moves per metre of height
function shadowDirection(cam, shadow) {
  const a = (shadow[0] + shadow[1]) * Math.SQRT1_2, b = (shadow[1] - shadow[0]) * Math.SQRT1_2;
  return { x: a * Math.cos(cam.yaw) + b * Math.sin(cam.yaw), y: -a * Math.sin(cam.yaw) + b * Math.cos(cam.yaw) };
}

function analyticShadow(cam, shadow, boxes, x, y) {
  const d = shadowDirection(cam, shadow);
  return boxes.some(box => {
    const step = Math.min(0.25, (box.top - box.base) / 400);
    for (let h = 0; h <= box.top - box.base + 1e-9; h += step) {
      const px = x - d.x * h, py = y - d.y * h;
      if (px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1) return true;
    }
    return false;
  });
}

function dilate(mask, radius) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    for (let j = Math.max(0, y - radius); j <= Math.min(H - 1, y + radius); j++) out.fill(1, j * W + Math.max(0, x - radius), j * W + Math.min(W, x + radius + 1));
  }
  return out;
}

// shaded and expected on the ground -> how many pixels lie outside the other's tolerance
function compare(rendered, expected, ground) {
  const a = new Uint8Array(W * H), b = new Uint8Array(W * H);
  let count = 0;
  for (let k = 0; k < W * H; k++) {
    if (!ground[k]) continue;
    a[k] = rendered[k] > 100 ? 1 : 0;
    b[k] = expected[k] ? 1 : 0;
    count += a[k] | b[k];
  }
  const bigA = dilate(a, TOLERANCE_PX), bigB = dilate(b, TOLERANCE_PX);
  let extra = 0, missing = 0;
  for (let k = 0; k < W * H; k++) {
    if (a[k] && !bigB[k]) extra++;
    if (b[k] && !bigA[k]) missing++;
  }
  return { shadowPixels: count, extra, missing, share: (extra + missing) / Math.max(1, count) };
}

// the tree: its crown where the projection puts it, its shadow where the ellipse says. It is a camphor:
// at this zoom it is drawn in its detailed form, the crown 15% larger than its radius, sitting 1.1 radii
// (and 30% more for the detail) above the ground, with an outline made lumpy by noise to about an eighth
// of its radius. Its shadow is the circle of its radius thrown from the crown's centre (aloneShade: no
// box is expected to shade anything else)
function checkTree(cam, shadow, tree, cls, mask, aloneShade = true) {
  const lift = tree.radius * 1.1 * 1.3;
  const centre = project(cam, tree.x, tree.y, tree.z + lift);
  const radius = Math.max(tree.radius * cam.scale, 0.75) * 1.15;
  const d = shadowDirection(cam, shadow);
  const ellipse = project(cam, tree.x + d.x * lift, tree.y + d.y * lift, tree.z);
  const rx = tree.radius * cam.scale * 1.05, ry = rx * Math.sin(cam.pitch) + 1;
  const out = { crownInside: 0, crownInsideWrong: 0, crownOutside: 0, crownOutsideWrong: 0, shadeInside: 0, shadeInsideWrong: 0, shadeOutside: 0, shadeOutsideWrong: 0 };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x, kind = cls[k * 4 + 1], ground = cls[k * 4] > 127;
    const crownDistance = Math.hypot(x + 0.5 - centre.sx, y + 0.5 - centre.sy) / radius;
    if (crownDistance < 0.84) { out.crownInside++; if (kind !== 3) out.crownInsideWrong++; }
    if (crownDistance > 1.14) { out.crownOutside++; if (kind === 3) out.crownOutsideWrong++; }
    if (!ground) continue;
    const e = Math.hypot((x + 0.5 - ellipse.sx) / rx, (y + 0.5 - ellipse.sy) / ry);
    const shaded = mask[k] > 100;
    if (e < 0.8) { out.shadeInside++; if (!shaded) out.shadeInsideWrong++; }
    if (aloneShade && e > 1.25 && Math.hypot(x + 0.5 - centre.sx, y + 0.5 - centre.sy) > radius + 2) { out.shadeOutside++; if (shaded) out.shadeOutsideWrong++; }
  }
  return out;
}

function meanLuminance(color, cls) {
  let sum = 0, count = 0;
  for (let k = 0; k < W * H; k++) {
    if (cls[k * 4 + 1] !== 3 || cls[k * 4] > 127) continue;
    sum += 0.3 * color[k * 4] + 0.59 * color[k * 4 + 1] + 0.11 * color[k * 4 + 2];
    count++;
  }
  return count ? sum / count : 0;
}

const decode = text => Uint8Array.from(Buffer.from(text, 'base64'));
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/tests/pages/shadows.html`)).ok) break;
      } catch {
        // not up yet
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/tests/pages/shadows.html`);
    await page.waitForFunction(() => window.shadowsReady === true, null, { timeout: 30000 });
    const run = args => page.evaluate(args => window.runShadows({ W: 640, H: 400, SS: 2, shadows: true, ...args }), args);

    for (const test of CASES) {
      const result = await run({ camera: test.camera, boxes: test.boxes, trees: test.trees });
      check(result.glError === 0, `${test.name}: WebGL error ${result.glError}`);
      const shaded = decode(result.shaded), cls = decode(result.cls), color = decode(result.color);
      const ground = new Uint8Array(W * H), expected = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x;
        ground[k] = cls[k * 4] > 127 && cls[k * 4 + 3] > 127 ? 1 : 0;
        if (!ground[k]) continue;
        const p = unproject(test.camera, x + 0.5, y + 0.5);
        expected[k] = analyticShadow(test.camera, result.shadow, test.boxes, p.x, p.y) ? 1 : 0;
      }
      const report = compare(shaded, expected, ground);
      let wallsShaded = 0, walls = 0;
      for (let k = 0; k < W * H; k++) if (cls[k * 4 + 3] > 127 && !ground[k]) { walls++; if (shaded[k]) wallsShaded++; }
      console.log(test.name.padEnd(30), JSON.stringify({ ...report, wallsShaded, walls }));
      if (process.env.ASCII) {
        // a coarse map: '#' both, 'r' rendered only, 'e' expected only, '.' open ground, ' ' not ground
        for (let y = 0; y < H; y += 10) {
          let row = '';
          for (let x = 0; x < W; x += 6) {
            const k = y * W + x;
            row += !ground[k] ? ' ' : (shaded[k] && expected[k]) ? '#' : shaded[k] ? 'r' : expected[k] ? 'e' : '.';
          }
          console.log(row);
        }
      }
      check(report.share < 0.01, `${test.name}: ${report.extra} extra and ${report.missing} missing of ${report.shadowPixels} shadow pixels`);
      // D093: walls take shadows now (their own far side included), so this only reports
      console.log(`  (walls shaded: ${wallsShaded} of ${walls})`);
      // a picture with the expected shadow outlined in magenta over the render, to look at when it fails
      const sheet = new Uint8Array(color);
      const edge = dilate(expected, 1);
      for (let k = 0; k < W * H; k++) if (edge[k] && !expected[k]) sheet.set([255, 0, 255, 255], k * 4);
      fs.writeFileSync(path.join(outDir, `${test.name}.png`), encodePNG(W, H, sheet));
    }

    // the tree, alone; then the same tree with a tower whose shade falls on it
    const tree = [{ x: 0, y: 0, z: 0, species: 0, radius: 5, seed: 7 }];
    const treeCamera = { x: 15, y: 0, yaw: 0, pitch: 30 * DEGREES, scale: 4 };
    const alone = await run({ camera: treeCamera, boxes: [], trees: tree });
    const underTower = await run({ camera: treeCamera, boxes: [{ x0: -45, y0: -8, x1: -27, y1: 8, base: 0, top: 40 }], trees: tree });   // the tower stands far enough west that, seen from the south-west, it no longer fronts the crown, and its shade still reaches the tree
    for (const [name, result] of [['tree', alone], ['tree-in-shade', underTower]]) {
      check(result.glError === 0, `${name}: WebGL error ${result.glError}`);
      const report = checkTree(treeCamera, result.shadow, tree[0], decode(result.cls), decode(result.shaded), name === 'tree');
      console.log(name.padEnd(30), JSON.stringify(report));
      check(report.crownInside > 500 && report.crownInsideWrong === 0, `${name}: the crown is not where the projection puts it`);
      check(report.crownOutsideWrong === 0, `${name}: crown pixels outside the crown`);
      check(report.shadeInside > 200 && report.shadeInsideWrong / report.shadeInside < 0.02, `${name}: the tree's shadow is not where its ellipse should be`);
      if (name === 'tree') check(report.shadeOutsideWrong / Math.max(1, report.shadeOutside) < 0.002, `${name}: shadow where the tree casts none`);
      fs.writeFileSync(path.join(outDir, `${name}.png`), encodePNG(W, H, decode(result.color)));
    }
    // ...and beside a low shed to the east of it, whose footprint in the sun's picture covers the crown's
    // column: only the depth in that column can tell that the crown, higher than the shed and west of
    // it, is in the sun
    const besideShed = await run({ camera: treeCamera, boxes: [{ x0: 1.5, y0: -4, x1: 8, y1: 4, base: 0, top: 3 }], trees: tree });
    const lit = meanLuminance(decode(alone.color), decode(alone.cls)), dark = meanLuminance(decode(underTower.color), decode(underTower.cls));
    const beside = meanLuminance(decode(besideShed.color), decode(besideShed.cls));
    console.log('crown luminance'.padEnd(30), JSON.stringify({ lit: +lit.toFixed(1), inShade: +dark.toFixed(1), besideAShed: +beside.toFixed(1) }));
    check(dark < 0.8 * lit, 'a tree standing in a building\'s shade should be darker than one in the sun');
    check(beside > 0.95 * lit, 'a crown above a low shed to its east is in the sun: the depth in the shadow map must be told apart');
    check(errors.length === 0, `page errors: ${errors.slice(0, 5).join(' | ')}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch(error => {
  failures.push(String(error.message).split('\n')[0]);
}).finally(() => {
  if (failures.length) {
    console.log('SHADOWS FAILED');
    failures.forEach(message => console.log('  -', message));
    process.exitCode = 1;
  } else {
    console.log('shadows OK');
  }
});
