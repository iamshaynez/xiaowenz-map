// The camera of the city: the same orthographic view as pixel-plays' fixed camera, but it turns, tilts,
// zooms and moves. World: metres, x east, y north, z up. `scale` is pixels per metre.
//
// Geometry is projected relative to the camera centre, never from absolute coordinates: at street level a
// kilometre is ten thousand pixels, and single precision would not carry that far.

const SQRT1_2 = Math.SQRT1_2;

export class CityCamera {
  constructor() {
    this.x = 0;                          // centre, world metres
    this.y = 0;
    this.yaw = 0;                        // radians, turns the world clockwise seen from above
    this.pitch = Math.PI / 6;            // 30 degrees down, as the reference
    this.scale = 1;                      // pixels per metre
    this.ss = 2;                         // supersampling of the scene buffers
    this.width = 960;                    // low-resolution frame
    this.height = 540;
  }

  get cos() { return Math.cos(this.yaw); }
  get sin() { return Math.sin(this.yaw); }
  get sinPitch() { return Math.sin(this.pitch); }
  get cosPitch() { return Math.cos(this.pitch); }

  // world metres -> the camera's frame (rotated so that the view axis is diagonal)
  frame(x, y) {
    const dx = x - this.x, dy = y - this.y, c = this.cos, s = this.sin;
    return { rx: dx * c - dy * s, ry: dx * s + dy * c };
  }

  // screen position in the camera's two axes, before the vertical squash: u across, v up the view
  axes(x, y) {
    const { rx, ry } = this.frame(x, y);
    return { u: (rx - ry) * SQRT1_2, v: (rx + ry) * SQRT1_2 };
  }

  // -> { sx, sy } in low-resolution pixels from the top-left corner, and d: engine depth (larger is nearer)
  project(x, y, z) {
    const { u, v } = this.axes(x, y);
    return {
      sx: this.width / 2 + u * this.scale,
      sy: this.height / 2 + (v * this.sinPitch - z * this.cosPitch) * this.scale,
      d: v * this.cosPitch + z * this.sinPitch,
    };
  }

  // the world point that lands on a screen position, at a given height
  unproject(sx, sy, z = 0) {
    return this.unprojectAt(sx, sy, this.scale, z);
  }

  // the same for another zoom, which is how the point under the cursor is kept in place
  unprojectAt(sx, sy, scale, z = 0) {
    const u = (sx - this.width / 2) / scale, v = ((sy - this.height / 2) / scale + z * this.cosPitch) / this.sinPitch;
    const rx = (u + v) * SQRT1_2, ry = (v - u) * SQRT1_2, c = this.cos, s = this.sin;
    return { x: this.x + rx * c + ry * s, y: this.y - rx * s + ry * c };
  }

  // screen position of the world origin, for shaders that project from absolute coordinates
  origin() {
    const { u, v } = this.axes(0, 0);
    return [this.width / 2 - u * this.scale, this.height / 2 - v * this.scale];
  }

  // Engine depth is mapped linearly onto the depth buffer; the range is fitted to what this zoom can see.
  // A screen point at height z lies at v = ((sy - H/2) / scale + z cos(pitch)) / sin(pitch), so the
  // farthest thing is the ground on the top row and the nearest is the top of the tallest building on
  // the bottom row, which is farther along by 1 / sin(pitch) times its height in this measure.
  depthRange(tallest = 420) {
    const ground = this.height / (2 * this.scale * this.sinPitch) * this.cosPitch;   // depth of the ground on the top and bottom rows
    return [ground + tallest / this.sinPitch, -ground];
  }

  // how much the depth changes per pixel row on a flat floor (the reference's GRADIENT_Y)
  get gradientY() { return this.cosPitch / (this.scale * this.sinPitch); }

  // keep the point under a screen position where it is while the zoom changes
  zoomAt(sx, sy, scale) {
    const before = this.unproject(sx, sy);
    const after = this.unprojectAt(sx, sy, scale);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.scale = scale;
  }
}

// The same camera in GLSL. `project` takes metres relative to the camera centre and returns screen
// pixels in the low-resolution frame and engine depth.
export const CITY_CAMERA = /* glsl */`
uniform vec4 uCentre;   // camera centre x, y in world metres; cos(yaw), sin(yaw)
uniform vec4 uTilt;     // sin(pitch), cos(pitch), pixels per metre, supersampling
uniform vec2 uFrame;    // width and height of the low-resolution frame
uniform vec2 uDepth;    // nearest and farthest engine depth

vec3 project(vec3 q) {
  float rx = q.x * uCentre.z - q.y * uCentre.w, ry = q.x * uCentre.w + q.y * uCentre.z;
  float u = (rx - ry) * 0.7071067811865476, v = (rx + ry) * 0.7071067811865476;
  return vec3(uFrame.x * 0.5 + u * uTilt.z, uFrame.y * 0.5 + (v * uTilt.x - q.z * uTilt.y) * uTilt.z, v * uTilt.y + q.z * uTilt.x);
}
float depthOf(float d) { return clamp((uDepth.x - d) / (uDepth.x - uDepth.y), 0.0, 1.0); }
vec4 clip(vec3 s) { return vec4(s.x / uFrame.x * 2.0 - 1.0, 1.0 - s.y / uFrame.y * 2.0, depthOf(s.z), 1.0); }
vec2 unproject(float sx, float sy, float z) {
  float u = (sx - uFrame.x * 0.5) / uTilt.z, v = ((sy - uFrame.y * 0.5) / uTilt.z + z * uTilt.y) / uTilt.x;
  return vec2((u + v) * 0.7071067811865476, (v - u) * 0.7071067811865476);
}

// Light on a face. pixel-plays lights its boxes from the upper left: the top is 3.4, the face turned
// towards the lower left 2.3, the one towards the lower right 1.2. A wall's outward normal, turned into
// the camera's frame, is compared with the direction of the light; (0, 0) means "up".
float faceLight(vec2 n) {
  if (n == vec2(0.0)) return 3.4;
  float cx = n.x * uCentre.z - n.y * uCentre.w, cy = n.x * uCentre.w + n.y * uCentre.z;
  return 1.75 + 0.55 * (cy - cx);
}
`;

// low-resolution pixel of a supersampled fragment, in the reference's top-left indexing
export const CITY_PIXEL = /* glsl */`
ivec2 pixelIndex() { return ivec2(floor(vec2(gl_FragCoord.x, uFrame.y * uTilt.w - gl_FragCoord.y) / uTilt.w)); }
vec2 pixelCentre() { return vec2(pixelIndex()) + 0.5; }
`;
