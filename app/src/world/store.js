// What the app draws: the overview package, plus the 1 km tiles that are in view.
// Tiles are fetched the first time they are needed and kept; the least recently used ones go first
// when the cache is full.
import { loadContainer, readBuildings, readGrid, readMassing } from './data.js';

export const DISTRICT_SCALE = 0.125;    // from this zoom up (1 pixel under 8 m) real outlines replace the boxes
export const TALLEST = 420;                     // metres; anything higher would be a surprise

// A grid mesh: one vertex buffer and index buffer for the whole grid, a height texture per tile or for the overview.
function gridMesh(gl, nx, ny) {
  const points = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const o = (j * nx + i) * 2;
    points[o] = i;
    points[o + 1] = j;
  }
  const index = new Uint32Array((nx - 1) * (ny - 1) * 6);
  let o = 0;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    index.set([a, c, b, b, c, d], o);
    o += 6;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, points, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, vbo, ibo, count: index.length };
}

function heightTexture(gl, grid) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, grid.nx, grid.ny, 0, gl.RED, gl.FLOAT, Float32Array.from(grid.heights));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// Describe a buffer's attributes on a vertex array. parts: [{ data, layout: [[location, size], ...], divisor }]
function assemble(gl, parts, indices) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = [];
  for (const part of parts) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, part.data, gl.STATIC_DRAW);
    const stride = part.layout.reduce((sum, [, size]) => sum + size, 0) * 4;
    let offset = 0;
    for (const [location, size] of part.layout) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(location, part.divisor || 0);
      offset += size * 4;
    }
    buffers.push(buffer);
  }
  if (indices) {
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    buffers.push(ibo);
  }
  gl.bindVertexArray(null);
  return { vao, buffers };
}

// the unit box the massing cells are drawn with: a top and four walls, as a triangle list
function unitBox() {
  const out = [];
  const quad = (corners, normal) => {
    for (const k of [0, 1, 2, 0, 2, 3]) out.push(...corners[k], normal[0], normal[1]);
  };
  quad([[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [0, 0]);
  quad([[1, -1, 0], [1, 1, 0], [1, 1, 1], [1, -1, 1]], [1, 0]);
  quad([[-1, 1, 0], [-1, -1, 0], [-1, -1, 1], [-1, 1, 1]], [-1, 0]);
  quad([[1, 1, 0], [-1, 1, 0], [-1, 1, 1], [1, 1, 1]], [0, 1]);
  quad([[-1, -1, 0], [1, -1, 0], [1, -1, 1], [-1, -1, 1]], [0, -1]);
  return new Float32Array(out);
}

export class World {
  constructor(gl, index, urlBase) {
    this.gl = gl;
    this.index = index;
    this.urlBase = urlBase;
    this.overview = null;
    this.tiles = new Map();        // "x_y" -> tile
    this.pending = new Map();
    this.capacity = 600;
    this.clock = 0;
    this.frame = 0;
  }

  get loaded() { return this.tiles.size; }

  async loadOverview() {
    const sections = await loadContainer(`${this.urlBase}/overview.bin`);
    const gl = this.gl;
    const grid = readGrid(sections.GRID);
    const cells = readMassing(sections.MASS);
    this.overview = {
      grid,
      mesh: gridMesh(gl, grid.nx, grid.ny),
      heights: heightTexture(gl, grid),
      boxes: assemble(gl, [
        { data: unitBox(), layout: [[0, 3], [1, 2]] },
        { data: cells, layout: [[2, 4], [3, 4]], divisor: 1 },
      ]),
      cells: cells.length / 8,
    };
  }

  // the tiles a camera can see, nearest first
  visible(camera, extraRows = 2) {
    const { index } = this;
    const halfW = camera.width / (2 * camera.scale) + 720;
    const halfV = camera.height / (2 * camera.scale) + 720;
    const top = TALLEST * camera.cosPitch / camera.sinPitch;
    const size = index.tileSize;
    const out = [];
    for (let ty = 0; ty < index.ny; ty++) {
      for (let tx = 0; tx < index.nx; tx++) {
        const x0 = (index.ix0 + tx) * size, y0 = (index.iy0 + ty) * size;
        const corners = [[x0, y0], [x0 + size, y0], [x0, y0 + size], [x0 + size, y0 + size]].map(([x, y]) => camera.axes(x, y));
        const us = corners.map(c => c.u), vs = corners.map(c => c.v);
        if (Math.max(...us) < -halfW || Math.min(...us) > halfW || Math.max(...vs) < -halfV - extraRows * size || Math.min(...vs) > halfV + top) continue;
        const mid = camera.axes(x0 + size / 2, y0 + size / 2);
        out.push({ tx, ty, x0, y0, distance: Math.hypot(mid.u, mid.v) });
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // start fetching what is missing, a few at a time
  request(visible, budget = 6) {
    let started = 0;
    for (const tile of visible) {
      const key = `${tile.tx}_${tile.ty}`;
      if (this.tiles.has(key) || this.pending.has(key)) continue;
      if (started >= budget) break;
      const entry = { key, tx: tile.tx, ty: tile.ty };
      this.pending.set(key, entry);
      started++;
      loadContainer(`${this.urlBase}/tiles/b/${tile.tx}_${tile.ty}.bin`)
        .then(sections => { entry.sections = sections; })
        .catch(error => { entry.error = error; });
    }
  }

  // move finished downloads onto the GPU
  upload(budget = 3) {
    const gl = this.gl;
    let done = 0;
    for (const [key, entry] of this.pending) {
      if (!entry.sections && !entry.error) continue;
      this.pending.delete(key);
      if (entry.error) continue;
      const { sections, tx, ty } = entry;
      const grid = sections.TERR ? readGrid(sections.TERR) : null;
      const buildings = sections.BLDB ? readBuildings(sections.BLDB) : null;
      const size = this.index.tileSize;
      const tile = { key, x0: (this.index.ix0 + tx) * size, y0: (this.index.iy0 + ty) * size, used: ++this.clock };
      if (grid) {
        tile.grid = grid;
        tile.heights = heightTexture(gl, grid);
        if (!this.tileMesh || this.tileMesh.nx !== grid.nx || this.tileMesh.ny !== grid.ny) {
          this.tileMesh = gridMesh(gl, grid.nx, grid.ny);
        }
      }
      if (buildings && buildings.indices.length) {
        tile.buildings = assemble(gl, [
          { data: buildings.vertices, layout: [[0, 3], [1, 2], [2, 1]] },
        ], buildings.indices);
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 9, buildings.buildings, 0, gl.RED, gl.FLOAT, buildings.props);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        tile.props = t;
        tile.indexCount = buildings.indices.length;
      }
      this.tiles.set(key, tile);
      done++;
      if (done >= budget) break;
    }
    while (this.tiles.size > this.capacity) {
      const oldest = [...this.tiles.values()].sort((a, b) => a.used - b.used)[0];
      this.release(oldest);
      this.tiles.delete(oldest.key);
    }
  }

  release(tile) {
    const gl = this.gl;
    if (tile.buildings) {
      gl.deleteVertexArray(tile.buildings.vao);
      tile.buildings.buffers.forEach(b => gl.deleteBuffer(b));
    }
    if (tile.heights) gl.deleteTexture(tile.heights);
    if (tile.props) gl.deleteTexture(tile.props);
  }
}
