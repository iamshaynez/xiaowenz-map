// Trees: a crown drawn as a screen-facing disc and shaded like the spheres of the reference, and a
// trunk. Both are billboards: their size is in pixels, from the crown's radius in metres.
//
// Close up the crown sits a little higher and wider, so that the trunk shows between it and the ground.
//
// A crown takes shadows like the ground does (city-common.js SHADOW): a tree standing in a building's
// shade is shaded with it. What a tree casts is drawn by shaders-shadow.js.
//
// The wind is the reference's: stepped to eight frames a second, and moving whole pixels.
import { PREFIX, MRT, TABLES } from './shaders.js';
import { CITY_CAMERA, CITY_PIXEL, GRAIN, ISLAND, NOISE, SHADOW } from './city-common.js';

const VERTEX = PREFIX + CITY_CAMERA;
const FRAGMENT = PREFIX + CITY_CAMERA + CITY_PIXEL + TABLES + NOISE + MRT + ISLAND + GRAIN + SHADOW;
const RECORD = /* glsl */`
layout(location = 0) in vec2 aCorner;   // the unit square
layout(location = 1) in vec3 aTree;     // x, y relative to the tile's corner; z
layout(location = 2) in vec4 aLook;     // bytes: species, crown radius in half-metres, seed, kind
uniform vec2 uOffset;                   // tile corner relative to the camera centre
`;

export const TREE_SHADERS = {
  trees: {
    vs: VERTEX + RECORD + /* glsl */`
uniform float uDetail;                  // 1 when the tree is large on the screen
uniform int uPart;                      // 0: the crown, 1: the trunk
uniform float uTime;                    // seconds
out vec2 vPlace;                        // the foot of the tree in world metres
out vec2 vCentre;                       // the centre of the crown or the trunk, in low-resolution pixels
out vec2 vHalf;                         // its half width and half height in pixels
out vec3 vCrown;                        // the centre of the crown, relative to the camera centre
out float vRadius;                      // the crown's radius in metres
out float vDepth;
flat out float vSpecies;
flat out float vSeed;
void main() {
  float seed = aLook.z / 255.0;
  float radius = aLook.y * 0.5;
  vec3 foot = vec3(aTree.xy + uOffset, aTree.z);
  vec3 ground = project(foot);
  // the wind: eight steps a second, so that it feels drawn rather than simulated
  float t = floor(uTime * 8.0) / 8.0;
  float gust = sin(t * 0.9 + seed * 6.2832 + foot.x * 0.03) + 0.5 * sin(t * 2.1 + seed * 12.0 + foot.y * 0.02);
  float lift = radius * (1.1 + 0.5 * uDetail);
  vCrown = vec3(foot.xy, foot.z + lift);
  vRadius = radius;
  if (uPart == 0) {
    vec3 s = project(vCrown);
    float across = max(radius * uTilt.z, 0.75) * (1.0 + 0.2 * uDetail);
    s.xy += vec2(round(gust * 0.9 * (0.5 + 0.5 * uDetail)), round(gust * 0.3));   // whole pixels, as the reference moves its leaves
    vCentre = s.xy;
    vHalf = vec2(across);
    vDepth = s.z;
  } else {
    float top = ground.y - radius * 1.1 * uTilt.y * uTilt.z;
    vCentre = vec2(ground.x, (ground.y + top) * 0.5);
    vHalf = vec2(max(radius * 0.09 * uTilt.z, 0.75), max((ground.y - top) * 0.5, 0.5));
    vDepth = ground.z;
  }
  vSpecies = aLook.x;
  vSeed = seed;
  vPlace = foot.xy + uCentre.xy;
  gl_Position = clip(vec3(vCentre + aCorner * vHalf, vDepth));
}
`,
    fs: FRAGMENT + /* glsl */`
uniform int uPart;                      // 0: the crown, 1: the trunk
uniform int uSpecies[6];                // the palette index of each species
uniform int uBark;                      // the palette index of bark
in vec2 vPlace;
in vec2 vCentre;
in vec2 vHalf;
in vec3 vCrown;
in float vRadius;
in float vDepth;
flat in float vSpecies;
flat in float vSeed;
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vPlace, ip)) discard;
  vec2 d = (pixelCentre() - vCentre) / vHalf;
  vec3 color;
  if (uPart == 0) {
    if (dot(d, d) > 1.0) discard;
    // the reference's rough sphere: lit from the upper left, roughened with per-pixel noise, with the
    // ground's warm light bouncing onto its underside
    float nz = sqrt(1.0 - dot(d, d));
    float l = clamp(-0.55 * d.x - 0.6 * d.y + 0.58 * nz, 0.0, 1.0);
    l += (hashAt(vec2(ip) + vSeed * 37.0) - 0.5) * 0.55;
    if (d.y > 0.35) l = max(l, 0.12 + d.y * 0.24);
    color = rampOf(uSpecies[int(vSpecies + 0.5)], floor(l * 4.4 + 0.2 + (bayerAt(ip) - 0.5) * 0.7));
  } else {
    if (abs(d.x) > 1.0 || abs(d.y) > 1.0) discard;
    float level = floor(2.2 + grainAt(d * 3.0 + vSeed * 50.0, 4.0, vSeed) + (bayerAt(ip) - 0.5) * 0.4);
    color = rampOf(uBark, level);
  }
  // whether the crown stands in something's shade, asked at the crown's centre: moved up to its surface
  // towards the sun, so that its own disc in the shadow map does not shade it
  if (inSun(vCrown + uLightDir * vRadius) < 0.5) color = inShade(color);
  outColor = vec4(color, 1.0);
  outClass = vec4(0.0, uPart == 0 ? 3.0 / 255.0 : 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}
`,
  },
};
