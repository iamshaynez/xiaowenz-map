// What a flight asks for. Flying used to request every tile the camera passed over, and let nothing go: a
// cross-city flight asked for 92 tiles (41 MB) where a jump asked for 10 (7 MB) (D068). Now only what the
// destination needs is asked for -- from the first frame of the flight, so that it is there on arrival -- and
// what was already on its way and is of no use there is let go (D071). What is checked, in the real page:
// a flight asks for about what its destination's view holds, and no more than that however far it flies;
// what was asked lands almost complete, so that the ground is under the traveller when they arrive; flying
// somewhere and jumping there ask for near enough the same tiles; and the picture at the destination is drawn.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/flight.cjs
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const here = path.resolve(__dirname, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5393;
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const TILE = /\/tiles\/b\//;

(async () => {
  const server = spawn('node', [path.join(here, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    for (let k = 0; k < 50; k++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/hz`)).ok) break;
      } catch {
        // not up yet
      }
      await wait(200);
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const problems = [], asked = new Set();
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('response', response => asked.add(new URL(response.url()).pathname));
    await page.goto(`http://127.0.0.1:${PORT}/hz`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    const settle = () => page.evaluate(() => window.__city.settle(60000));
    await settle();

    // how many tiles the flight's own destination view holds (the pose it lands at, not the landmark)
    const viewOf = () => page.evaluate(() => window.__city.world.viewOf(window.__city.ui.target(), window.__city.camera).length);
    const flown = async id => {
      const before = new Set(asked);
      await page.evaluate(id => window.__city.flyTo(id, 1.8), id);
      await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 30000 });
      const view = await viewOf();
      await wait(400);                                       // the last uploads of the destination's tiles
      const fresh = [...asked].filter(u => !before.has(u) && TILE.test(u));
      const left = await page.evaluate(() => window.__city.world.pending.size);
      return { fresh, view, left };
    };

    // ---- from the overview to the Broken Bridge: a first flight ----------------------------------------------
    await page.evaluate(() => window.__city.flyTo('1-01', 1.8));
    await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 30000 });
    const first = [...asked].filter(u => TILE.test(u));
    const broken = await viewOf();
    check(first.length <= broken * 1.5 + 4, `the first flight asks for about what the destination's view holds (${first.length} tiles for a view of ${broken})`);
    await settle();

    // ---- across the city: the flight that used to ask for 92 tiles --------------------------------------------
    const { fresh: across, view: olympic, left } = await flown('4-02');
    check(across.length <= olympic * 1.5 + 4, `a flight across the city asks for about what the destination's view holds (${across.length} tiles for a view of ${olympic}; it used to ask for 92)`);
    check(left <= 2, `the destination's tiles are almost all on the card when the flight ends (${left} still on their way)`);

    // ---- somewhere never visited, by a jump: near enough the same tiles ---------------------------------------
    // a short wait before counting: the flight ends and the page starts asking at once, and the response
    // events reach this script a moment behind settle's answer
    const before = new Set(asked);
    await page.evaluate(() => window.__city.flyTo('3-01', 0));
    await wait(600);
    await settle();
    const jumped = [...asked].filter(u => !before.has(u) && TILE.test(u));
    const gongchen = await viewOf();
    check(jumped.length <= gongchen * 1.5 + 4, `a jump asks for what the destination's view holds (${jumped.length} tiles for a view of ${gongchen})`);
    const drawn = await page.evaluate(() => window.__city.world.loaded);
    check(drawn >= across.length, `the destinations are drawn from their tiles (${drawn} on the card; the flight alone asked for ${across.length})`);
    check(!problems.length, `the browser has nothing to complain of (${problems.slice(0, 3).join(' | ')})`);

    console.log(`flight: first ${first.length} (view ${broken}), across the city ${across.length} (view ${olympic}; used to be 92), jumped ${jumped.length} (view ${gongchen}); on arrival ${left} left`);
    console.log(failures.length ? `flight: ${failures.length} FAILED` : 'flight: all as expected');
    for (const failure of failures) console.log('  FAILED: ' + failure);
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  process.exitCode = failures.length ? 1 : 0;
})().catch(error => { console.error(error); process.exit(1); });
