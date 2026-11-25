// The chain brands' signboards (pipeline/pixelcity/brands.py): a big board painted with the brand's own
// 32×32 pixel logo — 金拱门、绿色的星巴克圆、肯德基的斜纹、优衣库的白条 — out of the per-brand textures
// built from app/src/landmarks/brandmarks.js. Each board is one brand's picture, whole. The bake hangs
// every board on the roofline of the shop's own building (the z of aShop is that height, not the ground),
// high on the upper wall with its top edge over the parapet, so that it stays seen over the streets. A
// billboard like a tree's crown: its size is in pixels, from metres through the camera's scale. From far
// out it is under a pixel and is not drawn at all (BRAND_SCALE in render/city.js). The board is oversized
// on purpose — 招牌要显眼，不真实没关系.
//
// It takes no shadow and casts none. It casts none because at these sizes the shadow map's own blur is
// wider than the board's thickness; it takes none because a sign hangs at the wall of a building that is
// taller than it is — the sun's picture in its column is the building's own roof, and a lit test there
// would keep every sign of the city in shade. A sign reads by being bright; the rim gives it the form.
import { PREFIX, TABLES, MRT } from './shaders.js';
import { CITY_CAMERA, CITY_PIXEL, NOISE, ISLAND } from './city-common.js';

const VERTEX = PREFIX + CITY_CAMERA;
const FRAGMENT = PREFIX + CITY_CAMERA + CITY_PIXEL + TABLES + NOISE + MRT + ISLAND;

export const BRAND_SHADERS = {
  brands: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec2 aCorner;   // the unit square — also the picture's own coordinates
layout(location = 1) in vec3 aShop;     // x, y relative to the tile's corner; the height it hangs at
uniform vec2 uOffset;                   // tile corner relative to the camera centre
const vec3 BOARD = vec3(4.5, -7.0, 1.2); // half width, bottom edge, top edge, metres about the roofline
out vec2 vPlace;                        // the foot of the board in world metres
out vec2 vUV;                           // where in the brand's picture this pixel reads
out float vDepth;
void main() {
  vec3 foot = vec3(aShop.xy + uOffset, aShop.z);
  vec3 s = project(vec3(foot.xy, foot.z + BOARD.z));               // the top edge, just over the parapet
  float up = uTilt.y * uTilt.z;                                   // pixels per metre of height
  float tall = max((BOARD.z - BOARD.y) * up, 2.0);
  vec2 centre = vec2(s.x, s.y + tall * 0.5);                       // +y is down the screen: below the top
  vec2 extent = vec2(max(BOARD.x * uTilt.z, 0.75), tall * 0.5);
  vDepth = s.z;
  vPlace = foot.xy + uCentre.xy;
  vUV = vec2(0.5 + aCorner.x * 0.5, 0.5 + aCorner.y * 0.5);   // 板的上沿(aCorner.y=-1)读图的首行——图集的首行是图的顶
  gl_Position = clip(vec3(centre + aCorner * extent, vDepth));
}`,
    fs: FRAGMENT + /* glsl */`
uniform sampler2D uMark;                // this draw's brand picture, 32×32
in vec2 vPlace;
in vec2 vUV;
in float vDepth;
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vPlace, ip)) discard;
  // the brand's picture, whole: it is the sign's face, background and all, painted flat.
  // A step darker at the rim, so that the flag reads as a thing put up rather than a patch of colour
  vec3 color = texture(uMark, vUV).rgb;
  if (vUV.x < 0.1 || vUV.x > 0.9) color *= 0.72;
  outColor = vec4(color, 1.0);
  outClass = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}`,
  },
};
