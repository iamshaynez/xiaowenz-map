// Injected into tools/reference-cpu/index.html by tools/tests/reference_capture.cjs.
// Freezes the Stari Most scene into a reproducible pose and exposes raw buffers plus every sphere and
// shadow ellipse the engine draws, so the WebGL port can be compared against it pixel by pixel.
// This file is part of the reference tool, not of the app. Classic script on purpose: it needs to
// reassign the engine's global functions.
(() => {
  const orig = { sphere, capsule, castShadow };
  let record = null; // when set: { spheres: [], discs: [] }
  const rgbOf = c => [c[0], c[1], c[2]];
  window.freezeHook = hook => { record = hook; };

  // Every sphere the engine splats: rocks, tree trunks (as chains of spheres), leaves, people.
  sphere = function (x, y, z, r, c, mode) {
    // `capture` is the engine's own flag: set only while a leaf's pixels are being recorded.
    if (record && record.spheres) record.spheres.push({ x, y, z, r, c: rgbOf(c), mode: mode || 'plain', leaf: !!capture });
    return orig.sphere(x, y, z, r, c, mode);
  };
  // Every shadow ellipse, in world space, before it is stamped onto the ground.
  castShadow = function (x, y, z, r, strength = 1, dither = .4) {
    if (record && record.discs) record.discs.push({ x, y, z, r, strength, dither });
    return orig.castShadow(x, y, z, r, strength, dither);
  };

  const b64 = ta => { const s = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength); let out = ''; for (let i = 0; i < s.length; i += 8192) out += String.fromCharCode.apply(null, s.subarray(i, i + 8192)); return btoa(out); };

  // Same classification as shadeEdges(), read-only: 1 silhouette against ground, 2 warm rim, 3 dark rim.
  function edgeMask(depth) {
    const m = new Uint8Array(W * H);
    for (let iy = 1; iy < H - 1; iy++) for (let ix = 1; ix < W - 1; ix++) {
      const i = iy * W + ix, d = depth[i];
      if (d < -1e8 || d === groundZ[i]) continue;
      const a = i - W, b = i + W, c = i - 1, e = i + 1;
      if (depth[a] === groundZ[a] || depth[b] === groundZ[b] || depth[c] === groundZ[c] || depth[e] === groundZ[e]) m[i] = 1;
      else if (d - depth[a] - GRADIENT_Y > EDGE || d - depth[c] > EDGE) m[i] = 2;
      else if (depth[e] - d > EDGE || depth[b] - GRADIENT_Y - d > EDGE) m[i] = 3;
    }
    return m;
  }

  window.__freeze = {
    // Numeric constants of the scene, so the WebGL port reads the same numbers instead of copies.
    constants() {
      return {
        W, H, COOL, WARM, SHOE, BARK, GRASS, CROWN, LEAF_DEEP: [...LEAF_DEEP], LEAF_MID: [...LEAF_MID], LEAF_SILVER: [...LEAF_SILVER],
        SHADOW_X, SHADOW_Y, WIND_FPS,
        STONE, SLATE, TILE, DARK, WATER_TONES, BEACH_TONES,
        ARCH_A, ARCH_C, ARCH_R, ARCH_BASE, DECK_END, DECK_LOW, DECK_TOP, DECK_REACH, HALF_W, PARAPET,
        TOURIST_SCALE, TOURIST_SHIRTS, TOURIST_LEGS, TOURIST_HAIR, TOURIST_SKIN, DIVER, originY: SCENE.originY,
        leaves: leaves.map(l => ({ x: l.x, y: l.y, z: l.z, k: l.k, r: l.r })),
        streaks: STREAKS.map(s => ({ ...s })),
      };
    },
    // Re-bakes with the given camera while recording everything static the bake draws.
    bake(preset) {
      Object.assign(CAM, { yaw: 0, pitch: Math.PI / 6, scale: 10, panX: 0, panY: 0 }, preset);
      const rec = { spheres: [], discs: [] };
      window.freezeHook(rec);
      window.__cam.apply();
      window.freezeHook(null);
      return { spheres: rec.spheres, discs: rec.discs, bakeMs: CAM.bakeMs };
    },
    // The recorded static spheres replayed through the engine's own sphere(), alone on an empty buffer.
    spheresOnly(list) {
      zb.fill(-1e9);
      pix.fill(rgb(255, 255, 255));
      window.freezeHook(null);
      for (const s of list) sphere(s.x, s.y, s.z, s.r, s.c, s.mode);
      return { pix: b64(pix), zb: b64(zb) };
    },
    // One full frame in a fixed pose: tourists stand at fixed spots on the bridge, the diver waits, wind time is 0.
    frame() {
      tourists.forEach((t, k) => Object.assign(t, { x: -6.5 + k, y: k % 2 ? .35 : -.35, tx: 0, ty: 0, yaw: Math.PI / 2, look: Math.PI / 2, walking: false, phone: k % 3 === 0, gait: 0 }));
      G.phase = 'ready'; G.time = 0; G.pitch = 0; G.tuck = 0; G.z = deckZ(0) + PARAPET + HIP_HEIGHT;
      pix.set(bakedPix);
      zb.set(bakedZ);
      pendingShadows.length = 0;
      const dyn = { spheres: [], discs: [] };
      window.freezeHook(dyn);
      drawTourists();
      drawDiver();
      drawLeaves(0);
      drawTufts(0);
      drawWater(0);
      drawRings();
      flushShadows();
      window.freezeHook(null);
      applyShadows(groundZ);
      shadeEdges();
      ctx.putImageData(image, 0, 0);
      return { spheres: dyn.spheres, discs: dyn.discs };
    },
    // Raw state of the last frame ('full') or of the baked static scene ('static').
    buffers(which) {
      const stat = which === 'static', src = stat ? { pix: bakedPix, zb: bakedZ } : { pix, zb };
      return {
        W, H, camera: { ...CAM },
        pix: b64(src.pix), zb: b64(src.zb), groundZ: b64(groundZ), ground: b64(ground), kinds: b64(kinds),
        staticShadow: b64(staticShadow), shadowMask: b64(shadowMask), edges: b64(edgeMask(src.zb)),
        png: pngOf(src.pix),
      };
    },
  };

  function pngOf(buf) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const data = new ImageData(W, H);
    new Uint32Array(data.data.buffer).set(buf);
    c.getContext('2d').putImageData(data, 0, 0);
    return c.toDataURL('image/png').split(',')[1]; // bare base64
  }
})();
