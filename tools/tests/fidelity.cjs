// Gate G1: does the GPU style engine reproduce the CPU reference pixel by pixel?
//
// Reads the reference export (tools/tests/reference_capture.cjs), renders the same cases in headless Chrome
// through the real GPU, computes the gate metrics, and writes pictures and a JSON report.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/fidelity.cjs [--ss 2] [--out out/fidelity]
//
// Metrics, per camera position:
//   silhouette   IoU of the non-white masks of the static frames          (gate: >= 0.97)
//   edges        agreement of the edge classifications, an edge counting as agreed when the
//                other renderer drew an edge of any kind within one pixel  (gate: >= 0.90)
//   edgesStrict  the same, only exact same-pixel matches count           (reported)
//   edgePass     the GPU's edge pass against the reference's rule run on the GPU's own depth (reported; 1.0 = ported exactly)
//   colour       mean absolute RGB difference after a 3x3 box blur,
//                over pixels that are not white in both                  (gate: <= 10 / 255)
//   tones        total variation between 32-bin luminance histograms     (gate: <= 2 %)
// Why the edge gate tolerates one pixel: the reference splats points and keeps the nearest sample that
// lands in a pixel, the GPU keeps the nearest of a fixed grid of subsamples. Along every boundary that
// puts the two depth buffers up to a pixel apart, so an exact same-pixel comparison of one-pixel-wide
// lines cannot approach 1; docs/DECISIONS.md D013 has the numbers.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { encodePNG } = require('./png.cjs');

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const root = path.resolve(__dirname, '../..');
const cpuDir = path.join(root, 'out/fidelity/cpu');
const outDir = path.resolve(root, flag('--out', 'out/fidelity-gate'));
const SS = Number(flag('--ss', '4'));
const PORT = 5399;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GATE = { silhouette: 0.97, edgesTolerant: 0.9, colour: 10, tones: 0.02 };

const decode = b64 => Buffer.from(b64, 'base64');
const f32 = b64 => { const b = decode(b64); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const read = (file, Type) => { const b = fs.readFileSync(path.join(cpuDir, file)); return new Type(b.buffer, b.byteOffset, b.byteLength / Type.BYTES_PER_ELEMENT); };

// the reference's shadeEdges() classification, for any depth buffer: 1 silhouette, 2 warm rim, 3 dark rim
function edgeMask(W, H, depth, object, groundish, gradientY) {
  const m = new Uint8Array(W * H);
  const EDGE = 0.28;
  for (let iy = 1; iy < H - 1; iy++) for (let ix = 1; ix < W - 1; ix++) {
    const i = iy * W + ix;
    if (!object[i]) continue;
    const d = depth[i], a = depth[i - W], b = depth[i + W], c = depth[i - 1], e = depth[i + 1];
    if (groundish[i - W] || groundish[i + W] || groundish[i - 1] || groundish[i + 1]) m[i] = 1;
    else if (d - a - gradientY > EDGE || d - c > EDGE) m[i] = 2;
    else if (e - d > EDGE || b - gradientY - d > EDGE) m[i] = 3;
  }
  return m;
}

const isWhite = (px, i) => px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255;

function blur3(px, W, H) {
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const o = (yy * W + xx) * 4;
      r += px[o]; g += px[o + 1]; b += px[o + 2]; n++;
    }
    const o = (y * W + x) * 3;
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
  }
  return out;
}

function histogram(px, W, H) {
  const bins = new Float64Array(32);
  for (let i = 0; i < W * H; i++) {
    if (isWhite(px, i * 4)) continue;
    const l = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    bins[Math.min(31, l / 8 | 0)]++;
  }
  const total = bins.reduce((a, b) => a + b, 0) || 1;
  return Array.from(bins, v => v / total);
}

// which kind of edge the GPU drew at each pixel, recovered from what the edge pass changed
function gpuEdgeMask(W, H, plain, drawn) {
  const m = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const c = [plain[o], plain[o + 1], plain[o + 2]], d = [drawn[o], drawn[o + 1], drawn[o + 2]];
    if (c[0] === d[0] && c[1] === d[1] && c[2] === d[2]) continue;
    const err = t => Math.abs(Math.floor(c[0] * t[0][0] + t[1][0]) - d[0]) + Math.abs(Math.floor(c[1] * t[0][1] + t[1][1]) - d[1]) + Math.abs(Math.floor(c[2] * t[0][2] + t[1][2]) - d[2]);
    const kinds = [[1, [[.68, .66, .76], [0, 0, 0]]], [2, [[.7, .7, .78], [76.5, 69.6, 39.6]]], [3, [[.74, .72, .82], [0, 0, 0]]]];
    let best = 0, bestErr = 1e9;
    for (const [type, t] of kinds) { const e = err(t); if (e < bestErr) { bestErr = e; best = type; } }
    m[i] = best;
  }
  return m;
}

// agreement between two typed edge masks: strict (same pixel) and with a one-pixel tolerance
function edgeAgreement(W, H, a, b) {
  const out = {};
  for (const [name, type] of [['silhouette', 1], ['warm', 2], ['dark', 3], ['any', 0]]) {
    const A = new Uint8Array(W * H), B = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) { A[i] = type ? a[i] === type : a[i] > 0; B[i] = type ? b[i] === type : b[i] > 0; }
    let inter = 0, union = 0, hitA = 0, nA = 0, hitB = 0, nB = 0;
    for (let i = 0; i < W * H; i++) { if (A[i] && B[i]) inter++; if (A[i] || B[i]) union++; }
    const near = (M, i) => { const x = i % W, y = (i / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && M[yy * W + xx]) return true; } return false; };
    for (let i = 0; i < W * H; i++) { if (A[i]) { nA++; if (near(B, i)) hitA++; } if (B[i]) { nB++; if (near(A, i)) hitB++; } }
    const p = nB ? hitB / nB : 1, r = nA ? hitA / nA : 1; // of B's edges, how many are near an A edge, and vice versa
    out[name] = { strict: union ? inter / union : 1, tolerant: nA + nB ? (hitA + hitB) / (nA + nB) : 1, count: [nA, nB] };
  }
  return out;
}

function compare(W, H, cpu, gpu, gradientY) {
  const n = W * H;
  let inter = 0, union = 0;
  for (let i = 0; i < n; i++) {
    const a = !isWhite(cpu.pix, i * 4), b = !isWhite(gpu.pix, i * 4);
    if (a && b) inter++;
    if (a || b) union++;
  }
  // the reference's shadeEdges() classification, run on each depth buffer
  const cpuObject = new Uint8Array(n), cpuGround = new Uint8Array(n), gpuObject = new Uint8Array(n), gpuGround = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    cpuObject[i] = cpu.depth[i] > -1e8 && cpu.depth[i] !== cpu.groundZ[i] ? 1 : 0;
    cpuGround[i] = cpu.depth[i] === cpu.groundZ[i] ? 1 : 0;
    const covered = gpu.cls[i * 4 + 3] > 127, ground = gpu.cls[i * 4] > 127;
    gpuObject[i] = covered && !ground ? 1 : 0;
    gpuGround[i] = !(covered && !ground) ? 1 : 0;
  }
  const ec = edgeMask(W, H, cpu.depth, cpuObject, cpuGround, gradientY);      // edges the reference draws
  const eg = edgeMask(W, H, gpu.depth, gpuObject, gpuGround, gradientY);      // the same rule on the GPU's depth buffer
  const drawn = gpu.plain ? gpuEdgeMask(W, H, gpu.plain, gpu.pix) : eg;       // edges the GPU actually drew
  const bc = blur3(cpu.pix, W, H), bg = blur3(gpu.pix, W, H);
  let diff = 0, dn = 0;
  for (let i = 0; i < n; i++) {
    if (isWhite(cpu.pix, i * 4) || isWhite(gpu.pix, i * 4)) continue;
    diff += Math.abs(bc[i * 3] - bg[i * 3]) + Math.abs(bc[i * 3 + 1] - bg[i * 3 + 1]) + Math.abs(bc[i * 3 + 2] - bg[i * 3 + 2]);
    dn++;
  }
  const hc = histogram(cpu.pix, W, H), hg = histogram(gpu.pix, W, H);
  let depthSame = 0, depthBoth = 0;
  for (let i = 0; i < n; i++) if (cpuObject[i] && gpuObject[i]) { depthBoth++; if (Math.abs(cpu.depth[i] - gpu.depth[i]) < 0.05) depthSame++; }
  return {
    silhouette: union ? inter / union : 1,
    edges: edgeAgreement(W, H, ec, eg).any.tolerant,
    edgesStrict: edgeAgreement(W, H, ec, eg).any.strict,
    edgePass: gpu.plain ? edgeAgreement(W, H, drawn, eg).any.strict : null, // the GPU's edge pass against the same rule on the same depth
    depthAgreement: depthBoth ? depthSame / depthBoth : 1,
    colour: dn ? diff / dn / 3 : 0,
    tones: hc.reduce((s, v, i) => s + Math.abs(v - hg[i]), 0) / 2,
  };
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const constants = JSON.parse(fs.readFileSync(path.join(cpuDir, 'constants.json'), 'utf8'));
  const names = fs.readdirSync(cpuDir).filter(f => f.endsWith('.scene.json')).map(f => f.slice(0, -'.scene.json'.length));
  const cases = {};
  for (const name of names) cases[name] = JSON.parse(fs.readFileSync(path.join(cpuDir, `${name}.scene.json`), 'utf8'));
  const W = constants.W, H = constants.H;

  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/tests/pages/fidelity.html`)).ok) break; } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/tests/pages/fidelity.html`);
    await page.waitForFunction(() => window.fidelityReady === true, null, { timeout: 30000 });
    const result = await page.evaluate(args => window.runFidelity(args), { W, H, SS, constants, cases });
    if (errors.length) throw new Error(errors.join('\n'));

    const report = { SS, glError: result.glError, cases: {} };
    let pass = true;
    console.log(`supersampling ${SS}x${SS}, GL error ${result.glError}`);
    console.log('case      frame   silhouette  edges  strict  pass  depth   colour  tones   (edges = within one pixel, gate 0.90; strict = same pixel, reported)');
    for (const name of names) {
      report.cases[name] = {};
      for (const tag of ['static', 'full']) {
        const cpu = {
          pix: read(`${name}.${tag}.pix`, Uint8Array), depth: read(`${name}.${tag}.zb`, Float32Array),
          groundZ: read(`${name}.${tag}.groundZ`, Float32Array),
        };
        const g = result.frames[name][tag];
        const gpu = { pix: new Uint8Array(decode(g.color)), plain: g.plain ? new Uint8Array(decode(g.plain)) : null, cls: new Uint8Array(decode(g.cls)), depth: f32(g.depth) };
        const cam = cases[name].camera;
        const m = compare(W, H, cpu, gpu, Math.cos(cam.pitch) / (cam.scale * Math.sin(cam.pitch)));
        const gated = tag === 'static';
        const failed = !gated ? [] : Object.entries(GATE).filter(([key, limit]) => key === 'colour' || key === 'tones' ? m[key] > limit : m[key] < limit).map(([key]) => key);
        const ok = !failed.length;
        if (gated && !ok) pass = false;
        report.cases[name][tag] = { ...m, gated, ok, failed };
        const passOk = m.edgePass == null ? '    - ' : m.edgePass.toFixed(3);
        console.log(`${name.padEnd(9)} ${tag.padEnd(7)} ${m.silhouette.toFixed(4).padStart(10)} ${m.edges.toFixed(3).padStart(7)} ${m.edgesStrict.toFixed(3).padStart(7)} ${passOk.padStart(6)} ${m.depthAgreement.toFixed(3).padStart(7)} ${m.colour.toFixed(2).padStart(7)} ${(m.tones * 100).toFixed(2).padStart(6)}% ${gated ? (ok ? '  pass' : '  FAIL: ' + failed.join(', ')) : '  (reported)'}`);
        fs.writeFileSync(path.join(outDir, `${name}.${tag}.gpu.png`), encodePNG(W, H, gpu.pix));
        fs.writeFileSync(path.join(outDir, `${name}.${tag}.gpu.pix`), gpu.pix);
        fs.writeFileSync(path.join(outDir, `${name}.${tag}.gpu.cls`), gpu.cls);
        fs.writeFileSync(path.join(outDir, `${name}.${tag}.gpu.zb`), Buffer.from(gpu.depth.buffer));
      }
    }
    report.pass = pass;
    fs.writeFileSync(path.join(outDir, `report-ss${SS}.json`), JSON.stringify(report, null, 2));
    console.log(pass ? `GATE G1 PASSED at ${SS}x${SS}` : `GATE G1 FAILED at ${SS}x${SS}: ` + Object.entries(report.cases).filter(([, f]) => !f.static.ok).map(([n, f]) => `${n} (${f.static.failed.join(', ')})`).join(', '));
    process.exitCode = pass ? 0 : 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})().catch(e => { console.error('FIDELITY TEST FAILED', e.stack || e); process.exit(2); });
