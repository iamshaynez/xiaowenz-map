// Does the compact form of the baked files carry the same map as the floats it replaced? Reads a previous
// bake and the present one tile by tile with the page's readers (the old one from git) and compares what
// they give the page: every building corner, every ground triangle, every tree, every rooftop box, and the
// overview. Positions may differ by up to half a unit of their integer (the quantisation), the rest must agree.
//
// Buildings are told apart by what they are (their seed, levels, look, flags and the middle of their
// outline), not by their place in the file: the bake now leaves out the records that repeat another one's
// footprint (buildings.doubles), so a building may have moved up in the file. Every building of the new bake
// must be one of the old; the ones of the old bake that are gone must be exactly the records the bake says it
// left out (data/work/repeated-outlines.json); and what stood on the roofs of those must be gone with them.
//
// Usage: node tools/tests/bake-compare.cjs <previous-baked-dir> [old-data-module.mjs]
//   (the previous bake in data/baked's layout; its reader is taken from git unless a module is given:
//    git show <commit>:app/src/world/data.js > old-data.mjs)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const oldDir = path.resolve(process.argv[2] || '');
const nowDir = path.join(root, 'data/baked');
const oldModule = process.argv[3] ? path.resolve(process.argv[3]) : path.join(root, 'out/bake-compare/old-data.mjs');
if (!process.argv[2] && !process.argv[3]) { console.log('usage: bake-compare.cjs <previous-baked-dir> [old-data-module.mjs]'); process.exit(2); }

const close = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const SLACK = 1e-4;                                     // what a float32 may be off by on its own
const XY = 0.5 / 24 + SLACK, Z = 0.5 / 40 + SLACK, HALF = 0.5 / 10 + SLACK, CM = 0.5 / 100 + SLACK;   // half a unit of each integer, as compact.py has them

(async () => {
  const old = await import(oldModule), now = await import(path.join(root, 'app/src/world/data.js'));
  const index = JSON.parse(fs.readFileSync(path.join(nowDir, 'index.json'), 'utf8'));
  const lifts = Object.fromEntries(Object.entries(index.groundClasses).map(([id, info]) => [Number(id), info.lift]));
  const bytes = file => { const buffer = fs.readFileSync(file); return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); };
  const read = (module, dir, name) => module.parseContainer(bytes(path.join(dir, name)));
  const worst = {};                                       // the largest difference met, by kind
  const note = (kind, difference) => { worst[kind] = Math.max(worst[kind] || 0, difference); };
  let tiles = 0, buildings = 0, corners = 0, triangles = 0, trees = 0, boxes = 0, leftOut = 0;
  const goneAll = [];                                      // the records left out: where their roofs are, and where
  // what the bake says it left out, and what it kept in place of each (data/work/repeated-outlines.json,
  // written by a bake that leaves repeated outlines out; the same seven numbers as a building's properties
  // 2 to 8: levels, archetype, roof, wall colour, roof colour, seed, flags)
  const repeatedPath = path.join(root, 'data/work/repeated-outlines.json');
  const repeated = fs.existsSync(repeatedPath) ? JSON.parse(fs.readFileSync(repeatedPath, 'utf8')) : { leftOut: [], kept: [] };
  const key = row => row.map(Number).join(','), add = (map, k) => map.set(k, (map.get(k) || 0) + 1);
  const leftOutCount = new Map(), keptKeys = new Set(), leftSeen = new Map(), nowSeen = new Map();
  repeated.leftOut.forEach(row => add(leftOutCount, key(row)));
  repeated.kept.forEach(row => keptKeys.add(key(row)));            // one record may be kept over several

  const compareGround = (id, a, b, height, label) => {
    assert.equal(a.indices.length, b.indices.length, `${label} ${id}: as many indices`);
    for (let k = 0; k < a.indices.length; k++) {
      const va = a.indices[k] * 5, vb = b.indices[k] * 5;
      for (let c = 0; c < 2; c++) {
        const d = Math.abs(a.vertices[va + c] - b.vertices[vb + c]);
        note(`${id} x, y`, d);
        assert.ok(d <= XY, `${label} ${id}: corner ${k} axis ${c}: ${a.vertices[va + c]} against ${b.vertices[vb + c]}`);
      }
      assert.equal(a.vertices[va + 3], b.vertices[vb + 3], `${label} ${id}: corner ${k} class`);
      const dz = Math.abs(a.vertices[va + 2] - b.vertices[vb + 2]);
      note(`${id} height`, dz);
      // the height is read at the quantised position, on ground that may slope: a few centimetres at most
      assert.ok(dz <= 0.08, `${label} ${id}: corner ${k} height ${a.vertices[va + 2]} against ${b.vertices[vb + 2]}`);
      assert.ok(height || a.vertices[va + 4] === 0 || (a.vertices[va + 4] === 1 && a.vertices[va + 3] === 12), `${label} ${id}: an old seed of ${a.vertices[va + 4]} only on a deck's walls`);
    }
    triangles += a.indices.length / 3;
  };

  // ---- the overview ------------------------------------------------------------------------------------------------
  const o = read(old, oldDir, 'overview.bin'), n = read(now, nowDir, 'overview.bin');
  assert.ok(Buffer.from(n.GRID.bytes).equals(Buffer.from(o.GRID.bytes)), 'overview: the same height grid');
  assert.ok(Buffer.from(n.LCV.bytes).equals(Buffer.from(o.LCV.bytes)), 'overview: the same cover cells');
  // URB: how much of each cell is built over (which counted the repeated outlines twice) and how tall
  const urbOld = o.URB.bytes, urbNew = n.URB.bytes;
  assert.equal(urbNew.length, urbOld.length, 'overview: as many built-over cells');
  let crossed = 0, emptied = 0;
  for (let k = 0; k < urbOld.length; k += 2) {
    // a cell may have lost its buildings only if they repeated outlines whose taller record stands in the cell beside
    assert.ok(urbNew[k + 1] <= urbOld[k + 1], `overview: the tallest of cell ${k / 2}: ${urbOld[k + 1]} before, ${urbNew[k + 1]} now`);
    assert.ok(urbNew[k] <= urbOld[k], `overview: cell ${k / 2} is built over no more than before`);
    if ((urbNew[k] > 5) !== (urbOld[k] > 5)) crossed++;
    if (urbOld[k + 1] > 0 && urbNew[k + 1] === 0) emptied++;
  }
  const massOld = old.readMassing(o.MASS), massNew = now.readMassing(n.MASS);
  const cellOf = (mass, k) => `${mass[k]},${mass[k + 1]}`;
  const oldCells = new Map();
  for (let k = 0; k < massOld.length; k += 8) oldCells.set(cellOf(massOld, k), k);
  let cellsGone = 0;
  for (let k = 0; k < massNew.length; k += 8) {
    const at = oldCells.get(cellOf(massNew, k));
    assert.notEqual(at, undefined, `overview: a massing cell that the old bake had too (${cellOf(massNew, k)})`);
    oldCells.delete(cellOf(massNew, k));
    for (let c = 2; c < 8; c++) {
      const tolerance = c === 2 ? Z : c === 3 ? CM : 0;
      if (tolerance) note(`MASS ${c === 2 ? 'base' : 'height'}`, Math.abs(massOld[at + c] - massNew[k + c]));
      assert.ok(close(massOld[at + c], massNew[k + c], tolerance), `overview: massing cell ${cellOf(massNew, k)} field ${c}: ${massOld[at + c]} against ${massNew[k + c]}`);
    }
  }
  cellsGone = oldCells.size;
  const grid = now.readGrid(n.GRID);
  const ribbonsOld = old.readRibbons(o.RIBA), ribbonsNew = now.readRibbons(n.RIBA, (x, y) => now.surfaceOn(grid, x, y), lifts);
  assert.equal(ribbonsOld.indices.length, ribbonsNew.indices.length, 'overview: as many ribbon indices');
  assert.deepEqual([...ribbonsNew.indices], [...ribbonsOld.indices], 'overview: the same ribbon triangles');
  // lines the overview draws reach tens of kilometres past the region, where the bake still had the DEM's
  // heights and the page has only the overview's grid: beyond that grid a strip's height is the grid's last
  // cell's (and the page draws nothing there: the island ends at the region)
  const outside = (x, y) => x < grid.x0 || x > grid.x0 + (grid.nx - 1) * grid.cell || y < grid.y0 || y > grid.y0 + (grid.ny - 1) * grid.cell;
  let beyond = 0;
  for (let k = 0; k < ribbonsOld.vertices.length; k += 8) {
    const far = outside(ribbonsOld.vertices[k], ribbonsOld.vertices[k + 1]);
    if (far) beyond++;
    for (const [c, tolerance, what] of [[0, 0.8, 'x'], [1, 0.8, 'y'], [2, far ? Infinity : 0.6, 'height']]) {
      const d = Math.abs(ribbonsOld.vertices[k + c] - ribbonsNew.vertices[k + c]);
      note(`RIBA ${what}`, d);
      assert.ok(d <= tolerance, `overview: ribbon vertex ${k / 8} ${what}: ${ribbonsOld.vertices[k + c]} against ${ribbonsNew.vertices[k + c]}`);
    }
    for (const c of [3, 4, 5]) assert.equal(ribbonsOld.vertices[k + c], ribbonsNew.vertices[k + c], `overview: ribbon vertex ${k / 8} field ${c}`);
    for (const c of [6, 7]) {
      const d = Math.abs(ribbonsOld.vertices[k + c] - ribbonsNew.vertices[k + c]);
      note('RIBA direction', d);
      assert.ok(d <= 0.001, `overview: ribbon vertex ${k / 8} direction: ${ribbonsOld.vertices[k + c]} against ${ribbonsNew.vertices[k + c]}`);
    }
  }

  // ---- every tile ---------------------------------------------------------------------------------------------------
  const files = fs.readdirSync(path.join(nowDir, 'tiles/b'));
  for (const name of files) {
    const a = read(old, oldDir, `tiles/b/${name}`), b = read(now, nowDir, `tiles/b/${name}`);
    if (process.env.PROGRESS && tiles % 100 === 0) console.error(`${tiles} tiles, ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${name}: the same sections`);
    // META counts the buildings and rooftop boxes of the tile, which the repeated outlines change
    for (const id of ['BASE', 'PATH', 'PLCE']) if (a[id]) assert.ok(Buffer.from(a[id].bytes).equals(Buffer.from(b[id].bytes)), `${name}: ${id} unchanged`);
    const [tx, ty] = name.replace('.bin', '').split('_').map(Number);
    const x0 = (index.ix0 + tx) * index.tileSize, y0 = (index.iy0 + ty) * index.tileSize;
    const lattice = now.readGrid(b.TERR);
    const surface = (x, y) => now.surfaceOn(lattice, x + x0, y + y0);
    const onGround = (x, y, cls) => Math.fround(surface(x, y) + (lifts[cls] ?? 0.02));
    if (a.BLDB) {
      const p = old.readBuildings(a.BLDB), q = now.readBuildings(b.BLDB);
      // each building with its corners and triangles in order of first use, and the outline its walls stand on
      const split = r => {
        const list = [];
        for (let t = 0; t < r.indices.length; t++) {
          const i = r.indices[t], b = r.vertices[i * 6 + 5];
          (list[b] || (list[b] = { b, props: Array.from(r.props.subarray(b * 9, b * 9 + 9)), corners: [], triangles: [] }));
          const at = list[b].corners.findIndex(c => c[5] === i);
          list[b].triangles.push(at < 0 ? list[b].corners.length : at);
          if (at < 0) list[b].corners.push([r.vertices[i * 6], r.vertices[i * 6 + 1], r.vertices[i * 6 + 2], r.vertices[i * 6 + 3], r.vertices[i * 6 + 4], i]);
        }
        const items = list.filter(Boolean);                   // a building with nothing to draw leaves a gap
        for (const item of items) {
          // the outline: the foot of each wall, in the order the mesh goes round it (each wall is a quad
          // from one corner's foot to the next's, and the walls follow each other round the outline)
          const feet = item.corners.filter(c => Math.hypot(c[3], c[4]) > 0.99 && Math.abs(c[2] - item.props[0]) < 1e-3).map(c => [c[0], c[1]]);
          item.outline = feet.filter((p, k) => k === 0 || Math.hypot(p[0] - feet[k - 1][0], p[1] - feet[k - 1][1]) > 1e-4);
          if (item.outline.length > 1 && Math.hypot(item.outline[0][0] - item.outline.at(-1)[0], item.outline[0][1] - item.outline.at(-1)[1]) <= 1e-4) item.outline.pop();   // not the closing corner
          item.centre = item.outline.reduce((m, c) => [m[0] + c[0] / item.outline.length, m[1] + c[1] / item.outline.length], [0, 0]);
          item.top = item.props[0] + item.props[1];
        }
        return items;
      };
      const before = split(p), after = split(q), same = (x, y, cols) => cols.every(c => x.props[c] === y.props[c]);
      const LOOK = [2, 3, 4, 5, 6, 7, 8];
      const taken = new Set();
      for (const nowB of after) {
        // of the old buildings that look the same and stand in the same place, the one as tall as this
        const found = before.filter(oldB => same(oldB, nowB, LOOK) && Math.hypot(oldB.centre[0] - nowB.centre[0], oldB.centre[1] - nowB.centre[1]) <= 0.05 && oldB.corners.length === nowB.corners.length)
          .sort((x, y) => Math.abs(x.props[1] - nowB.props[1]) - Math.abs(y.props[1] - nowB.props[1]));
        assert.ok(found.length >= 1, `${name}: the new building at ${nowB.centre.map(v => v.toFixed(2))} is a building of the old bake`);
        const oldB = found[0];
        taken.add(oldB);
        assert.deepEqual(nowB.triangles, oldB.triangles, `${name}: the building at ${nowB.centre.map(v => v.toFixed(2))}: the same triangles`);
        for (const [tolerance, c] of [[Z, 0], [CM, 1]]) {
          note('BLDB ' + (c === 0 ? 'base' : 'height'), Math.abs(oldB.props[c] - nowB.props[c]));
          assert.ok(close(oldB.props[c], nowB.props[c], tolerance), `${name}: a building's ${c === 0 ? 'base' : 'height'}: ${oldB.props[c]} against ${nowB.props[c]}`);
        }
        for (let k = 0; k < nowB.corners.length; k++) {
          for (let c = 0; c < 5; c++) {                 // not the building's place in the file: that moves
            const tolerance = c < 2 ? XY : c === 2 ? Z : 1e-4;
            if (tolerance) note('BLDB corner ' + ['x, y', 'x, y', 'height', 'normal', 'normal'][c], Math.abs(oldB.corners[k][c] - nowB.corners[k][c]));
            assert.ok(close(oldB.corners[k][c], nowB.corners[k][c], tolerance), `${name}: a corner's field ${c}: ${oldB.corners[k][c]} against ${nowB.corners[k][c]}`);
          }
        }
        buildings++;
        corners += nowB.corners.length;
      }
      // what the old bake had and this one has not: the records the bake says it left out (data/work/
      // repeated-outlines.json, written by the bake from the list before they were left out), the same ones
      // and no others; and each record kept in their place is a building of the new bake
      const gone = [];
      for (const oldB of before) {
        if (taken.has(oldB)) continue;
        gone.push(oldB);
        add(leftSeen, key(oldB.props.slice(2, 9)));
      }
      for (const nowB of after) add(nowSeen, key(nowB.props.slice(2, 9)));
      leftOut += gone.length;
      for (const g of gone) goneAll.push({ tile: name, top: g.top, ring: g.outline });
    }
    for (const id of ['WATR', 'ROAD', 'LAND', 'DECK']) if (a[id]) compareGround(id, old.readMesh(a[id]), now.readMesh(b[id], id === 'DECK' ? null : onGround), id !== 'DECK', name);
    if (a.TREE) {
      const p = old.readTrees(a.TREE), q = now.readTrees(b.TREE, (x, y) => Math.fround(surface(x, y)));
      assert.equal(p.count, q.count, `${name}: as many trees`);
      assert.deepEqual([...q.starts], [...p.starts], `${name}: the same runs of trees`);
      const fa = new Float32Array(p.records.buffer, p.records.byteOffset, p.count * 4), fb = new Float32Array(q.records.buffer, q.records.byteOffset, q.count * 4);
      for (let k = 0; k < p.count; k++) {
        for (let c = 0; c < 2; c++) {
          const d = Math.abs(fa[k * 4 + c] - fb[k * 4 + c]);
          note('TREE x, y', d);
          assert.ok(d <= XY, `${name}: tree ${k} axis ${c}: ${fa[k * 4 + c]} against ${fb[k * 4 + c]}`);
        }
        const dz = Math.abs(fa[k * 4 + 2] - fb[k * 4 + 2]);
        note('TREE height', dz);
        assert.ok(dz <= 0.08, `${name}: tree ${k} height ${fa[k * 4 + 2]} against ${fb[k * 4 + 2]}`);
        for (let c = 12; c < 16; c++) assert.equal(q.records[k * 16 + c], p.records[k * 16 + c], `${name}: tree ${k}: species, size, seed, kind`);
      }
      trees += p.count;
    }
    tiles++;
  }
  // the records gone from the old bake are the ones the bake left out, and no others (none, where the bake
  // leaves none out)
  assert.deepEqual([...leftSeen].sort(), [...leftOutCount].sort(), 'the records gone from the tiles are the ones the bake left out');
  for (const k of keptKeys) assert.ok(nowSeen.has(k), `the record kept in place of one left out is a building of the new bake (${k})`);

  // ---- what stands on the roofs ------------------------------------------------------------------------------------------------
  // Every box of the new bake is a box of the old one, in the same place. Every box of the old bake that is
  // gone stood on a record that was left out, which may lie in the tile next door (a building belongs to the
  // tile holding its middle, each of its boxes to the tile it lies in).
  const originOf = name => { const [tx, ty] = name.replace('.bin', '').split('_').map(Number); return [(index.ix0 + tx) * index.tileSize, (index.iy0 + ty) * index.tileSize]; };
  const insideRing = (p, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const XY_ = XY, Z_ = Z, HALF_ = HALF;
  const near = (o, box) => o[6] === box[6] && o[7] === box[7] && Math.abs(o[0] - box[0]) <= XY_ && Math.abs(o[1] - box[1]) <= XY_ && Math.abs(o[2] - box[2]) <= Z_
    && Math.abs(o[3] - box[3]) <= HALF_ && Math.abs(o[4] - box[4]) <= HALF_ && Math.abs(o[5] - box[5]) <= HALF_;
  let boxesGone = 0;
  for (const name of files) {
    const a = read(old, oldDir, `tiles/b/${name}`), b = read(now, nowDir, `tiles/b/${name}`);
    if (!a.ROOF) continue;
    const was = old.readBoxes(a.ROOF), is = now.readBoxes(b.ROOF), used = new Set();
    for (let k = 0; k < is.length / 8; k++) {
      const box = is.subarray(k * 8, k * 8 + 8);
      let found = -1;
      for (let m = 0; m < was.length / 8 && found < 0; m++) if (!used.has(m) && near(was.subarray(m * 8, m * 8 + 8), box)) found = m;
      assert.ok(found >= 0, `${name}: rooftop box ${k} is a box of the old bake`);
      used.add(found);
    }
    const [x0, y0] = originOf(name);
    for (let m = 0; m < was.length / 8; m++) {
      if (used.has(m)) continue;
      const o = was.subarray(m * 8, m * 8 + 8), p = [o[0] + x0, o[1] + y0];
      assert.ok(goneAll.some(g => Math.abs(g.top - o[2]) <= 0.06 && insideRing(p, g.ring.map(q => [q[0] + originOf(g.tile)[0], q[1] + originOf(g.tile)[1]]))),
        `${name}: rooftop box ${m} of the old bake is gone: it must stand on a record that was left out (at ${p.map(v => v.toFixed(1))}, top ${o[2]})`);
      boxesGone++;
    }
    boxes += is.length / 8;
  }
  console.log(`ribbon vertices beyond the overview's grid, where heights are not compared: ${beyond} of ${ribbonsOld.vertices.length / 8}`);
  console.log(`overview: ${emptied} cells hold no building any more and ${crossed} changed sides of the built-over threshold (they held only records that repeat a footprint whose taller record stands in a cell beside); ${cellsGone} massing cells are gone`);
  console.log(`compared ${tiles} tiles: ${buildings} buildings (${corners} corners), every one a building of the old bake; ${leftOut} of the old bake's records are gone, each the shorter of two over one footprint; ${triangles} ground triangles, ${trees} trees, ${boxes} rooftop boxes (${boxesGone} of the old bake's are gone with them), ${ribbonsOld.vertices.length / 8} ribbon vertices, ${massOld.length / 8} massing cells`);
  console.log('the largest differences (a unit is 4.2 cm for positions, 2.5 cm for heights):');
  for (const [kind, value] of Object.entries(worst).sort()) console.log(`  ${kind.padEnd(16)} ${value.toExponential(1)}`);
  const size = dir => fs.readdirSync(path.join(dir, 'tiles/b')).reduce((sum, f) => sum + fs.statSync(path.join(dir, 'tiles/b', f)).size, 0) + fs.statSync(path.join(dir, 'overview.bin')).size;
  console.log(`bytes: ${(size(oldDir) / 1048576).toFixed(0)} MB before, ${(size(nowDir) / 1048576).toFixed(0)} MB now (${(100 * size(nowDir) / size(oldDir)).toFixed(0)}%)`);
})().catch(error => {
  console.error('BAKE COMPARE FAILED:', error.message.split('\n').slice(0, 3).join(' | '));
  process.exitCode = 1;
});
