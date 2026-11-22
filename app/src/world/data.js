// Reading what the pipeline baked: data/baked/overview.bin and data/baked/tiles/b/<x>_<y>.bin.
// The layout is defined in pipeline/hz/bake.py.

const MAGIC = [0x48, 0x5a, 0x54, 0x31]; // "HZT1"

export function parseContainer(buffer) {
  const view = new DataView(buffer);
  if (!MAGIC.every((byte, k) => view.getUint8(k) === byte)) throw new Error('not a baked file');
  const count = view.getUint16(6, true);
  const sections = {};
  for (let k = 0; k < count; k++) {
    const at = 8 + 12 * k;
    const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    sections[id] = { view, offset: view.getUint32(at + 4, true), length: view.getUint32(at + 8, true) };
  }
  return sections;
}

// GRID and TERR: a height grid whose rows run north to south
export function readGrid(section) {
  const { view, offset } = section;
  const nx = view.getUint16(offset, true), ny = view.getUint16(offset + 2, true);
  return {
    nx, ny,
    x0: view.getFloat64(offset + 4, true),
    y0: view.getFloat64(offset + 12, true),
    cell: view.getFloat64(offset + 20, true),
    heights: new Int16Array(section.view.buffer, section.view.byteOffset + offset + 28, nx * ny),
  };
}

// MASS: one record of 4 floats and 4 bytes per cell
export function readMassing(section) {
  const { view, offset } = section;
  const count = view.getUint32(offset, true);
  const out = new Float32Array(count * 8);
  for (let k = 0; k < count; k++) {
    const at = offset + 4 + k * 20;
    out[k * 8] = view.getFloat32(at, true);
    out[k * 8 + 1] = view.getFloat32(at + 4, true);
    out[k * 8 + 2] = view.getFloat32(at + 8, true);
    out[k * 8 + 3] = view.getFloat32(at + 12, true);
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
    props: new Float32Array(view.buffer.slice(propsAt, vertsAt)),
    vertices: new Float32Array(view.buffer.slice(vertsAt, indexAt)),
    indices: new Uint32Array(view.buffer.slice(indexAt, indexAt + indices * 4)),
  };
}

export async function loadContainer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return parseContainer(await response.arrayBuffer());
}
