// The landmarks of the app: the city's list (cities/<id>/landmarks.json, looked up in the map and placed by the bake)
// with every landmark that is built by hand assembled and ready on the graphics card.
import { assemble, floatTexture } from '../world/store.js';
import * as models from './models.js';

// what the models call their materials, as palette indices
// how deep the foot of a model sits below the ground it stands on: a tower on a hill is bedded in, so that
// no gap shows where the slope falls away; a bridge's deck must meet the road at its ends, so not at all
const BED = { archBridge: 0, trussBridge: 0 };
const ROLES = { stone: 'stone_pale', tile: 'tile_dark', wall: 'whitewash_aged', wood: 'wood_dark', metal: 'metal_pale', red: 'temple_red', path: 'paving',
  steel: 'metal_dark', deck: 'rail', concrete: 'concrete_pale', white: 'panel_white', grass: 'pitch', glass: 'glass_blue', rose: 'plaster_rose',
  brick: 'brick_red', cream: 'plaster_cream', gold: 'gild', grey: 'concrete_grey', silver: 'metal_pale', dark: 'window_dark',
  slate: 'tile_slate', verdigris: 'glass_teal' };

// -> the list, each landmark with `parts`: what is built by hand for it, itself and its dependents, as
//    [{ title, x, y, reach, top, mesh, props }], x and y in world metres
export function buildLandmarks(gl, list, place) {
  const roles = {};
  for (const [role, name] of Object.entries(ROLES)) roles[role] = place(name);
  // a landmark built by hand is looked at half-way up
  return list.map(row => {
    const parts = [row, ...(row.parts || [])].filter(item => item.kit).map(item => buildPart(gl, item, roles));
    return { ...row, parts, focus: parts.length ? Math.max(...parts.map(part => part.top)) / 2 : 0, bed: parts.length ? parts[0].bed : 2 };
  });
}

// one model, turned to run the way the map says, and measured: how far it reaches from where it stands,
// and how high
function buildPart(gl, item, roles) {
  const model = models[item.kit.model];
  if (!model) throw new Error(`没有叫 ${item.kit.model} 的地标模型`);
  const { vertices, indices, props, count } = model(roles, item.kit).finish();
  const angle = item.angle || 0, c = Math.cos(angle), s = Math.sin(angle);
  let reach = 0, top = 0;
  for (let k = 0; k < vertices.length; k += 6) {
    const x = vertices[k], y = vertices[k + 1], nx = vertices[k + 3], ny = vertices[k + 4];
    vertices[k] = x * c - y * s;
    vertices[k + 1] = x * s + y * c;
    vertices[k + 3] = nx * c - ny * s;
    vertices[k + 4] = nx * s + ny * c;
    reach = Math.max(reach, Math.hypot(vertices[k], vertices[k + 1]));
    top = Math.max(top, vertices[k + 2]);
  }
  const mesh = assemble(gl, [{ data: vertices, layout: [[0, 3], [1, 2], [2, 1]] }], indices);
  return { title: item.title, x: item.x, y: item.y, reach, top, bed: BED[item.kit.model] ?? 2, mesh, props: floatTexture(gl, 9, count, props), triangles: indices.length / 3 };
}
