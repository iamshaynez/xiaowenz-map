// The two lists the page reads before anything else, and the way a city's files are named in the bucket:
//   cities.json                        which cities there are
//   <city>/manifest.json               which files make up the city right now: each file's name as the page asks for
//                                      it -> where it lies in the bucket
//   <city>/objects/<sha256>.<kind>     the files themselves, named by what is in them: the same bytes always lie
//                                      under the same name, so nothing there is ever changed, only added to
//   <city>/releases/<release>.json     every manifest as it was published; a release is named by the hash of its own
//
// Shared by the dev server, which makes the lists up from what is on the disk (serve.mjs), and by publishing
// (tools/deploy/publish.mjs).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// the repository; PIXELCITY_ROOT names another one (tools/tests/deploy.cjs makes a small one of its own)
export const ROOT = process.env.PIXELCITY_ROOT ? resolve(process.env.PIXELCITY_ROOT) : fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');

export const CITIES = 'cities.json', MANIFEST = 'manifest.json', NEXT = 'next.json';
export const OBJECTS = 'objects', RELEASES = 'releases';
export const STAMP = 'bake.json';                 // the pipeline's note beside the baked files: not a file of the city, but what its manifest says of it
export const TYPES = { '.bin': 'application/octet-stream', '.json': 'application/json' };

export function definition(root, id) {
  return JSON.parse(readFileSync(join(root, 'cities', id, 'city.json'), 'utf8'));
}

// -> [id]: the cities the repository defines
export function ids(root) {
  return readdirSync(join(root, 'cities'), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(root, 'cities', entry.name, 'city.json'))).map(entry => entry.name).sort();
}

// what the page shows of a city before any of its files is loaded
export function shown(said) {
  return { id: said.id, name: said.name, en: said.en ?? '', subtitle: said.subtitle ?? '', bounds: said.bounds, tour: said.tour ? { label: said.tour.label } : null };
}

// -> [name]: every file of a city's baked folder, as the page asks for it: its path from the folder, `/` between the names
export function filesOf(folder) {
  const out = [];
  const walk = (at, prefix) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name.startsWith('.') || entry.name === STAMP) continue;
      const name = prefix + entry.name;
      if (entry.isDirectory()) walk(join(at, entry.name), name + '/');
      else if (statSync(join(at, entry.name)).isFile()) out.push(name);
    }
  };
  if (existsSync(folder)) walk(folder, '');
  return out;
}

// JSON that is the same whenever what it says is the same: keys in order, no padding. A release is named by the hash
// of it, so publishing the same bake twice is the same release.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

// the part of a baked folder's name that says what kind of file it is, for the object's name and its content type
export function kindOf(name) {
  const at = name.lastIndexOf('.');
  return at > name.lastIndexOf('/') ? name.slice(at) : '';
}
