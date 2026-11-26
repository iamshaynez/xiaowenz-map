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
    this.yaw = 0;                        // radians; increasing it turns the world counter-clockwise seen from above
    this.pitch = Math.PI / 6;            // 30 degrees down, as the reference
    this.scale = 1;                      // pixels per metre
    this.ss = 2;                         // supersampling of the scene buffers
    this.width = 960;                    // low-resolution frame
    this.height = 540;
    // Walking: the camera is a perspective eye at (x, y, eyeZ), looking along yaw and down by pitch.
    // scale keeps its map meaning nowhere; the shaders take the eye from uWalk instead.
    this.walking = false;
    this.eyeZ = 0;                       // the eye's height above the map's zero
    this.fov = 0.45;                     // tan of half the vertical field of view
    this.near = 0.6;                     // metres
    this.far = 1500;
    this.textureScale = 22;              // pixels per metre for the close-in textures while walking
  }

  // the direction on the ground that runs up the screen, and the one that runs to the right: unit vectors.
  // Up the screen is the ground direction that increases v ((c+s, c−s)/√2), right the one that increases
  // u ((c−s, −(c+s))/√2) — read both off the projection, not off the forward vector, or the right one
  // comes out mirrored everywhere but at yaw 0
  walkForward() {
    const k = Math.SQRT1_2, c = this.cos, s = this.sin;
    return { x: (c + s) * k, y: (c - s) * k };
  }

  walkRight() {
    const k = Math.SQRT1_2, c = this.cos, s = this.sin;
    return { x: (c - s) * k, y: -(c + s) * k };
  }

  // where the eye stands (walking), for the shaders and the tile arithmetic
  eye() {
    return { x: this.x, y: this.y, z: this.eyeZ };
  }

  // the yaw that looks along a world direction (x, y)
  static yawOf(x, y) {
    const k = Math.SQRT1_2;
    return Math.atan2((x - y) * k, (x + y) * k);
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
    return this.about(this.x, this.y, x, y);
  }

  // the same, about any centre (cx, cy) of the world: for measuring what a flight has to hold, before the camera moves
  about(cx, cy, x, y) {
    const dx = x - cx, dy = y - cy, c = this.cos, s = this.sin;
    const rx = dx * c - dy * s, ry = dx * s + dy * c;
    return { u: (rx - ry) * SQRT1_2, v: (rx + ry) * SQRT1_2 };
  }

  // -> { sx, sy } in low-resolution pixels from the top-left corner, and d: engine depth (larger is nearer).
  // The ground's v (the camera's far axis, the north-east diagonal at yaw 0) runs UP the page: the farther
  // along it a point stands, the higher on the screen, the way the ground recedes towards the horizon of a
  // tilted view. Heights still rise up the page, and the depth of the far axis runs the other way.
  project(x, y, z) {
    const { u, v } = this.axes(x, y);
    return {
      sx: this.width / 2 + u * this.scale,
      sy: this.height / 2 - (v * this.sinPitch + z * this.cosPitch) * this.scale,
      d: z * this.sinPitch - v * this.cosPitch,
    };
  }

  // the world point that lands on a screen position, at a given height
  unproject(sx, sy, z = 0) {
    return this.unprojectAt(sx, sy, this.scale, z);
  }

  // the same for another zoom, which is how the point under the cursor is kept in place
  unprojectAt(sx, sy, scale, z = 0) {
    const u = (sx - this.width / 2) / scale, v = -(((sy - this.height / 2) / scale + z * this.cosPitch) / this.sinPitch);
    const rx = (u + v) * SQRT1_2, ry = (v - u) * SQRT1_2, c = this.cos, s = this.sin;
    return { x: this.x + rx * c + ry * s, y: this.y - rx * s + ry * c };
  }

  // screen position of the world origin, for shaders that project from absolute coordinates
  origin() {
    const { sx, sy } = this.project(0, 0, 0);
    return [sx, sy];
  }

  // ---- walking view ------------------------------------------------------------------------------------------
  // a world point on the screen (low-resolution pixels) and its metres ahead of the eye; null behind the eye
  projectWalk(x, y, z) {
    const dz = z - this.eyeZ, dx = x - this.x, dy = y - this.y, c = this.cos, s = this.sin;
    const rx = dx * c - dy * s, ry = dx * s + dy * c;
    const u = (rx - ry) * SQRT1_2, v = (rx + ry) * SQRT1_2;
    const ahead = v * this.cosPitch - dz * this.sinPitch;
    if (ahead < this.near) return null;
    const f = this.height / 2 / this.fov, aspect = this.width / this.height;
    return { sx: this.width / 2 + (u / ahead) * f / aspect, sy: this.height / 2 - ((v * this.sinPitch + dz * this.cosPitch) / ahead) * f, ahead };
  }

  // the point on the ground that a screen position looks at (walking): the eye's ray against the map's zero
  unprojectWalk(sx, sy) {
    const nx = (sx - this.width / 2) / (this.width / 2), ny = (this.height / 2 - sy) / (this.height / 2);
    const du = nx * this.fov * (this.width / this.height), dUp = ny * this.fov;
    const dv = this.cosPitch + dUp * this.sinPitch, dz = -this.sinPitch + dUp * this.cosPitch;
    const rx = (du + dv) * SQRT1_2, ry = (dv - du) * SQRT1_2, c = this.cos, s = this.sin;
    const dirX = rx * c + ry * s, dirY = -rx * s + ry * c;
    const t = Math.abs(dz) < 1e-6 ? 1 : -this.eyeZ / dz;
    return { x: this.x + dirX * t, y: this.y + dirY * t, dirX, dirY, dz };
  }

  // Engine depth is mapped linearly onto the depth buffer; the range is fitted to what this zoom can see.
  // A screen point at height z lies at v = -((sy - H/2) / scale + z cos(pitch)) / sin(pitch), so the
  // farthest thing is the ground on the top row and the nearest is the top of the tallest building on
  // the bottom row, which stands sin(pitch) times its height nearer the camera in this measure.
  depthRange(tallest = 420) {
    const ground = this.height / (2 * this.scale * this.sinPitch) * this.cosPitch;   // depth of the ground on the top and bottom rows
    return [ground + tallest * this.sinPitch, -ground];
  }

  // how much the depth changes per pixel row on a flat floor (the reference's GRADIENT_Y)
  get gradientY() { return this.cosPitch / (this.scale * this.sinPitch); }

  // keep the point under a screen position where it is while the zoom changes. `height` is the height of
  // what is drawn there (the ground, a roof, a hill top), so that the thing seen under the cursor stays
  // under the cursor. At height 0 it is the ground point under the cursor that stays, and whatever stands
  // on that ground slides up the page as the zoom comes in: by its height, times the change in zoom.
  zoomAt(sx, sy, scale, height = 0) {
    const before = this.unprojectAt(sx, sy, this.scale, height);
    const after = this.unprojectAt(sx, sy, scale, height);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
    this.scale = scale;
  }

  // the height of the point drawn at a screen position, from its engine depth (what project() returns as d):
  // d = v cos(pitch) + z sin(pitch) and (sy - H/2) / scale = v sin(pitch) - z cos(pitch)
  heightAt(sx, sy, depth) {
    return this.sinPitch * depth - this.cosPitch * ((sy - this.height / 2) / this.scale);
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
  return vec3(uFrame.x * 0.5 + u * uTilt.z, uFrame.y * 0.5 - (v * uTilt.x + q.z * uTilt.y) * uTilt.z, q.z * uTilt.x - v * uTilt.y);
}
float depthOf(float d) { return clamp((uDepth.x - d) / (uDepth.x - uDepth.y), 0.0, 1.0); }
vec4 clip(vec3 s) { return vec4(s.x / uFrame.x * 2.0 - 1.0, 1.0 - s.y / uFrame.y * 2.0, depthOf(s.z), 1.0); }
vec2 unproject(float sx, float sy, float z) {
  float u = (sx - uFrame.x * 0.5) / uTilt.z, v = -(((sy - uFrame.y * 0.5) / uTilt.z + z * uTilt.y) / uTilt.x);
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
