// Shaders of the city renderer: terrain, the boxes of the overview tier, the building meshes of the
// district tier. The per-pixel passes they feed (resolve, occlusion, edges) are shared with the
// reference engine in shaders.js.
import { PREFIX, TABLES, MRT } from './shaders.js';
import { CITY_CAMERA, CITY_PIXEL } from './city-camera.js';

const VERTEX = PREFIX + CITY_CAMERA;
const FRAGMENT = PREFIX + CITY_CAMERA + CITY_PIXEL + TABLES + MRT;

// Noise is laid out in pixels rather than metres, so that it stays a texture and does not turn into
// speckle when the view is far out or into a flat wash when it is close.
const GRAIN = /* glsl */`
float grainAt(vec2 world, float sizeInPixels, float seed) {
  return noiseL(world * (sizeInPixels / uTilt.z) + seed * 7.31) - 0.5;
}
`;

// A surface with one colour: box() of the reference, with the light taken from the normal.
const SHADE_SURFACE = /* glsl */`
in vec3 vWorld;
in float vLight;
in float vDepth;
flat in vec4 vLook;   // archetype, wall colour, roof colour, seed
flat in float vTop;   // 1 on an up-facing surface
${GRAIN}
void main() {
  ivec2 ip = pixelIndex();
  float level = floor(vLight + grainAt(vWorld.xy, 7.0, vLook.w) * 1.3 + (bayerAt(ip) - 0.5) * 0.5);
  outColor = vec4(rampOf(int(vTop > 0.5 ? vLook.z : vLook.y), clamp(level, 0.0, 4.0)), 1.0);
  outClass = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}
`;

export const CITY_SHADERS = {
  // A height grid drawn as a mesh. Land cover arrives later; for now the colour follows the slope
  // and the height, with the mottling the reference gives its grass.
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
  vec3 s = project(vWorld);
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    fs: FRAGMENT + /* glsl */`
uniform vec3 uGround;                    // palette indices: grass, wood, rock
in vec3 vWorld;
in vec3 vNormal;
in float vDepth;
${GRAIN}
void main() {
  vec3 n = normalize(vNormal);
  float slope = 1.0 - n.z;                                   // 0 on the flat, towards 1 on a cliff
  float cx = n.x * uCentre.z - n.y * uCentre.w, cy = n.x * uCentre.w + n.y * uCentre.z;
  float toward = (cy - cx) * 0.7071067811865476;              // the slope's horizontal part, towards the light
  float light = 2.9 + 0.5 * n.z + 0.6 * toward;
  int colour = int(vWorld.z > 40.0 ? uGround.y : uGround.x);
  if (slope > 0.45) colour = int(uGround.z);
  float mottle = noiseL(vWorld.xy * 0.012) - 0.5;             // about 80 m across
  float level = floor(light + mottle * 1.2 + grainAt(vWorld.xy, 5.0, 0.0) * 0.8 + (bayerAt(pixelIndex()) - 0.5) * 0.7);
  outColor = vec4(rampOf(colour, clamp(level, 0.0, 4.0)), 1.0);
  outClass = vec4(1.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vDepth);
}`,
  },

  // The overview tier: one box per 50 m cell, instanced.
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

  // The district tier: walls and flat roofs of real outlines.
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
