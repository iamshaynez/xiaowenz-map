// For tests only: a landmark's parts in one flat colour, drawn over the frame that was just made, with the
// same projection and the same depth as the buildings' shader wrote for them. So what is in front of a
// landmark can be told from what is behind it, by the depth test the scene left behind.
import { PREFIX, MRT } from './shaders.js';
import { CITY_CAMERA } from './city-camera.js';

export const DEBUG_SHADERS = {
  mask: {
    vs: PREFIX + CITY_CAMERA + /* glsl */`
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec2 aNormal;
layout(location = 2) in float aPart;
uniform vec2 uOffset;          // metres relative to the camera centre
uniform float uLift;
out float vDepth;
void main() {
  vec3 s = project(vec3(aPos.xy + uOffset, aPos.z + uLift));
  vDepth = s.z;
  gl_Position = clip(s);
}`,
    // both outputs of the scene's buffers are written, as every shader drawn into them must: a shader that
    // leaves one of the enabled draw buffers unwritten is refused (INVALID_OPERATION) by Chrome
    fs: PREFIX + CITY_CAMERA + MRT + /* glsl */`
in float vDepth;
uniform float uMode;         // 0: flat colour; 1: the depth of the part packed into the colour
void main() {
  float z = depthOf(vDepth);
  if (uMode > 0.5) {
    float packed = floor(z * 16777215.0);
    outColor = vec4(floor(packed / 65536.0), floor(mod(packed, 65536.0) / 256.0), mod(packed, 256.0), 255.0) / 255.0;
  } else outColor = vec4(1.0, 0.0, 1.0, 1.0);
  outClass = vec4(0.0);
  gl_FragDepth = z;
}`,
  },
};
