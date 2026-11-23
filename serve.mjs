// Local static server for the project. No dependencies: `node serve.mjs`, then open http://127.0.0.1:5300/hz
//
// Two origins, as online (deploy/README.md). PORT (5300) is the page: app/ at the root, and any other file of the
// repository by its path, for the tests' own pages; an address that is no file and has no extension (a city's,
// /hz) gets app/index.html, as every address does online -- the page looks at its address for the city to show. DATA_PORT (PORT + 100) is the cities' data:
// data/baked/<city>/, with the two lists the page reads first made up from what is on the disk -- cities.json and
// <city>/manifest.json, which tools/deploy/publish.mjs writes to the bucket for real. So a bake is on the page as soon
// as it is on the disk, without being published, and the page is cross-origin here as it is online.
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

import { CITIES, MANIFEST, ROOT, STAMP, TYPES, definition, filesOf, ids, shown } from './tools/deploy/manifest.mjs';

const PORT = Number(process.env.PORT) || 5300, HOST = process.env.HOST || '127.0.0.1';
const DATA_PORT = Number(process.env.DATA_PORT) || PORT + 100;
const APP = join(ROOT, 'app'), BAKED = join(ROOT, 'data', 'baked');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': TYPES['.json'], '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bin': TYPES['.bin'], '.wasm': 'application/wasm',
};
// the data is for anyone to read, as the page online reads it from another name
const FOR_ANY_PAGE = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' };

const send = (res, status, body, type = 'text/plain; charset=utf-8', headers = {}) => {
  res.writeHead(status, { 'content-type': type, ...headers });
  res.end(body);
};
const inside = (root, target) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
const fileAt = async target => {
  try {
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
};
const asked = request => request.headers['sec-fetch-mode'] === 'navigate' || String(request.headers.accept || '').includes('text/html');
const pathOf = request => decodeURIComponent(new URL(request.url, 'http://x').pathname);
const baked = id => join(BAKED, id);
const bakedCities = () => ids(ROOT).filter(id => existsSync(join(baked(id), 'index.json')));

// the list of the cities whose bake is on the disk
const list = () => ({ cities: bakedCities().map(id => shown(definition(ROOT, id))) });

// what publish.mjs writes for a city, with every file where it lies on the disk: under its own name
const manifestOf = id => {
  const stampFile = join(baked(id), STAMP), stamp = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, 'utf8')) : {};
  return {
    ...shown(definition(ROOT, id)), release: 'local', format: JSON.parse(readFileSync(join(baked(id), 'index.json'), 'utf8')).format,
    built: stamp.built ?? null, commit: stamp.commit ?? null, uncommitted: stamp.uncommitted ?? null, steps: stamp.steps ?? null,
    sources: stamp.sources ?? null, definition: stamp.definition ?? null, encoding: null,
    files: Object.fromEntries(filesOf(baked(id)).map(name => [name, name])),
  };
};

// the page
createServer(async (req, res) => {
  let pathname;
  try {
    pathname = pathOf(req);
  } catch {
    return send(res, 400, 'bad request');
  }
  const under = root => resolve(root, '.' + pathname);
  // app/ is the root of the site; the rest of the repository is there by its path for the tests' own pages
  let file = pathname === '/' ? join(APP, 'index.html') : await fileAt(under(APP)) || await fileAt(under(ROOT));
  if (file && !inside(ROOT, file)) file = null;
  if (!file && inside(ROOT, under(ROOT)) && (asked(req) || !extname(pathname))) file = join(APP, 'index.html');     // a city's address (/hz): one page, and the address says which city
  try {
    send(res, 200, await readFile(file), types[extname(file)] || 'application/octet-stream', { 'cache-control': 'no-store' });
  } catch {
    send(res, 404, 'not found');
  }
}).listen(PORT, HOST, () => {
  console.log(`serving ${ROOT}`);
  console.log(`  the page:  http://${HOST}:${PORT}/   cities: ${bakedCities().join(' ') || 'none baked yet'}`);
});

// the cities' data
createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, null, undefined, FOR_ANY_PAGE);
  let pathname;
  try {
    pathname = pathOf(req);
  } catch {
    return send(res, 400, 'bad request', undefined, FOR_ANY_PAGE);
  }
  const [city, ...rest] = pathname.slice(1).split('/');
  const json = value => send(res, 200, JSON.stringify(value), TYPES['.json'], { 'cache-control': 'no-store', ...FOR_ANY_PAGE });
  if (pathname === `/${CITIES}`) return json(list());
  if (rest.length === 1 && rest[0] === MANIFEST && bakedCities().includes(city)) return json(manifestOf(city));
  const file = resolve(BAKED, '.' + pathname);
  if (!inside(BAKED, file) || rest.includes(STAMP)) return send(res, 404, 'not found', undefined, FOR_ANY_PAGE);
  try {
    send(res, 200, await readFile(file), types[extname(file)] || 'application/octet-stream', { 'cache-control': 'no-store', ...FOR_ANY_PAGE });
  } catch {
    send(res, 404, 'not found', undefined, FOR_ANY_PAGE);
  }
}).listen(DATA_PORT, HOST, () => {
  console.log(`  the data:  http://${HOST}:${DATA_PORT}/   from data/baked/<city>/`);
});
