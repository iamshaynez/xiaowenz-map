// The homepage (/): a globe of its own, and the cities there are as red dots on it. Checked on the same small
// repository as cities.cjs (two cities, Hangzhou's bake as hz and as hz2), because a globe with one dot on it
// proves nothing. What is checked: / is the homepage and no city's page boots there; the cities there are come
// with their English names, as dots and as a row of words; the readout says what the globe faces, and follows
// a drag; clicking a city dives to it -- the globe turns it to the front, zooms in, and the address becomes
// the city's (?from=globe), where the page comes down from very high and settles on the whole city; without
// ?from=globe there is no such descent; a reader who wants no animation goes straight to the city.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/home.cjs
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const here = path.resolve(__dirname, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5390;
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// the small repository: the real page; Hangzhou's bake as hz and as hz2 (tools/tests/cities.cjs makes the same one)
function small() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelcity-home-'));
  fs.symlinkSync(path.join(here, 'app'), path.join(root, 'app'));
  fs.mkdirSync(path.join(root, 'data', 'baked'), { recursive: true });
  for (const id of ['hz', 'hz2']) fs.symlinkSync(path.join(here, 'data', 'baked', 'hz'), path.join(root, 'data', 'baked', id));
  const said = JSON.parse(fs.readFileSync(path.join(here, 'cities', 'hz', 'city.json'), 'utf8'));
  for (const [id, definition] of [['hz', said], ['hz2', { ...said, id: 'hz2', name: '试城', en: 'Shicheng', subtitle: '', tour: undefined }]]) {
    fs.mkdirSync(path.join(root, 'cities', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'cities', id, 'city.json'), JSON.stringify(definition));
  }
  return root;
}

const ready = (page, timeout = 60000) => page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout });

(async () => {
  const root = small();
  const server = spawn('node', [path.join(here, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT), PIXELCITY_ROOT: root }, stdio: 'ignore' });
  let browser;
  try {
    for (let k = 0; k < 50; k++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/`)).ok) break;
      } catch {
        // not up yet
      }
      await wait(200);
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const opened = async (options = { viewport: { width: 960, height: 540 } }) => {
      const context = await browser.newContext(options), page = await context.newPage(), complaints = [];
      page.on('pageerror', error => complaints.push('page: ' + error.message));
      page.on('console', message => { if (message.type() === 'error') complaints.push('console: ' + message.text()); });
      return { context, page, complaints };
    };
    const pageOrigin = `http://127.0.0.1:${PORT}`;

    // ---- the homepage is the homepage -----------------------------------------------------------------------------
    const { context, page, complaints } = await opened();
    await page.goto(`${pageOrigin}/`);
    await ready(page);
    await page.waitForFunction(() => document.getElementById('readout-home').textContent !== '面向 …', null, { timeout: 10000 });   // 帧环对过一次表
    const home = await page.evaluate(() => ({
      id: window.__city?.city.id ?? null,
      title: document.title,
      cities: window.__home.cities.map(city => `${city.name}|${city.en}|${city.lat.toFixed(1)}|${city.lon.toFixed(1)}`),
      markers: document.querySelectorAll('.marker').length,
      row: [...document.querySelectorAll('#home-cities button')].map(button => button.textContent),
      stage: getComputedStyle(document.getElementById('front')).display,
      readout: document.getElementById('readout-home').textContent,
    }));
    check(home.id === null && home.title === '像素城市', `/ boots the homepage, not a city (got ${home.title}, ${home.id})`);
    check(home.stage !== 'none', 'the homepage is on show');
    check(same(home.cities, ['杭州|Hangzhou|30.3|120.2', '试城|Shicheng|30.3|120.2']), `the cities there are come with their places and their English names (got ${home.cities.join(' / ')})`);
    check(home.markers === 2 && same(home.row, ['杭州 Hangzhou', '试城 Shicheng']), `two dots on the globe, and the same two words in the row (got ${home.markers} dots, ${home.row.join(' / ')})`);
    check(/^面向 [EW] \d+\.\d° [NS] \d+\.\d°/.test(home.readout), `the readout says what the globe faces (got ${home.readout})`);

    // ---- a drag turns the globe ------------------------------------------------------------------------------------
    const was = await page.evaluate(() => window.__home.globe.facing());
    await page.mouse.move(480, 270);
    await page.mouse.down();
    for (let k = 0; k < 10; k++) {
      await page.mouse.move(480 - k * 22, 270);
      await wait(16);
    }
    await page.mouse.up();
    await wait(300);
    const nowFacing = await page.evaluate(() => window.__home.globe.facing());
    check(Math.abs(nowFacing.lon - was.lon) > 20, `a drag to the left turns the globe (lon ${was.lon.toFixed(1)} -> ${nowFacing.lon.toFixed(1)})`);
    check(!complaints.length, `nothing to complain of so far (got ${complaints.slice(0, 4).join(' | ')})`);
    await context.close();

    // ---- clicking a city: the dive, and the descent on the other side ----------------------------------------------
    const dived = await opened();
    await dived.page.goto(`${pageOrigin}/`);
    await ready(dived.page);
    await dived.page.click('#home-cities button:first-child');
    await dived.page.waitForURL('**/hz?from=globe', { timeout: 30000 });
    await ready(dived.page);
    const arriving = await dived.page.evaluate(() => ({ id: window.__city.city.id, home: getComputedStyle(document.getElementById('front')).display }));
    check(arriving.id === 'hz', `the address is the city's (got ${dived.page.url()})`);
    check(arriving.home === 'none', 'the homepage steps out when the city arrives');
    await dived.page.waitForFunction(() => !window.__city.flying(), null, { timeout: 30000 });
    const landed = await dived.page.evaluate(() => ({ scale: window.__city.camera.scale, wanted: window.__city.overviewTarget().scale, pitch: window.__city.camera.pitch }));
    check(Math.abs(landed.scale - landed.wanted) / landed.wanted < 0.01, `the descent settles on the whole city (scale ${landed.scale.toFixed(4)} against ${landed.wanted.toFixed(4)})`);
    check(!dived.complaints.length, `nothing to complain of on the way over (got ${dived.complaints.slice(0, 4).join(' | ')})`);
    await dived.context.close();

    // ---- a city's own address: no descent ---------------------------------------------------------------------------
    const direct = await opened();
    await direct.page.goto(`${pageOrigin}/hz`);
    await ready(direct.page);
    check(!(await direct.page.evaluate(() => window.__city.ui.flying())), 'opening a city by its address lands at once: no descent');
    await direct.context.close();

    // ---- a reader who wants no animation: straight to the city ------------------------------------------------------
    const quiet = await opened({ ...devices['iPhone 13'], reducedMotion: 'reduce' });
    await quiet.page.goto(`${pageOrigin}/`);
    await ready(quiet.page);
    await quiet.page.click('#home-cities button:first-child');
    await quiet.page.waitForURL('**/hz?from=globe', { timeout: 30000 });
    await ready(quiet.page);
    check(!(await quiet.page.evaluate(() => window.__city.ui.flying())), 'with motion turned down the dive is a cut, not a flight');
    check(!quiet.complaints.length, `nothing to complain of without motion (got ${quiet.complaints.slice(0, 4).join(' | ')})`);
    await quiet.context.close();

    console.log(failures.length ? `home: ${failures.length} FAILED` : 'home: all as expected');
    for (const failure of failures) console.log('  FAILED: ' + failure);
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = failures.length ? 1 : 0;
})().catch(error => { console.error(error); process.exit(1); });
