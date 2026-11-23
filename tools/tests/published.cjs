// The whole way of a city, on this machine. Hangzhou's bake is published to a bucket of this test's own the way
// publishing puts it in R2 -- compressed, each file named by its contents, told of by a manifest -- and the bucket
// serves what it was given as R2 does: with the content encoding, a year of cache, and CORS. Then it is read back the
// way it is online: tools/deploy/verify.mjs checks it as it will against the real bucket; the page, on one origin,
// draws from files that came compressed under names of their own from another; and what it draws is what it draws
// from the dev server's plain files -- pixel for pixel.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/published.cjs
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const here = path.resolve(__dirname, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE = 5397, BUCKET = PAGE + 100, SPARE = PAGE + 101;      // a page finds its data at its own port + 100: that is where the bucket stands
const PLAIN = 5396;                                              // a second page, whose data the dev server serves from the disk itself
const KEYS = { R2_ACCOUNT_ID: 'theaccount', R2_BUCKET: 'thetest', R2_ACCESS_KEY_ID: 'THEKEY', R2_SECRET_ACCESS_KEY: 'a secret' };
const FOR_ANY_PAGE = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' };
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const QUIET = () => {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const started = Date.now(), clock = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(3)} s`;      // how far into the test
// a script run beside this one, its output kept: the bucket lives in this process, so nothing here may block
const beside = (args, env = {}) => new Promise(resolve => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
  let said = '';
  child.stdout.on('data', chunk => { said += chunk; });
  child.stderr.on('data', chunk => { said += chunk; });
  child.on('close', code => resolve({ code, said }));
});

// a bucket on one port, as R2 is on two addresses: publishing's side, where S3 has put, head and get under the
// bucket's name (/thetest/<key>, every request signed); and the public side, as a custom domain serves it -- the
// same objects under their own names (/ <key>), with the headers they were given and CORS for a page on another
// name. The two are told apart by the signature: a browser's request has none. `served` counts what a page took.
function bucket() {
  const store = new Map(), served = { encoded: 0, tiles: 0 };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const signed = Boolean(request.headers.authorization);                      // publishing signs; a page does not
      const key = `${signed ? '' : '/thetest'}${decodeURIComponent(request.url)}`, held = store.get(key);
      if (request.method === 'OPTIONS') { response.writeHead(204, FOR_ANY_PAGE); response.end(); return; }
      if (request.method === 'PUT') {
        store.set(key, { body: Buffer.concat(chunks), type: request.headers['content-type'], cache: request.headers['cache-control'], encoding: request.headers['content-encoding'] });
        response.writeHead(200, { etag: '"etag"' });
        response.end();
        return;
      }
      if (!held) { response.writeHead(404, FOR_ANY_PAGE); response.end(); return; }
      const headers = { 'content-type': held.type, 'cache-control': held.cache, 'content-length': String(held.body.length), etag: '"etag"',
                        ...(held.encoding ? { 'content-encoding': held.encoding } : {}), ...FOR_ANY_PAGE };
      if (request.method === 'HEAD') { response.writeHead(200, headers); response.end(); return; }
      response.writeHead(200, headers);
      response.end(held.body);
      if (request.headers.origin && /\/objects\/[0-9a-f]{32}\.bin$/.test(key)) {          // a tile a page took, as it was served
        served.encoded += held.encoding === 'br' ? 1 : 0;
        served.tiles += 1;
      }
    });
  });
  return { store, served, server, listen: port => new Promise(resolve => server.listen(port, '127.0.0.1', resolve)), close: () => new Promise(resolve => server.close(resolve)) };
}

const devServer = env => spawn('node', [path.join(here, 'serve.mjs')], { env: { ...process.env, ...env }, stdio: 'ignore' });
const up = async url => {
  for (let k = 0; k < 50; k++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await wait(200);
  }
  throw new Error(`${url} never came up`);
};

// the page at the broken bridge, with its map held still: a picture of the canvas alone
async function picture(browser, url) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  try {
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    await page.evaluate(() => { window.__city.freeze(true); window.__city.flyTo('1-01', 0); });
    await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 20000 });
    await page.evaluate(() => window.__city.settle(60000));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return { png: await page.screenshot({ clip: { x: 0, y: 0, width: 960, height: 540 } }), tiles: await page.evaluate(() => window.__city.world.loaded) };
  } finally {
    await page.close();
  }
}

(async () => {
  const { publish } = await import('../deploy/publish.mjs');
  const { client } = await import('../deploy/env.mjs');
  const { filesOf } = await import('../deploy/manifest.mjs');
  const world = bucket();
  await world.listen(BUCKET);
  // the page by the bucket: its own data port is pushed aside, the bucket stands where the page will look.
  // And a second page, whose data the dev server serves from the disk itself.
  const byTheBucket = devServer({ PORT: String(PAGE), DATA_PORT: String(SPARE) }), fromTheDisk = devServer({ PORT: String(PLAIN) });
  const objects = () => [...world.store.entries()].filter(([key]) => key.startsWith('/thetest/hz/objects/'));
  let browser;
  try {
    await up(`http://127.0.0.1:${PAGE}/hz`);
    await up(`http://127.0.0.1:${PLAIN}/hz`);
    const r2 = client(KEYS, { endpoint: `http://127.0.0.1:${BUCKET}` });
    const files = filesOf(path.join(here, 'data', 'baked', 'hz'));

    // ---- published ------------------------------------------------------------------------------------------------
    const lines = [], marks = [];
    const first = await publish({ bucket: r2, root: here, city: 'hz', log: line => lines.push(line) });
    check(files.length > 1500 && first.fresh.length === files.length && objects().length === files.length,
          `every file of the bake went in as an object of its own (${first.fresh.length} fresh, ${objects().length} objects, ${files.length} files)`);
    marks.push(clock());
    check(objects().every(([, held]) => held.encoding === 'br' && held.cache === 'public, max-age=31536000, immutable'), 'each one is served as brotli, kept for a year');
    console.log(lines.map(line => '  ' + line).join('\n'));

    // ---- as verify.mjs will check it against the real bucket ------------------------------------------------------
    const verify = await beside([path.join(here, 'tools', 'deploy', 'verify.mjs'), 'hz', '--data', `http://127.0.0.1:${BUCKET}`, '--page', `http://127.0.0.1:${PAGE}`]);
    const said = verify.said.trim().split('\n');
    check(verify.code === 0, `verify.mjs finds everything as it should be (exit ${verify.code})`);
    marks.push(clock());
    console.log(said.map(line => '  ' + line).join('\n'));

    // ---- the page draws from it -------------------------------------------------------------------------------------
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const published = await picture(browser, `http://127.0.0.1:${PAGE}/hz?ui=off`);
    check(published.tiles > 0 && world.served.tiles >= published.tiles && world.served.encoded === world.served.tiles,
          `the page's tiles came from the bucket, every one of them as it was served, encoded (${world.served.encoded} of ${world.served.tiles} served; ${published.tiles} on the card)`);
    const plain = await picture(browser, `http://127.0.0.1:${PLAIN}/hz?ui=off`);
    marks.push(clock());
    check(published.tiles === plain.tiles && published.png.equals(plain.png),
          `what the page draws from the bucket is what it draws from the plain files on the disk, pixel for pixel (${published.png.length} against ${plain.png.length} bytes of picture; ${published.tiles} against ${plain.tiles} tiles)`);
    if (!published.png.equals(plain.png)) {
      fs.mkdirSync(path.join(here, 'out', 'test-runs'), { recursive: true });
      fs.writeFileSync(path.join(here, 'out', 'test-runs', 'published-bucket.png'), published.png);
      fs.writeFileSync(path.join(here, 'out', 'test-runs', 'published-disk.png'), plain.png);
    }

    // ---- publishing the same bake again uploads nothing ---------------------------------------------------------
    const again = await publish({ bucket: r2, root: here, city: 'hz', log: QUIET });
    check(again.fresh.length === 0 && again.release === first.release && objects().length === files.length, 'publishing the same bake again uploads nothing');

    console.log(`  published at ${marks[0]}, verified at ${marks[1]}, both pictures taken at ${marks[2]}`);
    console.log(failures.length ? `published: ${failures.length} FAILED` : 'published: all as expected');
    for (const failure of failures) console.log('  FAILED: ' + failure);
  } finally {
    if (browser) await browser.close();
    byTheBucket.kill();
    fromTheDisk.kill();
    await world.close();
  }
  process.exitCode = failures.length ? 1 : 0;
})().catch(error => { console.error(error); process.exit(1); });
