// More than one city: the page is one, and the address says which city is on show (/hz). Checked on a small
// repository of this test's own (PIXELCITY_ROOT), whose page is the real one and whose data is Hangzhou's bake under
// two names -- hz, with its tour, and hz2, "试城", without -- and a city that is defined but never baked, which is no
// city to the page. What is checked: / shows the first city and takes its address; the row of cities holds the baked
// cities only, the one on show marked; another city's button is its address, and there every word is that city's,
// and a city without a tour has no tour button and the T key does nothing; a city there is not stops the page with a
// message; what the address asked before the city was chosen (?find=) is kept; and every file is fetched from the
// data origin, as it is online.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/cities.cjs
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const here = path.resolve(__dirname, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5388;
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// the small repository: the real page; Hangzhou's bake as hz and as hz2; and zz, which was never baked
function small() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelcity-cities-'));
  fs.symlinkSync(path.join(here, 'app'), path.join(root, 'app'));
  fs.mkdirSync(path.join(root, 'data', 'baked'), { recursive: true });
  for (const id of ['hz', 'hz2']) fs.symlinkSync(path.join(here, 'data', 'baked', 'hz'), path.join(root, 'data', 'baked', id));
  const said = JSON.parse(fs.readFileSync(path.join(here, 'cities', 'hz', 'city.json'), 'utf8'));
  for (const [id, definition] of [['hz', said], ['hz2', { ...said, id: 'hz2', name: '试城', subtitle: '', tour: undefined }], ['zz', { ...said, id: 'zz', name: '未烘焙' }]]) {
    fs.mkdirSync(path.join(root, 'cities', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'cities', id, 'city.json'), JSON.stringify(definition));
  }
  return root;
}

// what the page says of the city on show
const state = page => page.evaluate(() => {
  const span = document.getElementById('city-subtitle');
  return {
    address: location.pathname + location.search, title: document.title,
    heading: document.getElementById('city-name').textContent + '|' + span.textContent + (span.hidden ? '|hidden' : ''),
    label: document.getElementById('c').getAttribute('aria-label'),
    tour: document.getElementById('tour').textContent + (document.getElementById('tour').hidden ? '|hidden' : ''),
    cities: [...document.querySelectorAll('#cities button')].map(button => button.textContent + (button.getAttribute('aria-pressed') === 'true' ? '*' : '')),
    id: window.__city?.city.id ?? null, release: window.__city?.city.release ?? null, channel: window.__city?.city.channel ?? null, touring: window.__city?.ui.touring() ?? null,
    tiles: window.__city?.world.loaded ?? null, found: window.__city?.found()?.title ?? null,
    readout: document.getElementById('readout-line').textContent,
  };
});
const ready = (page, timeout = 60000) => page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout });
const stopped = page => page.waitForFunction(() => document.getElementById('readout-line').textContent.startsWith('启动失败'), null, { timeout: 20000 });

(async () => {
  const root = small();
  const server = spawn('node', [path.join(here, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT), PIXELCITY_ROOT: root }, stdio: 'ignore' });
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
    const opened = async (url, options = { viewport: { width: 960, height: 540 } }) => {
      const context = await browser.newContext(options), page = await context.newPage(), complaints = [];
      page.on('pageerror', error => complaints.push('page: ' + error.message));
      page.on('console', message => { if (message.type() === 'error') complaints.push('console: ' + message.text()); });
      page.on('response', response => { if (!response.ok()) complaints.push(`${response.status()} ${new URL(response.url()).pathname}`); });
      return { context, page, complaints };
    };
    const pageOrigin = `http://127.0.0.1:${PORT}`, dataOrigin = `http://127.0.0.1:${PORT + 100}`;

    // ---- / : the first city, and its address --------------------------------------------------------------------
    const { context, page, complaints } = await opened(`${pageOrigin}/`);
    const origins = new Set();
    page.on('response', response => origins.add(new URL(response.url()).origin));
    await page.goto(`${pageOrigin}/`);
    await ready(page);
    let now = await state(page);
    check(now.address === '/' && now.id === null, `/ is the homepage: no city is on show (got ${now.address}, ${now.id})`);
    check(now.title === '像素城市', `the homepage is titled as the page itself (got ${now.title})`);
    check(await page.evaluate(() => getComputedStyle(document.getElementById('front')).display !== 'none'), 'the homepage is on show where the address names no city');
    // the homepage's own manners are tools/tests/home.cjs's

    // ---- a city: its address, and every word of it ---------------------------------------------------------------
    await page.goto(`${pageOrigin}/hz`);
    await ready(page);
    await page.waitForFunction(() => document.querySelectorAll('#cities button').length > 0, null, { timeout: 20000 });
    now = await state(page);
    check(now.address === '/hz' && now.id === 'hz', `a city's address shows that city (got ${now.address}, ${now.id})`);
    check(now.title === '像素杭州 · 主城区' && now.heading === '像素杭州|主城区' && now.label === '像素杭州：可以旋转、缩放的立体地图', 'the title, the heading and what the canvas is said to be name the city');
    check(now.tour === '西湖导览', `a city with a tour has its button, named as the city says (got ${now.tour})`);
    check(same(now.cities, ['杭州*', '试城']), `the row of cities holds the baked cities, the one on show marked, and not the one never baked (got ${now.cities})`);
    check(now.release === 'local', 'the page reads the manifest the dev server makes up');
    check(await page.evaluate(() => getComputedStyle(document.getElementById('front')).display === 'none'), 'and where the address names a city, the homepage is not there');

    // ---- another city: its button is its address ----------------------------------------------------------------
    await page.click('#cities button:nth-of-type(2)');          // the row's first child is its label
    await page.waitForFunction(() => window.__city?.city.id === 'hz2', null, { timeout: 60000 });
    await ready(page);
    await page.waitForFunction(() => document.querySelectorAll('#cities button').length > 0, null, { timeout: 20000 });
    now = await state(page);
    check(now.address === '/hz2' && now.id === 'hz2', `the other city's button is its address (got ${now.address}, ${now.id})`);
    check(now.title === '像素试城' && now.heading === '像素试城||hidden' && now.label === '像素试城：可以旋转、缩放的立体地图', 'and every word there is that city\'s: no subtitle is written where it has none');
    check(now.tour === '|hidden', `a city without a tour has no tour button (got ${now.tour})`);
    check(same(now.cities, ['杭州', '试城*']), `the other city is the one on show now (got ${now.cities})`);
    await page.click('#c');
    await page.keyboard.press('t');
    await wait(300);
    check((await state(page)).touring === false, 'the T key starts no tour where the city has none, and nothing goes wrong');
    await page.evaluate(() => { window.__city.flyTo('1-01', 0); });
    await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 20000 });
    await page.evaluate(() => window.__city.settle(60000));
    check((await state(page)).tiles > 0, 'its tiles come');
    check(!complaints.length, `nothing to complain of on the way (got ${complaints.slice(0, 4).join(' | ')})`);
    check(same([...origins].sort(), [dataOrigin, pageOrigin].sort()), `the page is asked of its origin and the data of another, as online (got ${[...origins].join(' ')})`);
    await context.close();

    // ---- what the address asked is kept; a trailing slash is the same address -------------------------------------
    // (/ 是首页了：带着 ?find= 的 / 也还是首页，首页不搜东西；要搜的是城的地址)
    const asked = await opened(`${pageOrigin}/hz?find=%E6%96%87%E4%B8%89%E8%B7%AF`);
    await asked.page.goto(`${pageOrigin}/hz?find=%E6%96%87%E4%B8%89%E8%B7%AF`);
    await ready(asked.page);
    await asked.page.waitForFunction(() => window.__city.found() !== null, null, { timeout: 60000 });
    now = await state(asked.page);
    check(now.address === '/hz?find=%E6%96%87%E4%B8%89%E8%B7%AF' && now.found === '文三路', `a city's address keeps what it asked and flies to it (got ${now.address}, found ${now.found})`);
    await asked.context.close();
    const askedHome = await opened(`${pageOrigin}/?find=%E6%96%87%E4%B8%89%E8%B7%AF`);
    await askedHome.page.goto(`${pageOrigin}/?find=%E6%96%87%E4%B8%89%E8%B7%AF`);
    await ready(askedHome.page);
    check((await state(askedHome.page)).address === '/?find=%E6%96%87%E4%B8%89%E8%B7%AF' && askedHome.complaints.length === 0, `the homepage takes what the address asked and says nothing of it (got ${askedHome.complaints.join(' | ')})`);
    await askedHome.context.close();
    const slashed = await opened(`${pageOrigin}/hz2/`);
    await slashed.page.goto(`${pageOrigin}/hz2/`);
    await ready(slashed.page);
    check((await state(slashed.page)).id === 'hz2' && !slashed.complaints.length, 'an address with a trailing slash is the same address');
    await slashed.context.close();

    // ---- a channel that has nothing waiting ----------------------------------------------------------------------
    const waiting = await opened(`${pageOrigin}/hz?channel=next`);
    await waiting.page.goto(`${pageOrigin}/hz?channel=next`);
    await ready(waiting.page);
    now = await state(waiting.page);
    check(now.channel === 'manifest' && now.address === '/hz?channel=next', `where nothing is published as next, the city on show is read, and the address kept (got channel ${now.channel}, ${now.address})`);
    check(same(waiting.complaints, ['404 /hz/next.json', 'console: Failed to load resource: the server responded with a status of 404 (Not Found)']), `and what is complained of is only that nothing waits (got ${waiting.complaints.join(' | ')})`);
    await waiting.context.close();

    // ---- a city there is not ----------------------------------------------------------------------------------------
    const absent = await opened(`${pageOrigin}/zz`);
    await absent.page.goto(`${pageOrigin}/zz`);
    await stopped(absent.page);
    now = await state(absent.page);
    check(now.readout === '启动失败：没有 zz 这座城' && now.id === null, `a city that is not baked is said so (got ${now.readout})`);
    // the browser's own word of the 404 comes as well: three complaints, of one missing file
    check(absent.complaints.length === 3 && absent.complaints[0] === '404 /zz/manifest.json' && absent.complaints[2] === 'page: 没有 zz 这座城', `only its missing manifest is complained of (got ${absent.complaints.join(' | ')})`);
    await absent.context.close();

    // ---- on a phone ------------------------------------------------------------------------------------------------
    const phone = await opened(`${pageOrigin}/hz`, devices['iPhone 13']);
    await phone.page.goto(`${pageOrigin}/hz`);
    await ready(phone.page);
    await phone.page.waitForFunction(() => document.querySelectorAll('#cities button').length > 0, null, { timeout: 20000 });
    now = await state(phone.page);
    check(same(now.cities, ['杭州*', '试城']) && now.id === 'hz', `the row of cities is on a phone too (got ${now.cities})`);
    check(await phone.page.evaluate(() => getComputedStyle(document.getElementById('city-subtitle')).display === 'none'), 'and the subtitle is left out there, as it was');
    await phone.context.close();

    console.log(failures.length ? `cities: ${failures.length} FAILED` : 'cities: all as expected');
    for (const failure of failures) console.log('  FAILED: ' + failure);
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = failures.length ? 1 : 0;
})().catch(error => { console.error(error); process.exit(1); });
