// The wheel zooms about what is under the cursor: the thing drawn there (the ground, a hill, a roof) stays
// under the cursor while the zoom changes.
//
// Two things went wrong before. The cursor's position was taken in CSS pixels and used as if it were the
// frame's own pixels: on a desktop each of the frame's pixels is two CSS pixels, so the anchor was twice
// too far from the corner (with the cursor at the centre of the page, the zoom turned about the bottom
// right corner). And the anchor was the point at ground level under the cursor, so whatever stood on that
// ground (a hill, a tall roof) slid up the page as the zoom came in.
//
// Checked on the default pixel size of a desktop page (细: one CSS pixel to a frame pixel), with the cursor
// on a roof, on a hill with nothing on it, and on the lake; zooming in and out; once at a page where a
// frame pixel is two CSS pixels (?px=1, the old default), and once where it is one (a small page).
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/zoom-anchor.cjs
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5391;
const OFF_PX = 1.5;                        // how far the point under the cursor may move, in frame pixels

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// put the cursor on a world point, turn the wheel there, and say how far that point moved on the page
async function zoomUnder(page, point, deltaY) {
  const at = await page.evaluate(async point => {
    const app = window.__city, c = app.camera;
    await app.settle(30000);
    const p = c.project(point.x, point.y, point.z), shown = app.renderer.W / document.getElementById('c').clientWidth;
    return { cssX: p.sx / shown, cssY: p.sy / shown, sx: p.sx, sy: p.sy, scale: c.scale };
  }, point);
  await frames(page);
  await page.mouse.move(at.cssX, at.cssY);
  await page.mouse.wheel(0, deltaY);
  await frames(page);
  const after = await page.evaluate(async point => {
    const app = window.__city;
    await app.settle(30000);
    const p = app.camera.project(point.x, point.y, point.z);
    return { sx: p.sx, sy: p.sy, scale: app.camera.scale, errors: app.gl.getError() };
  }, point);
  return { moved: Math.hypot(after.sx - at.sx, after.sy - at.sy), from: at.scale, to: after.scale, gl: after.errors };
}

async function run(browser, viewport, name, checks, query = '', expectedCss = 1) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/hz${query}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  const css = await page.evaluate(() => document.getElementById('c').clientWidth / document.getElementById('c').width);
  check(css === expectedCss, `${name}: each of the frame's pixels is shown as ${css} CSS pixels`);
  const rows = [];
  let point = null;
  for (const [label, setup, deltaY] of checks) {
    if (setup) point = await page.evaluate(setup);          // no setup: the cursor goes back to the same point
    const r = await zoomUnder(page, point, deltaY);
    rows.push(`${label.padEnd(30)} cursor at the point, wheel ${deltaY > 0 ? 'out' : 'in '} ${deltaY}: ${r.from.toFixed(3)} -> ${r.to.toFixed(3)} px/m, the point moved ${r.moved.toFixed(2)} px`);
    check(r.moved <= OFF_PX, `${name}: ${label}: the point under the cursor moved ${r.moved.toFixed(2)} px (at most ${OFF_PX})`);
    check(r.gl === 0, `${name}: ${label}: no graphics error (${r.gl})`);
  }
  console.log(rows.join('\n'));
  check(errors.length === 0, `${name}: no page errors (${errors.slice(0, 3).join(' | ')})`);
  await page.close();
}

// where the camera is put and the point the cursor will be on, for each check
const TO_LEIFENG_TOP = async () => {
  const app = window.__city;
  app.camera.yaw = 0;
  app.flyTo('1-03', 0);
  for (let k = 0; k < 400 && app.flying(); k++) await new Promise(resolve => setTimeout(resolve, 50));
  app.freeze(true);
  const landmark = app.landmarks.find(l => l.id === '1-03');
  return { x: landmark.x, y: landmark.y, z: landmark.ground - landmark.bed + landmark.parts[0].top };    // the top of its spire
};
const TO_HILL = async () => {
  // the highest ground of the overview, with nothing drawn on it: neither trees nor buildings
  const app = window.__city, r = app.renderer;
  r.drawTrees = r.drawLife = r.drawRoofs = () => {};
  r.landmarks = [];
  const g = app.world.overview.grid;
  let best = 0;
  for (let k = 1; k < g.heights.length; k++) if (g.heights[k] > g.heights[best]) best = k;
  const x = g.x0 + ((best % g.nx) + 0.5) * g.cell, y = g.y0 + (Math.floor(best / g.nx) + 0.5) * g.cell;
  app.camera.yaw = 0;
  Object.assign(app.camera, { x, y, scale: 0.5, pitch: Math.PI / 6 });
  app.freeze(true);
  await app.settle(30000);
  return { x, y, z: app.world.groundAt(x, y) };
};
const TO_LAKE = async () => {
  // whatever is drawn at the middle of a view over the lake near the Small Yingzhou island (water, a tree
  // of the island, a boat): the point is read the way the zoom reads it, so this checks that a zoom keeps
  // still, whatever it is holding on to
  const app = window.__city;
  const island = app.landmarks.find(l => l.id === '1-04');
  app.camera.yaw = 0;
  Object.assign(app.camera, { x: island.x + 150, y: island.y + 150, scale: 1.2, pitch: Math.PI / 6 });
  app.freeze(true);
  await app.settle(30000);
  const canvas = document.getElementById('c'), box = canvas.getBoundingClientRect();
  return app.under(box.left + box.width / 2, box.top + box.height / 2);
};

(async () => {
  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/hz`)).ok) break;
      } catch {
        // not up yet
      }
      await wait(200);
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    // a desktop page: 1920 x 1080, the frame as wide as the page (细, the default), one CSS pixel to a frame pixel
    await run(browser, { width: 1920, height: 1080 }, 'desktop', [
      ['the top of Leifeng Pagoda', TO_LEIFENG_TOP, -300],
      ['the top of Leifeng Pagoda', null, 300],
      ['a bare hilltop', TO_HILL, -300],
      ['the bare hilltop', null, 300],
      ['whatever is over the lake', TO_LAKE, -300],
    ]);
    // the same page at the old default (?px=1): the frame 960 x 540, two CSS pixels to a frame pixel
    await run(browser, { width: 1920, height: 1080 }, 'desktop ?px=1', [
      ['the top of Leifeng Pagoda', TO_LEIFENG_TOP, -300],
      ['a bare hilltop', TO_HILL, -300],
    ], '?px=1', 2);
    // a small page: 960 x 540, one CSS pixel to a frame pixel
    await run(browser, { width: 960, height: 540 }, 'small', [
      ['the top of Leifeng Pagoda', TO_LEIFENG_TOP, -300],
      ['a bare hilltop', TO_HILL, -300],
    ]);
  } catch (error) {
    failures.push(String(error.stack || error.message).split('\n').slice(0, 3).join(' '));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  if (failures.length) {
    console.log('ZOOM ANCHOR FAILED');
    failures.forEach(message => console.log('  -', message));
    process.exitCode = 1;
  } else {
    console.log('zoom anchor OK');
  }
})();
