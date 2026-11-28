// Shaders of the city renderer. The per-pixel passes they feed (resolve, occlusion, edges) are shared
// with the reference engine in shaders.js; trees are in shaders-trees.js and shadows in shaders-post.js.
//
// terrain   the height grid of a tile, or of the whole region at the overview tier
// ground    water, roads, land cover and bridge decks as meshes laid on the terrain
// ribbon    thin strips for the overview tier: main roads, railways, canals
// boxes     the overview tier's buildings: one box per 50 m cell
// buildings the district tier's buildings: walls and roofs of real outlines
import { CLASS, FULLSCREEN_VS, PIXEL, PREFIX, MRT, TABLES } from './shaders.js';
import { CLOUD, CITY_CAMERA, CITY_PIXEL, GRAIN, GROUND_GLSL, ISLAND, NOISE, SEASON, SHADOW } from './city-common.js';

const VERTEX = PREFIX + CITY_CAMERA;
const FRAGMENT = PREFIX + CITY_CAMERA + CITY_PIXEL + TABLES + NOISE + MRT + GROUND_GLSL + ISLAND + GRAIN + CLOUD;
const RECEIVING = FRAGMENT + SHADOW + SEASON;   // for surfaces that take shadows and snow

// A surface with one colour and a flat light: box() of the reference.
const SHADE_SURFACE = /* glsl */`
in vec3 vWorld;
in float vLight;
in float vDepth;
flat in vec4 vLook;   // archetype, wall colour, roof colour, seed
flat in float vTop;   // 1 on an up-facing surface
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vWorld.xy + uCentre.xy, ip)) discard;
  float level = floor(vLight + grainAt(vWorld.xy, 7.0, vLook.w) * 1.3 + (bayerAt(ip) - 0.5) * 0.5);
  int colour = vTop > 0.5 ? int(vLook.z) : int(vLook.y);
  if (vTop > 0.5 && snowed(0.85, vWorld.xy, ip)) colour = uSnowIndex;     // snow on what lies flat
  outColor = vec4(rampOf(colour, clamp(level, 0.0, 4.0)), 1.0);
  outClass = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}
`;

export const CITY_SHADERS = {
  // The height grid as a mesh. Up close, the colour follows the land cover of the terrain cell; at the
  // overview tier it follows the 50 m cells of the overview package, and a built-over cell is shaded as
  // a slab whose steepness comes from how fast the buildings' height changes.
  terrain: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec2 aGrid;      // grid point: x across from the west edge, y up from the south edge
uniform sampler2D uHeights;              // R32F metres, row 0 at the north edge
uniform vec2 uGridSize;
uniform float uCell;                     // metres between grid points
uniform vec2 uOffset;                    // grid origin relative to the camera centre
out vec3 vWorld;
out vec3 vNormal;
out float vDepth;
out vec2 vCell;                         // which terrain cell the fragment is in
float heightAt(ivec2 g) {
  g = clamp(g, ivec2(0), ivec2(uGridSize) - 1);
  return texelFetch(uHeights, ivec2(g.x, int(uGridSize.y) - 1 - g.y), 0).r;
}
void main() {
  ivec2 g = ivec2(aGrid);
  vWorld = vec3(aGrid * uCell + uOffset, heightAt(g));
  float dx = heightAt(g + ivec2(1, 0)) - heightAt(g - ivec2(1, 0));
  float dy = heightAt(g + ivec2(0, 1)) - heightAt(g - ivec2(0, 1));
  vNormal = normalize(vec3(-dx, -dy, 2.0 * uCell));
  vCell = aGrid - 0.5;
  vec3 s = project(vWorld);
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: RECEIVING + /* glsl */`
uniform sampler2D uBase;      // R8: the ground class of each terrain cell, row 0 at the north
uniform float uCells;        // terrain cells along a side of a tile
uniform float uFar;          // 1 at the overview tier
uniform sampler2D uCover;    // R8: ground class per overview cell, rows from the north
uniform sampler2D uBuilt;    // RG8: how much of an overview cell is built over, and how tall
uniform vec4 uCoverGrid;     // west edge, south edge, cell size, 0
uniform vec3 uCity;          // palette indices of built-over ground at the overview: low, high, tall
in vec3 vWorld;
in vec3 vNormal;
in float vDepth;
in vec2 vCell;
void main() {
  ivec2 ip = pixelIndex();
  vec2 world = vWorld.xy + uCentre.xy;
  if (!onIsland(world, ip)) discard;
  vec3 look = normalize(vNormal);
  int cls = 0;
  int builtTone = -1;
  if (uFar > 0.5) {
    ivec2 size = textureSize(uCover, 0);
    vec2 cell = (world - uCoverGrid.xy) / uCoverGrid.z;
    ivec2 c = ivec2(floor(cell));
    if (c.x < 0 || c.y < 0 || c.x >= size.x || c.y >= size.y) discard;
    c.y = size.y - 1 - c.y;
    cls = int(texelFetch(uCover, c, 0).r * 255.0 + 0.5);
    vec2 built = texelFetch(uBuilt, c, 0).rg * 255.0;
    if (built.x > 5.0 && cls == URBAN) {
      // a slab: steeper where the height changes faster from cell to cell
      float hx = texelFetch(uBuilt, c + ivec2(1, 0), 0).g - texelFetch(uBuilt, c - ivec2(1, 0), 0).g;
      float hy = texelFetch(uBuilt, c + ivec2(0, 1), 0).g - texelFetch(uBuilt, c - ivec2(0, 1), 0).g;
      look = normalize(vec3(-hx * 0.35, hy * 0.35, 1.0));
      builtTone = built.y > 150.0 ? 2 : (built.y > 60.0 ? 1 : 0);
    }
  } else {
    ivec2 cell = ivec2(clamp(floor(vCell), vec2(0.0), vec2(uCells - 1.0)));
    cls = int(texelFetch(uBase, ivec2(cell.x, int(uCells) - 1 - cell.y), 0).r * 255.0 + 0.5);
  }
  float cx = look.x * uCentre.z - look.y * uCentre.w, cy = look.x * uCentre.w + look.y * uCentre.z;
  float toward = (cy - cx) * 0.7071067811865476;              // the horizontal part of the normal, towards the light
  float light = 2.9 + 0.5 * look.z + 0.6 * toward;
  int colour = builtTone >= 0 ? (builtTone == 2 ? int(uCity.z) : (builtTone == 1 ? int(uCity.y) : int(uCity.x))) : uGroundPal[cls];
  if (1.0 - look.z > 0.45 && builtTone < 0) colour = uGroundPal[19];   // rock on the cliffs
  float mottle = noiseAt(world * 0.012) - 0.5;                 // about 80 m across
  float level = floor(light + mottle * 1.2 + grainAt(world, 5.0, 0.0) * 0.8 - cloudShade(world, ip) + (bayerAt(ip) - 0.5) * 0.7);
  vec3 color = rampOf(colour, clamp(level, 0.0, 4.0));
  if (snowed(SNOWED[cls], world, ip)) color = rampOf(uSnowIndex, clamp(light, 2.5, 4.0));
  if (inSun(vWorld) < 0.5) color = inShade(color);
  outColor = vec4(color, 1.0);
  outClass = vec4(1.0, float(cls) / 255.0, 0.0, 1.0);   // the ground class travels with the pixel: the seams pass reads it
  gl_FragDepth = depthOf(vDepth);
}`,
  },

  // Water, roads, land cover and bridge decks, laid on the terrain. Each class has its own surface.
  ground: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec3 aPos;       // metres relative to the tile's corner
layout(location = 1) in float aClass;
layout(location = 2) in float aSeed;
uniform vec2 uOffset;                    // tile corner relative to the camera centre
out vec3 vPlace;                         // the same point in world metres, for the edge of the island
out vec3 vSpot;                          // and relative to the camera centre, for the shadow map
out float vDepth;
flat out float vClass;
flat out float vSeed;
void main() {
  vec3 world = vec3(aPos.xy + uOffset, aPos.z);
  vPlace = vec3(aPos.xy + uOffset + uCentre.xy, aPos.z);
  vSpot = world;
  vClass = aClass;
  vSeed = aSeed;
  vec3 s = project(world);
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: RECEIVING + /* glsl */`
in vec3 vPlace;
in vec3 vSpot;
in float vDepth;
flat in float vClass;
flat in float vSeed;
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vPlace.xy, ip)) discard;
  float bayer = bayerAt(ip);
  float level;
  if (vClass < 4.5) {
    // water: broad bands of tone, and bright streaks that drift along the body
    float along = vClass == 2.0 ? vPlace.x : vPlace.y;      // the great river runs east, canals and lakes run north
    float across = vClass == 2.0 ? vPlace.y : vPlace.x;
    float bands = noiseAt(vPlace.xy * 0.0045);
    float streak = noiseAt(vec2(across * 0.30 + sin(along * 0.012 + uTime * 0.22) * 3.0, along * 0.011 - uTime * 0.10));
    level = floor(2.3 + (bands - 0.5) * 2.0 + (bayer - 0.5) * 0.8);
    // a few bright streaks, as the reference has them on its river: one pixel in a hundred from far out, one in ten close up
    if (streak > 0.99 - 0.09 * clamp(uTilt.z / 4.0, 0.0, 1.0)) level = 4.0;
  } else if (vClass < 10.5) {
    // roads and paths: a quiet, grainy surface; main roads a shade darker. Wide patches of tone (about
    // eighty metres across) keep a street in shade from reading as one flat field; and once a metre is
    // near a pixel, repairs and manholes spot the carriageway.
    level = 3.0 - (vClass == 5.0 ? 0.3 : 0.0) + (noiseAt(vPlace.xy * 0.013) - 0.5) * 0.7
      + grainAt(vPlace.xy, 6.0, vSeed) * 1.1 + (bayer - 0.5) * 0.6;
    float close = clamp((uTilt.z - 0.6) / 1.2, 0.0, 1.0);
    if (close > 0.0 && vClass >= 4.5 && vClass <= 8.5) {
      vec2 cell = floor(vPlace.xy / 14.0);
      float r = hashAt(cell + vSeed);
      vec2 spot = (cell + 0.15 + 0.7 * vec2(hashAt(cell + 1.7), hashAt(cell + 9.3))) * 14.0;
      float d = distance(vPlace.xy, spot);
      float dark = 0.0;
      if (r < 0.10) dark = d < 0.55 ? 1.2 : (d < 0.75 ? 0.4 : 0.0);   // a manhole, and the rim around it
      else if (r < 0.30) {                                            // a patch of newer asphalt, its edge torn by the dither
        float blob = d / (1.4 + 1.8 * hashAt(cell + 3.1)) + (noiseAt(vPlace.xy * 0.9) - 0.5) * 0.55;
        if (blob < 1.0 - (bayer - 0.5) * 0.4) dark = 0.8;
      }
      level -= dark * close;
    }
    if (uRain > 0.5) {
      // 湿路：水膜把颜色压深一档，膜里偶尔有一点反光
      level -= 0.7;
      if (hashAt(vPlace.xy * 0.7) > 0.985) level += 1.6;
    }
    level = floor(level);
  } else if (vClass == 14.0) {
    // grass: the mottled lawn of the reference, its clumps kept to a few pixels across at every zoom
    float clumps = noiseAt(vPlace.xy * min(0.5, uTilt.z / 6.0)) * 1.15 - 0.08;
    float specks = (hashAt(vec2(ip)) - 0.5) * 0.55 * clamp((uTilt.z - 1.5) / 2.0, 0.0, 1.0);
    float fine = (grainAt(vPlace.xy, 3.0, vSeed) - 0.5) * 1.1 * clamp((3.0 - uTilt.z) / 2.0, 0.0, 1.0);   // a grain of three pixels until specks take over
    level = floor((clumps + specks) * 4.2 + fine);
  } else if (vClass == 15.0) {
    // the floor of a wood: dark and dappled
    level = floor(1.9 + (noiseAt(vPlace.xy * min(0.3, uTilt.z / 9.0)) - 0.5) * 1.7 + (bayer - 0.5) * 0.8);
  } else if (vClass == 16.0) {
    // farmland: furrows about seven metres apart, fading out before they get too fine to see
    float fade = clamp((7.0 * uTilt.z - 3.0) / 3.0, 0.0, 1.0);
    float row = floor((vPlace.x * 0.83 + vPlace.y * 0.55) / 7.0);
    level = floor(2.7 + mod(row, 2.0) * 0.9 * fade + grainAt(vPlace.xy, 9.0, vSeed) * 0.6 + (bayer - 0.5) * 0.5);
  } else if (vClass == 24.0) {
    // tea: bushes in rows about a metre and a half apart, winding with the slope; far out they are one tone
    float row = fract((vPlace.x * 0.83 + vPlace.y * 0.55 + noiseAt(vPlace.xy * 0.02) * 5.0) / 1.6);
    level = floor(3.2 + row * 1.2 * clamp(uTilt.z / 1.2, 0.0, 1.0) + grainAt(vPlace.xy, 6.0, vSeed) * 0.7 + (bayer - 0.5) * 0.6);
  } else if (vClass == 12.0) {
    // the wall of a bridge: a flat, shaded tone
    level = floor(1.9 + grainAt(vPlace.xy, 5.0, 1.0) * 0.8 + (bayer - 0.5) * 0.5);
  } else {
    // paving, yards, sand, rock, wetland, pitches, urban ground
    level = floor(3.0 + grainAt(vPlace.xy, 7.0, vSeed) * 1.2 + (grainAt(vPlace.xy, 3.0, vSeed) - 0.5) * 0.8 + (bayer - 0.5) * 0.6);
    if (vClass == 22.0 || vClass == 13.0) {
      // paving seams every five metres, once that is wide enough to draw
      float fade = clamp((5.0 * uTilt.z - 12.0) / 12.0, 0.0, 1.0);
      float seam = step(0.035, fract(vPlace.x / 5.0)) * step(0.035, fract(vPlace.y / 5.0));
      level -= (1.0 - seam) * 0.7 * fade;
    }
  }
  level -= cloudShade(vPlace.xy, ip);
  vec3 color = rampOf(uGroundPal[int(vClass)], clamp(level, 0.0, 4.0));
  if (snowed(SNOWED[int(vClass)], vPlace.xy, ip)) color = rampOf(uSnowIndex, clamp(level, 2.5, 4.0));
  if (inSun(vSpot) < 0.5) color = inShade(color);
  outColor = vec4(color, 1.0);
  outClass = vec4(1.0, vClass / 255.0, 0.0, 1.0);   // the ground class travels with the pixel: the seams pass reads it
  gl_FragDepth = depthOf(vDepth);
}`,
  },

  // Strips for the overview tier. Whatever their width on the ground, they are never thinner on the
  // screen than one pixel, so a canal stays visible from the far side of the city.
  ribbon: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec4 aPosSide;   // x, y, z, lateral (-1 or 1)
layout(location = 1) in vec4 aWide;      // half width in metres, class, direction x, direction y
uniform vec2 uOffset;                    // world origin relative to the camera centre
uniform float uMinPx;                    // the narrowest a strip may be on the screen
out vec3 vPlace;
out float vDepth;
flat out float vClass;
void main() {
  vec3 world = vec3(aPosSide.xy + uOffset, aPosSide.z);
  vec3 s = project(world);
  vec2 along = project(vec3(world.xy + aWide.zw, world.z)).xy - s.xy;
  float len = length(along);
  vec2 side = len > 1e-5 ? vec2(-along.y, along.x) / len : vec2(1.0, 0.0);
  float halfWidth = max(aWide.x * uTilt.z, uMinPx * 0.5);   // never thinner on the screen than uMinPx
  s.xy += side * aPosSide.w * halfWidth;
  vPlace = vec3(aPosSide.xy + uOffset + uCentre.xy, aPosSide.z);
  vClass = aWide.y;
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: FRAGMENT + /* glsl */`
in vec3 vPlace;
in float vDepth;
flat in float vClass;
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vPlace.xy, ip)) discard;
  float level = floor(3.0 + grainAt(vPlace.xy, 6.0, 0.0) * 1.0 + (bayerAt(ip) - 0.5) * 0.5);
  outColor = vec4(rampOf(uGroundPal[int(vClass)], clamp(level, 0.0, 4.0)), 1.0);
  outClass = vec4(1.0, vClass / 255.0, 0.0, 1.0);   // the ground class travels with the pixel: the seams pass reads it
  gl_FragDepth = depthOf(vDepth);
}`,
  },

  // The overview tier's buildings: one box per 50 m cell, instanced.
  boxes: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec3 aCorner;    // unit box: x and y in {-1, 1}, z in {0, 1}
layout(location = 1) in vec2 aNormal;    // outward normal of the face; (0, 0) on the top
layout(location = 2) in vec4 aPlace;     // per instance: centre x, y; base; height, in world metres
layout(location = 3) in vec4 aLook;      // per instance: archetype, wall colour, roof colour, seed
uniform vec2 uOffset;                    // world origin relative to the camera centre
uniform float uHalf;                     // half the width of a cell
out vec3 vWorld;
out float vLight;
out float vDepth;
flat out vec4 vLook;
flat out float vTop;
void main() {
  vec3 world = vec3(aPlace.xy + aCorner.xy * uHalf + uOffset, aPlace.z + aCorner.z * aPlace.w);
  vWorld = world;
  vLight = faceLight(aNormal);
  vLook = aLook;
  vTop = aNormal == vec2(0.0) ? 1.0 : 0.0;
  vec3 s = project(world);
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: FRAGMENT + SEASON + SHADE_SURFACE,
  },

  // What stands on flat roofs: boxes drawn as instances (the unit box is bound at location 0).
  roofBoxes: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec3 aCorner;    // unit box: x and y in {-1, 1}, z in {0, 1}
layout(location = 1) in vec2 aNormal;    // outward normal of the face; (0, 0) on the top
layout(location = 2) in vec4 aPlace;     // per instance: centre x, y relative to the tile; base; height
layout(location = 3) in vec4 aLook;      // per instance: half width, half depth, wall colour, roof colour
uniform vec2 uOffset;                    // tile corner relative to the camera centre
out vec3 vWorld;
out float vLight;
out float vDepth;
flat out vec4 vLook;
flat out float vTop;
void main() {
  vec3 world = vec3(aPlace.xy + aCorner.xy * aLook.xy + uOffset, aPlace.z + aCorner.z * aPlace.w);
  vWorld = world;
  vLight = faceLight(aNormal);
  vLook = vec4(aLook.zw, 0.0, 0.0);
  vTop = aNormal == vec2(0.0) ? 1.0 : 0.0;
  vec3 s = project(world);
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: FRAGMENT + SEASON + SHADE_SURFACE,
  },

  // The district tier's buildings: walls and roofs of real outlines. Far out a wall is one flat tone and
  // a roof another; from a pixel under half a metre (uDetail 1) a wall shows its storeys and window bays
  // in the manner of its archetype, a pitched roof its courses of tiles.
  buildings: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec3 aPos;       // metres relative to the tile's corner
layout(location = 1) in vec2 aNormal;    // outward normal of a wall; the level part of it for a sloped roof; (0, 0) on a flat roof
layout(location = 2) in float aBuilding;
uniform sampler2D uProps;                // 9 floats per building: base, height, levels, archetype, roof, wall, roofColour, seed, flags
uniform vec2 uOffset;                    // tile corner relative to the camera centre
uniform float uLift;                     // added to every height: for a landmark, the height of the ground it stands on
out vec3 vWorld;                         // relative to the camera centre
out vec4 vLook;                          // archetype, wall colour, roof colour, seed
out float vBuilding;                     // which building of the tile this wall belongs to
out float vGround;                       // its ground floor's use: 1 when the bake read shops there
out vec4 vSize;                          // base, eave, height of a storey, spare
out vec3 vFace;                          // metres along the wall, share of the normal that faces up, spare
out float vLight;
out float vDepth;
// the properties are nine floats per building, one texel each, in a one-channel texture: a texelFetch
// gives back (value, 0, 0, 1), so each is read on its own. (Read as vec4s, every wall came out the first
// colour of the table and every roof the second, and a storey was one metre high.)
float prop(int b, int c) { return texelFetch(uProps, ivec2(c, b), 0).r; }
void main() {
  int b = int(aBuilding + 0.5);
  if (prop(b, 8) >= 32.0) {                                // flagged as cleared: a landmark built by hand stands here instead
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float base = prop(b, 0), height = prop(b, 1), levels = max(prop(b, 2), 1.0);
  vec3 world = vec3(aPos.xy + uOffset, aPos.z + uLift);
  vWorld = world;
  vLight = faceLight(aNormal);
  vLook = vec4(prop(b, 3), prop(b, 5), prop(b, 6), prop(b, 7));      // archetype, wall colour, roof colour, seed
  vBuilding = float(b);
  vGround = prop(b, 10) * step(11.0, float(textureSize(uProps, 0).x));   // 一层是不是铺面；手搭地标是九列，读 0
  vSize = vec4(base, base + height, height / levels, 0.0);            // base, eave, height of a storey
  vFace = vec3(dot(aPos.xy, vec2(-aNormal.y, aNormal.x)), sqrt(max(0.0, 1.0 - dot(aNormal, aNormal))), 0.0);
  vec3 s = project(world);
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: FRAGMENT + SHADOW + SEASON + /* glsl */`
uniform float uDetail;                  // 0 far out, 1 once a pixel is under half a metre
uniform float uMid;                      // 1 once a pixel is under two metres: the ribs of great roofs
uniform int uWindow;                    // the palette index of window glass, of wood, of temple red
uniform int uWood;
uniform int uRed;
uniform int uAwning;                    // of the first of three awning colours (green, red, blue, consecutive)
uniform float uLift;                    // what the vertex shader raised the model by (a landmark on its ground)
uniform float uNight;                   // 0 by day, 1 in the small hours: some windows answer it with light
uniform int uWindowLit;                 // the palette index of lit glass (never tinted by the hour)
uniform int uShutter;                   // the palette index of a shop's roller shutter (closed for the night)
const int JIANGNAN = 1, WALKUP = 2, FARMHOUSE = 3, TOWER = 4, OFFICE = 5, INDUSTRIAL = 6, PUBLIC = 7, TEMPLE = 8, STATION = 9, SHED = 10;
// by archetype: metres between window bays; and where in a bay a window opens (across, up the storey)
const float BAY[10] = float[10](4.2, 3.3, 3.2, 3.0, 1.5, 2.4, 3.6, 4.0, 1.5, 3.0);
const vec4 OPEN[10] = vec4[10](vec4(0.40, 0.58, 0.35, 0.75), vec4(0.28, 0.72, 0.30, 0.82), vec4(0.30, 0.70, 0.32, 0.80), vec4(0.25, 0.75, 0.28, 0.84),
                               vec4(0.10, 0.90, 0.10, 0.94), vec4(0.10, 0.90, 0.60, 0.82), vec4(0.20, 0.80, 0.30, 0.86), vec4(0.36, 0.64, 0.32, 0.78),
                               vec4(0.08, 0.92, 0.08, 0.96), vec4(0.40, 0.60, 0.40, 0.70));
in vec3 vWorld;
in vec4 vLook;
in vec4 vSize;
in vec3 vFace;
in float vLight;
in float vDepth;
in float vBuilding;
in float vGround;
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vWorld.xy + uCentre.xy, ip)) discard;
  float bayer = bayerAt(ip);
  bool roof = vFace.y > 0.6;                               // up-facing enough to be a roof
  int archetype = int(vLook.x + 0.5);
  int colour = roof ? int(vLook.z) : int(vLook.y);
  float level = vLight + grainAt(vWorld.xy, 7.0, vLook.w) * 1.3 - cloudShade(vWorld.xy + uCentre.xy, ip) + (bayer - 0.5) * 0.5;
  if (!roof && vWorld.z - vSize.x - uLift < 0.7) level -= 0.55;   // a wall darkens where it meets the ground
  if (roof && uMid > 0.5 && archetype == STATION) {
    // a great roof, ribbed: the skylight strips of a station hall, every twenty-one metres
    if (fract(vWorld.x / 21.0) < 0.12) level -= 1.2;
  } else if (roof && uMid > 0.5 && archetype == INDUSTRIAL) {
    if (fract(vWorld.x / 12.0) < 0.07) level -= 1.0;                     // the ribs of a factory roof
  }
  if (uDetail > 0.5) {
    if (roof && vFace.y < 0.98) {
      // courses of tiles up a pitched roof: a dark line every 35 cm of rise, a joint every 30 cm along the eave
      if (fract((vWorld.z - vSize.y) / 0.35) < 0.22) level -= 1.0;
      if (fract(vFace.x / 0.3) < 0.08) level -= 0.5;
    } else if (!roof && archetype >= 1 && archetype <= 10) {
      // a wall: storeys and window bays
      float storeys = (vWorld.z - vSize.x) / max(vSize.z, 2.0);
      float up = fract(storeys);
      float bay = fract(vFace.x / BAY[archetype - 1] + vLook.w);
      vec4 open = OPEN[archetype - 1];
      if (archetype == OFFICE || archetype == STATION) {
        // a curtain wall: glass between mullions on every storey
        bool glass = bay > open.x && bay < open.y && up > open.z && up < open.w;
        level += glass ? -1.0 : 0.8;
        if (!glass && up < 0.1) level -= 0.5;                                   // the slab line in the spandrel
        // at night a whole floor of offices is at work, or is not, floor by floor
        if (uNight > 0.0 && glass && hashAt(vec2(vLook.w * 7.13, floor(storeys) + float(archetype))) < uNight * 0.45) colour = uWindowLit;
      } else if (archetype == INDUSTRIAL) {
        if (up > open.z && up < open.w && fract(vFace.x / 1.2) > 0.12) colour = uWindow;     // a strip of windows under the eave
        level -= (fract(vFace.x / 0.4) > 0.5 ? 0.35 : 0.0);                                  // corrugated sheeting
      } else if (archetype != SHED) {
        if (bay > open.x && bay < open.y && up > open.z && up < open.w) colour = uWindow;     // a window
        else if (archetype == TOWER && up < 0.07) level -= 1.0;                                 // the line of a floor slab
        else if (archetype == TEMPLE && bay < 0.05) colour = uRed;                              // a column
        else if (bay > open.x - 0.02 && bay < open.y + 0.02 && colour != uWindow) {
          // 窗台与窗楣：窗下一条受光的亮线，窗上一条压暗的框影——窗从此凹进墙里去
          if (up > open.z - 0.055 && up < open.z) level += 0.6;
          else if (up > open.w && up < open.w + 0.05) level -= 0.55;
        }
        // the wall's own material, where no opening has taken the pixel
        bool opening = colour == uWindow || colour == uWood || colour == uRed;
        if (!opening) {
          if (archetype == WALKUP || archetype == PUBLIC) {
            // courses of tile every sixty centimetres, the vertical joints offset half a course a storey
            if (fract((vWorld.z - vSize.x - uLift) / 0.6) < 0.10) level -= 0.6;
            if (fract(vFace.x / 1.2 + floor(storeys) * 0.5) < 0.05) level -= 0.5;
          } else if (archetype == FARMHOUSE) {
            if (fract((vWorld.z - vSize.x - uLift) / 0.28) < 0.14) level -= 0.7;               // a course of brick every 28 cm
          } else if (archetype == TOWER) {
            if (fract(vFace.x / 0.9) < 0.035) level -= 0.4;                                    // a mullion joint every 90 cm
          }
          // 排水管：老住宅的墙上隔两三米一根竖管，按楼的种子落位
          if (archetype == WALKUP || archetype == FARMHOUSE) {
            if (fract(vFace.x / 2.7 + vLook.w * 3.1) < 0.014) level -= 0.5;
          }
          // 女儿墙：平顶楼的顶上一道压顶，最后一层的上缘压暗
          float levelsAll = (vSize.y - vSize.x) / max(vSize.z, 2.0);
          if ((archetype == WALKUP || archetype == TOWER || archetype == PUBLIC || archetype == OFFICE)
            && storeys > levelsAll - 1.0 && up > 0.92) level -= 0.55;
        }
        float bayIndex = floor(vFace.x / BAY[archetype - 1] + vLook.w);
        float inBay = bay;
        if (storeys < 1.0) {
          // 一层按开间分成铺面：每一间自己掷骰——开橱窗、只开门、或者拉下卷帘
          bool shopArch = archetype != TEMPLE;
          float bayRand = hashAt(vec2(vLook.w * 17.31, bayIndex * 3.77 + 1.1));
          float shopChance = vGround >= 1.0 ? 0.86 : 0.58;   // 烘焙认出的一层铺面：底商几乎都开；其余按开间掷骰
          bool shop = shopArch && bayRand < shopChance;
          float bayOpen = hashAt(vec2(vLook.w * 17.31, bayIndex * 3.77 + 2.4));
          if (shop) {
            if (bayOpen < 0.16) {
              // 收了卷帘的铺面：浅灰的横棱，夜里不亮
              if (inBay > 0.10 && inBay < 0.90 && up < 0.72) {
                colour = uShutter;
                level -= fract(up * 12.0) < 0.22 ? 0.8 : 0.0;
              } else if (up >= 0.72 && up < 0.84 && inBay > 0.06 && inBay < 0.94) {
                colour = uAwning + int(hashAt(vec2(vLook.w * 3.1, bayIndex)) * 3.0);
              }
            } else {
              if (inBay > 0.10 && inBay < 0.90 && up > 0.12 && up < 0.66) colour = uWindow;
              else if (inBay >= 0.32 && inBay < 0.52 && up >= 0.66 && up < 0.80) colour = uWood;   // 门
              else if (up >= 0.66 && up < 0.80 && inBay > 0.06 && inBay < 0.94) {
                colour = uAwning + int(hashAt(vec2(vLook.w * 3.1, bayIndex)) * 3.0);               // 雨棚
              }
              // 开着的铺面过去天黑也亮着灯
              if (uNight > 0.0 && colour == uWindow && bayOpen > 0.3) colour = uWindowLit;
            }
          } else {
            // 不是铺面的一层：一扇门，门上一个小雨罩；老住宅门洞上缘压暗
            if (inBay > 0.40 && inBay < 0.56 && up < 0.78) colour = archetype == TEMPLE ? uRed : uWood;
            else if (inBay > 0.36 && inBay < 0.60 && up >= 0.80 && up < 0.88) level -= 0.6;
            else if ((archetype == WALKUP || archetype == FARMHOUSE || archetype == INDUSTRIAL) && up > 0.9) level -= 1.0;
          }
        } else if (storeys < 1.32) {
          // 二层墙脚的招牌带：底下那间是铺面的，就有一道自己的色；夜里亮成灯箱
          bool shopBelow = archetype != TEMPLE && hashAt(vec2(vLook.w * 17.31, bayIndex * 3.77 + 1.1)) < 0.58;
          if (shopBelow && inBay > 0.08 && inBay < 0.92 && up > 0.52) {
            colour = uAwning + int(hashAt(vec2(vLook.w * 3.1, bayIndex)) * 3.0);
            if (uNight > 0.0) colour = uWindowLit;
          }
        } else if (uNight > 0.0 && colour == uWindow) {
          // a home answers the night window by window: a little over half of them at full night
          if (hashAt(vec2(vLook.w * 13.7, floor(storeys) * 3.11 + floor(bay * 4.0))) < uNight * 0.55) colour = uWindowLit;
        }
      }
    }
  }
  if (roof && snowed(vFace.y > 0.97 ? 0.9 : 0.5, vWorld.xy, ip)) colour = uSnowIndex;   // more lies on a flat roof than on a slope
  vec3 color = rampOf(colour, clamp(floor(level), 0.0, 4.0));
  // a wall or a roof in another building's shade takes the tint, the same as the ground does. The bias
  // keeps a sun-facing wall out of its own building's shadow; the shaded sides were dark already.
  if (inSun(vWorld) < 0.5) color = inShade(color);
  outColor = vec4(color, 1.0);
  outClass = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}
`,
  },

  // The walking view's haze: the picture fades into the page's paper with distance, so that the edge
  // where the loaded tiles end is never seen. Fullscreen over the finished picture.
  walkFog: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + /* glsl */`
uniform sampler2D uColor;
uniform sampler2D uDepthTex;            // the resolved depth, 0..1
uniform vec2 uDepth;                    // nearest and farthest engine depth (the walking view: metres ahead)
uniform vec2 uFog;                      // metres ahead where the haze begins, and where it is whole
uniform vec3 uPaper;                    // the colour of the page's paper (white by day, ink at night)
out vec4 outColor;
void main() {
  vec3 color = texelFetch(uColor, ivec2(gl_FragCoord.xy), 0).rgb;
  float z = texelFetch(uDepthTex, ivec2(gl_FragCoord.xy), 0).r;
  float ahead = uDepth.x - z * (uDepth.x - uDepth.y);   // metres from the eye (the walking view's depth)
  float fog = smoothstep(uFog.x, uFog.y, ahead);
  outColor = vec4(mix(color, uPaper, fog), 1.0);
}`,
  },

  // What the streets paint on themselves: centre-line dashes and crossing zebras, worked out from the
  // tile's PATH lines (world/streets.js). Flat quads a hand's width above the road, so they win the depth
  // test against it; they take shadows like the ground does, and are classed as the road they lie on, so
  // the seams pass never draws a line at a marking's edge.
  stripes: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec2 aCorner;    // unit quad, per vertex
layout(location = 1) in vec4 aPlace;     // per instance: x, y, z relative to the tile's corner; heading x
layout(location = 2) in vec4 aShape;     // per instance: heading y, half length, half width, colour
uniform vec2 uOffset;                    // tile corner relative to the camera centre
out vec3 vPlace;                         // the same point in world metres, for the edge of the island
out vec3 vSpot;                          // and relative to the camera centre, for the shadow map
out float vDepth;
flat out float vMark;
void main() {
  vec2 dir = vec2(aPlace.w, aShape.x);
  vec2 along = dir * aCorner.x * aShape.y;
  vec2 across = vec2(-dir.y, dir.x) * aCorner.y * aShape.z;
  vec3 world = vec3(aPlace.xy + along + across + uOffset, aPlace.z);
  vPlace = vec3(aPlace.xy + along + across + uOffset + uCentre.xy, aPlace.z);
  vSpot = world;
  vMark = aShape.w;
  vec3 s = project(world);
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: FRAGMENT + SHADOW + /* glsl */`
in vec3 vPlace;
in vec3 vSpot;
in float vDepth;
flat in float vMark;
void main() {
  ivec2 ip = pixelIndex();
  if (!onIsland(vPlace.xy, ip)) discard;
  vec3 color = rampOf(int(vMark + 0.5), 4.0);   // paint is the brightest thing on the road, shade included
  if (inSun(vSpot) < 0.5) color = inShade(color);
  float cs = cloudShade(vPlace.xy, ip);         // and it pales under the clouds like the road does
  if (cs > 0.0) color = vec3(floor(color.r * 255.0 * (1.0 - cs * 0.5)) / 255.0,
    floor(color.g * 255.0 * (1.0 - cs * 0.5)) / 255.0, floor(color.b * 255.0 * (1.0 - cs * 0.5)) / 255.0);
  outColor = vec4(color, 1.0);
  outClass = vec4(1.0, 5.0 / 255.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}`,
  },

  // The pools the street lamps cast on the ground at night. The page hands over the lamp heads near the
  // camera (world metres relative to the camera centre); each is projected back onto the screen and warms
  // the ground pixels inside its pool, in the engine's own manner: a stepped gain with the Bayer pattern
  // at its edge. Only the ground answers; what stands above it keeps the dark.
  lampLight: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + CITY_CAMERA + CLASS + /* glsl */`
uniform sampler2D uColor;
uniform sampler2D uClass;               // r: ground, g: the ground class of each pixel
uniform vec4 uLamps[64];                // x, y, z of a lamp head, relative to the camera centre
uniform int uLampCount;
uniform float uNight;
out vec4 outColor;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec3 color = texelFetch(uColor, q, 0).rgb;
  outColor = vec4(color, 1.0);
  if (uNight < 0.2) return;
  vec4 cls = texelFetch(uClass, q, 0);
  if (!(isCovered(cls) && isGround(cls))) return;
  vec2 here = vec2(float(q.x) + 0.5, uFrame.y - float(q.y) - 0.5);
  float gain = 0.0;
  for (int k = 0; k < 64; k++) {
    if (k >= uLampCount) break;
    vec3 s = project(uLamps[k].xyz);
    vec2 px = toPixels(s);
    float radius = max(3.5 * pixelsPerMetre(s), 2.0);
    float d = distance(here, px);
    if (d < radius) gain = max(gain, (1.0 - d / radius) * uNight);
  }
  if (gain <= 0.0) return;
  float step = gain > 0.62 ? 1.0 : gain > 0.3 ? 0.62 : 0.34;
  outColor = vec4(floor(color * 255.0 * mix(vec3(1.0), vec3(1.55, 1.40, 0.92), step)) / 255.0, 1.0);
}`,
  },

  // 大气透视：at the far end of the picture the city sinks into the page's paper — the streets, the
  // blocks, the far shore, each by how far it is. Fullscreen over the finished picture, map view only
  // (the walking view has its own fog). The rain thickens it.
  airHaze: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + /* glsl */`
uniform sampler2D uColor;
uniform sampler2D uDepthTex;
uniform vec2 uDepth;                    // nearest and farthest engine depth
uniform vec3 uPaper;
uniform float uHaze;
out vec4 outColor;
void main() {
  vec3 color = texelFetch(uColor, ivec2(gl_FragCoord.xy), 0).rgb;
  float z = texelFetch(uDepthTex, ivec2(gl_FragCoord.xy), 0).r;
  float dist = (uDepth.x - uDepth.y) * z;      // metres of engine depth away from the camera centre
  float haze = smoothstep(1800.0, 6000.0, dist) * uHaze;
  outColor = vec4(mix(color, uPaper, haze), 1.0);
}`,
  },

  // ?sky=1 的天空：岛后面四条色带，带与带之间 Bayer 抖动过渡，夜里洒一点星。屏幕空间就够——
  // 岛的溶解边本来就溶进它后面的东西，现在那后面是天。
  sky: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + 'uniform vec4 uView;\n' + PIXEL + CITY_CAMERA + TABLES + NOISE + CLASS + /* glsl */`
uniform sampler2D uColor;              // the finished picture, for the pixels nothing was drawn on
uniform sampler2D uClass;              // the class buffer: covered pixels keep their colour
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform float uNight;
out vec4 outColor;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec3 color = texelFetch(uColor, q, 0).rgb;
  vec4 cls = texelFetch(uClass, q, 0);
  if (!isCovered(cls)) {
    // nothing was drawn here: the sky takes it, in bands with a dithered seam, stars at night
    float h = float(q.y) / uFrame.y;                     // 0 at the horizon side, 1 at the top
    float band = floor(h * 4.0 + (bayerAt(cpu(q)) - 0.5) * 0.8);
    color = mix(uSkyHorizon, uSkyTop, clamp(band / 4.0, 0.0, 1.0));
    if (uNight > 0.5 && h > 0.3) {
      float r = hashAt(vec2(q) / 2.0 + 41.0);            // a speck in one cell of forty-six
      if (r > 0.9785) color = mix(color, vec3(0.88, 0.90, 1.0), 0.85);
    }
  }
  outColor = vec4(color, 1.0);
}`,
  },

  // The rain: whole-pixel dashes sliding down the frame in steps, in a third of the columns, and only
  // over what is drawn — the paper stays dry. Frozen time holds them where they are for the tests.
  rain: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + NOISE + CLASS + /* glsl */`
uniform sampler2D uColor;
uniform sampler2D uClass;
uniform float uTime;
uniform float uRain;
out vec4 outColor;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec3 color = texelFetch(uColor, q, 0).rgb;
  outColor = vec4(color, 1.0);
  if (uRain < 0.5) return;
  vec4 cls = texelFetch(uClass, q, 0);
  if (!isCovered(cls)) return;                 // the paper keeps dry
  int t = int(uTime * 12.0);
  int col = q.x / 2;
  if (hashAt(vec2(float(col) * 0.123, 7.7)) > 0.5) return;    // not every column carries a drop
  // two streams of dashes with coprime falls, so the eye never finds a lattice in them
  int dy = (q.y + (t * 17 + col * 61 + int(hashAt(vec2(float(col), 3.3)) * 131.0)) % 131) % 131;
  int dy2 = (q.y + (t * 29 + col * 97 + int(hashAt(vec2(float(col), 9.1)) * 173.0)) % 173) % 173;
  bool dash = (dy < 5 && hashAt(vec2(float(col), float(dy) + 1.1)) > 0.35)
    || (dy2 < 4 && hashAt(vec2(float(col) + 2.3, float(dy2) + 5.7)) > 0.5);
  if (!dash) return;
  outColor = vec4(mix(color, vec3(0.86, 0.88, 0.92), 0.4), 1.0);
}`,
  },

  // The seams of the ground: where two ground classes meet (kerb between road and pavement, the bank of
  // a water, the edge of a path across grass), the last pixel is darkened a shade, with the Bayer pattern
  // breaking the line into the dither. Only ground meets ground here; where the ground meets what stands
  // on it, the edges pass is already speaking. Fullscreen over the finished ground, before the edges.
  seams: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + 'uniform vec4 uView;\n' + PIXEL + TABLES + CLASS + /* glsl */`
uniform sampler2D uColor;
uniform sampler2D uClass;               // r: ground, g: the ground class of each pixel
uniform float uSnow;
out vec4 outColor;
float classOf(vec4 c) { return floor(c.g * 255.0 + 0.5); }
bool isWater(float k) { return k >= 1.0 && k <= 4.0; }
bool isRoad(float k) { return k >= 5.0 && k <= 10.0; }
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec3 color = texelFetch(uColor, q, 0).rgb;
  outColor = vec4(color, 1.0);
  ivec2 size = textureSize(uClass, 0);
  if (q.x < 1 || q.y < 1 || q.x >= size.x - 1 || q.y >= size.y - 1) return;
  vec4 cls = texelFetch(uClass, q, 0);
  if (!(isCovered(cls) && isGround(cls))) return;
  float here = classOf(cls);
  bool hereWater = isWater(here), hereRoad = isRoad(here);
  bool seam = false, shore = false;
  for (int k = 0; k < 4; k++) {
    ivec2 off = k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1);
    vec4 n = texelFetch(uClass, q + off, 0);
    if (!(isCovered(n) && isGround(n))) continue;   // the island's edge dissolving into white draws no line
    float nc = classOf(n);
    if (nc == here) continue;
    if (hereWater != isWater(nc)) shore = hereWater;   // a water pixel against the land pales: shallow water, foam
    else if (hereRoad != isRoad(nc) && !hereWater && !isWater(nc)) seam = true;
  }
  float speck = bayerAt(cpu(q));
  if (shore) {
    if (speck >= 0.3) outColor = vec4(floor(color * 255.0 * vec3(1.14, 1.12, 1.05)) / 255.0, 1.0);
    return;
  }
  if (!seam || speck < 0.2) return;
  outColor = vec4(floor(color * 255.0 * (uSnow > 0.5 ? 0.92 : 0.84)) / 255.0, 1.0);
}`,
  },
};
