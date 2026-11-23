// Check what was published, as a browser gets it. Nothing is changed anywhere.
//
//   -- the two lists come, and are asked about every time (they are what changes when a city is published)
//   -- the files the manifest tells of are fetched from the data address, with the header a page on another name
//      sends: each must come whole (its contents are what its name says), kept for a year, readable by the page,
//      and of the right type
//   -- the page opens on the city's address, shows the release the manifest names, and the browser has nothing to
//      complain of
//
// Usage: node tools/deploy/verify.mjs <city> [--data https://data.<domain>] [--page https://<domain>] [--all] [--no-browser]
//   without --data and --page, both are read from the page's own configuration (app/src/config.js)
//   --all         every tile is fetched, not a sample of 24: the whole city, about 160 MB
//   --no-browser  the files only
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, constants as ZLIB, gunzipSync, gzipSync } from 'node:zlib';

import { CITIES, MANIFEST, NEXT, OBJECTS, RELEASES, ROOT, ids, kindOf } from './manifest.mjs';

const FLAGS = ['--all', '--no-browser', '----help'], WITH_VALUE = ['--data', '--page'];
const MB = n => `${(n / 1e6).toFixed(1)} MB`;
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

// how publish.mjs packs a file: to pack what came the same way, and see whether it is what its name says
const AGAIN = { br: body => brotliCompressSync(body, { params: { [ZLIB.BROTLI_PARAM_QUALITY]: 5 } }), gzip: body => gzipSync(body) };
const TYPE = name => (kindOf(name) === '.json' ? 'application/json' : 'application/octet-stream');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function main() {
  const args = process.argv.slice(2);
  const city = args.find((arg, k) => k === 0 || !FLAGS.includes(args[k - 1]) && !WITH_VALUE.includes(args[k - 1]));
  const value = flag => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  if (!city || args.includes('--help')) {
    console.log(`usage: node tools/deploy/verify.mjs <city> [--data https://<data-domain>] [--page https://<page-domain>] [--all] [--no-browser]       cities: ${ids(ROOT).join(' ') || 'none'}`);
    return 2;
  }
  // where the data and the page are: as asked, or as the project itself is told (app/src/config.js for the data, wrangler.jsonc for the page)
  const config = readFileSync(join(ROOT, 'app', 'src', 'config.js'), 'utf8');
  const data = value('--data') || config.match(/'(https:\/\/[^']+)'/)?.[1];
  // wrangler.jsonc names the domain without a scheme; a page is always https
  const page = value('--page') || 'https://' + readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').match(/"pattern":\s*"([^"]+)"/)?.[1];
  if (!data || !page || data.includes('example.com') || page.includes('example.com')) throw new Error(`where the data and the page are is not said yet (the data is ${data}, the page ${page}): --data https://<data-domain> --page https://<page-domain>`);
  const origin = new URL(page).origin, from = name => `${data}/${city}/${name}`;
  const get = name => fetch(from(name), { headers: { Origin: origin } });

  // ---- the two lists ---------------------------------------------------------------------------------------------
  const asked = await get(MANIFEST);
  check(asked.ok, `${from(MANIFEST)}: ${asked.status}`);
  const manifest = await asked.json();
  const everyTime = response => /no-cache/.test(response.headers.get('cache-control') || '');
  const readable = response => response.headers.get('access-control-allow-origin') !== null;
  check(everyTime(asked), `${MANIFEST} must be asked about every time; it came with cache-control: ${asked.headers.get('cache-control')}`);
  check(readable(asked), `${MANIFEST} came without an Access-Control-Allow-Origin header: the page, on another name, could not read it`);
  check(manifest.id === city, `${MANIFEST} tells of ${manifest.id}, not of ${city}`);
  const names = Object.keys(manifest.files || {});
  check(names.includes('index.json') && names.includes('overview.bin'), `${MANIFEST} does not tell of index.json and overview.bin`);
  const listed = await fetch(`${data}/${CITIES}`, { headers: { Origin: origin } });
  check(listed.ok && everyTime(listed) && readable(listed), `${CITIES}: ${listed.status}, cache-control ${listed.headers.get('cache-control')}`);
  const cities = listed.ok ? (await listed.json()).cities : [];
  check(cities.some(said => said.id === city), `${CITIES} does not list ${city}`);
  // every file of the city lies where the manifest says, the index among them
  const index = await (await fetch(`${data}/${city}/${manifest.files['index.json']}`, { headers: { Origin: origin } })).json();
  check(index.format === manifest.format, `index.json is of format ${index.format}; the manifest says ${manifest.format}`);
  for (const channel of [MANIFEST, NEXT]) {
    const other = await get(channel);
    if (channel === NEXT && other.status === 404) continue;                   // nothing waiting as next: fine
    check(other.ok, `${from(channel)}: ${other.status}`);
  }

  // ---- the files: each one that is not a tile, and a sample of the tiles ------------------------------------------
  const tiles = names.filter(name => name.startsWith('tiles/')), others = names.filter(name => !name.startsWith('tiles/'));
  const sample = args.includes('--all') ? tiles : tiles.filter((_, k) => k % Math.ceil(tiles.length / 24) === 0);
  let came = 0;
  const one = async name => {
    const where = manifest.files[name], response = await fetch(`${data}/${city}/${where}`, { headers: { Origin: origin } });
    if (!response.ok) return `${name}: ${response.status}`;
    const body = Buffer.from(await response.arrayBuffer());
    came += body.length;
    const encoding = response.headers.get('content-encoding'), type = response.headers.get('content-type');
    const problems = [];
    if (!/immutable/.test(response.headers.get('cache-control') || '')) problems.push(`cache-control is "${response.headers.get('cache-control')}"`);
    if (!readable(response)) problems.push('no Access-Control-Allow-Origin header');
    if (type !== TYPE(name)) problems.push(`content-type is "${type}"`);
    // an object lies under the hash of its compressed bytes. What came was unpacked by fetch; packed again the way
    // publishing packs, it must hash to its name -- unless it was packed by another compressor than this one's
    if (where.startsWith(`${OBJECTS}/`) && encoding !== manifest.encoding) problems.push(`packed as ${encoding}; the manifest says ${manifest.encoding}`);
    if (where.startsWith(`${OBJECTS}/`) && AGAIN[encoding]) {
      const hash = createHash('sha256').update(AGAIN[encoding](body)).digest('hex').slice(0, 32);
      if (!where.includes(hash)) problems.push('its contents are not what its name says (or were packed by another compressor)');
    }
    return problems.length ? `${name}: ${problems.join('; ')}` : '';
  };
  const fetched = [...others, ...sample];
  console.log(`${city}, release ${manifest.release}: ${others.length} files and ${sample.length} of ${tiles.length} tiles from ${data}`);
  for (let k = 0; k < fetched.length; k += 16) {
    (await Promise.all(fetched.slice(k, k + 16).map(one))).filter(Boolean).forEach(problem => failures.push(problem));
  }
  console.log(`  ${fetched.length} files came, ${MB(came)} unpacked`);

  // ---- the page ----------------------------------------------------------------------------------------------------
  if (!args.includes('--no-browser')) {
    let playwright = null;
    try {
      playwright = createRequire(import.meta.url)(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'));
    } catch {
      console.log('  the page itself was not opened: playwright is not where npm keeps global packages (npm i -g playwright)');
    }
    if (playwright) {
      const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true });
      try {
        const opened = await browser.newPage({ viewport: { width: 960, height: 540 } });
        const complaints = [];
        opened.on('pageerror', error => complaints.push(`page: ${error.message}`));
        opened.on('console', message => { if (message.type() === 'error') complaints.push(`console: ${message.text()}`); });
        opened.on('response', response => { if (response.status() >= 400) complaints.push(`${response.status()} ${response.url()}`); });        // a redirect (Cloudflare injects one for its bot check) is not a complaint
        await opened.goto(`${page}/${city}`);
        await opened.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
        // on to a close view, so that tiles are asked for: the first landmark where the city has one, the middle otherwise
        await opened.evaluate(() => {
          const app = window.__city;
          if (app.landmarks.length) app.flyTo(app.landmarks[0].id, 0);
          else Object.assign(app.camera, { scale: 1 });
          app.touch();
        });
        await opened.waitForFunction(() => !window.__city.flying(), null, { timeout: 30000 });
        await opened.evaluate(() => window.__city.settle(60000));
        const shown = await opened.evaluate(() => ({ title: document.title, release: window.__city.city.release, tiles: window.__city.world.loaded, format: window.__city.world.index.format }));      // the index the page read is the world's
        check(shown.release === manifest.release, `the page shows release ${shown.release}; the manifest names ${manifest.release}`);
        check(shown.format === index.format, `the page read files of format ${shown.format}; index.json says ${index.format}`);
        check(shown.tiles > 0, 'no tile came to the page');
        check(!complaints.length, `the browser complained: ${complaints.slice(0, 5).join(' | ')}`);
        console.log(`  the page at ${page}/${city}: "${shown.title}", release ${shown.release}, ${shown.tiles} tiles on the card${complaints.length ? `, ${complaints.length} complaints` : ', nothing to complain of'}`);
      } finally {
        await browser.close();
      }
    }
  }

  // ---- the release is kept, to be put on show again ---------------------------------------------------------------
  const kept = await get(`${RELEASES}/${manifest.release}.json`);
  check(kept.ok && /immutable/.test(kept.headers.get('cache-control') || ''), `the release ${manifest.release} is not kept under ${RELEASES}/ as it should be: ${kept.status}`);

  console.log(failures.length ? `FAILED, ${failures.length}:` : `${city} is as it was published: everything checked is as it should be`);
  for (const failure of failures.slice(0, 40)) console.log('  ' + failure);
  return failures.length ? 1 : 0;
}

main().then(code => { process.exit(code); }, error => { console.error(`could not check: ${error.message}`); process.exit(1); });
