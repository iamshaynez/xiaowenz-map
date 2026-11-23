// Publishing a city, against a small bucket of this test's own -- a server that speaks as much S3 as publishing asks
// (put, head and get) and keeps what it is given -- and a small repository of its own holding one tiny city. What is
// checked: the files go in compressed and named by their contents, with the headers a browser is served with; the
// manifest tells of every file and of the bake; publishing again uploads nothing; a changed file is the only one
// uploaded, and the release changes; the next channel, putting it on show, and going back to an earlier release; a
// dry run uploads nothing; what is refused.
//
// Usage: node tools/tests/deploy.cjs
const assert = require('node:assert');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { brotliDecompressSync, gunzipSync } = require('node:zlib');

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const QUIET = () => {};
const KEYS = { R2_ACCOUNT_ID: 'theaccount', R2_BUCKET: 'thetest', R2_ACCESS_KEY_ID: 'THEKEY', R2_SECRET_ACCESS_KEY: 'a secret' };
const FILES = ['index.json', 'landmarks.json', 'names.bin', 'overview.bin', 'tiles/b/0_0.bin', 'tiles/b/1_0.bin'];

// a bucket: what it was given, by key, with the headers it was given with; and every request it had
function bucket() {
  const store = new Map(), asked = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const key = decodeURIComponent(request.url), held = store.get(key);
      asked.push({ method: request.method, key, signed: String(request.headers.authorization || '').startsWith('AWS4-HMAC-SHA256 Credential=THEKEY/') });
      const headers = { 'content-length': String(held?.body.length ?? 0), etag: '"etag"', 'content-type': held?.type, 'cache-control': held?.cache,
                        ...(held?.encoding ? { 'content-encoding': held.encoding } : {}) };
      if (request.method === 'PUT') {
        store.set(key, { body: Buffer.concat(chunks), type: request.headers['content-type'], cache: request.headers['cache-control'], encoding: request.headers['content-encoding'] });
        response.writeHead(200, { etag: '"etag"' });
        response.end();
      } else if (!held) { response.writeHead(404); response.end(); }
      else if (request.method === 'HEAD') { response.writeHead(200, headers); response.end(); }
      else if (request.method === 'GET') { response.writeHead(200, headers); response.end(held.body); }
      else { response.writeHead(405); response.end(); }
    });
  });
  return { store, asked, server, listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve)), close: () => new Promise(resolve => server.close(resolve)) };
}

// what a JSON object in the bucket says
const said = held => JSON.parse((held.encoding === 'br' ? brotliDecompressSync(held.body) : held.encoding === 'gzip' ? gunzipSync(held.body) : held.body).toString('utf8'));

const stamp = { city: 'x', built: '2026-11-23T11:11:30+00:00', steps: ['bake'], commit: '02506d8aea3f', uncommitted: false, sources: { osm: { sha256: 'a'.repeat(64) } }, definition: { 'city.json': 'b'.repeat(64) } };
const DATA = {                         // bytes that compress, as the baked files do
  'index.json': JSON.stringify({ format: 2, bounds: [0, 0, 1, 1] }),
  'overview.bin': Buffer.alloc(200000, 7).toString('latin1'),
  'names.bin': JSON.stringify({ names: ['文三路', '文三路', '文三路'] }),
  'landmarks.json': JSON.stringify([{ id: '1-01', title: '试桥' }]),
  'tiles/b/0_0.bin': 'ab'.repeat(5000),
  'tiles/b/1_0.bin': 'cd'.repeat(3000),
  'bake.json': JSON.stringify(stamp),
  '.DS_Store': 'junk',                 // not a file of the city: nor what starts with a dot, nor the stamp
  'tiles/b/.hidden.bin': 'junk',
};

// a repository with one city, x, whose baked folder holds `files`
function repository(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelcity-repo-'));
  fs.mkdirSync(path.join(root, 'cities', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'cities', 'x', 'city.json'),
                   JSON.stringify({ id: 'x', name: '试城', en: 'Shicheng', subtitle: '试验', bounds: [0, 0, 1, 1], epsg: 32651, origin: [0, 0], sources: {}, tour: { label: '环城导览' } }));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, 'data', 'baked', 'x', name)), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'baked', 'x', name), body);
  }
  return root;
}
const of = (root, name) => fs.readFileSync(path.join(root, 'data', 'baked', 'x', name));

async function main() {
  const { publish, putOnShow } = await import('../deploy/publish.mjs');
  const { client, settings, told, NEEDED } = await import('../deploy/env.mjs');
  const { canonical } = await import('../deploy/manifest.mjs');
  const world = bucket();
  await world.listen();
  const r2 = client(KEYS, { endpoint: `http://127.0.0.1:${world.server.address().port}` });
  const root = repository(DATA);
  const at = name => world.store.get(`/thetest/${name}`);
  const objects = () => [...world.store.keys()].filter(key => key.startsWith('/thetest/x/objects/'));
  const MANIFEST = 'x/manifest.json';

  try {
    // ---- the first publishing ------------------------------------------------------------------------------------
    const first = await publish({ bucket: r2, root, city: 'x', log: QUIET });
    check(first.fresh.length === FILES.length && first.kept === 0, `${FILES.length} files uploaded the first time (got ${first.fresh.length} fresh, ${first.kept} kept)`);
    check(objects().length === FILES.length, `${FILES.length} objects in the bucket (got ${objects().length})`);
    const manifest = said(at(MANIFEST));
    check(manifest.id === 'x' && manifest.name === '试城' && manifest.subtitle === '试验' && JSON.stringify(manifest.bounds) === '[0,0,1,1]' && manifest.tour.label === '环城导览',
          'the manifest says of the city what its definition says');
    check(manifest.format === 2 && manifest.built === stamp.built && manifest.commit === stamp.commit && manifest.uncommitted === false, 'the manifest says of the bake what its stamp says');
    check(manifest.encoding === 'br' && /^[0-9a-f]{12}$/.test(manifest.release), 'the manifest names its encoding, and a release of twelve hex digits');
    check(JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify(FILES), 'every file of the city is in the manifest, and nothing else is');
    let whole = true, named = true, headed = true, typed = true;
    for (const [name, where] of Object.entries(manifest.files)) {
      const held = at(`x/${where}`);
      if (!held) { whole = false; continue; }
      if (brotliDecompressSync(held.body).compare(of(root, name)) !== 0) whole = false;
      if (where !== `objects/${createHash('sha256').update(held.body).digest('hex').slice(0, 32)}${path.extname(name)}`) named = false;
      if (held.encoding !== 'br' || held.cache !== 'public, max-age=31536000, immutable') headed = false;
      if (held.type !== (name.endsWith('.json') ? 'application/json' : 'application/octet-stream')) typed = false;
    }
    check(whole, 'every file the manifest tells of is in the bucket, and unpacks to what was baked');
    check(named, 'an object is named by the hash of its compressed bytes, and by what kind of file it is');
    check(headed, 'a file is served as brotli and kept for a year: it never changes under its name');
    check(typed, 'a file is served with the type of what it is');
    check(canonical(said(at('cities.json'))) === canonical({ cities: [{ id: 'x', name: '试城', en: 'Shicheng', subtitle: '试验', bounds: [0, 0, 1, 1], tour: { label: '环城导览' } }] }),
          'the list of cities holds the city, and what the page shows of it before its files are loaded');
    check(at('cities.json').cache === 'no-cache' && at(MANIFEST).cache === 'no-cache', 'the two lists are asked about every time: they are what changes when a city is published');
    check(said(at(`x/releases/${manifest.release}.json`)).release === manifest.release && at(`x/releases/${manifest.release}.json`).cache.includes('immutable'), 'the manifest is kept as a release, never to change');
    check(world.asked.every(request => request.signed), 'every request was signed');
    check(world.asked.some(request => request.method === 'GET' && request.key === '/thetest/cities.json'), 'the list of cities is read before it is written, so that other cities stay in it');
    const stored = world.store.size;

    // ---- the same bake again: nothing to upload ------------------------------------------------------------------
    const again = await publish({ bucket: r2, root, city: 'x', log: QUIET });
    check(again.fresh.length === 0 && again.kept === FILES.length, 'publishing the same bake again uploads nothing');
    check(again.release === first.release && world.store.size === stored, 'the same bake is the same release, and changes nothing in the bucket');

    // ---- one tile changed -----------------------------------------------------------------------------------------
    fs.writeFileSync(path.join(root, 'data', 'baked', 'x', 'tiles/b/1_0.bin'), 'ef'.repeat(3100));
    const changed = await publish({ bucket: r2, root, city: 'x', log: QUIET });
    const second = said(at(MANIFEST));
    check(changed.fresh.length === 1 && changed.fresh[0].name === 'tiles/b/1_0.bin' && changed.kept === FILES.length - 1, 'a changed tile is the only file uploaded');
    check(second.release !== first.release && second.files['tiles/b/1_0.bin'] !== manifest.files['tiles/b/1_0.bin'] && second.files['tiles/b/0_0.bin'] === manifest.files['tiles/b/0_0.bin'],
          'the release changes, and with it the one file\'s place; the others keep theirs');
    check(objects().length === FILES.length + 1, 'the file that was there is still there: nothing in the bucket is changed');

    // ---- the next channel, putting it on show, and an earlier release ---------------------------------------------
    fs.writeFileSync(path.join(root, 'data', 'baked', 'x', 'tiles/b/0_0.bin'), 'gh'.repeat(5100));
    const next = await publish({ bucket: r2, root, city: 'x', channel: 'next', log: QUIET });
    check(said(at('x/next.json')).release === next.release && said(at(MANIFEST)).release === second.release, 'what is published as next is reached by the next channel only');
    await putOnShow({ bucket: r2, root, city: 'x', from: 'next.json', log: QUIET });
    check(said(at(MANIFEST)).release === next.release, 'next put on show: the manifest is that release');
    await putOnShow({ bucket: r2, root, city: 'x', from: first.release, log: QUIET });
    check(said(at(MANIFEST)).release === first.release && said(at(MANIFEST)).files['tiles/b/1_0.bin'] === manifest.files['tiles/b/1_0.bin'], 'an earlier release can be put on show again, with its files as they were');
    await assert.rejects(putOnShow({ bucket: r2, root, city: 'x', from: '0'.repeat(12), log: QUIET }), /no release 000000000000 of x/, 'a release there is not is refused');
    world.store.delete('/thetest/x/next.json');
    await assert.rejects(putOnShow({ bucket: r2, root, city: 'x', from: 'next.json', log: QUIET }), /publish with --channel next first/, 'putting a next channel that was never published on show is refused');

    // ---- a dry run ------------------------------------------------------------------------------------------------
    fs.writeFileSync(path.join(root, 'data', 'baked', 'x', 'names.bin'), JSON.stringify({ names: ['教场路'] }));
    const before = world.store.size;
    const dry = await publish({ bucket: r2, root, city: 'x', dryRun: true, log: QUIET });
    check(dry.fresh.length === 1 && dry.fresh[0].name === 'names.bin' && world.store.size === before, 'a dry run says what would be uploaded, and uploads nothing');

    // ---- gzip instead of brotli -----------------------------------------------------------------------------------
    const gz = await publish({ bucket: r2, root, city: 'x', encoding: 'gzip', log: QUIET });
    const zipped = said(at(MANIFEST));
    check(gz.fresh.length === FILES.length && zipped.encoding === 'gzip', 'with gzip every file is another object, as its compressed bytes are others');
    check(gunzipSync(at(`x/${zipped.files['overview.bin']}`).body).compare(of(root, 'overview.bin')) === 0, 'and each unpacks to what was baked');

    // ---- what is refused ------------------------------------------------------------------------------------------
    await assert.rejects(publish({ bucket: r2, root: repository({ 'index.json': '{}' }), city: 'x', log: QUIET }), /no overview.bin/, 'a folder without a whole bake is refused');
    await assert.rejects(publish({ bucket: r2, root, city: 'x', encoding: 'zip', log: QUIET }), /--encoding is one of br, gzip/);
    const saved = Object.fromEntries(NEEDED.map(name => [name, process.env[name]]));
    for (const name of NEEDED) delete process.env[name];
    const bare = repository(DATA);
    const bareSaid = told(bare);                                   // nothing in the environment now, and no .env yet
    for (const name of NEEDED) assert.strictEqual(bareSaid[name], undefined, `${name} should not be told by anything`);
    assert.throws(() => settings(bareSaid), /not told R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
    fs.writeFileSync(path.join(bare, '.env'), '# what publishing needs\nR2_ACCOUNT_ID=acct\nexport R2_BUCKET="the-bucket"\nR2_ACCESS_KEY_ID=\'key\'\nR2_SECRET_ACCESS_KEY=s3cr3t=\n');
    assert.deepStrictEqual(settings(told(bare)), { R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'the-bucket', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 's3cr3t=' });     // quotes, export and a value ending in = are read as they are
    process.env.R2_BUCKET = 'from-the-environment';
    assert.strictEqual(settings(told(bare)).R2_BUCKET, 'from-the-environment', 'what the environment says comes first');
    delete process.env.R2_BUCKET;
    for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;

    // ---- a list is the same whenever what it says is the same ----------------------------------------------------
    check(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }) === '{"a":[2,{"c":4,"d":3}],"b":1}', 'a list is written with its keys in order');

    console.log(`publish: ${failures.length ? `${failures.length} FAILED` : 'all as expected'}`);
    for (const failure of failures) console.log('  FAILED: ' + failure);
  } finally {
    await world.close();
    for (const folder of fs.readdirSync(os.tmpdir()).filter(name => name.startsWith('pixelcity-repo-'))) fs.rmSync(path.join(os.tmpdir(), folder), { recursive: true, force: true });
  }
  process.exitCode = failures.length ? 1 : 0;
}

main().catch(error => { console.error(error); process.exit(1); });
