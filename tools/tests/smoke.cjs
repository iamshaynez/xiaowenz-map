// Loads the app in headless Chrome on the real GPU, checks for errors, settles the tiles in view and
// times the frames at three zooms.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/smoke.cjs [out-dir]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const outDir = path.resolve(root, process.argv[2] || 'out/smoke');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5398;
// places are in world metres, from hz.region.project(lon, lat)
const SHOTS = [
  ['overview', ''],
  ['boxes', 'c.scale = 0.08;'],                                                   // the overview tier, with its boxes
  ['district', 'c.scale = 0.2;'],
  ['woods', 'c.x = 23968.08; c.y = 7640.83; c.scale = 0.5;'],                      // the wooded hills at Longjing (120.132 E, 30.229 N)
  ['westlake', 'c.x = 26274.23; c.y = 11244.24; c.scale = 1.5;'],                  // Broken Bridge and the north shore (120.155 E, 30.262 N)
  ['street', 'c.zoomAt(c.width / 2, c.height / 2, 6);'],
];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  const errors = [];
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
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('requestfailed', r => errors.push('requestfailed: ' + r.url()));
    await page.goto(`http://127.0.0.1:${PORT}/app/`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    for (const [name, setup] of SHOTS) {
      const result = await page.evaluate(async code => {
        const app = window.__hz;
        if (code) new Function('c', code)(app.camera);
        app.touch();
        await new Promise(resolve => setTimeout(resolve, 120));
        const settled = await app.settle();
        return { settled, bench: app.bench(40), readout: document.getElementById('readout').textContent };
      }, setup);
      await page.screenshot({ path: path.join(outDir, `${name}.png`) });
      console.log(name.padEnd(9), JSON.stringify(result));
    }
  } catch (error) {
    console.log('SMOKE FAILED:', String(error.message).split('\n')[0]);
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  console.log('errors:', errors.length ? errors.slice(0, 10) : 'none');
})();
