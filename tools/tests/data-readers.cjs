// Checks the app's readers against real baked files, without a browser: every section must be consumed
// to its last byte, and what is read must be in range. (That the compact forms carry the same map as the
// floats they replaced is bake-compare.cjs's check, against the previous bake.)
//
// Usage: node tools/tests/data-readers.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const baked = path.join(root, 'data/baked');
const index = JSON.parse(fs.readFileSync(path.join(baked, 'index.json'), 'utf8'));

(async () => {
  const data = await import(path.join(root, 'app/src/world/data.js'));
  const bytes = file => { const buffer = fs.readFileSync(file); return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); };
  const read = name => data.parseContainer(bytes(path.join(baked, name)));
  const lifts = Object.fromEntries(Object.entries(index.groundClasses).map(([id, info]) => [Number(id), info.lift]));
  const RINGS = data.TERRAIN_RINGS, STEP = index.tileSize / 32;

  const overview = read('overview.bin');
  for (const id of ['GRID', 'MASS', 'LCV', 'URB', 'RIBA']) assert.ok(overview[id], `overview.bin has no ${id}`);
  const grid = data.readGrid(overview.GRID);
  assert.equal(grid.heights.length, grid.nx * grid.ny);
  assert.equal(overview.GRID.bytes.length, 28 + grid.nx * grid.ny * 2);
  assert.ok(grid.heights.every(h => h >= -50 && h < 1800), 'terrain heights in range');

  const mass = data.readMassing(overview.MASS);
  const cells = mass.length / 8;
  assert.equal(overview.MASS.bytes.length, 4 + cells * 12);
  for (let k = 0; k < cells; k++) {
    const [x, y, base, height] = mass.slice(k * 8, k * 8 + 4);
    // buildings are kept when they touch the region, so a centre may lie a little outside it
    assert.ok(x >= index.bounds[0] - 300 && x <= index.bounds[2] + 300 && y >= index.bounds[1] - 300 && y <= index.bounds[3] + 300, `massing cell inside the region: ${x}, ${y}`);
    assert.ok(height > 0 && height < 1000 && base > -50 && base < 1800, 'massing base and height in range');
    assert.ok(mass[k * 8 + 4] >= 1 && mass[k * 8 + 4] <= 10, 'archetype 1..10');
  }

  const cover = data.readCells(overview.LCV, 1), built = data.readCells(overview.URB, 2);
  const MARGIN = 3000;                     // the overview's cells cover the region and this much around it
  for (const r of [cover, built]) {
    assert.equal(r.bytes.length, r.nx * r.ny * r.bytesPerCell);
    assert.equal(overview[r === cover ? 'LCV' : 'URB'].bytes.length, 28 + r.bytes.length);
    assert.ok(r.x0 <= index.bounds[0] - MARGIN && r.x0 > index.bounds[0] - MARGIN - r.cell, 'cells start at the west of the margin');
    assert.ok(r.y0 <= index.bounds[1] - MARGIN && r.y0 > index.bounds[1] - MARGIN - r.cell, 'cells start at the south of the margin');
    assert.ok(r.x0 + r.nx * r.cell >= index.bounds[2] + MARGIN && r.x0 + r.nx * r.cell < index.bounds[2] + MARGIN + r.cell, 'cells end at the east of the margin');
    assert.ok(r.y0 + r.ny * r.cell >= index.bounds[3] + MARGIN && r.y0 + r.ny * r.cell < index.bounds[3] + MARGIN + r.cell, 'cells end at the north of the margin');
  }
  assert.deepEqual([cover.nx, cover.ny, cover.x0, cover.y0, cover.cell], [built.nx, built.ny, built.x0, built.y0, built.cell]);
  let wet = 0, lakes = 0;
  for (const c of cover.bytes) {
    assert.ok(c <= 24, 'ground class id');
    if (c >= 1 && c <= 4) wet++;
    if (c === 1) lakes++;
  }
  // West Lake alone is about 6.4 km², and there are reservoirs in the hills; the river, canals and
  // ponds add several times that
  const area = cells => cells * cover.cell * cover.cell / 1e6;
  assert.ok(area(lakes) > 5 && area(lakes) < 40, `lake cells cover ${area(lakes).toFixed(1)} km²`);
  assert.ok(area(wet) > 40 && area(wet) < 400, `water cells cover ${area(wet).toFixed(1)} km²`);

  // the parts, walked as the reader does, must add up to the section's length
  {
    const view = overview.RIBA.view, at0 = overview.RIBA.offset;
    let at = at0 + 4, parts = 0;
    for (let k = view.getUint32(at0, true); k > 0; k--, parts++) at += 2 + 10 * view.getUint16(at, true);
    assert.equal(at, at0 + overview.RIBA.bytes.length, 'ribbon parts end where the section does');
  }
  const ribbons = data.readRibbons(overview.RIBA, (x, y) => data.surfaceOn(grid, x, y), lifts);
  assert.equal(ribbons.indices.length % 6, 0);
  assert.equal(ribbons.vertices.length / 8, ribbons.indices.length / 6 * 4, 'four ribbon vertices to two triangles');
  assert.ok(ribbons.indices.every(i => i < ribbons.vertices.length / 8), 'ribbon indices in range');
  assert.ok(ribbons.vertices.every(Number.isFinite), 'ribbon vertices finite');

  // every kind of tile section, from a few tiles spread over the region
  const files = fs.readdirSync(path.join(baked, 'tiles/b'));
  assert.equal(files.length, index.tilesBaked);
  const seen = new Set();
  const sample = [files[0], files[Math.floor(files.length / 3)], files[Math.floor(files.length * 2 / 3)], files[files.length - 1],
    ...files.filter(f => /^2[0-9]_1[0-9]\.bin$/.test(f)).slice(0, 6)];
  let buildings = 0, trees = 0, rooftop = 0, routes = 0;
  for (const name of sample) {
    const t = read(`tiles/b/${name}`);
    const [tx, ty] = name.replace('.bin', '').split('_').map(Number);
    for (const id of Object.keys(t)) seen.add(id);
    let lattice = null;
    const x0 = (index.ix0 + tx) * index.tileSize, y0 = (index.iy0 + ty) * index.tileSize;
    if (t.TERR) {
      lattice = data.readGrid(t.TERR);
      const side = 33 + 2 * RINGS;
      assert.equal(lattice.nx, side); assert.equal(lattice.ny, side);
      assert.equal(t.TERR.bytes.length, 28 + side * side * 2);
      assert.equal(lattice.x0, x0 - RINGS * STEP);                   // the rings lie beyond the tile's west and south
      assert.equal(lattice.y0, y0 - RINGS * STEP);
      assert.equal(lattice.cell, STEP);
      assert.ok(lattice.heights.every(h => h >= -50 && h < 1800), 'tile heights in range');
      const g = data.innerGrid(lattice, RINGS);
      assert.deepEqual([g.nx, g.ny, g.x0, g.y0], [33, 33, x0, y0]);
    }
    const surface = (x, y) => data.surfaceOn(lattice, x + x0, y + y0);
    const onGround = (x, y, cls) => Math.fround(surface(x, y) + (lifts[cls] ?? 0.02));
    if (t.BASE) {
      const base = data.readBase(t.BASE);
      assert.equal(base.length, 1024);
      assert.ok(base.every(c => c <= 24), 'base class id');
    }
    if (t.BLDB) {
      const b = data.readBuildings(t.BLDB);
      const wide = t.BLDB.view.getUint8(t.BLDB.offset + 12, true) === 4 ? 4 : 2;
      assert.equal(t.BLDB.bytes.length, 13 + b.buildings * 11 + b.vertices.length * 2 + b.indices.length * wide);
      assert.equal(b.props.length, b.buildings * 9);
      assert.ok(b.vertices.every(Number.isFinite) && b.vertices.filter((_, k) => k % 6 < 2).every(v => Math.abs(v) < 1366), 'building corners in range');
      assert.equal(b.vertices.length % 6, 0);
      assert.ok(b.indices.every(i => i < b.vertices.length / 6), 'building index in range');
      assert.ok(b.vertices.filter((_, k) => k % 6 === 5).every(i => i >= 0 && i < b.buildings), 'vertex building index in range');
      assert.ok(Array.from(b.props.filter((_, k) => k % 9 === 1)).every(h => h > 0 && h < 1000), 'building heights in range');
      buildings += b.buildings;
    }
    if (t.ROOF) {
      const boxes = data.readBoxes(t.ROOF);
      assert.equal(t.ROOF.bytes.length, 4 + boxes.length / 8 * 11);
      assert.equal(boxes.length % 8, 0);
      for (let k = 0; k < boxes.length; k += 8) {
        const [x, y, base, height, halfW, halfD] = boxes.subarray(k, k + 6);
        assert.ok(x >= 0 && x <= index.tileSize && y >= 0 && y <= index.tileSize, 'rooftop box inside its tile');
        assert.ok(height > 0 && height < 20 && halfW > 0 && halfW < 10 && halfD > 0 && halfD < 10 && base > -50 && base < 1800, 'rooftop box in range');
        assert.ok(Number.isInteger(boxes[k + 6]) && boxes[k + 7] < 255, 'rooftop box colours');
      }
      rooftop += boxes.length / 8;
    }
    for (const id of ['WATR', 'ROAD', 'LAND', 'DECK']) {
      if (!t[id]) continue;
      const deck = id === 'DECK';
      const m = data.readMesh(t[id], deck ? null : onGround);
      const width = t[id].view.getUint8(t[id].offset + 8, true) === 4 ? 4 : 2;
      assert.equal(t[id].bytes.length, 9 + m.vertices.length / 5 * (deck ? 8 : 5) + m.indices.length * width);
      assert.equal(m.vertices.length % 5, 0);
      assert.ok(m.vertices.every(Number.isFinite), `${id} vertices finite`);
      assert.ok(m.indices.every(i => i < m.vertices.length / 5), `${id} index in range`);
      const classes = m.vertices.filter((_, k) => k % 5 === 3);
      assert.ok(classes.every(c => c >= 1 && c <= 24 && Number.isInteger(c)), `${id} class in range`);
    }
    if (t.TREE) {
      assert.ok(lattice, 'a tile with trees has a height grid to read their height from');
      const tr = data.readTrees(t.TREE, (x, y) => Math.fround(surface(x, y)));
      assert.equal(t.TREE.bytes.length, 8 + (tr.cells * tr.cells + 1) * 4 + tr.count * 7);
      assert.equal(tr.cells, index.tileSize / index.treeCell);
      assert.equal(tr.starts[tr.cells * tr.cells], tr.count);
      for (let k = 1; k < tr.starts.length; k++) assert.ok(tr.starts[k] >= tr.starts[k - 1], 'tree runs in order');
      const f = new Float32Array(tr.records.buffer, tr.records.byteOffset, tr.count * 4);
      for (let k = 0; k < tr.count; k++) {
        const x = f[k * 4], y = f[k * 4 + 1], z = f[k * 4 + 2];
        // a tree at the tile's last centimetre rounds to the tile's edge, 1000 m
        assert.ok(x >= 0 && x <= index.tileSize && y >= 0 && y <= index.tileSize, 'tree inside its tile');
        assert.ok(z > -50 && z < 1800 && Number.isFinite(z), 'tree height in range');
        assert.ok(tr.records[k * 16 + 12] < 6, 'tree species');
      }
      trees += tr.count;
    }
    if (t.PLCE) assert.ok(Array.isArray(data.readPlaces(t.PLCE)));
    if (t.PATH) {
      const lines = data.readPaths(t.PATH);
      assert.equal(t.PATH.bytes.length, 4 + lines.reduce((sum, l) => sum + 12 + l.points.length * 4, 0));
      for (const line of lines) {
        assert.ok([5, 6, 7, 8, 9, 10, 200, 201, 202].includes(line.cls), `line class ${line.cls}`);
        assert.ok(line.points.length >= 8 && line.length > 0 && line.width > 0, 'line has points, a length and a width');
        for (let i = 0; i < line.points.length; i += 4) {
          const [x, y, z, dist] = line.points.subarray(i, i + 4);
          assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), 'line point is finite');
          // lines are drawn whole from the tile holding their middle, so their ends may be a long way outside it
          assert.ok(Math.abs(x) < 120000 && Math.abs(y) < 120000 && z > -50 && z < 1800, 'line point in range');
          if (i) assert.ok(dist >= line.points[i - 1], 'distances increase along the line');
        }
        assert.ok(Math.abs(line.points[line.points.length - 1] - line.length) < 0.5, 'the last distance is the length');
      }
      routes += lines.length;
    }
  }
  for (const id of ['TERR', 'BASE', 'BLDB', 'WATR', 'ROAD', 'LAND', 'TREE', 'PLCE', 'ROOF', 'PATH']) assert.ok(seen.has(id), `no sampled tile has ${id}`);
  console.log(`overview: grid ${grid.nx}x${grid.ny}, ${cells} massing cells, cover ${cover.nx}x${cover.ny} (${area(wet).toFixed(1)} km² of water), ${ribbons.indices.length / 3} ribbon triangles; ${overview.GRID.bytes.length + overview.MASS.bytes.length + overview.LCV.bytes.length + overview.URB.bytes.length + overview.RIBA.bytes.length} bytes`);
  console.log(`tiles: ${sample.length} sampled of ${files.length}, sections ${[...seen].sort().join(' ')}, ${buildings} buildings, ${rooftop} rooftop boxes, ${routes} routes, ${trees} trees`);
})().catch(error => {
  console.error('DATA READERS FAILED:', error.message);
  process.exitCode = 1;
});
