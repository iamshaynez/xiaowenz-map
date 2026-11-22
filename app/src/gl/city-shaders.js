// Shaders of the city renderer. The per-pixel passes they feed (resolve, occlusion, edges) are shared
// with the reference engine in shaders.js; trees are in shaders-trees.js and shadows in shaders-post.js.
//
// terrain   the height grid of a tile, or of the whole region at the overview tier
// ground    water, roads, land cover and bridge decks as meshes laid on the terrain
// ribbon    thin strips for the overview tier: main roads, railways, canals
// boxes     the overview tier's buildings: one box per 50 m cell
// buildings the district tier's buildings: walls and roofs of real outlines
import { PREFIX, MRT, TABLES } from './shaders.js';
import { CITY_CAMERA, CITY_PIXEL, GRAIN, GROUND_GLSL, ISLAND, NOISE, SHADOW } from './city-common.js';

const VERTEX = PREFIX + CITY_CAMERA;
const FRAGMENT = PREFIX + CITY_CAMERA + CITY_PIXEL + TABLES + NOISE + MRT + GROUND_GLSL + ISLAND + GRAIN;
const RECEIVING = FRAGMENT + SHADOW;   // for surfaces that take shadows

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
  outColor = vec4(rampOf(int(vTop > 0.5 ? vLook.z : vLook.y), clamp(level, 0.0, 4.0)), 1.0);
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
  float level = floor(light + mottle * 1.2 + grainAt(world, 5.0, 0.0) * 0.8 + (bayerAt(ip) - 0.5) * 0.7);
  vec3 color = rampOf(colour, clamp(level, 0.0, 4.0));
  if (inSun(vWorld) < 0.5) color = inShade(color);
  outColor = vec4(color, 1.0);
  outClass = vec4(1.0, 0.0, 0.0, 1.0);
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
    if (streak > 0.84) level = 4.0;
  } else if (vClass < 10.5) {
    // roads and paths: a quiet, grainy surface; main roads a shade darker
    level = floor(3.0 - (vClass == 5.0 ? 0.3 : 0.0) + grainAt(vPlace.xy, 6.0, vSeed) * 1.1 + (bayer - 0.5) * 0.6);
  } else if (vClass == 14.0) {
    // grass: the mottled lawn of the reference, its clumps kept to a few pixels across at every zoom
    float clumps = noiseAt(vPlace.xy * min(0.5, uTilt.z / 6.0)) * 1.15 - 0.08;
    float specks = (hashAt(vec2(ip)) - 0.5) * 0.55 * clamp((uTilt.z - 1.5) / 2.0, 0.0, 1.0);
    level = floor((clumps + specks) * 4.2);
  } else if (vClass == 15.0) {
    // the floor of a wood: dark and dappled
    level = floor(1.9 + (noiseAt(vPlace.xy * min(0.3, uTilt.z / 9.0)) - 0.5) * 1.7 + (bayer - 0.5) * 0.8);
  } else if (vClass == 16.0) {
    // farmland: furrows about seven metres apart, fading out before they get too fine to see
    float fade = clamp((7.0 * uTilt.z - 3.0) / 3.0, 0.0, 1.0);
    float row = floor((vPlace.x * 0.83 + vPlace.y * 0.55) / 7.0);
    level = floor(2.7 + mod(row, 2.0) * 0.9 * fade + grainAt(vPlace.xy, 9.0, vSeed) * 0.6 + (bayer - 0.5) * 0.5);
  } else if (vClass == 12.0) {
    // the wall of a bridge: a flat, shaded tone
    level = floor(1.9 + grainAt(vPlace.xy, 5.0, 1.0) * 0.8 + (bayer - 0.5) * 0.5);
  } else {
    // paving, yards, sand, rock, wetland, pitches, urban ground
    level = floor(3.0 + grainAt(vPlace.xy, 7.0, vSeed) * 1.2 + (bayer - 0.5) * 0.6);
    if (vClass == 22.0 || vClass == 13.0) {
      // paving seams every five metres, once that is wide enough to draw
      float fade = clamp((5.0 * uTilt.z - 12.0) / 12.0, 0.0, 1.0);
      float seam = step(0.035, fract(vPlace.x / 5.0)) * step(0.035, fract(vPlace.y / 5.0));
      level -= (1.0 - seam) * 0.7 * fade;
    }
  }
  vec3 color = rampOf(uGroundPal[int(vClass)], clamp(level, 0.0, 4.0));
  if (inSun(vSpot) < 0.5) color = inShade(color);
  outColor = vec4(color, 1.0);
  bool wet = vClass < 4.5;
  outClass = vec4(1.0, wet ? 2.0 / 255.0 : 0.0, 0.0, 1.0);
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
  outClass = vec4(1.0, 0.0, 0.0, 1.0);
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
    fs: FRAGMENT + SHADE_SURFACE,
  },

  // The district tier's buildings: walls and flat roofs of real outlines.
  buildings: {
    vs: VERTEX + /* glsl */`
layout(location = 0) in vec3 aPos;       // metres relative to the tile's corner
layout(location = 1) in vec2 aNormal;    // outward normal of the wall; (0, 0) on a roof
layout(location = 2) in float aBuilding;
uniform sampler2D uProps;                // 9 floats per building: base, height, levels, archetype, roof, wall, roofColour, seed, flags
uniform vec2 uOffset;                    // tile corner relative to the camera centre
out vec3 vWorld;
out float vLight;
out float vDepth;
flat out vec4 vLook;
flat out float vTop;
void main() {
  int b = int(aBuilding + 0.5);
  vec4 look = texelFetch(uProps, ivec2(3, b), 0);
  vec3 world = vec3(aPos.xy + uOffset, aPos.z);
  vWorld = world;
  vLight = faceLight(aNormal);
  vLook = vec4(look.x, look.z, look.w, texelFetch(uProps, ivec2(7, b), 0).r);
  vTop = aNormal == vec2(0.0) ? 1.0 : 0.0;
  vec3 s = project(world);
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: FRAGMENT + SHADE_SURFACE,
  },
};
