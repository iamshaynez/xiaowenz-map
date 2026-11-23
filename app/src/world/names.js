// The names the map's things are called by, and finding them: what the pipeline baked in a city's names.bin.
//
// A thing is found by its name, by the other names the map gives it (an English one, an old one, an alias from
// the city's own aliases, cities/<id>/aliases.json) and, for a landmark of the curated list, by each part of its title. The best answers
// come first. A station the map calls by the place above it (武林广场 for the station under the square) is found
// as if its name ended in 站, so that the place comes before it; and a query that ends in 站 finds the thing without it.
import { loadContainer, readNames } from './data.js';

export const LANDMARK = 0, ROAD = 1, RAIL = 2, BUILDING = 3, PLACE = 4, WATER = 5;
export const KINDS = ['地标', '道路', '铁路', '建筑', '地点', '水域'];
const STATION = '车站';
const SHOWN = 12;

// the form a name and a query are compared in: full-width letters and brackets as their narrow selves, no case, no spaces
export const fold = text => text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

// -> { rows, points, keys, sheets, count, bytes }: the index. keys: for each thing what it is found by, folded: its
// name, then its other names; sheets: the rows that are a sheet of water
export function openNames(sections) {
  const { rows, points } = readNames(sections);
  const keys = rows.names.map((name, k) => {
    const station = rows.labels[rows.label[k]] === STATION && !name.endsWith('站');
    return [fold(station ? `${name}站` : name), ...(rows.also[k] || '').split(';').filter(Boolean).map(fold)];
  });
  const bytes = Object.values(sections).reduce((sum, section) => sum + section.bytes.length, 0);
  return { rows, points, keys, sheets: new Set(rows.sheets || []), count: rows.names.length, bytes };
}

export async function loadNames(url) {
  return openNames(await loadContainer(url));
}

// how well `key` answers `query`: 0 the query is the key, 1 the key begins with it, 2 the key is the query without
// its final 站 (龙翔桥 for 龙翔桥站), 3 the key holds it; -1: it does not answer it
function how(query, key) {
  if (key === query) return 0;
  if (key.startsWith(query)) return 1;
  if (query.endsWith('站') && key === query.slice(0, -1)) return 2;
  return key.includes(query) ? 3 : -1;
}

// how far a thing reaches, to set equal answers in order: a line by its length, what covers ground (a sheet of
// water among it) by the side of a square of its area, a point not at all
function reach(index, k) {
  const size = index.rows.size[k];
  return index.rows.line[k] && !index.sheets.has(k) ? size : Math.sqrt(size);
}

// -> the things answering `text`, best first, at most `shown`: { k, score, name, kind, label, x, y, z, size, box, line, landmark, near }
export function search(index, text, shown = SHOWN) {
  const { rows, keys } = index, query = fold(text.trim());
  if (!query) return [];
  const found = [];
  for (let k = 0; k < rows.names.length; k++) {
    let score = Infinity;
    for (let a = 0; a < keys[k].length; a++) {
      const quality = how(query, keys[k][a]);
      if (quality >= 0) score = Math.min(score, quality + (a ? 0.5 : 0));     // another name answers half a step less well than the name
    }
    // a landmark is the better view of anything called that; but the lake comes before a landmark whose other name
    // merely holds "西湖"
    if (score < Infinity) found.push({ k, score: score - (rows.kinds[k] === LANDMARK ? (score < 2 ? 1 : 2) : 0) });
  }
  // of equal answers a landmark comes first, then what reaches furthest, then by kind
  found.sort((a, b) => a.score - b.score || (rows.kinds[a.k] === LANDMARK ? 0 : 1) - (rows.kinds[b.k] === LANDMARK ? 0 : 1) || reach(index, b.k) - reach(index, a.k)
    || rows.kinds[a.k] - rows.kinds[b.k] || a.k - b.k);
  return found.slice(0, shown).map(({ k, score }) => ({ k, score, name: rows.names[k], kind: rows.kinds[k], label: rows.labels[rows.label[k]], x: rows.x[k], y: rows.y[k], z: rows.z[k],
    size: rows.size[k], box: rows.box[k], line: rows.line[k], landmark: rows.landmark[k], near: rows.near[k] || null }));
}

// the course of a thing that runs as a line: x, y, z a point, in the index's own array; null for what does not
export function course(index, row) {
  const span = index.rows.line[row];
  return span ? index.points.subarray(span[0] * 3, (span[0] + span[1]) * 3) : null;
}

// what is said of a thing: what it is, and how long or how large
export function said(index, k) {
  const { rows } = index, label = rows.labels[rows.label[k]], size = rows.size[k];
  const words = [KINDS[rows.kinds[k]], ...(label ? [label] : [])];
  if (rows.line[k] && !index.sheets.has(k)) words.push(size >= 1000 ? `${(size / 1000).toFixed(1)} 公里` : `${size} 米`);
  else if (size >= 1e6) words.push(`${(size / 1e6).toFixed(1)} 平方公里`);
  else if (size >= 1e4) words.push(`${(size / 1e4).toFixed(1)} 公顷`);
  return words.join(' · ');
}
