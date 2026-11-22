// Reading what the pipeline baked: data/baked/overview.bin and data/baked/tiles/b/<x>_<y>.bin.
// The layout is defined in pipeline/hz/scene.py.
//
// Sections of a file may start at any byte, so their bytes are copied into a buffer of their own before
// typed views are taken over them: a Float32Array has to start on a multiple of four.

const MAGIC = [0x48, 0x5a, 0x54, 0x31]; // "HZT1"
const TEXT = new TextDecoder();

export function parseContainer(buffer) {
  const view = new DataView(buffer);
  if (!MAGIC.every((byte, k) => view.getUint8(k) === byte)) throw new Error('not a baked file');
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

const ownCopy = section => section.bytes.slice();

// GRID and TERR: a height grid whose rows run north to south
export function readGrid(section) {
  const { view, offset } = section;
  const nx = view.getUint16(offset, true), ny = view.getUint16(offset + 2, true);
  return {
    nx, ny,
    x0: view.getFloat64(offset + 4, true),
    y0: view.getFloat64(offset + 12, true),
    cell: view.getFloat64(offset + 20, true),
    heights: new Int16Array(ownCopy(section).buffer, 28, nx * ny),
  };
}

// LCV and URB: a grid of cells over the region, rows from the north, one or two bytes per cell.
// x0 and y0 are the west and south edges of the grid.
export function readCells(section, bytesPerCell) {
  const { view, offset } = section;
  const nx = view.getUint16(offset, true), ny = view.getUint16(offset + 2, true);
  const bytes = ownCopy(section).subarray(28, 28 + nx * ny * bytesPerCell);
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

// MASS: one record of 4 floats and 4 bytes per cell
export function readMassing(section) {
  const { view, offset } = section;
  const count = view.getUint32(offset, true);
  const out = new Float32Array(count * 8);
  for (let k = 0; k < count; k++) {
    const at = offset + 4 + k * 20;
    for (let f = 0; f < 4; f++) out[k * 8 + f] = view.getFloat32(at + f * 4, true);
    for (let b = 0; b < 4; b++) out[k * 8 + 4 + b] = view.getUint8(at + 16 + b);
  }
  return out;
}

// BLDB: building properties, vertices and indices of a tile's coarse meshes. Offsets are absolute in the file.
export function readBuildings(section) {
  const { view, offset } = section;
  const buildings = view.getUint32(offset, true), vertices = view.getUint32(offset + 4, true), indices = view.getUint32(offset + 8, true);
  const propsAt = offset + 12, vertsAt = propsAt + buildings * 9 * 4, indexAt = vertsAt + vertices * 6 * 4;
  return {
    buildings,
    props: new Float32Array(section.view.buffer.slice(propsAt, vertsAt)),
    vertices: new Float32Array(section.view.buffer.slice(vertsAt, indexAt)),
    indices: new Uint32Array(section.view.buffer.slice(indexAt, indexAt + indices * 4)),
  };
}

// ROOF: boxes put on flat roofs by rule: count, then 8 floats per box: x, y relative to the tile, base, height,
// half width, half depth, wall colour, roof colour
export function readBoxes(section) {
  const buffer = ownCopy(section).buffer;
  return new Float32Array(buffer, 4, new DataView(buffer).getUint32(0, true) * 8);
}

// WATR, ROAD, LAND and DECK: vertex count, index count, then vertices of five floats
// (x, y, z, class, seed) and indices
export function readMesh(section) {
  const buffer = ownCopy(section).buffer;
  const view = new DataView(buffer);
  const vertices = view.getUint32(0, true), indices = view.getUint32(4, true);
  return {
    vertices: new Float32Array(buffer, 8, vertices * 5),
    indices: new Uint32Array(buffer, 8 + vertices * 20, indices),
  };
}

// BASE: one ground class per terrain cell, row 0 at the north
export function readBase(section) {
  return ownCopy(section);
}

// TREE: cells per side, count, where each cell's run of trees starts, then the trees: 16 bytes each,
// of x and y (float), z (float), species, crown radius in half-metres, seed, kind
export function readTrees(section) {
  const buffer = ownCopy(section).buffer;
  const view = new DataView(buffer);
  const cells = view.getUint32(0, true), count = view.getUint32(4, true);
  const starts = new Uint32Array(buffer, 8, cells * cells + 1);
  return { cells, count, starts, records: new Uint8Array(buffer, 8 + (cells * cells + 1) * 4, count * 16) };
}

// RIBA: strips; a vertex is x, y, z, lateral, half width, class, dir x, dir y
export function readRibbons(section) {
  const buffer = ownCopy(section).buffer;
  const view = new DataView(buffer);
  const vertices = view.getUint32(0, true), indices = view.getUint32(4, true);
  return {
    vertices: new Float32Array(buffer, 8, vertices * 8),
    indices: new Uint32Array(buffer, 8 + vertices * 32, indices),
  };
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

export function readMeta(section) {
  return JSON.parse(TEXT.decode(section.bytes));
}

export async function loadContainer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return parseContainer(await response.arrayBuffer());
}
