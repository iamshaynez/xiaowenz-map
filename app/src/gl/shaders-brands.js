// The chain brands' signboards (pipeline/pixelcity/brands.py): an upright board painted with the brand's
// own 16×16 pixel logo — 金拱门、绿色的星巴克圆、肯德基的斜纹、优衣库的白条 — out of an atlas of hand-drawn
// pictures (app/src/landmarks/brandmarks.js; the board is the logo's own background, so the quad is just
// the picture held up). A billboard like a tree's crown: its size is in pixels, from metres through the
// camera's scale. From far out it is under a pixel and is not drawn at all (BRAND_SCALE in render/city.js).
// The board is a shop flag of the pixel map, oversized like the cars are: real ones are narrower.
//
// It takes no shadow and casts none. It casts none because at three and a half metres it is narrower than
// the shadow map's own blur; it takes none because a sign hangs at the wall of a building that is taller
// than it is — the sun's picture in its column is the building's own roof, and a lit test there would
// keep every sign of the city in shade. A sign reads by being bright; the rim gives it the form.
import { PREFIX, TABLES, MRT } from './shaders.js';
import { CITY_CAMERA, CITY_PIXEL, NOISE, ISLAND } from './city-common.js';

const VERTEX = PREFIX + CITY_CAMERA;
const FRAGMENT = PREFIX + CITY_CAMERA + CITY_PIXEL + TABLES + NOISE + MRT + ISLAND;

export const BRAND_SHADERS = {
  brands: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec2 aCorner;   // the unit square
layout(location = 1) in vec3 aShop;     // x, y relative to the tile's corner; z
layout(location = 2) in vec4 aLook;     // bytes: board colour, mark colour, brand number, spare
uniform vec2 uOffset;                   // tile corner relative to the camera centre
const vec3 BOARD = vec3(1.8, 1.6, 5.2); // half width, bottom edge, top edge, in metres — a square flag
out vec2 vPlace;                        // the foot of the board in world metres
out vec2 vBox;                          // -1..1 across and up the board
out float vDepth;
flat out vec3 vLook;
void main() {
  vec3 foot = vec3(aShop.xy + uOffset, aShop.z);
  vec3 s = project(vec3(foot.xy, foot.z + BOARD.y));
  float up = uTilt.y * uTilt.z;                                   // pixels per metre of height
  float tall = max((BOARD.z - BOARD.y) * up, 2.0);
  vec2 centre = vec2(s.x, s.y + tall * 0.5);
  vec2 extent = vec2(max(BOARD.x * uTilt.z, 0.75), tall * 0.5);
  vDepth = s.z;
  vPlace = foot.xy + uCentre.xy;
  vLook = aLook.xyz;
  vBox = aCorner;
  gl_Position = clip(vec3(centre + aCorner * extent, vDepth));
}`,
    fs: FRAGMENT + /* glsl */`
uniform sampler2D uMarks;               // the atlas of pixel logos, one 16×16 cell a brand
uniform float uColumns;                 // how many brands the atlas holds
in vec2 vPlace;
in vec2 vBox;
in float vDepth;
flat in vec3 vLook;
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vPlace, ip)) discard;
  // the brand's picture, whole: the atlas cell is the sign's face, background and all, painted flat.
  // A step darker at the rim, so that the flag reads as a thing put up rather than a patch of colour
  vec2 uv = vec2((vLook.z + 0.5 + vBox.x * 0.5) / uColumns, 0.5 - vBox.y * 0.5);
  vec3 color = texture(uMarks, uv).rgb;
  if (abs(vBox.x) > 0.85) color *= 0.72;
  outColor = vec4(color, 1.0);
  outClass = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}`,
  },
};
