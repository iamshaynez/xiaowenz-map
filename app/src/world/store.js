// What the app draws: the overview package, plus the 1 km tiles that are in view.
// Tiles are fetched the first time they are needed and kept; when the cache is full the ones used
// longest ago are let go. Where a file is fetched from the city says (world/source.js): by the manifest
// of the city, which names every file of it.
import { TERRAIN_RINGS, innerGrid, loadContainer, readBase, readBoxes, readBrands, readBuildings, readCells, readGrid, readMassing, readMesh, readPaths, readPlaces, readRibbons, readTrees, surfaceOn } from './data.js';

export const DISTRICT_SCALE = 0.125;    // from this zoom up (1 pixel under 8 m) real outlines replace the overview
export const BOX_SCALE = 0.04;          // from this zoom up the overview draws its boxes (1 pixel under 25 m)
export const TREE_SCALE = 0.4;          // from this zoom up trees are drawn one by one (a crown is a pixel or more)
export const SHADOW_SCALE = 0.125;      // from this zoom up shadows are drawn; farther out they are under a pixel
export const LIFE_SCALE = 0.3;           // from this zoom up boats are drawn; cars from 1.2, the lake's own boats from 0.8, people from 5
export const ROOF_SCALE = 0.6;          // from this zoom up what stands on flat roofs is drawn; farther out it is under a pixel
export const TALLEST = 420;             // metres; anything higher would be a surprise
const CAPACITY = 300;                   // tiles kept on the GPU

// ---- meshes and textures ----------------------------------------------------------------------------------------
export function gridMesh(gl, nx, ny) {
  const points = new Float32Array(nx * ny * 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    points[(j * nx + i) * 2] = i;
    points[(j * nx + i) * 2 + 1] = j;
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
  return { vao, buffers: [vbo, ibo], count: index.length };
}

export function floatTexture(gl, width, height, data) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data);
  nearest(gl);
  return texture;
}

export function byteTexture(gl, width, height, data, channels = 1) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const format = channels === 1 ? gl.RED : channels === 2 ? gl.RG : gl.RGBA;
  gl.texImage2D(gl.TEXTURE_2D, 0, channels === 1 ? gl.R8 : gl.RG8, width, height, 0, format, gl.UNSIGNED_BYTE, data);
  nearest(gl);
  return texture;
}

function nearest(gl) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// Assemble the buffers of a draw on a vertex array.
// A part is { data, layout, divisor }, with one interleaved record per vertex or per instance.
//   layout: [[location, floats], ...]                one record of floats; the attributes follow each other
//   layout: [[location, size, type, byteOffset], ...] with `stride` in bytes; for records that hold bytes too
export function assemble(gl, parts, indices) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffers = [];
  for (const part of parts) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, part.data, gl.STATIC_DRAW);
    const stride = part.stride ?? part.layout.reduce((sum, entry) => sum + entry[1], 0) * 4;
    let floatAt = 0;
    for (const entry of part.layout) {
      const location = entry[0];
      let size, type, offset;
      if (part.stride) {
        [size, type, offset] = entry.slice(1);
      } else {
        size = entry[1];
        type = gl.FLOAT;
        offset = floatAt * 4;
        floatAt += size;
      }
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, type, false, stride, offset);
      gl.vertexAttribDivisor(location, part.divisor || 0);
    }
    buffers.push(buffer);
  }
  let count = 0;
  if (indices) {
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    buffers.push(ibo);
    count = indices.length;
  }
  gl.bindVertexArray(null);
  return { vao, buffers, count };
}

const release = (gl, object) => {
  if (!object) return;
  gl.deleteVertexArray(object.vao);
  object.buffers.forEach(buffer => gl.deleteBuffer(buffer));
};

// the unit box the overview's cells and the rooftop boxes are drawn with: a top and four walls, as a triangle list
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

export const UNIT_BOX = unitBox();

// a square from -1 to 1, as a strip of four vertices
export const UNIT_SQUARE = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

export class World {
  constructor(gl, index, city) {
    this.gl = gl;
    this.index = index;
    // how far each class of ground lies above the terrain it is drawn on (the bake's LIFT)
    this.lifts = Object.fromEntries(Object.entries(index.groundClasses).map(([id, info]) => [Number(id), info.lift]));
    this.city = city;           // says whether a file is part of the city, and where it is fetched from
    this.overview = null;
    this.tiles = new Map();        // "x_y" -> tile
    this.pending = new Map();
    this.clock = 0;
  }

  get loaded() { return this.tiles.size; }

  // the height of the ground at a point of the world: read from the tile that holds it when that tile is
  // loaded, smoothly between its grid points; otherwise from the overview's coarse grid
  groundAt(x, y) {
    const { index } = this, size = index.tileSize;
    const tx = Math.floor(x / size) - index.ix0, ty = Math.floor(y / size) - index.iy0;
    const tile = this.tiles.get(`${tx}_${ty}`);
    if (tile && tile.grid) {
      const g = tile.grid, fx = (x - g.x0) / g.cell, fromSouth = (y - g.y0) / g.cell;
      const i = Math.min(g.nx - 2, Math.max(0, Math.floor(fx))), j = Math.min(g.ny - 2, Math.max(0, Math.floor(fromSouth)));
      const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fromSouth - j));
      const h = (a, b) => g.heights[(g.ny - 1 - b) * g.nx + a];        // row 0 of the grid is the northern edge
      // read the way the mesh is drawn (gridMesh): a cell is two triangles, a-c-b and b-c-d, with a
      // south-west, b south-east, c north-west and d north-east; the bake stands everything on this surface
      const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
      return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
    }
    const o = this.overview;
    if (!o) return 0;
    const g = o.grid;
    const i = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / g.cell)));
    const j = Math.min(g.ny - 1, Math.max(0, Math.floor((g.y0 + g.ny * g.cell - y) / g.cell)));
    return g.heights[j * g.nx + i];
  }

  async loadOverview() {
    const sections = await loadContainer(this.city.url('overview.bin'));
    const gl = this.gl;
    const grid = readGrid(sections.GRID);
    const cells = readMassing(sections.MASS);
    const cover = readCells(sections.LCV, 1);
    const built = readCells(sections.URB, 2);
    const ribbons = sections.RIBA ? readRibbons(sections.RIBA, (x, y) => surfaceOn(grid, x, y), this.lifts) : null;
    this.overview = {
      grid,
      mesh: gridMesh(gl, grid.nx, grid.ny),
      heights: floatTexture(gl, grid.nx, grid.ny, Float32Array.from(grid.heights)),
      boxes: assemble(gl, [
        { data: UNIT_BOX, layout: [[0, 3], [1, 2]] },
        { data: cells, layout: [[2, 4], [3, 4]], divisor: 1 },
      ]),
      cells: cells.length / 8,
      cover: { ...cover, texture: byteTexture(gl, cover.nx, cover.ny, cover.bytes) },
      built: { ...built, texture: byteTexture(gl, built.nx, built.ny, built.bytes, 2) },
      ribbons: ribbons && ribbons.indices.length ? assemble(gl, [
        { data: ribbons.vertices, layout: [[0, 4], [1, 4]] },
      ], ribbons.indices) : null,
    };
  }

  // the tiles a camera can see, nearest first
  visible(camera) {
    const { index } = this;
    const halfW = camera.width / (2 * camera.scale) + 720;
    const halfV = camera.height / (2 * camera.scale) + 720;
    const top = TALLEST * camera.cosPitch / camera.sinPitch;   // how far up the screen the top of a tall building reaches
    const size = index.tileSize;
    const out = [];
    for (let ty = 0; ty < index.ny; ty++) {
      for (let tx = 0; tx < index.nx; tx++) {
        const x0 = (index.ix0 + tx) * size, y0 = (index.iy0 + ty) * size;
        const corners = [[x0, y0], [x0 + size, y0], [x0, y0 + size], [x0 + size, y0 + size]].map(([x, y]) => camera.axes(x, y));
        const us = corners.map(c => c.u), vs = corners.map(c => c.v);
        if (Math.max(...us) < -halfW || Math.min(...us) > halfW || Math.max(...vs) < -halfV || Math.min(...vs) > halfV + top) continue;
        const mid = camera.axes(x0 + size / 2, y0 + size / 2);
        out.push({ tx, ty, x0, y0, distance: Math.hypot(mid.u, mid.v) });
      }
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // start fetching what is missing, a few at a time
  // the tiles a pose of the camera can see, nearest first: the destination of a flight, while it is on its way.
  // A pose is the camera's { x, y, scale, pitch, yaw }; the frame's size and the projecting come from the camera.
  viewOf(pose, camera) {
    return this.visible({ x: pose.x, y: pose.y, scale: pose.scale, width: camera.width, height: camera.height,
                          sinPitch: Math.sin(pose.pitch), cosPitch: Math.cos(pose.pitch), axes: (x, y) => camera.about(pose.x, pose.y, x, y) });
  }

  // While a flight is on, only what its destination needs is asked for (D071): what the flight passes over would
  // be out of date before it arrives, and the overview is drawn under it meanwhile. What was asked for before
  // and is of no use there is let go, so that it stops taking bandwidth.
  beginFlight(view) {
    this.flightTarget = new Set(view.map(tile => `${tile.tx}_${tile.ty}`));
    for (const [key, entry] of this.pending) {
      if (!this.flightTarget.has(key)) {
        entry.abort?.();
        this.pending.delete(key);
      }
    }
  }

  endFlight() {
    this.flightTarget = null;
  }

  request(visible, budget = 6) {
    let started = 0;
    for (const tile of visible) {
      const key = `${tile.tx}_${tile.ty}`;
      if (this.tiles.has(key) || this.pending.has(key)) continue;
      if (this.flightTarget && !this.flightTarget.has(key)) continue;
      const name = `tiles/b/${key}.bin`;
      if (!this.city.has(name)) continue;           // nothing was baked for this square (open water, beyond the region)
      if (started >= budget) break;
      const entry = { key, tx: tile.tx, ty: tile.ty };
      const controller = new AbortController();
      entry.abort = () => controller.abort();
      this.pending.set(key, entry);
      started++;
      loadContainer(this.city.url(name), controller.signal)
        .then(sections => { entry.sections = sections; })
        .catch(error => { if (!controller.signal.aborted) entry.error = error; });
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
      this.tiles.set(key, this.buildTile(key, entry.tx, entry.ty, entry.sections));
      done++;
      if (done >= budget) break;
    }
    while (this.tiles.size > CAPACITY) {
      const oldest = [...this.tiles.values()].sort((a, b) => a.used - b.used)[0];
      this.discard(oldest);
      this.tiles.delete(oldest.key);
    }
  }

  buildTile(key, tx, ty, sections) {
    const gl = this.gl;
    const size = this.index.tileSize;
    const tile = { key, x0: (this.index.ix0 + tx) * size, y0: (this.index.iy0 + ty) * size, used: ++this.clock };
    if (sections.TERR) {
      // the tile's grid, and the wider lattice around it that the height of the ground beyond the tile is read from
      tile.lattice = readGrid(sections.TERR);
      tile.grid = innerGrid(tile.lattice, TERRAIN_RINGS);
      tile.heights = floatTexture(gl, tile.grid.nx, tile.grid.ny, Float32Array.from(tile.grid.heights));
      // the height of the ground at a point of the world, as the bake read it (the same lattice, read the same way)
      tile.surfaceAt = (x, y) => surfaceOn(tile.lattice, x, y);
      if (!this.tileMesh || this.tileMesh.nx !== tile.grid.nx || this.tileMesh.ny !== tile.grid.ny) {
        release(gl, this.tileMesh);
        this.tileMesh = { ...gridMesh(gl, tile.grid.nx, tile.grid.ny), nx: tile.grid.nx, ny: tile.grid.ny };
      }
    }
    if (sections.BASE) tile.base = byteTexture(gl, 32, 32, readBase(sections.BASE));
    if (sections.BLDB) {
      const buildings = readBuildings(sections.BLDB);
      if (buildings.indices.length) {
        tile.buildings = assemble(gl, [{ data: buildings.vertices, layout: [[0, 3], [1, 2], [2, 1]] }], buildings.indices);
        tile.props = floatTexture(gl, 9, buildings.buildings, buildings.props);
      }
    }
    if (sections.ROOF) {
      const boxes = readBoxes(sections.ROOF);
      if (boxes.length) {
        tile.roofs = assemble(gl, [{ data: UNIT_BOX, layout: [[0, 3], [1, 2]] }, { data: boxes, layout: [[2, 4], [3, 4]], divisor: 1 }]);
        tile.roofs.count = boxes.length / 8;
      }
    }
    tile.ground = {};
    for (const [name, id] of [['water', 'WATR'], ['road', 'ROAD'], ['land', 'LAND'], ['deck', 'DECK']]) {
      if (!sections[id]) continue;
      // water, roads and land lie on the ground, a lift above it by their class; a deck keeps the height it was given
      const mesh = readMesh(sections[id], id === 'DECK' ? null : (x, y, cls) => Math.fround(tile.surfaceAt(tile.x0 + x, tile.y0 + y) + (this.lifts[cls] ?? 0.02)));
      if (mesh.indices.length) tile.ground[name] = assemble(gl, [{ data: mesh.vertices, layout: [[0, 3], [1, 1], [2, 1]] }], mesh.indices);
    }
    if (sections.TREE) {
      const trees = readTrees(sections.TREE, (x, y) => Math.fround(tile.surfaceAt(tile.x0 + x, tile.y0 + y)));
      if (trees.count) {
        tile.trees = trees;
        tile.treeMesh = assemble(gl, [
          { data: UNIT_SQUARE, layout: [[0, 2]] },
          { data: trees.records, stride: 16, layout: [[1, 4, gl.FLOAT, 0], [2, 4, gl.UNSIGNED_BYTE, 12]], divisor: 1 },
        ]);
      }
    }
    if (sections.PLCE) tile.places = readPlaces(sections.PLCE);
    if (sections.PATH) tile.paths = readPaths(sections.PATH);
    if (sections.BRND) {
      const shops = readBrands(sections.BRND);
      if (shops.count) {
        tile.brands = shops;
        tile.brandMesh = assemble(gl, [
          { data: UNIT_SQUARE, layout: [[0, 2]] },
          { data: shops.records, stride: 16, layout: [[1, 3, gl.FLOAT, 0], [2, 4, gl.UNSIGNED_BYTE, 12]], divisor: 1 },
        ]);
      }
    }
    // how high and how low the tile reaches: what the sun's picture must hold
    tile.floor = tile.grid ? tile.grid.heights.reduce((min, h) => Math.min(min, h), Infinity) : 0;
    tile.top = tile.grid ? tile.grid.heights.reduce((max, h) => Math.max(max, h), -Infinity) : 0;
    if (tile.props) {
      for (let k = 0; k < tile.props.length; k += 9) tile.top = Math.max(tile.top, tile.props[k] + tile.props[k + 1]);
      tile.top += 4;                     // room for what stands on the roofs
    }
    return tile;
  }

  discard(tile) {
    const gl = this.gl;
    release(gl, tile.buildings);
    release(gl, tile.roofs);
    release(gl, tile.brandMesh);
    Object.values(tile.ground).forEach(mesh => release(gl, mesh));
    release(gl, tile.treeMesh);
    for (const name of ['heights', 'base', 'props']) if (tile[name]) gl.deleteTexture(tile[name]);
  }
}
