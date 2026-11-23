// 首页地球的陆地骨架：Natural Earth 1:110m 的陆地多边形，烘成一行行等面积的陆地点阵，
// 存进 app/globe-land.json（几 KB，进 git，和 palette.json 一样是页面自己的文件）。
//
// 行是纬度，一行一度；行内的点按经度均匀取，个数取 round(360·cos(lat))，所以点在球面上大致均匀，
// 离极地越近越稀。每个点是一位：在陆地里是 1。页面上地球的一个像素去它的行列里查最近的点。
//
// 数据只有这一处来源，第一次下载后缓存在 data/raw/globe/ 里，之后离线也能重烘：
//   node tools/bake/globe-land.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson';
const CACHE = join(ROOT, 'data', 'raw', 'globe', 'ne_110m_land.geojson');
const OUT = join(ROOT, 'app', 'globe-land.json');

// 每行一位的十六进制：第 k 位（从低位数）是行内第 k 个点，k 从经度 -180 那头数起
const hexOf = bits => {
  let out = '';
  for (let k = 0; k < bits.length; k += 4) {
    let nibble = 0;
    for (let j = 0; j < 4 && k + j < bits.length; j++) if (bits[k + j]) nibble |= 1 << j;
    out += nibble.toString(16);
  }
  return out || '';
};

// 点在一个多边形里吗：偶奇规则，外环和洞环一起数奇偶
const insideRings = (lon, lat, rings) => {
  let crossings = 0;
  for (const ring of rings) {
    for (let k = 0, n = ring.length - 1; k < n; k++) {
      const [aLon, aLat] = ring[k], [bLon, bLat] = ring[k + 1];
      if ((aLat > lat) !== (bLat > lat)) {
        const at = aLon + (lat - aLat) / (bLat - aLat) * (bLon - aLon);
        if (at > lon) crossings++;
      }
    }
  }
  return (crossings & 1) === 1;
};

// 一个多边形是「一圈圈的环」：Polygon 的 coordinates 直接就是，MultiPolygon 的是许多个
const polygonsOf = geometry => geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];

const geojson = JSON.parse(readFileSync(await (async () => {
  if (existsSync(CACHE)) return CACHE;
  console.log(`取 ${SOURCE}`);
  mkdirSync(join(ROOT, 'data', 'raw', 'globe'), { recursive: true });
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`陆地多边形取不到：${response.status}`);
  writeFileSync(CACHE, await response.text());
  return CACHE;
})(), 'utf8'));

// 每个多边形的经纬度范围，点不落在范围里的多边形看都不看
const shapes = geojson.features.flatMap(feature => polygonsOf(feature.geometry).map(rings => {
  const box = [180, 90, -180, -90];
  for (const [lon, lat] of rings.flat()) {
    box[0] = Math.min(box[0], lon); box[1] = Math.min(box[1], lat);
    box[2] = Math.max(box[2], lon); box[3] = Math.max(box[3], lat);
  }
  return { rings, box };
}));

const rows = [];
let land = 0;
for (let row = 0; row < 180; row++) {
  const lat = row - 89.5;                                   // 这行的纬度取中心
  const cols = Math.max(1, Math.round(360 * Math.cos(lat * Math.PI / 180)));
  const bits = [];
  for (let col = 0; col < cols; col++) {
    const lon = (col + 0.5) / cols * 360 - 180;             // 这一点的经度也取中心
    let hit = false;
    for (const { rings, box } of shapes) {
      if (hit || lon < box[0] || lat < box[1] || lon > box[2] || lat > box[3]) continue;
      if (insideRings(lon, lat, rings)) hit = true;
    }
    bits.push(hit);
    if (hit) land++;
  }
  rows.push([lat, cols, hexOf(bits)]);
}

const file = {
  _comment: '首页地球的陆地骨架：一行一个纬度（行首是这一行的纬度，取一度带的中心），行内的点是等面积的（个数 round(360·cos lat)，一位一个点，十六进制，第 k 位是自西向东第 k 个点，行内第 k 个点的经度是 -180 + (k+0.5)·360/cols）。1:110m 的陆地多边形烘的，Natural Earth，公有领域。重烘：node tools/bake/globe-land.mjs',
  rows,
};
writeFileSync(OUT, JSON.stringify(file));
console.log(`app/globe-land.json：${rows.length} 行，${land} 个陆地点，${(JSON.stringify(file).length / 1024).toFixed(1)} KB`);
