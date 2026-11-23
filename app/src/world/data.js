// Reading what the pipeline baked for a city (data/baked/<city>/): overview.bin, tiles/b/<x>_<y>.bin and names.bin.
// The layout is defined in pipeline/pixelcity/scene.py and pipeline/pixelcity/compact.py: numbers in the smallest integers
// that hold them, and what the page can work out left out. So that a file stays small, each reader puts
// the numbers back as they were: positions in metres, heights read off the tile's grid.
//
// Sections of a file may start at any byte, so they are read through the file's DataView; where typed
// arrays are needed over them the bytes are copied first (a Float32Array has to start on a multiple of four).

const MAGIC = [0x48, 0x5a, 0x54, 0x31]; // "HZT1"
const FORMAT = 2;                      // the version after the magic: the compact forms (a file of version 1 is refused)
const TEXT = new TextDecoder();

// the units of compact.py
const XY_PER_M = 24;                   // positions: 4 cm
const Z_PER_M = 40;                    // heights of buildings and rooftop boxes: 2.5 cm
const DECK_Z_PER_M = 8;                // a deck's height: 12.5 cm
const NORMAL_UNIT = 16384;             // the level part of a wall's or a slope's normal
export const TERRAIN_RINGS = 2;        // the height grid of a tile reaches this many rings (62.5 m) beyond the tile
const HALF_TURN = Math.PI / 32768;     // a ribbon's direction: the turn in 65536ths of a circle

export function parseContainer(buffer) {
  const view = new DataView(buffer);
  if (!MAGIC.every((byte, k) => view.getUint8(k) === byte)) throw new Error('not a baked file');
  const format = view.getUint16(4, true);
  if (format !== FORMAT) throw new Error(`这是第 ${format} 版的烘焙数据，页面读的是第 ${FORMAT} 版：请重新烘焙（python -m pixelcity.build_all --city <城市> --from bake）`);
  const count = view.getUint16(6, true);
  const sections = {};
  for (let k = 0; k < count; k++) {
    const at = 8 + 12 * k;
    // ids are four bytes and padded with NULs ("LCV\0", "URB\0")
    const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3)).replace(/\0+$/, '');
    const offset = view.getUint32(at + 4, true), length = view.getUint32(at + 8, true);
    sections[id] = { view, offset, bytes: new Uint8Array(buffer, offset, length) };
  }
  return sections;
}

// the section's bytes from `skip`, or all of them, copied into a buffer of their own
const ownCopy = (section, skip = 0, length = section.bytes.length - skip) => section.bytes.subarray(skip, skip + length).slice();

// GRID and TERR: a height grid whose rows run north to south
export function readGrid(section) {
  const { view, offset } = section;
  const nx = view.getUint16(offset, true), ny = view.getUint16(offset + 2, true);
  return {
    nx, ny,
    x0: view.getFloat64(offset + 4, true),
    y0: view.getFloat64(offset + 12, true),
    cell: view.getFloat64(offset + 20, true),
    heights: new Int16Array(ownCopy(section, 28, nx * ny * 2).buffer),
  };
}

// The ground as the page draws it over a height grid (rows from the north): each cell is two triangles, as
// gridMesh splits them, a-c-b and b-c-d with a south-west, b south-east, c north-west and d north-east. It
// is what the bake's surface() computes (pipeline/pixelcity/bake.py): whatever is laid on the ground follows the mesh.
export function surfaceOn(grid, x, y) {
  const fx = (x - grid.x0) / grid.cell, fy = (y - grid.y0) / grid.cell;
  const i = Math.min(grid.nx - 2, Math.max(0, Math.floor(fx))), j = Math.min(grid.ny - 2, Math.max(0, Math.floor(fy)));
  const u = fx - i, v = fy - j, h = (a, b) => grid.heights[(grid.ny - 1 - b) * grid.nx + a];
  const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
  return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
}

// A grid with that many rings taken off every side: the tile's own 33 x 33 out of the 37 x 37 it carries
export function innerGrid(grid, rings) {
  const nx = grid.nx - 2 * rings, ny = grid.ny - 2 * rings, heights = new Int16Array(nx * ny);
  for (let row = 0; row < ny; row++) heights.set(grid.heights.subarray((row + rings) * grid.nx + rings, (row + rings) * grid.nx + rings + nx), row * nx);
  return { nx, ny, x0: grid.x0 + rings * grid.cell, y0: grid.y0 + rings * grid.cell, cell: grid.cell, heights };
}

// LCV and URB: a grid of cells over the region, rows from the north, one or two bytes per cell.
// x0 and y0 are the west and south edges of the grid.
export function readCells(section, bytesPerCell) {
  const { view, offset } = section;
  const nx = view.getUint16(offset, true), ny = view.getUint16(offset + 2, true);
  const bytes = ownCopy(section, 28, nx * ny * bytesPerCell);
  if (bytes.length !== nx * ny * bytesPerCell) throw new Error('truncated cell grid');
  return {
    nx, ny,
    x0: view.getFloat64(offset + 4, true),
    y0: view.getFloat64(offset + 12, true),
    cell: view.getFloat64(offset + 20, true),
    bytes,
    bytesPerCell,
  };
}

// MASS: one record of 12 bytes per 50 m cell that holds a building (compact.py): its column and row (i16,
// counted from the world origin, which the region straddles),
// the tallest building's base (i16, 2.5 cm) and height (u16, a centimetre), its archetype, wall colour, roof
// colour and seed (u8). -> centre x, y; base; height; the four looks, as floats
export function readMassing(section) {
  const { view, offset } = section;
  const count = view.getUint32(offset, true);
  const out = new Float32Array(count * 8);
  for (let k = 0; k < count; k++) {
    const at = offset + 4 + k * 12;
    out[k * 8] = (view.getInt16(at, true) + 0.5) * 50;
    out[k * 8 + 1] = (view.getInt16(at + 2, true) + 0.5) * 50;
    out[k * 8 + 2] = view.getInt16(at + 4, true) / Z_PER_M;
    out[k * 8 + 3] = view.getUint16(at + 6, true) / 100;
    for (let c = 0; c < 4; c++) out[k * 8 + 4 + c] = view.getUint8(at + 8 + c);
  }
  return out;
}

// RIBA: strips along lines for the overview (compact.py): parts (u32); per part its points (u16), class (u8),
// half width (u8, quarter-metres), the points (x, y: i32 metres from the world origin) and the direction of
// each segment (u16, the turn from the map's x axis in 65536ths of a circle). A strip stands lift(cls) above
// the height grid `ground(x, y)` gives, the overview's; the bake took its height from the same grid.
// -> { vertices, indices }: a vertex is x, y, z, lateral (-1 or 1), half width, class, dir x, dir y
export function readRibbons(section, ground, lifts) {
  const { view, offset } = section;
  const parts = view.getUint32(offset, true);
  let at = offset + 4, segments = 0;
  for (let k = 0; k < parts; k++) {
    const count = view.getUint16(at, true);
    segments += Math.max(0, count - 1);
    at += 2 + 10 * count;
  }
  const vertices = new Float32Array(segments * 32), indices = new Uint32Array(segments * 6);
  at = offset + 4;
  let v = 0, t = 0;
  for (let k = 0; k < parts; k++) {
    const count = view.getUint16(at, true), cls = view.getUint8(at + 2), half = view.getUint8(at + 3) / 4;
    at += 4;
    const points = new Float64Array(count * 2);           // the part's points, in metres
    for (let n = 0; n < count; n++, at += 8) {
      points[2 * n] = view.getInt32(at, true);
      points[2 * n + 1] = view.getInt32(at + 4, true);
    }
    for (let n = 0; n < count - 1; n++, at += 2) {
      const angle = view.getUint16(at, true) * HALF_TURN - Math.PI;
      const dx = Math.fround(Math.cos(angle)), dy = Math.fround(Math.sin(angle));
      const ax = points[2 * n], ay = points[2 * n + 1], bx = points[2 * n + 2], by = points[2 * n + 3];
      // the quad from where the segment starts to where it ends, a half width to each side of it
      const quad = [[ax - dy * half, ay + dx * half], [ax + dy * half, ay - dx * half], [bx + dy * half, by - dx * half], [bx - dy * half, by + dx * half]];
      for (const [c, corner] of quad.entries()) {
        const x = Math.fround(corner[0]), y = Math.fround(corner[1]), o = (v + c) * 8;
        vertices[o] = x;
        vertices[o + 1] = y;
        vertices[o + 2] = Math.fround(ground(x, y) + (lifts[cls] ?? 0.02));
        vertices[o + 3] = c === 0 || c === 3 ? -1 : 1;
        vertices[o + 4] = half;
        vertices[o + 5] = cls;
        vertices[o + 6] = dx;
        vertices[o + 7] = dy;
      }
      indices.set([v, v + 1, v + 2, v, v + 2, v + 3], t);
      v += 4;
      t += 6;
    }
  }
  return { vertices, indices };
}

// BLDB: the buildings of a tile (compact.py): buildings, corners and indices (u32 each), bytes per index (u8);
// then 11 bytes of properties a building (base i16 in 2.5 cm, height u16 in a centimetre, then levels,
// archetype, roof, wall colour, roof colour, seed and flags, a byte each); 12 bytes a corner (x, y in 4 cm,
// z in 2.5 cm, the level part of the normal in two i16, the building it belongs to, u16); the indices (u16,
// or u32 where a tile has more than 65,535 corners).
// -> { buildings, props: 9 floats a building, vertices: 6 floats a corner, indices }
export function readBuildings(section) {
  const { view, offset } = section;
  const buildings = view.getUint32(offset, true), corners = view.getUint32(offset + 4, true), count = view.getUint32(offset + 8, true);
  const wide = view.getUint8(offset + 12) === 4;
  let at = offset + 13;
  const props = new Float32Array(buildings * 9), vertices = new Float32Array(corners * 6);
  for (let b = 0; b < buildings; b++, at += 11) {
    props[b * 9] = view.getInt16(at, true) / Z_PER_M;
    props[b * 9 + 1] = view.getUint16(at + 2, true) / 100;
    for (let c = 2; c < 9; c++) props[b * 9 + c] = view.getUint8(at + 2 + c);
  }
  for (let v = 0; v < corners; v++, at += 12) {
    const o = v * 6;
    vertices[o] = view.getInt16(at, true) / XY_PER_M;
    vertices[o + 1] = view.getInt16(at + 2, true) / XY_PER_M;
    vertices[o + 2] = view.getInt16(at + 4, true) / Z_PER_M;
    vertices[o + 3] = view.getInt16(at + 6, true) / NORMAL_UNIT;
    vertices[o + 4] = view.getInt16(at + 8, true) / NORMAL_UNIT;
    vertices[o + 5] = view.getUint16(at + 10, true);
  }
  const bytes = ownCopy(section, at - offset, count * (wide ? 4 : 2)).buffer;
  const indices = wide ? new Uint32Array(bytes) : Uint32Array.from(new Uint16Array(bytes));
  return { buildings, props, vertices, indices };
}

// ROOF: what is put on flat roofs by rule, as boxes: count (u32), then 11 bytes each (compact.py): x, y
// relative to the tile's corner (i16, 4 cm), base (i16, 2.5 cm), height, half width and half depth (u8,
// decimetres), wall colour and roof colour (u8). -> 8 floats a box, as the roofBoxes shader takes them
export function readBoxes(section) {
  const { view, offset } = section;
  const count = view.getUint32(offset, true), out = new Float32Array(count * 8);
  for (let k = 0; k < count; k++) {
    const at = offset + 4 + k * 11, o = k * 8;
    out[o] = view.getInt16(at, true) / XY_PER_M;
    out[o + 1] = view.getInt16(at + 2, true) / XY_PER_M;
    out[o + 2] = view.getInt16(at + 4, true) / Z_PER_M;
    out[o + 3] = view.getUint8(at + 6) / 10;
    out[o + 4] = view.getUint8(at + 7) / 10;
    out[o + 5] = view.getUint8(at + 8) / 10;
    out[o + 6] = view.getUint8(at + 9);
    out[o + 7] = view.getUint8(at + 10);
  }
  return out;
}

// WATR, ROAD, LAND: a mesh of the ground (compact.py): corner count, index count (u32), bytes per index (u8);
// the corners, 5 bytes each: x, y relative to the tile's corner (i16, 4 cm) and the class (u8); then the
// triangle indices (u16, or u32). A corner's height is the ground's under it plus the lift of its class,
// which `height(x, y, class)` gives (the page reads it off the tile's grid, as the bake did), and its seed 0.
// DECK is the same with 8 bytes a corner, its height (i16, 12.5 cm) before the class: a deck is not at the
// ground's own height.
// -> { vertices: x, y, z, class, seed a corner, indices }
export function readMesh(section, height = null) {
  const { view, offset } = section;
  const corners = view.getUint32(offset, true), count = view.getUint32(offset + 4, true);
  const wide = view.getUint8(offset + 8) === 4, size = height ? 5 : 8;
  let at = offset + 9;
  const vertices = new Float32Array(corners * 5);
  for (let k = 0; k < corners; k++, at += size) {
    const o = k * 5, x = view.getInt16(at, true) / XY_PER_M, y = view.getInt16(at + 2, true) / XY_PER_M, cls = view.getUint8(at + size - 1);
    vertices[o] = x;
    vertices[o + 1] = y;
    vertices[o + 2] = height ? height(x, y, cls) : view.getInt16(at + 4, true) / DECK_Z_PER_M;
    vertices[o + 3] = cls;
  }
  const bytes = ownCopy(section, at - offset, count * (wide ? 4 : 2)).buffer;
  const indices = wide ? new Uint32Array(bytes) : Uint32Array.from(new Uint16Array(bytes));
  return { vertices, indices };
}

// TREE: the trees of the tile, sorted into squares of 250 m: cells per side (u32), count (u32), where
// each cell's run starts (u32 per cell, and one more), then 7 bytes per tree (compact.py): x, y relative to
// the tile's corner (i16, 4 cm), its species (3 bits) and kind (3 bits), the radius of its crown in
// half-metres, and its seed. Its height is the ground's under it, which `height(x, y)` reads off the tile.
// -> records of 16 bytes each, as the trees' shader takes them: x, y, z, species, size, seed, kind
export function readTrees(section, height) {
  const { view, offset } = section;
  const cells = view.getUint32(offset, true), count = view.getUint32(offset + 4, true);
  const starts = new Uint32Array(ownCopy(section, 8, (cells * cells + 1) * 4).buffer);
  const records = new Uint8Array(count * 16), data = new DataView(records.buffer);
  let at = offset + 8 + (cells * cells + 1) * 4;
  for (let k = 0; k < count; k++, at += 7) {
    const x = view.getInt16(at, true) / XY_PER_M, y = view.getInt16(at + 2, true) / XY_PER_M, look = view.getUint8(at + 4), o = k * 16;
    data.setFloat32(o, x, true);
    data.setFloat32(o + 4, y, true);
    data.setFloat32(o + 8, height(x, y), true);
    records[o + 12] = look % 8;
    records[o + 13] = view.getUint8(at + 5);
    records[o + 14] = view.getUint8(at + 6);
    records[o + 15] = look >> 3;
  }
  return { cells, count, starts, records };
}

// BASE: one ground class per terrain cell, row 0 at the north
export function readBase(section) {
  return ownCopy(section);
}

// PATH: the lines things move along. u32 count, then per line u16 points, u8 class, u8 spare, f32 width, f32 length,
// and per point x, y relative to the tile, z, distance from the start (f32 each)
export function readPaths(section) {
  const buffer = ownCopy(section).buffer, view = new DataView(buffer);
  const count = view.getUint32(0, true);
  const lines = [];
  let at = 4;
  for (let k = 0; k < count; k++) {
    const points = view.getUint16(at, true), cls = view.getUint8(at + 2), width = view.getFloat32(at + 4, true), length = view.getFloat32(at + 8, true);
    at += 12;
    const data = new Float32Array(buffer, at, points * 4);
    at += points * 16;
    // the middle of the line's box and half its diagonal, for deciding whether it can be in view
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (let i = 0; i < data.length; i += 4) {
      west = Math.min(west, data[i]); east = Math.max(east, data[i]);
      south = Math.min(south, data[i + 1]); north = Math.max(north, data[i + 1]);
    }
    lines.push({ cls, width, length, points: data, cx: (west + east) / 2, cy: (south + north) / 2, reach: Math.hypot(east - west, north - south) / 2 });
  }
  if (at !== buffer.byteLength) throw new Error('truncated paths');
  return lines;
}

// PLCE: JSON: [name, kind key, kind]
export function readPlaces(section) {
  return JSON.parse(TEXT.decode(section.bytes));
}

// NAME and LINE of names.bin, the names the page searches by (pipeline/pixelcity/names.py). NAME is JSON: a
// column a list and one value in each for every thing -- names, kinds, x, y, z, label, size, box, line, landmark, and
// for only some things near and also, by row. LINE holds, for a thing that runs as a line, its course: a point in
// 10 bytes, x and y (f32, metres) and z (i16, 12.5 cm); a point whose x and y are not a number ends a piece.
// -> { rows: the columns, points: x, y, z a point (f32), course: [first, count] into it for a row, or null }
export function readNames(sections) {
  if (!sections.NAME || !sections.LINE) throw new Error('names.bin has no NAME and LINE sections');
  const { view, offset, bytes } = sections.LINE;
  if (bytes.length % 10) throw new Error('truncated courses');
  const count = bytes.length / 10, points = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    points[k * 3] = view.getFloat32(offset + k * 10, true);
    points[k * 3 + 1] = view.getFloat32(offset + k * 10 + 4, true);
    points[k * 3 + 2] = view.getInt16(offset + k * 10 + 8, true) / DECK_Z_PER_M;
  }
  return { rows: JSON.parse(TEXT.decode(sections.NAME.bytes)), points };
}

export function readMeta(section) {
  return JSON.parse(TEXT.decode(section.bytes));
}

export async function loadContainer(url, signal = null) {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return parseContainer(await response.arrayBuffer());
}
