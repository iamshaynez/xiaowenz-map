// Flies to every landmark as a visitor would, and takes the pictures the plan asks for: every landmark
// from three sides, the core of West Lake in the four seasons, the ladder of zooms from the whole city to
// the Broken Bridge, and a turn around Leifeng Pagoda. It is a test of the page as well as a camera: each
// landmark is reached by clicking its name, and the camera is checked against where the landmark is.
//
// Full-size frames (960 x 540, the page's own pixels) go to out/review/, and sheets of them, smaller, to
// docs/REVIEW/ for the repository.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/tour.cjs [--only 1-01,1-02] [--skip-sheets]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readPNG, resize, crop, sheet, encodePNG } = require('../review/png.cjs');

const root = path.resolve(__dirname, '../..');
const outDir = path.join(root, 'out/review');
const sheetDir = path.join(root, 'docs/REVIEW');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5395;
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const ONLY = flag('--only', '').split(',').filter(Boolean);
const ANGLES = [0, 2 * Math.PI / 3, 4 * Math.PI / 3];

// the words around the map are put away for the pictures (the note that names the place stays), and
// brought back for the clicks
const quiet = (page, on) => page.evaluate(on => document.body.classList.toggle('quiet', on), on);

// one landmark's three sides on a sheet: the first as the page shows it, the other two as the middle of
// the frame at the same size (the landmark is in the middle of its view), above each other
function landmarkSheet(files) {
  const W = 960, H = 540, total = W + W / 2, out = new Uint8Array(total * H * 4).fill(255);
  const put = (file, left, top, w, h) => {
    const image = readPNG(file), fitted = image.w === w && image.h === h ? image : crop(image, w, h);
    for (let y = 0; y < h; y++) out.set(fitted.data.subarray(y * w * 4, (y + 1) * w * 4), ((top + y) * total + left) * 4);
  };
  put(files[0], 0, 0, W, H);
  put(files[1], W, 0, W / 2, H / 2);
  put(files[2], W, H / 2, W / 2, H / 2);
  return encodePNG(total, H, out);
}

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(path.join(outDir, 'landmarks'), { recursive: true });
  fs.mkdirSync(sheetDir, { recursive: true });
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
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
    await page.goto(`http://127.0.0.1:${PORT}/app/`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    const index = await page.evaluate(() => ({
      size: [innerWidth, innerHeight], frame: [window.__hz.renderer.W, window.__hz.renderer.H],
      landmarks: window.__hz.landmarks.map(l => ({ id: l.id, title: l.title, group: l.group, view: l.view, x: l.x, y: l.y })),
    }));
    check(index.size[0] === index.frame[0] && index.size[1] === index.frame[1], `the page shows the frame's own pixels: ${index.size} vs ${index.frame}`);
    const shots = [];
    const shoot = async file => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: file });
      shots.push(file);
      return file;
    };
    // wait for a flight to end and the tiles of the view to be in
    const arrived = () => page.evaluate(async () => {
      const app = window.__hz;
      for (let k = 0; k < 400 && app.flying(); k++) await new Promise(r => setTimeout(r, 50));
      await app.settle(30000);
      return { flying: app.flying(), camera: { x: app.camera.x, y: app.camera.y, scale: app.camera.scale } };
    });

    // ---- every landmark, by clicking its name, from three sides ---------------------------------------------
    for (const landmark of index.landmarks) {
      if (ONLY.length && !ONLY.includes(landmark.id)) continue;
      await page.click(`#landmarks button[data-id="${landmark.id}"]`);
      const here = await arrived();
      check(!here.flying, `${landmark.id}: the flight ended`);
      const target = await page.evaluate(() => window.__hz.ui.target());
      const near = Math.hypot(here.camera.x - target.x, here.camera.y - target.y);
      check(near < 5, `${landmark.id}: arrives where its flight was bound (${near.toFixed(1)} m off)`);
      check(Math.abs(here.camera.scale - target.scale) < 1e-3, `${landmark.id}: at its zoom (${here.camera.scale} against ${target.scale})`);
      // the landmark is looked at, not merely near: its middle (half-way up what was built for it, on the
      // ground it stands on) is at the centre of the frame, whoever far down the page the camera had to go
      const middle = await page.evaluate(id => {
        const app = window.__hz, landmark = app.landmarks.find(l => l.id === id), c = app.camera;
        const p = c.project(landmark.x, landmark.y, (landmark.ground ?? 0) - (landmark.bed ?? 2) + (landmark.focus ?? 8));
        const [ex, ey] = app.ui.expected(landmark);            // where the view's table says its middle belongs
        return { dx: p.sx - c.width / 2 - ex, dy: p.sy - c.height / 2 - ey };
      }, landmark.id);
      check(Math.hypot(middle.dx, middle.dy) < 2 && target.scale >= landmark.view.scale,
        `${landmark.id}: its middle is at the centre of the frame (${middle.dx.toFixed(1)}, ${middle.dy.toFixed(1)} px off)`);
      // ... and stays there when the map is turned, as a visitor turns it to see the other sides
      await page.evaluate(() => window.__hz.ui.turnTo(4 * Math.PI / 3));
      const turned = await page.evaluate(id => {
        const app = window.__hz, landmark = app.landmarks.find(l => l.id === id), c = app.camera;
        const p = c.project(landmark.x, landmark.y, (landmark.ground ?? 0) - (landmark.bed ?? 2) + (landmark.focus ?? 8));
        const [ex, ey] = app.ui.expected(landmark);
        return { dx: p.sx - c.width / 2 - ex, dy: p.sy - c.height / 2 - ey };
      }, landmark.id);
      check(Math.hypot(turned.dx, turned.dy) < 2, `${landmark.id}: turned, its middle is still at the centre (${turned.dx.toFixed(1)}, ${turned.dy.toFixed(1)} px off)`);
      const shown = await page.evaluate(() => ({ hidden: document.getElementById('note').hidden, title: document.getElementById('note-title').textContent }));
      check(!shown.hidden && shown.title === landmark.title, `${landmark.id}: its note is shown (${shown.title})`);
      const files = [];
      await quiet(page, true);
      for (const [k, yaw] of ANGLES.entries()) {
        // turned as a visitor turns it: the landmark last flown to stays in the middle of the frame
        await page.evaluate(yaw => { window.__hz.ui.turnTo(yaw); window.__hz.touch(); }, yaw);
        files.push(await shoot(path.join(outDir, 'landmarks', `${landmark.id}-${k}.png`)));
      }
      await quiet(page, false);
      if (!args.includes('--skip-sheets')) fs.writeFileSync(path.join(sheetDir, `${landmark.id}.png`), landmarkSheet(files));
      console.log(`${landmark.id} ${landmark.title}`.padEnd(28), 'ok', failures.length ? `(${failures.length} failures so far)` : '');
    }
    if (ONLY.length) return;

    // ---- the seasons over the lake --------------------------------------------------------------------------
    await page.click('#landmarks button[data-id="1-04"]');
    await arrived();
    const seasons = await page.evaluate(() => window.__hz.seasons);
    const seasonFiles = [];
    for (const season of seasons) {
      await page.click(`#seasons button[data-season="${season}"]`);
      const state = await page.evaluate(() => ({ season: document.body.dataset.season, pressed: document.querySelector('#seasons button[aria-pressed="true"]').dataset.season }));
      check(state.season === season && state.pressed === season, `season ${season} is the one pressed`);
      await quiet(page, true);
      seasonFiles.push(await shoot(path.join(outDir, `season-${season}.png`)));
      await quiet(page, false);
    }
    fs.writeFileSync(path.join(sheetDir, 'seasons.png'), sheet(seasonFiles, 2, 480, 270));

    // ---- the ladder of zooms: the whole city down to the Broken Bridge -------------------------------------
    const bridge = index.landmarks.find(l => l.id === '1-01');
    const zooms = [null, 0.06, 0.4, 1.2, 2.4, 8];
    const zoomFiles = [];
    await page.evaluate(() => window.__hz.setSeason('summer'));
    await quiet(page, true);
    for (const [k, scale] of zooms.entries()) {
      await page.evaluate(scale => {
        const app = window.__hz;
        if (scale === null) { app.overview(); app.touch(); return; }
        const whole = { x: app.camera.x, y: app.camera.y, scale: app.camera.scale };
        // on the way from the middle of the city to the bridge, as the zoom closes in
        const t = Math.min(1, Math.log(scale / whole.scale) / Math.log(2.4 / whole.scale));
        Object.assign(app.camera, { x: whole.x + (window.__hz.landmarks.find(l => l.id === '1-01').x - whole.x) * t, y: whole.y + (window.__hz.landmarks.find(l => l.id === '1-01').y - whole.y) * t, scale });
        app.touch();
      }, scale);
      await page.evaluate(() => window.__hz.settle(30000));
      zoomFiles.push(await shoot(path.join(outDir, `zoom-${k}.png`)));
    }
    fs.writeFileSync(path.join(sheetDir, 'zooms.png'), sheet(zoomFiles, 3, 480, 270));
    await quiet(page, false);

    // ---- a turn around Leifeng Pagoda, and the view from above -----------------------------------------------
    await page.click('#landmarks button[data-id="1-03"]');
    await arrived();
    const turnFiles = [];
    await quiet(page, true);
    for (let k = 0; k < 6; k++) {
      await page.evaluate(k => { window.__hz.ui.turnTo(k * Math.PI / 3); window.__hz.touch(); }, k);
      turnFiles.push(await shoot(path.join(outDir, `turn-${k}.png`)));
    }
    fs.writeFileSync(path.join(sheetDir, 'turn.png'), sheet(turnFiles, 3, 480, 270));
    await page.keyboard.press('m');
    await arrived();
    const pitch = await page.evaluate(() => window.__hz.camera.pitch);
    check(pitch > 1.4, `M looks straight down (pitch ${pitch.toFixed(2)})`);
    await shoot(path.join(outDir, 'top-down.png'));
    await quiet(page, false);
    await page.keyboard.press('m');
    await arrived();

    // ---- the tour, the home button, and dragging ------------------------------------------------------------------
    await page.click('#tour');
    await wait(2500);
    const touring = await page.evaluate(() => window.__hz.ui.touring());
    check(touring, 'the tour starts');
    await page.mouse.move(480, 270);
    await page.mouse.down();
    await page.mouse.move(560, 290, { steps: 6 });
    await page.mouse.up();
    check(!(await page.evaluate(() => window.__hz.ui.touring())), 'dragging the map stops the tour');
    const yaw = await page.evaluate(() => window.__hz.camera.yaw);
    check(Math.abs(yaw) > 0.05, 'dragging turns the city');
    await page.click('#home');
    await arrived();
    const whole = await page.evaluate(() => ({ scale: window.__hz.camera.scale, tour: window.__hz.ui.touring() }));
    check(whole.scale < 0.02 && !whole.tour, `R and the home button bring the whole city back (scale ${whole.scale.toFixed(4)})`);
    await quiet(page, true);
    await shoot(path.join(outDir, 'overview.png'));
    await quiet(page, false);
    fs.writeFileSync(path.join(sheetDir, 'over-and-above.png'), sheet([path.join(outDir, 'overview.png'), path.join(outDir, 'top-down.png')], 2, 480, 270));
    check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
    fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify({ date: new Date().toISOString(), shots: shots.map(f => path.relative(root, f)) }, null, 1));
    console.log(`${shots.length} frames in out/review; sheets in docs/REVIEW`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch(error => {
  failures.push(String(error.stack || error.message).split('\n').slice(0, 3).join(' '));
}).finally(() => {
  if (failures.length) {
    console.log('TOUR FAILED');
    failures.forEach(message => console.log('  -', message));
    process.exitCode = 1;
  } else {
    console.log('tour OK');
  }
});
