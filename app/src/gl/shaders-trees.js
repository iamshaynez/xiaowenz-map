// Trees: a crown drawn as a shape that faces the screen and is shaded like the spheres of the reference,
// and a trunk. Both are billboards: their size is in pixels, from the crown's radius in metres.
//
// Each species has its own shape and manner: a camphor a round crown; a willow a taller one whose lower
// edge breaks into hanging strands; a plane a wide, slightly flattened crown on a pale trunk; a pine a
// narrow cone in tiers; bamboo a slim clump with the lines of its stalks; a blossoming tree a small
// round crown. Close up (uDetail) the outline grows lumpy and the trunk shows, the crown sitting higher.
//
// Winter: the deciduous species (willow, plane, blossoming) lose their leaves and are drawn as a loose
// cluster of twigs (uBare); snow lies on the upper part of evergreen crowns (uSnow).
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
// By species (camphor, willow, plane, pine, bamboo, blossoming): the crown's half width and half height
// as a share of its radius, and the height of its centre above the ground. The caster of shadows has
// the same table.
export const TREE_SPECIES = /* glsl */`
const vec2 SHAPE[6] = vec2[6](vec2(1.0, 1.0), vec2(0.95, 1.25), vec2(1.05, 0.95), vec2(0.72, 1.5), vec2(0.6, 1.5), vec2(0.9, 0.85));
const float LIFT[6] = float[6](1.1, 1.35, 1.05, 1.6, 1.6, 1.0);
`;

export const TREE_SHADERS = {
  trees: {
    vs: VERTEX + RECORD + TREE_SPECIES + /* glsl */`
uniform float uDetail;                  // 1 when the tree is large on the screen
uniform int uPart;                      // 0: the crown, 1: the trunk
uniform float uTime;                    // seconds
out vec2 vPlace;                        // the foot of the tree in world metres
out vec2 vCentre;                       // the centre of the crown or the trunk, in low-resolution pixels
out vec2 vHalf;                         // its half width and half height in pixels
out vec3 vCrown;                        // the centre of the crown, relative to the camera centre
out float vRadius;                      // the crown's radius in metres
out float vDepth;
out float vNear;                        // how far the eye is from the crown's centre, in crown radii (the walking view)
flat out float vKind;                   // woods, lawns, streets, shores
flat out float vSpecies;
flat out float vSeed;
void main() {
  float seed = aLook.z / 255.0;
  int species = int(aLook.x + 0.5);
  float radius = aLook.y * 0.5;
  if (int(aLook.w + 0.5) == 2) radius *= 0.85;   // a street tree is pruned: a crown a shade smaller
  vec3 foot = vec3(aTree.xy + uOffset, aTree.z);
  vec3 ground = project(foot);
  // the wind: eight steps a second, so that it feels drawn rather than simulated
  float t = floor(uTime * 8.0) / 8.0;
  float gust = sin(t * 0.9 + seed * 6.2832 + foot.x * 0.03) + 0.5 * sin(t * 2.1 + seed * 12.0 + foot.y * 0.02);
  float lift = radius * LIFT[species] * (1.0 + 0.3 * uDetail);
  vCrown = vec3(foot.xy, foot.z + lift);
  vRadius = radius;
  // the eye against the canopy: how many crown radii the eye stands from its centre (the walking view
  // says whether its eye is inside the leaves; the map's camera is always far above)
  vNear = distance(vec3(vCrown.xy, foot.z + lift), vec3(0.0, 0.0, uWalk.z)) / max(radius, 1.0);
  vKind = aLook.w;
  if (uPart == 0) {
    vec3 s = project(vCrown);
    vec2 size = SHAPE[species] * max(radius * pixelsPerMetre(s), 0.75) * (1.0 + 0.15 * uDetail);
    vec2 centre = toPixels(s) + vec2(round(gust * 0.9 * (0.5 + 0.5 * uDetail)), round(gust * 0.3));   // whole pixels, as the reference moves its leaves
    vCentre = centre;
    vHalf = size;
    vDepth = s.z;
  } else {
    vec2 at = toPixels(ground);
    float ppm = pixelsPerMetre(ground);
    float top = at.y - lift * uTilt.y * ppm;
    vCentre = vec2(at.x, (at.y + top) * 0.5);
    vHalf = vec2(max(radius * (0.09 + 0.05 * uDetail) * ppm, 0.75 + uDetail), max((at.y - top) * 0.5, 0.5));
    vDepth = ground.z;
  }
  vSpecies = aLook.x;
  vSeed = seed;
  vPlace = foot.xy + uCentre.xy;
  gl_Position = clipPixels(vec3(vCentre + aCorner * vHalf, vDepth));
}
`,
    fs: FRAGMENT + TREE_SPECIES + /* glsl */`
uniform int uPart;                      // 0: the crown, 1: the trunk
uniform int uSpecies[6];                // the palette index of each species
uniform int uBark;                      // the palette index of bark, and of a plane tree's pale bark
uniform int uBarkPale;
uniform float uDetail;                  // 1 when the tree is large on the screen
uniform float uBare;                    // 1 in winter: the deciduous trees are drawn as twigs
uniform float uSnow;                    // 1 where snow lies
uniform vec3 uSnowColour;
in vec2 vPlace;
in vec2 vCentre;
in vec2 vHalf;
in vec3 vCrown;
in float vRadius;
in float vDepth;
in float vNear;
flat in float vKind;
flat in float vSpecies;
flat in float vSeed;

// whether a point of the crown's square (-1..1) is inside this species' crown
bool inCrown(vec2 d, int species, float seed, float detail) {
  float rr = dot(d, d) + (noiseAt(d * 2.6 + seed * 40.0) - 0.5) * 0.5 * detail;   // lumpy close up
  if (species == 3) return d.y > -1.0 && d.y < 1.0 && abs(d.x) < 0.1 + 0.9 * (d.y + 1.0) * 0.5;      // a pine: a cone
  if (species == 1) return rr < 1.0 || (d.y > 0.3 && d.y < 1.05 && hashAt(vec2(floor(d.x * 9.0 + seed * 5.0), 3.0)) < 0.45);   // a willow's strands
  return rr < 1.0;
}

void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vPlace, ip)) discard;
  vec2 d = (pixelCentre() - vCentre) / vHalf;
  int species = int(vSpecies + 0.5);
  float bayer = bayerAt(ip);
  vec3 color;
  if (uPart == 0) {
    // 走到树跟前，树冠自己让开，三层：
    //   一、眼睛进了树冠（离冠心不到一圈半径多些）——整冠按抖动让开，人站在树荫里看得见街；
    //   二、行道树和湖岸树到了中景（二三十米外）就按抖动溶解——一排树冠在画面里会融成一堵
    //       绿墙，让掉八成，街道和街对面就都读得见了；林子不让，林子本来就是去处；
    //   三、贴脸的大树冠心挖一个抖动边的洞——洞里看得见树干。
    if (uWalk.x > 0.5) {
      if (vNear < 1.25 + (bayer - 0.5) * 0.3) discard;
      if (int(vKind + 0.5) != 0) {
        // 行道树与湖岸树替街道让路：贴身十米内的整冠让开（树干还在，人在树下看得见街），
        // 二三十米外的一排树冠按抖动溶解八成——它们在画面里会融成一堵绿墙
        float metres = vNear * vRadius;
        if (metres < 10.0) discard;
        float yield = clamp((metres - 24.0) / 16.0, 0.0, 0.8);
        if (yield > 0.0 && bayer < yield) discard;
      }
      float pxRadius = max(vHalf.x, vHalf.y);
      float hole = clamp((pxRadius - 110.0) / 170.0, 0.0, 0.55);
      if (hole > 0.0 && dot(d, d) < hole * hole + (bayer - 0.5) * 0.14) discard;
    }
    if (!inCrown(d, species, vSeed, uDetail)) discard;
    bool evergreen = species == 0 || species == 3 || species == 4;
    if (uBare > 0.5 && !evergreen) {
      // winter: a loose cluster of twigs
      if (hashAt(vec2(ip) + vSeed * 37.0) > 0.2 + 0.12 * uDetail) discard;
      color = rampOf(uBark, 1.0 + (hashAt(vec2(ip) * 0.7 + vSeed * 11.0) > 0.6 ? 1.0 : 0.0));
    } else {
      float l;
      if (species == 3) {
        // a pine: darker on the right, in tiers
        l = 0.62 - 0.3 * d.x + (fract(d.y * 3.0 + vSeed) < 0.25 ? -0.18 : 0.0) + (hashAt(vec2(ip) + vSeed * 37.0) - 0.5) * 0.35;
      } else {
        // the reference's rough sphere: lit from the upper left, roughened with per-pixel noise, with the
        // ground's warm light bouncing onto its underside
        float nz = sqrt(max(0.0, 1.0 - dot(d, d)));
        l = clamp(-0.55 * d.x - 0.6 * d.y + 0.58 * nz, 0.0, 1.0);
        l += (hashAt(vec2(ip) + vSeed * 37.0) - 0.5) * 0.55;
        if (d.y > 0.35) l = max(l, 0.12 + d.y * 0.24);
        if (species == 4) l -= (fract(d.x * 7.0 + vSeed) < 0.22 ? 0.2 : 0.0);      // the lines of the stalks
        // 近景的树冠分层：两片更小的叶团向光挪进去，盖在大团上——上面的那层接光多、亮一档，
        // 层与层之间露出的下叶就是它们投下的影子。只对圆冠的树（香樟、垂柳、梧桐、花树），
        // 松是分层锥、竹是一丛细秆，各有各的画法
        if (uDetail > 0.5 && species != 3 && species != 4) {
          vec2 off1 = vec2(-0.16, -0.13), off2 = vec2(-0.30, -0.21);
          bool in1 = dot(d - off1, d - off1) < 0.55, in2 = dot(d - off2, d - off2) < 0.26;
          if (in2) l = clamp(l + 0.9 + (hashAt(vec2(ip) * 1.7 + vSeed * 23.0) - 0.5) * 0.4, 0.0, 1.0);
          else if (in1) l = clamp(l + 0.5 + (hashAt(vec2(ip) * 1.3 + vSeed * 31.0) - 0.5) * 0.4, 0.0, 1.0);
          else l = clamp(l - 0.25, 0.0, 1.0);
        }
      }
      color = rampOf(uSpecies[species], floor(l * 4.4 + 0.2 + (bayer - 0.5) * 0.7));
      if (uSnow > 0.5 && evergreen && d.y < 0.1 && bayer < 0.62 + 0.2 * uDetail) color = uSnowColour;
    }
  } else {
    if (abs(d.x) > 1.0 || abs(d.y) > 1.0) discard;
    float level = floor(2.2 + grainAt(d * 3.0 + vSeed * 50.0, 4.0, vSeed) + (bayer - 0.5) * 0.4);
    color = rampOf(species == 2 ? uBarkPale : uBark, level);
    // a plane tree's bark comes in patches
    if (species == 2 && noiseAt(d * 4.0 + vSeed * 20.0) > 0.55) color = rampOf(uBark, clamp(level - 1.5, 0.0, 4.0));
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
