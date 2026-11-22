// What casts shadows: the scene drawn once more from the sun's point of view, depth only.
// Buildings are drawn as they are; trees as discs facing the sun, as wide as their crowns, so that a
// tree's shadow is the circle the reference's castShadow() stamps. What receives shadows is in
// city-common.js (SHADOW).
import { PREFIX } from './shaders.js';
import { CITY_CAMERA, LIGHT } from './city-common.js';
import { TREE_SPECIES } from './shaders-trees.js';

const EMPTY = PREFIX + /* glsl */`void main() {}`;
const RECORD = /* glsl */`
layout(location = 0) in vec2 aCorner;   // the unit square
layout(location = 1) in vec3 aTree;     // x, y relative to the tile's corner; z
layout(location = 2) in vec4 aLook;     // bytes: species, crown radius in half-metres, seed, kind
uniform vec2 uOffset;                   // tile corner relative to the camera centre
`;

export const SHADOW_SHADERS = {
  shadowBuildings: {
    vs: PREFIX + CITY_CAMERA + LIGHT + /* glsl */`
layout(location = 0) in vec3 aPos;
layout(location = 2) in float aBuilding;       // metres relative to the tile's corner
uniform sampler2D uProps;                // 9 floats per building, as for the buildings' shader
uniform vec2 uOffset;                    // tile corner relative to the camera centre
uniform float uLift;
void main() {
  if (texelFetch(uProps, ivec2(8, int(aBuilding + 0.5)), 0).r >= 32.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // cleared for a landmark
  gl_Position = toLight(vec3(aPos.xy + uOffset, aPos.z + uLift));
}`,
    fs: EMPTY,
  },

  shadowBoxes: {
    vs: PREFIX + CITY_CAMERA + LIGHT + /* glsl */`
layout(location = 0) in vec3 aCorner;    // unit box
layout(location = 2) in vec4 aPlace;     // per instance: centre x, y relative to the tile; base; height
layout(location = 3) in vec4 aLook;      // per instance: half width, half depth, and two unused
uniform vec2 uOffset;                    // tile corner relative to the camera centre
void main() {
  gl_Position = toLight(vec3(aPlace.xy + aCorner.xy * aLook.xy + uOffset, aPlace.z + aCorner.z * aPlace.w));
}`,
    fs: EMPTY,
  },

  shadowTrees: {
    vs: PREFIX + CITY_CAMERA + LIGHT + RECORD + TREE_SPECIES + /* glsl */`
uniform float uDetail;                  // 1 when the tree is large on the screen
out vec2 vDisc;
void main() {
  float radius = aLook.y * 0.5;
  int species = int(aLook.x + 0.5);
  vec3 centre = vec3(aTree.xy + uOffset, aTree.z + radius * LIFT[species] * (1.0 + 0.3 * uDetail));
  vec4 place = toLight(centre);
  // a disc the size of the crown, square to the sun: its radius is so many texels of the picture
  place.xy += aCorner * radius * SHAPE[species].x * uShadowBox.zw * 2.0;
  vDisc = aCorner;
  gl_Position = place;
}`,
    fs: PREFIX + /* glsl */`
in vec2 vDisc;
void main() {
  if (dot(vDisc, vDisc) > 1.0) discard;
}`,
  },
};
