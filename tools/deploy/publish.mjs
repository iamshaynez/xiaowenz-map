// Publish a city: its baked files to the bucket, compressed and named by what is in them, and the lists that say what
// the page should load -- the city's manifest and the list of cities (the layout is manifest.mjs's). Nothing that is
// in the bucket is ever changed: a file whose compressed bytes are already there is left alone, so publishing again
// after a small change uploads that change only, and a visitor who comes back downloads what changed only.
//
// Usage: node tools/deploy/publish.mjs <city>                          publish, and make it the city on show
//        node tools/deploy/publish.mjs <city> --channel next          publish where only a looker finds it (?channel=next)
//        node tools/deploy/publish.mjs <city> --dry-run               say what would be uploaded, and upload nothing
//        node tools/deploy/publish.mjs <city> --encoding gzip         gzip instead of brotli
//        node tools/deploy/publish.mjs <city> --promote               what was published as next goes on show
//        node tools/deploy/publish.mjs <city> --release <release>     an earlier release goes on show again
//        node tools/deploy/publish.mjs --list                         the cities the repository defines
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants as ZLIB, gzipSync } from 'node:zlib';

import { client } from './env.mjs';
import { CITIES, MANIFEST, NEXT, OBJECTS, RELEASES, ROOT, STAMP, TYPES, canonical, definition, filesOf, ids, kindOf, shown } from './manifest.mjs';

// how a file is compressed in the bucket, and the header a browser is served with: it unpacks the file itself
const PACKINGS = {
  br: { header: 'br', pack: body => brotliCompressSync(body, { params: { [ZLIB.BROTLI_PARAM_QUALITY]: 5 } }), unpack: body => brotliDecompressSync(body) },
  gzip: { header: 'gzip', pack: body => gzipSync(body), unpack: body => gunzipSync(body) },
};
const IMMUTABLE = 'public, max-age=31536000, immutable';     // a file named by its contents never changes: keep it a year
const ASK_EVERY_TIME = 'no-cache';                           // a list that changes when a city is published: ask whether it is the same
const AT_ONCE = 16;
const HASH = 32;                                             // hex digits of the SHA-256 in an object's name: 128 bits

const parse = args => {
  const out = { city: null, channel: MANIFEST.slice(0, -5), encoding: 'br', dryRun: false, promote: false, release: null, list: false };
  for (let k = 0; k < args.length; k++) {
    const arg = args[k], value = () => { if (k + 1 >= args.length) throw new Error(`${arg} wants a value`); return args[++k]; };
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--promote') out.promote = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--channel') out.channel = value();
    else if (arg === '--encoding') out.encoding = value();
    else if (arg === '--release') out.release = value();
    else if (arg.startsWith('--')) throw new Error(`no such option: ${arg}`);
    else if (!out.city) out.city = arg;
    else throw new Error(`two names given: ${out.city} and ${arg}`);
  }
  if (!PACKINGS[out.encoding]) throw new Error(`--encoding is one of ${Object.keys(PACKINGS).join(', ')}, not ${out.encoding}`);
  if (![MANIFEST.slice(0, -5), NEXT.slice(0, -5)].includes(out.channel)) throw new Error(`--channel is ${MANIFEST.slice(0, -5)} or ${NEXT.slice(0, -5)}, not ${out.channel}`);
  return out;
};

// a few things at a time, in order
async function together(items, work, width = AT_ONCE) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

const json = value => canonical(value) + '\n';

// what a city's manifest says, from its definition, its bake and the plan of its files
function manifestOf(root, city, plan, packing) {
  const folder = join(root, 'data', 'baked', city);
  const read = name => JSON.parse(readFileSync(join(folder, name), 'utf8'));
  const stamp = existsSync(join(folder, STAMP)) ? read(STAMP) : {};
  const core = {
    ...shown(definition(root, city)),
    format: read('index.json').format,                 // the version of the baked files the page must be able to read
    built: stamp.built ?? null, commit: stamp.commit ?? null, uncommitted: stamp.uncommitted ?? null, steps: stamp.steps ?? null,
    sources: stamp.sources ?? null, definition: stamp.definition ?? null,
    encoding: packing.header,
    files: Object.fromEntries(plan.map(({ name, key }) => [name, key.slice(city.length + 1)])),
  };
  return { ...core, release: createHash('sha256').update(canonical(core)).digest('hex').slice(0, 12) };
}

// -> { release, manifest, fresh: [{ name, bytes }], kept, upload }: the release published, and what had to be uploaded for it
export async function publish({ bucket, root, city, channel = MANIFEST.slice(0, -5), encoding = 'br', dryRun = false, log = console.log }) {
  const packing = PACKINGS[encoding];
  if (!packing) throw new Error(`--encoding is one of ${Object.keys(PACKINGS).join(', ')}, not ${encoding}`);
  const folder = join(root, 'data', 'baked', city);
  const names = filesOf(folder);
  for (const needed of ['index.json', 'overview.bin']) {
    if (!names.includes(needed)) throw new Error(`${folder} holds no bake of ${city} (no ${needed}): run the pipeline first`);
  }
  // what each file is once compressed, and so what it is called in the bucket
  const plan = names.map(name => {
    const body = packing.pack(readFileSync(join(folder, name)));
    const key = `${city}/${OBJECTS}/${createHash('sha256').update(body).digest('hex').slice(0, HASH)}${kindOf(name)}`;
    return { name, key, body };
  });
  // the small lists first: they tell of every object, so every object is there before they say so
  const manifest = manifestOf(root, city, plan, packing), fresh = [];
  let kept = 0, putCount = 0;
  await together(plan, async item => {
    if (await bucket.head(item.key)) { kept++; return; }
    fresh.push({ name: item.name, bytes: item.body.length });
    if (!dryRun) {
      await bucket.put(item.key, item.body, { type: TYPES[kindOf(item.name)], cacheControl: IMMUTABLE, contentEncoding: packing.header });
      if (++putCount % 200 === 0) log(`  ${putCount} uploaded so far (${(fresh.reduce((sum, item) => sum + item.bytes, 0) / 1e6).toFixed(0)} MB of new files found)`);
    }
  });
  const upload = fresh.reduce((sum, item) => sum + item.bytes, 0);
  const what = `${city} ${manifest.release}: ${plan.length} files, ${(plan.reduce((sum, item) => sum + item.body.length, 0) / 1e6).toFixed(1)} MB as ${packing.header}`;
  if (dryRun) {
    log(`${what}; ${fresh.length} to upload (${(upload / 1e6).toFixed(1)} MB), ${kept} already in the bucket; nothing uploaded`);
    return { release: manifest.release, manifest, fresh, kept, upload };
  }
  // a list goes in as a file does: compressed, and served with the header that says so
  const put = (key, text, cacheControl, as = packing) => bucket.put(key, as.pack(Buffer.from(text)), { type: TYPES['.json'], cacheControl, contentEncoding: as.header });
  await put(`${city}/${RELEASES}/${manifest.release}.json`, json(manifest), IMMUTABLE);
  await put(`${city}/${channel}.json`, json(manifest), ASK_EVERY_TIME);
  // the city among the cities: what is there is read first, so that publishing one city leaves the others as they are
  const list = (await bucket.json(CITIES)) || { cities: [] };
  const cityShown = shown(definition(root, city));
  const cities = [...list.cities.filter(said => said.id !== city), cityShown].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  await put(CITIES, json({ cities }), ASK_EVERY_TIME);
  log(`${what}; uploaded ${fresh.length} (${(upload / 1e6).toFixed(1)} MB), ${kept} already there`);
  log(`${city}/${channel}.json is this release; ${cities.length} ${cities.length === 1 ? 'city' : 'cities'} in ${CITIES}`);
  return { release: manifest.release, manifest, fresh, kept, upload };
}

// the manifest on show becomes what `from` says: the next channel, or a release that was published before
export async function putOnShow({ bucket, city, from, log = console.log }) {
  const manifest = await bucket.json(from === NEXT ? `${city}/${NEXT}` : `${city}/${RELEASES}/${from}.json`);
  if (!manifest) throw new Error(from === NEXT ? `${city}/${NEXT} is not there: publish with --channel next first` : `no release ${from} of ${city} in the bucket`);
  if (manifest.id !== city) throw new Error(`${from} tells of ${manifest.id}, not of ${city}`);
  const held = await bucket.head(`${city}/${RELEASES}/${manifest.release}.json`);
  if (!held) throw new Error(`the release ${manifest.release} is not in the bucket: its files may have been taken away`);
  const packing = Object.values(PACKINGS).find(one => one.header === held.encoding);
  if (!packing) throw new Error(`the release ${manifest.release} is packed as ${held.encoding}, which is not known here`);
  await bucket.put(`${city}/${MANIFEST}`, packing.pack(Buffer.from(json(manifest))), { type: TYPES['.json'], cacheControl: ASK_EVERY_TIME, contentEncoding: packing.header });
  log(`${city} on show: release ${manifest.release}${manifest.built ? `, baked ${manifest.built}` : ''}`);
  return manifest;
}

async function main() {
  const asked = parse(process.argv.slice(2));
  if (asked.list || !asked.city) {
    console.log(asked.list ? `cities: ${ids(ROOT).join(' ') || 'none'}` : 'usage: node tools/deploy/publish.mjs <city> [--channel next] [--dry-run] [--encoding gzip] [--promote | --release <release>] [--list]');
    return asked.list ? 0 : 2;
  }
  if (!ids(ROOT).includes(asked.city)) throw new Error(`there is no city called "${asked.city}" under cities/ (there are: ${ids(ROOT).join(' ') || 'none'})`);
  const bucket = client();
  if (asked.promote) await putOnShow({ bucket, city: asked.city, from: NEXT });
  else if (asked.release) await putOnShow({ bucket, city: asked.city, from: asked.release });
  else await publish({ bucket, root: ROOT, city: asked.city, channel: asked.channel, encoding: asked.encoding, dryRun: asked.dryRun });
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exit(code); }, error => { console.error(`publishing failed: ${error.message}`); process.exit(1); });
}
