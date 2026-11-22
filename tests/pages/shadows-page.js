// Test page for the city renderer's shadows: a made-up tile with a few boxes and a tree on flat ground,
// drawn by the real renderer. The scene is drawn twice, with and without shadows; a pixel whose colour
// changes is in shade. That is handed back with the class buffer, for comparison with what the sun's
// geometry says should be in shade (tools/tests/shadows.cjs).
import { createContext, framebuffer, Program } from '../../app/src/gl/context.js';
import { CityRenderer, SHADOW } from '../../app/src/render/city.js';
import { SHADOW_SHADERS } from '../../app/src/gl/shaders-shadow.js';
import { TREE_SHADERS } from '../../app/src/gl/shaders-trees.js';
import { assemble, byteTexture, floatTexture, gridMesh, UNIT_SQUARE } from '../../app/src/world/store.js';

const preview = document.getElementById('c');
const canvas = document.createElement('canvas');   // offscreen: the visible canvas shows the result through a 2D context
const SIZE = 1000, CELLS = 32;
const PREFIX = '#version 300 es\nprecision highp float;\n';

function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(out);
}

function flip(bytes, W, H) {
  const out = new Uint8Array(bytes.length), row = W * 4;
  for (let y = 0; y < H; y++) out.set(bytes.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  return out;
}

// one box in the form the baked buildings have: walls with their outward normal, then the roof
function box(x0, y0, x1, y1, base, top, index) {
  const v = [];
  const wall = (ax, ay, bx, by, nx, ny) => {
    for (const [x, y, z] of [[ax, ay, base], [bx, by, base], [bx, by, top], [ax, ay, base], [bx, by, top], [ax, ay, top]]) v.push(x, y, z, nx, ny, index);
  };
  wall(x0, y0, x1, y0, 0, -1);
  wall(x1, y0, x1, y1, 1, 0);
  wall(x1, y1, x0, y1, 0, 1);
  wall(x0, y1, x0, y0, -1, 0);
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) v.push(x, y, top, 0, 0, index);
  return v;
}

// A world with one tile whose origin is at (-500, -500): flat grass, the boxes and the trees given.
function makeWorld(gl, boxes, trees) {
  const x0 = -SIZE / 2, y0 = -SIZE / 2, step = SIZE / CELLS;
  const grid = { nx: CELLS + 1, ny: CELLS + 1, x0, y0, cell: step };
  const props = [];
  const vertices = [];
  boxes.forEach((b, index) => {
    vertices.push(...box(b.x0 - x0, b.y0 - y0, b.x1 - x0, b.y1 - y0, b.base, b.top, index));
    props.push(b.base, b.top - b.base, 10, 4, 0, 3, 5, 0, 0);
  });
  const tile = {
    key: '0_0', x0, y0, grid,
    heights: floatTexture(gl, grid.nx, grid.ny, new Float32Array(grid.nx * grid.ny)),
    base: byteTexture(gl, CELLS, CELLS, new Uint8Array(CELLS * CELLS).fill(14)),
    ground: {},
    floor: 0,
    top: boxes.length ? Math.max(...boxes.map(b => b.top)) : 0,
  };
  if (boxes.length) {
    tile.buildings = assemble(gl, [{ data: new Float32Array(vertices), layout: [[0, 3], [1, 2], [2, 1]] }], Uint32Array.from({ length: vertices.length / 6 }, (_, k) => k));
    tile.props = floatTexture(gl, 9, boxes.length, new Float32Array(props));
  }
  if (trees.length) {
    // into the 250 m cells they stand in, each cell's trees in one run, as the bake lays them out
    const cellOf = t => Math.min(3, Math.max(0, Math.floor((t.y - y0) / 250))) * 4 + Math.min(3, Math.max(0, Math.floor((t.x - x0) / 250)));
    const sorted = trees.map(t => ({ t, cell: cellOf(t) })).sort((a, b) => a.cell - b.cell);
    const starts = new Uint32Array(17);
    sorted.forEach(entry => { for (let j = entry.cell + 1; j <= 16; j++) starts[j]++; });
    // 16 bytes per tree: x and y relative to the tile and z (float), species, crown radius in half-metres, seed, kind
    const records = new Uint8Array(trees.length * 16);
    const floats = new Float32Array(records.buffer);
    sorted.forEach((entry, k) => {
      const t = entry.t;
      floats.set([t.x - x0, t.y - y0, t.z], k * 4);
      records[k * 16 + 12] = t.species;
      records[k * 16 + 13] = Math.round(t.radius * 2);
      records[k * 16 + 14] = t.seed;
      records[k * 16 + 15] = 0;
    });
    tile.trees = { cells: 4, count: trees.length, starts, records };
    tile.treeMesh = assemble(gl, [
      { data: UNIT_SQUARE, layout: [[0, 2]] },
      { data: records, stride: 16, layout: [[1, 3, gl.FLOAT, 0], [2, 4, gl.UNSIGNED_BYTE, 12]], divisor: 1 },
    ]);
  }
  return {
    overview: {},                      // "loaded": enough for the renderer to draw the district tier
    tiles: new Map([['0_0', tile]]),
    tileMesh: gridMesh(gl, grid.nx, grid.ny),
    index: { treeCell: 250 },
    clock: 1,
    visible: () => [{ tx: 0, ty: 0 }],
  };
}

// shaderPatch: [[from, to], ...] applied to the buildings' shadow shader, for digging into a failure
window.runShadows = async ({ W, H, SS, camera, boxes, trees, shaderPatch = [], treePatch = [] }) => {
  const gl = createContext(canvas);
  const renderer = new CityRenderer(gl, W, H, SS);
  const [paletteFile, index] = await Promise.all([
    fetch('../../data/curated/palette.json').then(r => r.json()),
    fetch('../../data/baked/index.json').then(r => r.json()),
  ]);
  const names = index.palette.slice();
  for (const name of Object.keys(paletteFile.colours)) if (!names.includes(name)) names.push(name);
  renderer.palette.seat(names.map(name => paletteFile.colours[name]));
  renderer.updatePalette();
  renderer.setLook(index, name => names.indexOf(name));
  if (shaderPatch.length) {
    let source = SHADOW_SHADERS.shadowBuildings.vs;
    for (const [from, to] of shaderPatch) {
      if (!source.includes(from)) throw new Error('patch does not apply: ' + from);
      source = source.replace(from, to);
    }
    renderer.programs.shadowBuildings = new Program(gl, source, SHADOW_SHADERS.shadowBuildings.fs, 'shadowBuildings-patched');
  }
  if (treePatch.length) {
    let source = TREE_SHADERS.trees.fs;
    for (const [from, to] of treePatch) {
      if (!source.includes(from)) throw new Error('patch does not apply: ' + from);
      source = source.replace(from, to);
    }
    renderer.programs.trees = new Program(gl, TREE_SHADERS.trees.vs, source, 'trees-patched');
  }
  // no edge of the island anywhere near the scene
  renderer.island = [0, 0, 1e5, 1e5];
  renderer.island2 = [1, 0, 1000, 1000];
  Object.assign(renderer.city, camera);
  renderer.time = 0;
  const world = makeWorld(gl, boxes, trees);
  const { frame } = renderer;
  const shoot = withShadows => {
    // no edges: their outline of the box would differ from nothing, and the picture is not what is compared
    const fbo = renderer.render(world, { edges: false, shadows: withShadows });
    return new Uint8Array(flip(frame.read(fbo), W, H));
  };
  const lit = shoot(false), color = shoot(true);
  const shaded = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) shaded[k] = lit[k * 4] !== color[k * 4] || lit[k * 4 + 1] !== color[k * 4 + 1] || lit[k * 4 + 2] !== color[k * 4 + 2] ? 255 : 0;
  preview.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(color), W, H), 0, 0);
  return {
    color: base64(color),
    cls: base64(flip(frame.read(frame.resolvedFbo, 1), W, H)),
    shaded: base64(shaded),
    shadow: SHADOW,
    drawn: { ...renderer.drawn, runs: renderer.treeRuns([...world.tiles.values()]).map(r => r.count) },
    // for digging into a failure: what the sun's picture should hold at the crown
    probe: trees.length ? (() => {
      const tree = trees[0], L = renderer.light, r = tree.radius, lift = r * 1.6;
      const centre = [tree.x - camera.x, tree.y - camera.y, tree.z + lift];
      const light = q => [q[0] * L.right[0] + q[1] * L.right[1] + q[2] * L.right[2], q[0] * L.up[0] + q[1] * L.up[1] + q[2] * L.up[2], q[0] * L.dir[0] + q[1] * L.dir[1] + q[2] * L.dir[2]];
      const c = light(centre), look = light([centre[0] + L.dir[0] * r, centre[1] + L.dir[1] * r, centre[2] + L.dir[2] * r]);
      // the depth the picture really holds at the crown, read through a one-pixel shader
      const sample = new Program(gl, PREFIX + 'void main() { vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0); gl_Position = vec4(p, 0.0, 1.0); }',
        PREFIX + 'uniform sampler2D uShadowMap; uniform vec2 uAt; out vec4 o; void main() { o = vec4(texture(uShadowMap, uAt).r); }', 'sample');
      const pixel = byteTexture(gl, 1, 1, new Uint8Array(4));
      const target = framebuffer(gl, [pixel]);
      sample.use();
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, renderer.shadowMap); gl.uniform1i(sample.uniforms.get('uShadowMap').loc, 0);
      const read = at => {
        gl.uniform2f(sample.uniforms.get('uAt').loc, at[0], at[1]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.viewport(0, 0, 1, 1); gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel.bytes || (pixel.bytes = new Uint8Array(4)));
        return pixel.bytes[0];
      };
      const map = [(c[0] - L.box[0]) * L.box[2], (c[1] - L.box[1]) * L.box[3]];
      const held = { centre: read(map), left: read([map[0] - 0.01, map[1]]), right: read([map[0] + 0.01, map[1]]) };
      // and the whole picture, coarse, so that a misplaced caster can be seen
      const grid = [];
      // the neighbourhood of the crown, one character per 0.0025 of the picture (about a metre)
      for (let j = 11; j >= -11; j--) { let row = ''; for (let i = -19; i <= 19; i++) { const v = read([map[0] + i * 0.0025, map[1] + j * 0.0025]); row += v === 0 ? '.' : v > 200 ? '#' : v > 100 ? '+' : '-'; } grid.push(row); }
      grid.push('raw across the middle: ' + [-8, -6, -4, -2, 0, 2, 4, 6, 8].map(i => read([map[0] + i * 0.0025, map[1]])).join(' '));
      grid.push('raw down the middle:   ' + [-8, -6, -4, -2, 0, 2, 4, 6, 8].map(j => read([map[0], map[1] + j * 0.0025])).join(' '));
      return { map, discDepth: (c[2] - L.depth[0]) * L.depth[1], lookupDepth: (look[2] - L.depth[0]) * L.depth[1], bias: renderer.shadowBias, shadowOn: renderer.shadowOn, held, grid, light: JSON.parse(JSON.stringify(L)) };
    })() : null,
    glError: gl.getError(),
  };
};

window.shadowsReady = true;
