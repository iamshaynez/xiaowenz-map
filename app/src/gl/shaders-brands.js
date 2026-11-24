// The chain brands' signboards (pipeline/pixelcity/brands.py): a small upright board of the brand's own
// colour, standing just outside the facade of the shop, where a door sign would hang. A billboard like a
// tree's crown: its size is in pixels, from metres through the camera's scale. From far out it is under a
// pixel and is not drawn at all (BRAND_SCALE in render/city.js).
//
// It takes no shadow and casts none. It casts none because at two and a half metres it is narrower than
// the shadow map's own blur; it takes none because a sign hangs at the wall of a building that is taller
// than it is — the sun's picture in its column is the building's own roof, and a lit test there would
// keep every sign of the city in shade. A sign reads by being bright; the rim of its own shade gives it
// the form.
import { PREFIX, TABLES, MRT } from './shaders.js';
import { CITY_CAMERA, CITY_PIXEL, NOISE, ISLAND } from './city-common.js';

const VERTEX = PREFIX + CITY_CAMERA;
const FRAGMENT = PREFIX + CITY_CAMERA + CITY_PIXEL + TABLES + NOISE + MRT + ISLAND;

export const BRAND_SHADERS = {
  brands: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec2 aCorner;   // the unit square
layout(location = 1) in vec3 aShop;     // x, y relative to the tile's corner; z
layout(location = 2) in vec4 aLook;     // bytes: the palette index of the brand's colour, then three not read
uniform vec2 uOffset;                   // tile corner relative to the camera centre
const vec3 BOARD = vec3(1.5, 1.2, 2.8); // half width, bottom edge, top edge, in metres — a shop flag, oversized like the cars are
out vec2 vPlace;                        // the foot of the board in world metres
out vec2 vBox;                          // -1..1 across and up the board
out float vDepth;
flat out float vColour;
void main() {
  vec3 foot = vec3(aShop.xy + uOffset, aShop.z);
  vec3 s = project(vec3(foot.xy, foot.z + BOARD.y));
  float up = uTilt.y * uTilt.z;                                   // pixels per metre of height
  float tall = max((BOARD.z - BOARD.y) * up, 1.5);
  vec2 centre = vec2(s.x, s.y + tall * 0.5);
  vec2 extent = vec2(max(BOARD.x * uTilt.z, 0.75), tall * 0.5);
  vDepth = s.z;
  vPlace = foot.xy + uCentre.xy;
  vColour = aLook.x;
  vBox = aCorner;
  gl_Position = clip(vec3(centre + aCorner * extent, vDepth));
}`,
    fs: FRAGMENT + /* glsl */`
in vec2 vPlace;
in vec2 vBox;
in float vDepth;
flat in float vColour;
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vPlace, ip)) discard;
  // a board lit like a wall that faces the viewer: one tone of the brand's colour, a step darker at its
  // rim, so that it reads as a thing put up rather than a patch of colour on the ground
  float bayer = bayerAt(ip);
  float level = clamp(floor(2.6 + (bayer - 0.5) * 0.5 - (abs(vBox.x) > 0.8 ? 0.8 : 0.0)), 0.0, 4.0);
  outColor = vec4(rampOf(int(vColour + 0.5), level), 1.0);
  outClass = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}`,
  },
};
