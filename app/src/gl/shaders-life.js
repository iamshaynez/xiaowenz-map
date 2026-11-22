// What moves, drawn as boxes: cars, buses, boats, and people as a small box with a head on it. A box is
// turned to the heading of its vehicle and stands on the line it moves along (app/src/life/traffic.js).
// Vehicles cast shadows like buildings do; people are too small to bother.
import { PREFIX, MRT, TABLES } from './shaders.js';
import { CITY_CAMERA, CITY_PIXEL, GRAIN, ISLAND, LIGHT, NOISE } from './city-common.js';

const RECORD = /* glsl */`
layout(location = 0) in vec3 aCorner;    // unit box: x and y in {-1, 1}, z in {0, 1}
layout(location = 1) in vec2 aNormal;    // outward normal of the face; (0, 0) on the top
layout(location = 2) in vec4 aPlace;     // per instance: x, y in world metres; z; heading x
layout(location = 3) in vec4 aShape;     // per instance: heading y, half length, half width, height
`;
// the corner of a box in world axes, relative to the camera centre (as every city shader wants it)
const PLACE = /* glsl */`
vec3 place(vec3 corner) {
  float hx = aPlace.w, hy = aShape.x;                      // the heading, as cosine and sine
  vec2 local = vec2(corner.x * aShape.z, corner.y * aShape.y);   // across the heading, along it
  vec2 turned = vec2(local.x * hy + local.y * hx, -local.x * hx + local.y * hy);   // across is to the heading's right
  return vec3(aPlace.xy - uCentre.xy + turned, aPlace.z + corner.z * aShape.w);
}
vec2 turned(vec2 normal) {
  float hx = aPlace.w, hy = aShape.x;
  return vec2(normal.x * hy + normal.y * hx, -normal.x * hx + normal.y * hy);
}
`;

export const LIFE_SHADERS = {
  lifeBoxes: {
    vs: PREFIX + CITY_CAMERA + NOISE + RECORD + PLACE + /* glsl */`
layout(location = 4) in vec4 aLook;      // per instance: wall colour, top colour, kind, spare
out vec3 vWorld;
out vec2 vLocal;                        // across and along the box, -1..1: where on a vehicle a pixel is
out float vLight;
out float vDepth;
flat out vec4 vLook;
flat out float vTop;
void main() {
  vec3 world = place(aCorner);
  vWorld = world;
  vLocal = aCorner.xy;
  vLight = faceLight(turned(aNormal));
  vLook = aLook;
  vTop = aNormal == vec2(0.0) ? 1.0 : 0.0;
  vec3 s = project(world);
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: PREFIX + CITY_CAMERA + CITY_PIXEL + TABLES + NOISE + MRT + ISLAND + GRAIN + /* glsl */`
uniform int uWindow;                    // the palette index of glass
in vec3 vWorld;
in vec2 vLocal;
in float vLight;
in float vDepth;
flat in vec4 vLook;
flat in float vTop;
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vWorld.xy + uCentre.xy, ip)) discard;
  float level = vLight + grainAt(vWorld.xy, 4.0, 0.0) * 0.8 + (bayerAt(ip) - 0.5) * 0.5;
  int colour = vTop > 0.5 ? int(vLook.y) : int(vLook.x);
  // a vehicle seen from above is a body with a windscreen across the front of its roof
  if (vTop > 0.5 && vLook.z < 2.5 && vLocal.y > 0.15 && vLocal.y < 0.75) colour = uWindow;
  outColor = vec4(rampOf(colour, clamp(floor(level), 0.0, 4.0)), 1.0);
  outClass = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}`,
  },

  shadowLife: {
    vs: PREFIX + CITY_CAMERA + LIGHT + RECORD + PLACE + /* glsl */`
layout(location = 4) in vec4 aLook;
void main() {
  gl_Position = toLight(place(aCorner));
}`,
    fs: PREFIX + /* glsl */`void main() {}`,
  },
};
