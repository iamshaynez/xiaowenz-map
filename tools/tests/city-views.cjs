// A city's first look: the whole area and every landmark, one frame each, with time frozen and the words
// around the map hidden. For a city that is new: what to look at before its landmark views are tuned, and
// what to show for it. Hangzhou's own still frames for pixel comparison are frames.cjs's.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/city-views.cjs <city> [out-dir]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const here = path.resolve(__dirname, '../..');                 // this repository
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5387;
const city = process.argv[2];
if (!city) {
  console.error('usage: node tools/tests/city-views.cjs <city> [out-dir]');
  process.exit(2);
}
const outDir = path.resolve(here, process.argv[3] || `out/city-views/${city}`);

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const server = spawn('node', [path.join(here, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/${city}`)).ok) break;
      } catch {
        // not up yet
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/${city}`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 120000 });
    await page.evaluate(() => {
      window.__city.freeze(true);
      document.body.classList.add('quiet');
      document.getElementById('note').hidden = true;
    });
    const settle = () => page.evaluate(async () => { await window.__city.settle(120000); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
    const shoot = async name => {
      await settle();
      await page.screenshot({ path: path.join(outDir, `${name}.png`) });
      console.log(name);
    };
    await shoot('overview');
    const ids = await page.evaluate(() => window.__city.landmarks.map(l => l.id));
    for (const id of ids) {
      await page.evaluate(id => { window.__city.camera.yaw = 0; window.__city.flyTo(id, 0); }, id);
      await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 30000 });
      await shoot(id);
    }
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exit(1);
    }
    console.log(`${ids.length + 1} views of ${city} -> ${outDir}`);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})();
