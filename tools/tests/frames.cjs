// The page's picture, view by view, held still: for comparing one build of the data or the renderer with
// another pixel for pixel. Time is frozen, so boats, cars and wind are where they are at time zero, and
// the words around the map are hidden.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/frames.cjs <out-dir>   (HZ_ROOT=<another checkout> serves that one's page)
// then:  node tools/tests/frames.cjs <other-dir>; node tools/tests/frames-diff.cjs <out-dir> <other-dir>
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const here = path.resolve(__dirname, '../..');                 // this repository
const root = process.env.HZ_ROOT ? path.resolve(here, process.env.HZ_ROOT) : here;   // the checkout whose page is drawn: another one, for the frames of an older build
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5389;
const outDir = path.resolve(here, process.argv[2] || 'out/frames/run');
// landmarks that are also seen far out, very far out, and very close
const ZOOMED = ['1-01', '1-03', '2-02', '3-01', '4-02', '4-04'];
const SCALES = { '025': 0.25, '006': 0.06, '12': 12 };

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/app/`)).ok) break;
      } catch {
        // not up yet
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/app/`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    await page.evaluate(() => {
      window.__hz.freeze(true);
      document.body.classList.add('quiet');
      document.getElementById('note').hidden = true;
    });
    const settle = () => page.evaluate(async () => { await window.__hz.settle(60000); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    const shoot = async name => {
      await settle();
      await page.screenshot({ path: path.join(outDir, `${name}.png`) });
      return name;
    };
    const pose = (x, y, scale, pitch = Math.PI / 6, yaw = 0) => page.evaluate(({ x, y, scale, pitch, yaw }) => { Object.assign(window.__hz.camera, { x, y, scale, pitch, yaw }); window.__hz.touch(); }, { x, y, scale, pitch, yaw });
    const ids = await page.evaluate(() => window.__hz.landmarks.map(l => l.id));
    const shot = [];
    let k = 0;
    const name = label => `${String(++k).padStart(2, '0')}-${label}`;
    // every landmark as its name flies to it
    for (const id of ids) {
      await page.evaluate(id => { window.__hz.camera.yaw = 0; window.__hz.flyTo(id, 0); }, id);
      await page.waitForFunction(() => !window.__hz.flying(), null, { timeout: 20000 });
      shot.push(await shoot(name(id)));
    }
    // six of them from far out, very far out, and very close
    for (const id of ZOOMED) {
      const at = await page.evaluate(id => { const l = window.__hz.landmarks.find(l => l.id === id); return { x: l.x, y: l.y }; }, id);
      for (const [label, scale] of Object.entries(SCALES)) {
        await pose(at.x, at.y, scale);
        shot.push(await shoot(name(`${id}-${label}`)));
      }
    }
    // the whole area, a turn about Leifeng Pagoda, and from above
    await page.evaluate(() => { window.__hz.overview(); window.__hz.touch(); });
    shot.push(await shoot(name('overview')));
    const leifeng = await page.evaluate(() => { const l = window.__hz.landmarks.find(l => l.id === '1-03'); return { x: l.x, y: l.y }; });
    for (let k2 = 0; k2 < 6; k2++) {
      await pose(leifeng.x, leifeng.y, 2.34, Math.PI / 6, k2 * Math.PI / 3);
      shot.push(await shoot(name(`turn-${k2}`)));
    }
    await pose(leifeng.x, leifeng.y, 2.34, 1.483);
    shot.push(await shoot(name('above')));
    // the four seasons over the lake's centre
    const seasons = await page.evaluate(() => window.__hz.seasons);
    await page.evaluate(() => { window.__hz.camera.yaw = 0; window.__hz.flyTo('1-04', 0); });
    await page.waitForFunction(() => !window.__hz.flying(), null, { timeout: 20000 });
    for (const season of seasons) {
      await page.evaluate(season => window.__hz.setSeason(season), season);
      shot.push(await shoot(name(`season-${season}`)));
    }
    await page.evaluate(() => window.__hz.setSeason('summer'));
    if (errors.length) console.log('page errors:', errors.slice(0, 5).join(' | '));
    console.log(`${shot.length} frames in ${path.relative(root, outDir)}${errors.length ? ' (with page errors)' : ''}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})();
