// All shaders of the style engine. Each one ports a piece of pixel-plays' engine.js and says which in its
// header. Conventions throughout: screen positions are low-resolution pixels with a top-left origin, depth
// is the engine's ("larger is nearer"), and every per-pixel decision is taken at the centre of a
// low-resolution pixel exactly as the reference does, whatever the supersampling.

export const PREFIX = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

export const CAMERA = /* glsl */`
uniform vec4 uView;    // W, H, SS, S: low-resolution size, supersampling, pixels per unit
uniform vec4 uAngles;  // cos(yaw), sin(yaw), sin(pitch), cos(pitch)
uniform vec2 uOrigin;  // OX, OY in low-resolution pixels
uniform vec2 uDepth;   // nearest and farthest engine depth
const float R2I = 0.7071067811865476;

// project(): screen position and engine depth of a world point
vec3 project(vec3 p) {
  float rx = p.x * uAngles.x - p.y * uAngles.y;
  float ry = p.x * uAngles.y + p.y * uAngles.x;
  float u = (rx - ry) * R2I, v = (rx + ry) * R2I;
  return vec3(uOrigin.x + u * uView.w, uOrigin.y - (v * uAngles.z + p.z * uAngles.w) * uView.w, p.z * uAngles.z - v * uAngles.w);
}
// unproject(): world point under a screen position on the flat ground z = 0
vec2 unproject(float sx, float sy) {
  float u = (sx - uOrigin.x) / uView.w, v = -(sy - uOrigin.y) / (uView.w * uAngles.z);
  float rx = (u + v) * R2I, ry = (v - u) * R2I;
  return vec2(rx * uAngles.x + ry * uAngles.y, -rx * uAngles.y + ry * uAngles.x);
}
float groundDepth(vec2 w) {
  float rx = w.x * uAngles.x - w.y * uAngles.y, ry = w.x * uAngles.y + w.y * uAngles.x;
  return -(rx + ry) * R2I * uAngles.w;
}
float depthOf(float d) { return clamp((uDepth.x - d) / (uDepth.x - uDepth.y), 0.0, 1.0); }
float depthToD(float z) { return uDepth.x - z * (uDepth.x - uDepth.y); }
vec4 toClip(vec3 s) { return vec4(s.x / uView.x * 2.0 - 1.0, 1.0 - s.y / uView.y * 2.0, depthOf(s.z), 1.0); }
`;

// for fragments of the supersampled scene buffers: the reference pixel this sample belongs to
export const SAMPLE = /* glsl */`
ivec2 pixelIndex() { return ivec2(floor(vec2(gl_FragCoord.x, uView.y * uView.z - gl_FragCoord.y) / uView.z)); }
vec2 pixelCentre() { return vec2(pixelIndex()) + 0.5; }
`;

// for full-screen passes over the resolved low-resolution buffers
export const PIXEL = /* glsl */`
ivec2 lr() { return ivec2(gl_FragCoord.xy); }                       // low-resolution framebuffer pixel
ivec2 cpu(ivec2 q) { return ivec2(q.x, int(uView.y) - 1 - q.y); }    // the same pixel in top-left indexing
`;

export const TABLES = /* glsl */`
uniform sampler2D uHash;  // the engine's hash at integer lattice points, offset 256
uniform sampler2D uRamp;  // x: ramp level, y: colour index
float hashL(vec2 i) { return texelFetch(uHash, ivec2(i) + 256, 0).r; }
float noiseL(vec2 p) {
  vec2 i = floor(p), f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashL(i), hashL(i + vec2(1.0, 0.0)), f.x), mix(hashL(i + vec2(0.0, 1.0)), hashL(i + vec2(1.0, 1.0)), f.x), f.y);
}
float bayerAt(ivec2 p) {
  const float B[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (B[(p.y & 3) * 4 + (p.x & 3)] + 0.5) / 16.0;
}
float roundUp(float v) { return floor(v + 0.5); }                 // JS Math.round
float trunc0(float v) { return v >= 0.0 ? floor(v) : ceil(v); }   // truncates towards zero, like a JS bitwise or
vec3 rampOf(int c, float level) { return texelFetch(uRamp, ivec2(int(clamp(level, 0.0, 4.0)), c), 0).rgb; }
// masonry(): staggered courses, mortar joints, a tone per block
float masonryLevel(float a, float z, float base) {
  float fz = z * 1.6, course = floor(fz), fa = a * 1.2 + mod(course, 2.0) * 0.5, block = floor(fa);
  bool mortar = fz - course < 0.14 || fa - block < 0.1;
  float tone = hashL(vec2(block, course));
  return clamp(base + (tone > 0.75 ? 1.0 : tone < 0.2 ? -1.0 : 0.0) - (mortar ? 1.0 : 0.0), 0.0, 4.0);
}
`;

export const MRT = /* glsl */`
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outClass;   // r: ground, g: kind / 255, b: kind of the ground underneath / 255, a: covered
`;

export const CLASS = /* glsl */`
bool isCovered(vec4 c) { return c.a > 0.5; }
bool isGround(vec4 c) { return c.r > 0.5; }
`;

export const FULLSCREEN_VS = PREFIX + /* glsl */`
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

export const SHADERS = {
  // groundColor() of the reference scene: an island with a dithered, noisy dissolve into white,
  // a river with banks, and grass. Decisions use the low-resolution pixel, never the sample.
  ground: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + CAMERA + SAMPLE + TABLES + MRT + /* glsl */`
uniform vec2 uShape;          // half extents of the island
uniform vec3 uWater[4]; uniform vec3 uBeach[4]; uniform vec3 uGrass[5];
uniform vec3 uBeachLight; uniform vec3 uBeachDark;
vec3 pick(vec3 tones[4], float v, ivec2 ip) {
  return tones[int(clamp(floor(v * 4.0 + (bayerAt(ip) - 0.5) * 0.7), 0.0, 3.0))];
}
void main() {
  ivec2 ip = pixelIndex();
  vec2 centre = pixelCentre();
  vec2 w = unproject(centre.x, centre.y);
  float edge = pow(pow(abs(w.x) / uShape.x, 4.0) + pow(abs(w.y) / uShape.y, 4.0), 0.25);
  float rough = edge + (noiseL(w * 1.3) - 0.5) * 0.13;
  if (rough > 1.04) discard;
  if (rough > 0.93 && hashL(vec2(ip)) < (rough - 0.93) / 0.11) discard;
  float halfW = 6.0 + (noiseL(vec2(w.y * 0.25 + 9.0, 3.0)) - 0.5) * 1.2;
  float fine = hashL(vec2(ip)), a = abs(w.x);
  vec3 color;
  float kind;
  if (a < halfW) {
    kind = 2.0;
    float shore = a / halfW;
    color = pick(uWater, 0.1 + shore * shore * 0.7 + (noiseL(w * vec2(0.6, 0.3)) - 0.5) * 0.35, ip);
  } else if (a < halfW + 1.1 + noiseL(w * 2.0) * 0.9) {
    kind = 1.0;
    if (fine > 0.96) color = uBeachLight;
    else if (hashL(vec2(ip) - 1.0) > 0.96) color = uBeachDark;
    else color = pick(uBeach, 0.25 + noiseL(w * 3.0) * 0.6, ip);
  } else {
    kind = 3.0;
    float t = noiseL(w * 0.9) * 1.15 + (fine - 0.5) * 0.55 - 0.08;
    color = uGrass[int(clamp(floor(t * 4.2), 0.0, 3.0))];
  }
  outColor = vec4(color, 1.0);
  outClass = vec4(1.0, kind / 255.0, kind / 255.0, 1.0);
  gl_FragDepth = depthOf(groundDepth(w));
}`,
  },

  // the hand-built surfaces of the reference scene, as meshes instead of point plots.
  // aInfo: material, colour index, base / half, extra (seed, centre, light); aCoord: two material coordinates
  surfaces: {
    vs: PREFIX + CAMERA + /* glsl */`
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aInfo;
layout(location = 2) in vec3 aCoord;   // two material coordinates and one smooth material value
out vec3 vS; out vec3 vCoord; flat out vec4 vInfo;
void main() {
  vS = project(aPos);
  vCoord = aCoord;
  vInfo = aInfo;
  gl_Position = toClip(vS);
}`,
    fs: PREFIX + CAMERA + SAMPLE + TABLES + MRT + /* glsl */`
uniform vec4 uArch;   // ARCH_A, ARCH_C, ARCH_R, ARCH_BASE
uniform vec4 uDeck;   // DECK_END, DECK_LOW, DECK_TOP
uniform float uDebug; // 1: paint material, colour and base instead of shading
in vec3 vS; in vec3 vCoord; flat in vec4 vInfo;
float deckZ(float x) {
  float a = abs(x);
  return a >= uDeck.x ? uDeck.y : uDeck.z - (uDeck.z - uDeck.y) * pow(a / uDeck.x, 1.6);
}
void main() {
  int id = int(vInfo.x + 0.5), col = int(vInfo.y + 0.5);
  float base = vInfo.z, extra = vInfo.w, a = vCoord.x, b = vCoord.y, level = 0.0;
  if (id == 1) level = masonryLevel(a, b, base);
  else if (id == 2) level = base;
  else if (id == 3) level = mod(floor(a * 2.6), 2.0) == 0.0 ? 3.0 : 4.0;
  else if (id == 4) {  // roof(): two slopes with alternating courses and the odd missing tile
    float q = abs(b - extra) / base, row = mod(floor(q * base * 3.4), 2.0);
    level = clamp((b > extra ? 3.0 : 1.0) + row - (hashL(vec2(trunc0(a * 3.0), trunc0(b * 9.0))) > 0.85 ? 1.0 : 0.0), 0.0, 4.0);
  } else if (id == 5) level = masonryLevel(a, b, clamp(roundUp(2.4 + vCoord.z * 1.3), 1.0, 4.0));   // round tower wall, lit by its normal
  else if (id == 6) level = clamp(roundUp(2.4 + a * 1.4 + mod(floor(b * 12.0), 2.0) * 0.4), 1.0, 4.0);  // its cone
  else if (id == 7) level = clamp(floor(base + (noiseL(vec2(a * 0.8 + extra, b * 9.0)) - 0.5) * 1.3 + (bayerAt(pixelIndex()) - 0.5) * 0.5), 0.0, 4.0);  // box()
  else if (id == 10) level = clamp(floor(base + (noiseL(vec2(a * 9.0, b * 0.8 + extra)) - 0.5) * 1.3 + (bayerAt(pixelIndex()) - 0.5) * 0.5), 0.0, 4.0);
  else if (id == 8) level = abs(a - extra) < 0.03 ? 3.0 : 1.0;   // a window with its mullion
  else if (id == 9) {  // the near wall of the deck: string course, ring of voussoirs, masonry
    float top = deckZ(a), ax = abs(a);
    if (b > top - 0.24 && b < top - 0.1) level = 4.0;
    else if (b > uArch.w && length(vec2(ax + uArch.y, b - uArch.w)) < uArch.z + 0.62) level = mod(atan(b - uArch.w, ax + uArch.y) * 26.0, 1.0) < 0.16 ? 2.0 : 4.0;
    else level = masonryLevel(a, b, 3.0);
  }
  outColor = uDebug > 0.5 ? vec4(vInfo.xyz / 255.0, 1.0) : vec4(rampOf(col, level), 1.0);
  outClass = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vS.z);
}`,
  },

  // sphere(): a screen-facing disc shaded as a sphere. A shifted sphere keeps the shading of its
  // unshifted position, which is exactly what the reference does when it slides a leaf's pixels.
  spheres: {
    vs: PREFIX + CAMERA + /* glsl */`
layout(location = 0) in vec2 aCorner;               // unit quad, per vertex
layout(location = 1) in vec4 aPosR;
layout(location = 2) in vec4 aInfo;
layout(location = 3) in vec2 aShift;       // x y z r | colour index, mode | screen shift in low-res pixels, per instance
out vec2 vCentre; out float vRp; out float vD; out float vR; out vec2 vShift; flat out int vCol; flat out int vMode;
void main() {
  vec3 s = project(aPosR.xyz);
  vCentre = s.xy;
  vRp = max(aPosR.w * uView.w, 0.75);
  vD = s.z;
  vR = aPosR.w;
  vShift = aShift;
  vCol = int(aInfo.x + 0.5);
  vMode = int(aInfo.y + 0.5);
  gl_Position = toClip(vec3(s.xy + aCorner * vRp, 0.0));
}`,
    fs: PREFIX + CAMERA + SAMPLE + TABLES + MRT + /* glsl */`
in vec2 vCentre; in float vRp; in float vD; in float vR; in vec2 vShift; flat in int vCol; flat in int vMode;
void main() {
  vec2 d = (pixelCentre() - vShift - vCentre) / vRp;
  float nn = dot(d, d);
  if (nn > 1.0) discard;
  float nz = sqrt(1.0 - nn);
  float l = clamp(-0.55 * d.x - 0.6 * d.y + 0.58 * nz, 0.0, 1.0);
  ivec2 ip = pixelIndex();
  if (vMode == 1) l += (hashL(vec2(ip)) - 0.5) * 0.55;            // rough
  if (d.y > 0.35) l = max(l, 0.12 + d.y * 0.24);                  // warm light bouncing off the ground
  if (vMode == 2 && l > 0.9) outColor = vec4(vec3(255.0, 250.0, 232.0) / 255.0, 1.0);   // gloss highlight
  else if (vMode == 3) outColor = vec4(rampOf(vCol, clamp(floor(l * 4.4 + 0.2), 1.0, 4.0)), 1.0);  // solid: flat bands, no dither
  else outColor = vec4(rampOf(vCol, floor(l * 4.4 + 0.2 + (bayerAt(ip) - 0.5) * 0.7)), 1.0);
  outClass = vec4(0.0, 0.0, 0.0, 1.0);
  gl_FragDepth = depthOf(vD + vR * nz);
}`,
  },

  // castShadow(): an ellipse stamped on the ground, its edge broken up with the Bayer pattern.
  // Drawn into a mask with max blending; only ground pixels ever receive the tint.
  discs: {
    vs: PREFIX + CAMERA + /* glsl */`
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aDisc;      // x y z r, per instance
layout(location = 2) in vec2 aStrength;  // strength, dither
uniform vec2 uShadowDir;
out vec2 vCentre; out vec2 vRadius; flat out vec2 vStrength;
void main() {
  vec3 s = project(vec3(aDisc.xy + uShadowDir * aDisc.z, 0.0));
  float rx = aDisc.w * uView.w * 1.05;
  vCentre = s.xy;
  vRadius = vec2(rx, rx * uAngles.z + 1.0);
  vStrength = aStrength;
  gl_Position = toClip(vec3(s.xy + aCorner * vRadius, 0.0));
}`,
    fs: PREFIX + CAMERA + PIXEL + TABLES + /* glsl */`
out vec4 outMask;
in vec2 vCentre; in vec2 vRadius; flat in vec2 vStrength;
void main() {
  ivec2 q = lr();
  vec2 centre = vec2(float(q.x) + 0.5, uView.y - float(q.y) - 0.5); // top-left origin, like vCentre
  vec2 d = (centre - vCentre) / vRadius;
  if (dot(d, d) + (bayerAt(cpu(q)) - 0.5) * vStrength.y > 1.0) discard;
  outMask = vec4(vStrength.x * 0.5);
}`,
  },

  // supersampled scene buffers -> low-resolution buffers: a pixel is covered if any of its samples is,
  // and it takes the nearest covered sample, as the reference keeps the nearest sample that lands in it
  resolve: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + CAMERA + CLASS + /* glsl */`
uniform sampler2D uColor; uniform sampler2D uClass; uniform sampler2D uDepthTex;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outClass;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * int(uView.z);
  float best = 2.0;
  vec4 color = vec4(1.0), cls = vec4(0.0);
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    if (i >= int(uView.z) || j >= int(uView.z)) continue;
    vec4 c = texelFetch(uClass, p + ivec2(i, j), 0);
    if (!isCovered(c)) continue;
    float z = texelFetch(uDepthTex, p + ivec2(i, j), 0).r;
    if (z < best) { best = z; color = texelFetch(uColor, p + ivec2(i, j), 0); cls = c; }
  }
  outColor = color;
  outClass = cls;
  gl_FragDepth = best < 2.0 ? best : 1.0;
}`,
  },

  // bakeOcclusion() and applyShadows(): ground darkening next to objects, then the shadow tint.
  groundTint: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + CAMERA + PIXEL + TABLES + CLASS + /* glsl */`
uniform sampler2D uColor; uniform sampler2D uClass; uniform sampler2D uMask; uniform sampler2D uStaticClass;
uniform float uAO;
out vec4 outColor;
void main() {
  ivec2 q = lr(), ip = cpu(q);
  vec4 color = texelFetch(uColor, q, 0);
  vec4 cls = texelFetch(uClass, q, 0);
  if (!(isCovered(cls) && isGround(cls))) { outColor = color; return; }
  vec3 c = color.rgb * 255.0;
  if (uAO > 0.5 && ip.x >= 4 && ip.x < int(uView.x) - 4 && ip.y >= 4 && ip.y < int(uView.y) - 4) {
    int hits = 0;
    for (int r = 2; r <= 4; r += 2) for (int k = 0; k < 8; k++) {
      float ang = float(k) * 0.7853981633974483;
      ivec2 off = ivec2(int(roundUp(cos(ang) * float(r))), int(roundUp(sin(ang) * float(r) * 0.7)));
      vec4 n = texelFetch(uStaticClass, q + ivec2(off.x, -off.y), 0);
      if (isCovered(n) && !isGround(n)) hits++;
    }
    if (hits >= 8) c = floor(c * vec3(0.56, 0.54, 0.72));
    else if (hits > 0 && float(hits) / 8.0 > bayerAt(ip)) c = floor(c * vec3(0.74, 0.72, 0.84));
  }
  float s = texelFetch(uMask, q, 0).r;
  if (s > 0.75) c = floor(c * vec3(0.36, 0.34, 0.56));
  else if (s > 0.25) c = floor(c * vec3(0.54, 0.52, 0.72));
  outColor = vec4(c / 255.0, 1.0);
}`,
  },

  // drawTufts(): blades of grass growing up from ground pixels, bending in an 8 fps wind.
  // A gather: for each pixel, the latest tuft whose blade would land on it wins, as in the reference.
  tufts: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + CAMERA + PIXEL + TABLES + CLASS + /* glsl */`
uniform sampler2D uColor; uniform sampler2D uClass; uniform sampler2D uMask; uniform sampler2D uTuft;
uniform vec3 uGrassLit[5]; uniform vec3 uGrassDark[5]; uniform vec3 uBloomA; uniform vec3 uBloomB;
out vec4 outColor;
void main() {
  ivec2 q = lr(), ip = cpu(q);
  vec4 color = texelFetch(uColor, q, 0);
  vec4 cls = texelFetch(uClass, q, 0);
  float kind = floor(cls.b * 255.0 + 0.5);
  // blades only land on grass, on nothing (the island's edge), or on visible ground
  bool open = (kind == 3.0 || kind == 0.0) && (!isCovered(cls) || isGround(cls));
  if (open) {
    for (int k = 4; k >= 1; k--) {
      int r = ip.y + k;
      if (r < 3 || r >= int(uView.y)) continue;
      bool found = false;
      for (int o = -2; o <= 2; o++) {
        int cx = ip.x - o;
        if (cx < 0 || cx >= int(uView.x)) continue;
        vec4 t = texelFetch(uTuft, ivec2(cx, r), 0);
        vec4 baseClass = texelFetch(uClass, ivec2(cx, int(uView.y) - 1 - r), 0);
        if (t.r > 0.17 || floor(baseClass.b * 255.0 + 0.5) != 3.0) continue; // only grass grows tufts
        int height = 1 + int(t.g * 3.0);
        if (height < k) continue;
        float phase = float(cx) * 0.11 + float(r) * 0.19 + t.a * 0.9;
        float gust = sin(phase) + 0.5 * sin(phase * 2.3);
        if (int(roundUp(gust * 0.95 * float(k) / 3.0)) != o) continue;
        bool dark = texelFetch(uMask, ivec2(cx, int(uView.y) - 1 - r), 0).r > 0.0;
        if (t.b < 0.022 && k == height) color = vec4(t.a > 0.5 ? uBloomA : uBloomB, 1.0);
        else {
          int base = int(roundUp(noiseL(vec2(float(cx) * 0.09, float(r) * 0.18)) * 2.2));
          int idx = int(clamp(float(base + k) + (gust > 1.0 ? 1.0 : 0.0), 1.0, 4.0));
          color = vec4(dark ? uGrassDark[idx] : uGrassLit[idx], 1.0);
        }
        found = true;
        break;
      }
      if (found) break;
    }
  }
  outColor = color;
}`,
  },

  // drawWater(): streaks drifting on the river, one pixel each, only on visible water
  water: {
    vs: PREFIX + CAMERA + /* glsl */`
layout(location = 0) in vec2 aPoint;   // screen position in low-resolution pixels
layout(location = 1) in float aKind;   // 0 soft, 1 lit
out float vKind;
void main() {
  vKind = aKind;
  gl_Position = vec4(aPoint.x / uView.x * 2.0 - 1.0, 1.0 - aPoint.y / uView.y * 2.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`,
    fs: PREFIX + CAMERA + PIXEL + CLASS + /* glsl */`
uniform sampler2D uClass; uniform sampler2D uMask;
uniform vec3 uLit; uniform vec3 uSoft; uniform vec3 uDim;
in float vKind;
out vec4 outColor;
void main() {
  ivec2 q = lr();
  vec4 cls = texelFetch(uClass, q, 0);
  if (!(isCovered(cls) && isGround(cls) && floor(cls.b * 255.0 + 0.5) == 2.0)) discard;
  bool dark = texelFetch(uMask, q, 0).r > 0.0;
  outColor = vec4(dark ? uDim : (vKind > 0.5 ? uLit : uSoft), 1.0);
}`,
  },

  // shadeEdges(): pixel-art edges read from the depth buffer. The ground itself is never touched, so
  // nothing halos around a figure: an object darkens its own silhouette against the ground and gets a
  // warm rim only over another object.
  edges: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + CAMERA + PIXEL + TABLES + CLASS + /* glsl */`
uniform sampler2D uColor; uniform sampler2D uClass; uniform sampler2D uDepthTex;
uniform float uGradientY;
uniform float uEdge; // depth difference that counts as an edge: 2.8 pixels' worth at this zoom
out vec4 outColor;
bool groundish(ivec2 q) { vec4 c = texelFetch(uClass, q, 0); return !(isCovered(c) && !isGround(c)); }
float dep(ivec2 q) { return depthToD(texelFetch(uDepthTex, q, 0).r); }
void main() {
  ivec2 q = lr(), ip = cpu(q);
  vec4 color = texelFetch(uColor, q, 0);
  vec4 cls = texelFetch(uClass, q, 0);
  if (ip.x >= 1 && ip.x < int(uView.x) - 1 && ip.y >= 1 && ip.y < int(uView.y) - 1 && isCovered(cls) && !isGround(cls)) {
    float d = dep(q);
    vec3 c = color.rgb * 255.0;
    bool above = groundish(q + ivec2(0, 1)), below = groundish(q - ivec2(0, 1));
    bool left = groundish(q - ivec2(1, 0)), right = groundish(q + ivec2(1, 0));
    if (above || below || left || right) c = floor(c * vec3(0.68, 0.66, 0.76));
    else if (d - dep(q + ivec2(0, 1)) - uGradientY > uEdge || d - dep(q - ivec2(1, 0)) > uEdge)
      c = floor(mix(c, vec3(255.0, 232.0, 180.0), vec3(0.3, 0.3, 0.22)));
    else if (dep(q + ivec2(1, 0)) - d > uEdge || dep(q - ivec2(0, 1)) - uGradientY - d > uEdge)
      c = floor(c * vec3(0.74, 0.72, 0.82));
    outColor = vec4(c / 255.0, 1.0);
  } else outColor = color;
}`,
  },

  // depth texture -> RGBA8 so it can be read back and inspected
  packDepth: {
    vs: FULLSCREEN_VS,
    fs: PREFIX + /* glsl */`
uniform sampler2D uDepthTex;
out vec4 outColor;
void main() {
  float v = texelFetch(uDepthTex, ivec2(gl_FragCoord.xy), 0).r;
  // three bytes hold the full 24-bit depth; a fourth would exceed single precision
  float n = min(floor(clamp(v, 0.0, 1.0) * 16777215.0 + 0.5), 16777215.0);   // 1.0 would round up to 2^24
  float b0 = mod(n, 256.0);
  n = floor(n / 256.0);
  float b1 = mod(n, 256.0);
  outColor = vec4(b0, b1, floor(n / 256.0), 255.0) / 255.0;
}`,
  },
};
