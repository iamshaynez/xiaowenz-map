// The page on a phone: a small touch screen, held upright and sideways. What is checked: it loads and
// draws at a sensible resolution, the list of places opens from its button, a touch turns the city, two
// fingers zoom it about what is under their middle and pan when they move together, the season buttons
// work, and nothing runs off the side of the page.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/mobile.cjs [out-dir]
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const outDir = path.resolve(root, process.argv[2] || 'out/mobile');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5393;

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// one finger dragged across the canvas: touchStart, moves, touchEnd, through the debugging protocol
async function drag(client, x, y, dx, dy, steps = 8) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let k = 1; k <= steps; k++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * k / steps, y: y + dy * k / steps }] });
    await wait(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// two fingers moving apart around a point: a pinch that zooms in
async function pinch(client, x, y, from, to, steps = 8) {
  const points = spread => [{ x: x - spread, y, id: 1 }, { x: x + spread, y, id: 2 }];
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(from) });
  for (let k = 1; k <= steps; k++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(from + (to - from) * k / steps) });
    await wait(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function run(browser, device, name) {
  const context = await browser.newContext({ ...devices[device] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/app/`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await wait(600);
  const info = await page.evaluate(() => {
    const app = window.__hz, r = app.renderer, canvas = document.getElementById('c');
    return {
      viewport: [innerWidth, innerHeight], coarse: matchMedia('(pointer: coarse)').matches,
      frame: [r.W, r.H], shown: [canvas.clientWidth, canvas.clientHeight], supersampling: r.SS,
      overflow: document.scrollingElement.scrollWidth > innerWidth || document.scrollingElement.scrollHeight > innerHeight,
      toggleVisible: getComputedStyle(document.getElementById('toggle')).display !== 'none',
      listHidden: !document.getElementById('landmarks').checkVisibility(),
      narrow: innerWidth <= 720,
    };
  });
  check(info.coarse, `${name}: a touch screen is recognised`);
  const pixels = info.frame[0] * info.frame[1];
  check(pixels <= 960 * 540 && Math.min(...info.frame) >= 280, `${name}: the frame is ${info.frame}, ${pixels} pixels (at most 960 x 540, and not too coarse)`);
  check(info.supersampling === 2, `${name}: two samples each way on a phone (${info.supersampling})`);
  check(!info.overflow, `${name}: nothing runs off the page`);
  check(info.narrow ? info.toggleVisible && info.listHidden : !info.listHidden, `${name}: the list of places is ${info.narrow ? 'folded behind its button' : 'shown'} (viewport ${info.viewport})`);
  fs.mkdirSync(outDir, { recursive: true });
  await page.screenshot({ path: path.join(outDir, `${name}-start.png`) });

  // the list opens from its button, and a name in it flies the camera
  if (info.narrow) {
    await page.click('#toggle');
    await page.waitForFunction(() => document.getElementById('landmarks').checkVisibility(), null, { timeout: 5000 });
  }
  await page.click('#landmarks button[data-id="1-03"]');
  await page.waitForFunction(() => !window.__hz.flying(), null, { timeout: 20000 });
  const here = await page.evaluate(async () => { await window.__hz.settle(30000); const c = window.__hz.camera, t = window.__hz.ui.target(); return { away: Math.hypot(c.x - t.x, c.y - t.y), scale: c.scale }; });
  check(here.away < 5, `${name}: the flight from the list arrives (${here.away.toFixed(1)} m away)`);
  await page.screenshot({ path: path.join(outDir, `${name}-leifeng.png`) });

  // one finger turns the city
  const client = await context.newCDPSession(page);
  const before = await page.evaluate(() => ({ yaw: window.__hz.camera.yaw, pitch: window.__hz.camera.pitch, scale: window.__hz.camera.scale }));
  const w = info.viewport[0], h = info.viewport[1];
  await drag(client, w * 0.5, h * 0.5, w * 0.25, h * 0.08);
  const after = await page.evaluate(() => ({ yaw: window.__hz.camera.yaw, pitch: window.__hz.camera.pitch, scale: window.__hz.camera.scale }));
  check(Math.abs(after.yaw - before.yaw) > 0.1 && Math.abs(after.pitch - before.pitch) > 0.02, `${name}: a finger drag turns and tilts (yaw ${before.yaw.toFixed(2)} -> ${after.yaw.toFixed(2)}, pitch ${before.pitch.toFixed(2)} -> ${after.pitch.toFixed(2)})`);
  check(Math.abs(after.scale - before.scale) < 1e-6, `${name}: one finger does not zoom`);
  // two fingers zoom, about what is under their middle: it stays there. The view is of a pagoda on a hill
  // and the middle of the page is half-way up it: a zoom taken about the ground under the fingers, as it
  // used to be, leaves the pagoda sliding up the page.
  const middle = { x: w * 0.5, y: h * 0.5 };
  const held = await under(page, middle.x, middle.y);
  await pinch(client, middle.x, middle.y, 40, 140);
  const zoomed = await page.evaluate(() => window.__hz.camera.scale);
  check(zoomed > after.scale * 1.5, `${name}: two fingers spread zoom in (${after.scale.toFixed(2)} -> ${zoomed.toFixed(2)})`);
  await page.evaluate(() => window.__hz.settle(30000));
  const still = await under(page, middle.x, middle.y);
  const slipped = Math.hypot(still.x - held.x, still.y - held.y, still.z - held.z);
  check(slipped < 2, `${name}: what was under the middle of the fingers stays there (${slipped.toFixed(1)} m off; was ${held.z.toFixed(0)} m up)`);
  // two fingers together carry the map along
  const shift = { x: w * 0.12, y: h * 0.1 };
  await move2(client, middle.x, middle.y, 60, shift.x, shift.y);
  await page.evaluate(() => window.__hz.settle(30000));
  const carried = await under(page, middle.x + shift.x, middle.y + shift.y);
  const left = Math.hypot(carried.x - still.x, carried.y - still.y, carried.z - still.z);
  check(left < 3, `${name}: two fingers moving together pan: what was under their middle follows it (${left.toFixed(1)} m off)`);
  await page.screenshot({ path: path.join(outDir, `${name}-zoomed.png`) });
  // seasons by their buttons
  await page.click('#seasons button[data-season="winter"]');
  const season = await page.evaluate(() => document.body.dataset.season);
  check(season === 'winter', name + ': the winter button works');
  await page.screenshot({ path: path.join(outDir, `${name}-winter.png`) });
  check(errors.length === 0, `${name}: no errors (${errors.slice(0, 3).join(' | ')})`);
  console.log(name.padEnd(10), JSON.stringify({ viewport: info.viewport, frame: info.frame, shown: info.shown, yaw: +after.yaw.toFixed(2), zoom: +zoomed.toFixed(2) }));
  await context.close();
}

// two fingers moving together across the canvas: a pan
async function move2(client, x, y, spread, dx, dy, steps = 8) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - spread, y, id: 1 }, { x: x + spread, y, id: 2 }] });
  for (let k = 1; k <= steps; k++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - spread + dx * k / steps, y: y + dy * k / steps, id: 1 }, { x: x + spread + dx * k / steps, y: y + dy * k / steps, id: 2 }] });
    await wait(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// the world point the page draws at a position on the page
const under = (page, x, y) => page.evaluate(({ x, y }) => window.__hz.under(x, y), { x, y });

(async () => {
  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/app/`)).ok) break;
      } catch {
        // not up yet
      }
      await wait(200);
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    await run(browser, 'iPhone 13', 'upright');
    await run(browser, 'Pixel 5 landscape', 'sideways');
  } catch (error) {
    failures.push(String(error.stack || error.message).split('\n').slice(0, 2).join(' '));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  if (failures.length) {
    console.log('MOBILE FAILED');
    failures.forEach(message => console.log('  -', message));
    process.exitCode = 1;
  } else {
    console.log('mobile OK');
  }
})();
