// The mouse: the left button drags the map along, the right button turns and tilts the view (D055).
//
// Checked: with the left button what was taken hold of stays under the pointer, and the view does not turn;
// with the right button the view turns by how far the pointer went across and tilts by how far it went down,
// and the map does not move; the right button brings no menu of its own; once the map has been dragged the
// view no longer turns about a landmark that was flown to. On a desktop page (two CSS pixels to a frame
// pixel) and on a small one.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/mouse.cjs
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5390;
const OFF_PX = 1.5;                 // how far what was taken hold of may be from the pointer, in frame pixels
const ACROSS = 0.006, DOWN = 0.005; // radians per CSS pixel, as the page has them

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const pose = page => page.evaluate(() => { const c = window.__city.camera; return { x: c.x, y: c.y, yaw: c.yaw, pitch: c.pitch, scale: c.scale }; });
const under = (page, x, y) => page.evaluate(({ x, y }) => window.__city.under(x, y), { x, y });

// press a button at one point, move to another with it held, let go; -> what was under the pointer at the start
async function drag(page, button, from, to, steps = 8) {
  const held = await under(page, from.x, from.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down({ button });
  await page.mouse.move(to.x, to.y, { steps });
  await page.mouse.up({ button });
  await page.evaluate(() => window.__city.settle(30000));
  return held;
}

async function run(browser, viewport, name) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/hz`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  const [w, h] = [viewport.width, viewport.height], middle = { x: w / 2, y: h / 2 };
  await page.evaluate(async () => {
    window.__city.flyTo('1-03', 0);
    for (let k = 0; k < 400 && window.__city.flying(); k++) await new Promise(resolve => setTimeout(resolve, 50));
    window.__city.freeze(true);
    await window.__city.settle(30000);
    // whether the browser would show a menu for the right button on the canvas (it runs after the page's own
    // listener, which asks it not to)
    window.__city.menu = null;
    document.getElementById('c').addEventListener('contextmenu', e => { window.__city.menu = !e.defaultPrevented; });
  });

  // the left button: the map follows the pointer
  for (const [label, to] of [['down and to the right', { x: middle.x + 240, y: middle.y + 120 }], ['up and to the left', { x: middle.x - 300, y: middle.y - 90 }]]) {
    const before = await pose(page);
    const held = await drag(page, 'left', middle, to);
    const after = await pose(page), at = await page.evaluate(p => { const c = window.__city.camera.project(p.x, p.y, p.z); return { x: c.sx, y: c.sy }; }, held);
    const css = await page.evaluate(() => document.getElementById('c').clientWidth / window.__city.renderer.W);
    const off = Math.hypot(at.x * css - to.x, at.y * css - to.y);
    check(off <= OFF_PX, `${name}: left drag ${label}: what was taken hold of is under the pointer (${off.toFixed(2)} px off)`);
    check(before.yaw === after.yaw && before.pitch === after.pitch && before.scale === after.scale, `${name}: left drag ${label}: the view does not turn (yaw ${before.yaw} -> ${after.yaw}, pitch ${before.pitch.toFixed(3)} -> ${after.pitch.toFixed(3)})`);
    check(Math.hypot(after.x - before.x, after.y - before.y) > 1, `${name}: left drag ${label}: the map moves`);
  }

  // the right button: the view turns and tilts, and the map stays where it is
  const before = await pose(page);
  const to = { x: middle.x + 240, y: middle.y + 60 };
  await page.mouse.move(middle.x, middle.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  await page.evaluate(() => window.__city.settle(30000));
  const after = await pose(page);
  const wantYaw = before.yaw - 240 * ACROSS, wantPitch = before.pitch + 60 * DOWN;
  check(Math.abs(after.yaw - wantYaw) < 1e-6, `${name}: right drag: the view turns with the pointer (${(after.yaw - before.yaw).toFixed(3)} rad, expected ${(wantYaw - before.yaw).toFixed(3)})`);
  check(Math.abs(after.pitch - wantPitch) < 1e-6, `${name}: right drag: the view tilts with the pointer (${(after.pitch - before.pitch).toFixed(3)} rad, expected ${(wantPitch - before.pitch).toFixed(3)})`);
  check(after.x === before.x && after.y === before.y && after.scale === before.scale, `${name}: right drag: the map stays where it is`);
  const menu = await page.evaluate(() => window.__city.menu);
  check(menu === false, `${name}: the right button brings no menu (seen as ${menu})`);
  console.log(`${name.padEnd(8)} left drag: the point taken hold of follows the pointer; right drag: yaw ${(after.yaw - before.yaw).toFixed(2)} rad, pitch ${(after.pitch - before.pitch).toFixed(2)} rad`);
  check(errors.length === 0, `${name}: no page errors (${errors.slice(0, 3).join(' | ')})`);
  await page.close();
}

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
    await run(browser, { width: 1920, height: 1080 }, 'desktop');
    await run(browser, { width: 960, height: 540 }, 'small');
  } catch (error) {
    failures.push(String(error.stack || error.message).split('\n').slice(0, 3).join(' '));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  if (failures.length) {
    console.log('MOUSE FAILED');
    failures.forEach(message => console.log('  -', message));
    process.exitCode = 1;
  } else {
    console.log('mouse OK');
  }
})();
