// What every city shader shares: the camera, the pixel a fragment belongs to, the rule that dissolves the
// edge of the floating city into white, and the classes of the ground.
//
// pixel-plays draws one small place floating on pure white, its ragged edge dissolving into the page.
// The city keeps that: it is an island. The same test runs in every shader, on the ground's own position
// under each fragment, so that the ground, the buildings on it, the roads and the trees all dissolve
// together and nothing is left floating at the edge.

// World: metres, x east, y north, z up. `project` takes metres relative to the camera centre and returns
// screen pixels in the low-resolution frame (from the top-left corner) and engine depth (larger is nearer).
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

// Light on a face. pixel-plays lights its boxes from the upper left of the screen: the top is 3.4, the
// face turned towards the lower left 2.3, the one towards the lower right 1.2. A wall's outward normal,
// turned into the camera's frame, is compared with the direction of the light; (0, 0) means "up".
// The light stays where it is on the screen when the city is turned, so shadows always fall to the right.
// The normal comes as its level part: nothing for an up-facing surface, a unit vector for a wall, and for
// a sloped roof as much of one as the slope is steep. The rest of it is the share that faces up.
float faceLight(vec2 n) {
  float cx = n.x * uCentre.z - n.y * uCentre.w, cy = n.x * uCentre.w + n.y * uCentre.z;
  return 1.75 + 0.55 * (cy - cx) + 1.65 * sqrt(max(0.0, 1.0 - dot(n, n)));
}
`;

// The low-resolution pixel a supersampled fragment belongs to, in the reference's top-left indexing.
export const CITY_PIXEL = /* glsl */`
ivec2 pixelIndex() { return ivec2(floor(vec2(gl_FragCoord.x, uFrame.y * uTilt.w - gl_FragCoord.y) / uTilt.w)); }
vec2 pixelCentre() { return vec2(pixelIndex()) + 0.5; }
`;

// Noise over the whole map. The reference's hash is read from a table that covers the corner of the world
// its own scene stands in; the city is forty kilometres wide and its noise is laid out in pixels, so the
// lattice points run into the millions. So the city hashes the lattice point itself, with whole numbers:
// not the reference's values, but the same kind of scatter, and the same everywhere.
export const NOISE = /* glsl */`
float hashAt(vec2 p) {
  ivec2 i = ivec2(floor(p));
  uint h = uint(i.x) * 0x9e3779b1u + uint(i.y) * 0x85ebca77u;
  h ^= h >> 15u;
  h *= 0x2545f491u;
  h ^= h >> 13u;
  return float(h) * (1.0 / 4294967295.0);
}
float noiseAt(vec2 p) {
  vec2 i = floor(p), f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashAt(i), hashAt(i + vec2(1.0, 0.0)), f.x), mix(hashAt(i + vec2(0.0, 1.0)), hashAt(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

// Noise is laid out in pixels rather than metres, so that it stays a texture and does not turn into
// speckle when the view is far out or into a flat wash when it is close.
// Needs NOISE.
export const GRAIN = /* glsl */`
float grainAt(vec2 world, float sizeInPixels, float seed) {
  return noiseAt(world * (sizeInPixels / uTilt.z) + seed * 7.31) - 0.5;
}
`;

// The island. Its outline is the region itself: a rectangle of longitude and latitude, which stands on
// the ground as a rectangle turned a little (index.json's "island" says how much), its corners rounded.
// A band along the edge is broken up by noise and scattered away with the Bayer pattern, the way
// groundColor() in the reference scatters its own fringe.


// Needs NOISE.
export const ISLAND = /* glsl */`
uniform vec4 uIsland;   // centre x, centre y, half-width, half-height, all in world metres
uniform vec4 uIsland2;  // the region's east axis (x, y), corner radius, width of the band that dissolves

bool onIsland(vec2 world, ivec2 pixel) {
  vec2 d = world - uIsland.xy;
  vec2 local = vec2(d.x * uIsland2.x + d.y * uIsland2.y, -d.x * uIsland2.y + d.y * uIsland2.x);
  // the distance to a rounded rectangle, negative inside
  vec2 corner = abs(local) - (uIsland.zw - uIsland2.z);
  float distanceToEdge = length(max(corner, vec2(0.0))) + min(max(corner.x, corner.y), 0.0) - uIsland2.z;
  float ragged = (noiseAt(world * 0.00042) - 0.5) * 0.8;               // lobes about two kilometres across
  ragged += smoothstep(0.55, 0.85, noiseAt(world * 0.00013 + 31.0)) * 0.9;   // and a few large bites
  float rough = 1.0 + distanceToEdge / uIsland2.w + ragged;
  if (rough > 1.04) return false;
  return rough <= 0.93 || bayerAt(pixel) >= (rough - 0.93) / 0.11;
}
`;

// Ground classes; the numbers are those of pipeline/pixelcity/ground.py and reach the app through index.json.
export const GROUND_CLASSES = {
  WATER_LAKE: 1, WATER_RIVER: 2, WATER_CANAL: 3, WATER_POND: 4,
  ROAD_MAJOR: 5, ROAD_SECONDARY: 6, ROAD_MINOR: 7, ROAD_SERVICE: 8, ROAD_PEDESTRIAN: 9, PATH: 10,
  RAIL: 11, WALL: 12, SIDEWALK: 13,
  GRASS: 14, FOREST: 15, FARMLAND: 16, YARD: 17, SAND: 18, ROCK: 19, WETLAND: 20, PITCH: 21, URBAN: 22, CEMETERY: 23,
  TEA: 24,                     // the tea hills: terraces the satellite map takes for trees
};

export const GROUND_GLSL = /* glsl */`
const int WATER_LAKE = 1, WATER_RIVER = 2, WATER_CANAL = 3, WATER_POND = 4;
const int ROAD_MAJOR = 5, ROAD_MINOR = 7, ROAD_PEDESTRIAN = 9, PATH = 10, WALL = 12, SIDEWALK = 13;
const int GRASS = 14, FOREST = 15, FARMLAND = 16, YARD = 17, URBAN = 22, TEA = 24;
uniform int uGroundPal[25];   // the palette index of each ground class
uniform float uTime;          // seconds; tests freeze it
`;

// Shadows. The scene is drawn once more from the sun's point of view, depth only, into a picture
// (the shadow map); a point on the ground is in shade when something stands nearer the sun in its
// column of that picture. The sun is fixed to the screen (see faceLight), so its axes turn with the
// camera; everything here is in world axes relative to the camera centre.
export const LIGHT = /* glsl */`
uniform vec3 uLightDir;      // towards the sun
uniform vec3 uLightRight;    // across and up in the sun's picture
uniform vec3 uLightUp;
uniform vec4 uShadowBox;     // the picture's west and south edge in those axes, and 1 / its width and height, in metres
uniform vec2 uShadowDepth;   // the farthest depth it holds, and 1 / its range

// a point in world metres relative to the camera centre -> where the sun sees it. The depth is laid
// out so that what the depth buffer holds (the vertex depth, halved and raised by a half) is the
// picture's own depth, 0 for the farthest and 1 for the nearest to the sun.
vec4 toLight(vec3 q) {
  vec3 l = vec3(dot(q, uLightRight), dot(q, uLightUp), dot(q, uLightDir));
  return vec4((l.x - uShadowBox.x) * uShadowBox.z * 2.0 - 1.0, (l.y - uShadowBox.y) * uShadowBox.w * 2.0 - 1.0, ((l.z - uShadowDepth.x) * uShadowDepth.y) * 2.0 - 1.0, 1.0);
}
`;

// for surfaces that take shadows: the ground, water, roads, decks, and the crowns of trees
export const SHADOW = LIGHT + /* glsl */`
uniform sampler2D uShadowMap;   // depth from the sun's point of view
uniform float uShadowOn;        // 0 at the overview tier, where shadows are smaller than a pixel
uniform float uShadowBias;      // how much nearer the sun something must be to count, as a share of the picture's depth range

// -> 1 in the sun, 0 in shade; a point outside the picture counts as in the sun
float inSun(vec3 q) {
  if (uShadowOn < 0.5) return 1.0;
  vec3 l = vec3(dot(q, uLightRight), dot(q, uLightUp), dot(q, uLightDir));
  vec2 map = (l.xy - uShadowBox.xy) * uShadowBox.zw;
  if (any(lessThan(map, vec2(0.0))) || any(greaterThan(map, vec2(1.0)))) return 1.0;
  float here = (l.z - uShadowDepth.x) * uShadowDepth.y;
  return texture(uShadowMap, map).r > here + uShadowBias ? 0.0 : 1.0;
}
// the shadow tint of the reference, for a colour in 0..1
vec3 inShade(vec3 color) { return floor(color * 255.0 * vec3(0.54, 0.52, 0.72)) / 255.0; }
`;

// Winter. Snow lies on what faces up, in a share that depends on the surface: nothing on water, a dusting on
// the cleared roads, nearly all of a lawn. The Bayer pattern and a slow noise break the edge of it.
export const SEASON = /* glsl */`
uniform float uSnow;          // 1 where snow lies
uniform int uSnowIndex;       // the palette index of snow
const float SNOWED[25] = float[25](0.0, 0.0, 0.0, 0.0, 0.0, 0.25, 0.25, 0.3, 0.3, 0.6, 0.7, 0.15, 0.2, 0.65, 0.94, 0.6, 0.96, 0.8, 0.96, 0.85, 0.96, 0.9, 0.6, 0.96, 0.0);
// The noise breaks the edge of the snow into patches; it must not put snow where none lies at all (the
// water), so a cover of nothing stays nothing.
bool snowed(float cover, vec2 world, ivec2 pixel) {
  return uSnow > 0.5 && cover > 0.0 && bayerAt(pixel) < cover + (noiseAt(world * 0.03) - 0.5) * 0.5;
}
`;
