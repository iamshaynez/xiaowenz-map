// The page on a phone: a small touch screen, held upright and sideways. What is checked: it loads and
// draws at a sensible resolution, the list of places opens from its button, a touch drags the map along,
// two fingers zoom about what is under their middle and turn the city when they move together, the season
// buttons work, and nothing runs off the side of the page.
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
const OFF_PX = 1.5;            // how far what was taken hold of may be from the finger, in CSS pixels

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
  await page.goto(`http://127.0.0.1:${PORT}/hz`);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await wait(600);
  const info = await page.evaluate(() => {
    const app = window.__city, r = app.renderer, canvas = document.getElementById('c');
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
  await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 20000 });
  const here = await page.evaluate(async () => { await window.__city.settle(30000); const c = window.__city.camera, t = window.__city.ui.target(); return { away: Math.hypot(c.x - t.x, c.y - t.y), scale: c.scale }; });
  check(here.away < 5, `${name}: the flight from the list arrives (${here.away.toFixed(1)} m away)`);
  await page.screenshot({ path: path.join(outDir, `${name}-leifeng.png`) });

  // one finger drags the map along: what was taken hold of stays under it, and the view does not turn
  const client = await context.newCDPSession(page);
  const before = await page.evaluate(() => ({ yaw: window.__city.camera.yaw, pitch: window.__city.camera.pitch, scale: window.__city.camera.scale }));
  const w = info.viewport[0], h = info.viewport[1];
  const heldAt = { x: w * 0.5, y: h * 0.5 };
  const grabbed = await under(page, heldAt.x, heldAt.y);
  await drag(client, heldAt.x, heldAt.y, w * 0.25, h * 0.08);
  await page.evaluate(() => window.__city.settle(30000));
  const after = await page.evaluate(() => ({ yaw: window.__city.camera.yaw, pitch: window.__city.camera.pitch, scale: window.__city.camera.scale }));
  const followed = await projectedOff(page, grabbed, heldAt.x + w * 0.25, heldAt.y + h * 0.08);
  check(followed < OFF_PX, `${name}: a finger drag pans: what was under the finger follows it (${followed.toFixed(2)} px off)`);
  check(after.yaw === before.yaw && after.pitch === before.pitch, `${name}: a finger drag does not turn the view (yaw ${before.yaw.toFixed(2)} -> ${after.yaw.toFixed(2)}, pitch ${before.pitch.toFixed(2)} -> ${after.pitch.toFixed(2)})`);
  check(after.scale === before.scale, `${name}: one finger does not zoom`);
  // two fingers zoom, about what is under their middle: it stays there. The view is of a pagoda on a hill
  // and the middle of the page is half-way up it: a zoom taken about the ground under the fingers, as it
  // used to be, leaves the pagoda sliding up the page.
  const middle = { x: w * 0.5, y: h * 0.5 };
  const held = await under(page, middle.x, middle.y);
  await pinch(client, middle.x, middle.y, 40, 140);
  const zoomed = await page.evaluate(() => window.__city.camera.scale);
  check(zoomed > after.scale * 1.5, `${name}: two fingers spread zoom in (${after.scale.toFixed(2)} -> ${zoomed.toFixed(2)})`);
  await page.evaluate(() => window.__city.settle(30000));
  // measured by where the held point now lands on the page, not by what the page draws under the middle
  // now: zooming in brings a different slope or wall under the middle, and asking the page what is there
  // would compare two different surfaces
  const slipped = await projectedOff(page, held, middle.x, middle.y);
  check(slipped < OFF_PX, `${name}: what was under the middle of the fingers stays there (${slipped.toFixed(2)} px off; it was ${held.z.toFixed(0)} m up)`);
  // two fingers moving together turn the city and tilt it, and the map does not move
  const shift = { x: w * 0.12, y: h * 0.1 };
  const centre = await page.evaluate(() => { const c = window.__city.camera; return { x: c.x, y: c.y, yaw: c.yaw, pitch: c.pitch, scale: c.scale }; });
  await move2(client, middle.x, middle.y, 60, shift.x, shift.y);
  await page.evaluate(() => window.__city.settle(30000));
  const turned = await page.evaluate(() => { const c = window.__city.camera; return { x: c.x, y: c.y, yaw: c.yaw, pitch: c.pitch, scale: c.scale }; });
  check(Math.abs(turned.yaw - (centre.yaw + shift.x * 0.006)) < 1e-4, `${name}: two fingers moving together turn the view (${(turned.yaw - centre.yaw).toFixed(3)} rad, expected ${(shift.x * 0.006).toFixed(3)})`);
  check(Math.abs(turned.pitch - (centre.pitch + shift.y * 0.005)) < 1e-4, `${name}: two fingers moving together tilt the view (${(turned.pitch - centre.pitch).toFixed(3)} rad, expected ${(shift.y * 0.005).toFixed(3)})`);
  check(Math.abs(turned.x - centre.x) < 1e-3 && Math.abs(turned.y - centre.y) < 1e-3 && Math.abs(turned.scale - centre.scale) < 1e-5,
    `${name}: two fingers moving together do not move the map (${Math.hypot(turned.x - centre.x, turned.y - centre.y).toExponential(1)} m, scale ${(turned.scale - centre.scale).toExponential(1)})`);
  await page.screenshot({ path: path.join(outDir, `${name}-zoomed.png`) });
  // seasons by their buttons
  await page.click('#seasons button[data-season="winter"]');
  const season = await page.evaluate(() => document.body.dataset.season);
  check(season === 'winter', name + ': the winter button works');
  await page.screenshot({ path: path.join(outDir, `${name}-winter.png`) });

  // 走进城市（手机版 GTA 的手势）：左半边摇杆走人推满跑，右半边拖动看四周，双指各司其职同时进行，
  // 右下的圆钮上车；驾驶时摇杆推上是油门、左右是转向，松手视线自己回正
  const entered = await page.evaluate(() => {
    const app = window.__city, walk = app.walk;
    let ok = walk.toggle();
    if (!ok) {
      const p = app.camera.unproject(app.camera.width / 2, app.camera.height / 2);
      const near = app.world.roadsNear(p.x, p.y, 400);
      ok = near ? walk.enterAt(near.x, near.y) : false;
    }
    return ok && walk.active;
  });
  check(entered, `${name}: 走进城市在触屏上落得了脚`);
  if (entered) {
    await page.evaluate(() => window.__city.settle(20000));
    await wait(400);
    const stickAt = { x: 70, y: info.viewport[1] - 220 };
    // 一根拇指：按下出摇杆，推到头跑起来
    const who0 = await page.evaluate(() => ({ ...window.__city.walk.player }));
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stickAt.x, y: stickAt.y }] });
    await wait(80);
    check(await page.evaluate(() => !document.getElementById('stick').hidden), `${name}: 摇杆随拇指出现在按下处`);
    for (let k = 1; k <= 6; k++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: stickAt.x, y: stickAt.y - 62 * k / 6 }] });
      await wait(40);
    }
    await wait(700);
    const walked = await page.evaluate(({ x0, y0 }) => Math.hypot(window.__city.walk.player.x - x0, window.__city.walk.player.y - y0), { x0: who0.x, y0: who0.y });
    check(walked > 1.5, `${name}: 摇杆推满跑起来（${walked.toFixed(1)} 米/0.9 秒）`);
    // 双指：拇指按着摇杆，另一指在右半边拖动看四周——两条同时进行
    const yaw0 = await page.evaluate(() => window.__city.camera.yaw);
    const lookAt = { x: info.viewport[0] * 0.72, y: info.viewport[1] * 0.4 };
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stickAt.x, y: stickAt.y - 62, id: 1 }, { x: lookAt.x, y: lookAt.y, id: 2 }] });
    for (let k = 1; k <= 6; k++) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: stickAt.x, y: stickAt.y - 62, id: 1 }, { x: lookAt.x + 34 * k / 6, y: lookAt.y - 6 * k / 6, id: 2 }],
      });
      await wait(40);
    }
    await wait(600);
    const both = await page.evaluate(({ x0, y0, yaw }) => ({
      moved: Math.hypot(window.__city.walk.player.x - x0, window.__city.walk.player.y - y0),
      yawDelta: window.__city.camera.yaw - yaw,
      stickAlive: !!window.__city.walk.stick,
    }), { x0: who0.x, y0: who0.y, yaw: yaw0 });
    check(both.moved > 0.8, `${name}: 摇杆按住时人还在走（又走了 ${both.moved.toFixed(1)} 米）`);
    check(Math.abs(both.yawDelta) > 0.1, `${name}: 右边拖动看四周（视线转了 ${both.yawDelta.toFixed(2)} 弧度）`);
    check(both.stickAlive, `${name}: 双指并行摇杆不丢`);
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await wait(80);
    check(await page.evaluate(() => document.getElementById('stick').hidden && !window.__city.walk.stick), `${name}: 松手摇杆收起`);
    // 圆钮上车，摇杆驾驶，圆钮下车（落在离路太远的地方就先挪到路边）
    await page.evaluate(() => {
      const app = window.__city, walk = app.walk;
      walk.hudRoad();
      if (document.getElementById('action').disabled) {
        const near = app.world.roadsNear(walk.player.x, walk.player.y, 150);
        if (near) { walk.player.x = near.x; walk.player.y = near.y; walk.player.z = near.z; }
        walk.hudRoad();
      }
    });
    await page.click('#action');
    check(await page.evaluate(() => window.__city.walk.driving), `${name}: 圆钮上车`);
    const before = await page.evaluate(() => ({ ...window.__city.walk.player }));
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stickAt.x, y: stickAt.y }] });
    for (let k = 1; k <= 6; k++) {
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: stickAt.x, y: stickAt.y - 62 * k / 6 }] });
      await wait(40);
    }
    await wait(900);
    const drove = await page.evaluate(({ x0, y0 }) => ({ far: Math.hypot(window.__city.walk.player.x - x0, window.__city.walk.player.y - y0), speed: window.__city.walk.car.speed }), { x0: before.x, y0: before.y });
    check(drove.far > 2, `${name}: 摇杆推上开车（${drove.far.toFixed(0)} 米，时速表 ${drove.speed.toFixed(1)}）`);
    await page.screenshot({ path: path.join(outDir, `${name}-drive.png`) });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.click('#action');
    check(await page.evaluate(() => !window.__city.walk.driving), `${name}: 圆钮下车`);
    await page.screenshot({ path: path.join(outDir, `${name}-walk.png`) });
  }
  check(errors.length === 0, `${name}: no errors (${errors.slice(0, 3).join(' | ')})`);
  console.log(name.padEnd(10), JSON.stringify({ viewport: info.viewport, frame: info.frame, shown: info.shown, yaw: +after.yaw.toFixed(2), zoom: +zoomed.toFixed(2) }));
  await context.close();
}

// two fingers moving together across the canvas: a turn and a tilt
async function move2(client, x, y, spread, dx, dy, steps = 8) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x - spread, y, id: 1 }, { x: x + spread, y, id: 2 }] });
  for (let k = 1; k <= steps; k++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - spread + dx * k / steps, y: y + dy * k / steps, id: 1 }, { x: x + spread + dx * k / steps, y: y + dy * k / steps, id: 2 }] });
    await wait(16);
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// the world point the page draws at a position on the page
const under = (page, x, y) => page.evaluate(({ x, y }) => window.__city.under(x, y), { x, y });
// how far a world point lands from a position on the page, in CSS pixels
const projectedOff = (page, point, x, y) => page.evaluate(({ point, x, y }) => {
  const c = window.__city.camera.project(point.x, point.y, point.z), canvas = document.getElementById('c');
  const css = canvas.clientWidth / window.__city.renderer.W;          // the CSS pixels one frame pixel makes
  return Math.hypot(c.sx * css - x, c.sy * css - y);
}, { point, x, y });

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
