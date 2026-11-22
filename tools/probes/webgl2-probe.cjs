// WebGL2 capability and throughput probe for this machine's Chrome.
// Usage: NODE_PATH="$(npm root -g)" node tools/probes/webgl2-probe.cjs [--headed]
// Launches Chrome headless by default (or headed with --headed, which is how a real GPU is most reliably reached),
// runs an in-page probe and prints labelled lines. Nothing is written to disk.
const { chromium } = require('playwright');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const headed = process.argv.includes('--headed');
const CONFIGS = [
  { tag: 'A', name: 'default', args: [] },
  { tag: 'B', name: 'metal-flags', args: ['--use-angle=metal', '--ignore-gpu-blocklist'] },
];

function probeFn() {
  const W = 960, H = 540, out = { failures: [] };
  const fail = m => out.failures.push(m);
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: false, depth: true, stencil: false, powerPreference: 'high-performance' });
  out.webgl2 = !!gl;
  if (!gl) return out;
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    out.unmasked_renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
    out.unmasked_vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null;
  } catch (e) { fail('renderer_info:' + e.message); }
  out.limits = {};
  for (const k of ['MAX_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_SAMPLES', 'MAX_DRAW_BUFFERS', 'MAX_VERTEX_ATTRIBS',
    'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_TEXTURE_IMAGE_UNITS',
    'MAX_ELEMENTS_VERTICES', 'MAX_ELEMENTS_INDICES']) {
    try { out.limits[k] = gl.getParameter(gl[k]); } catch (e) { out.limits[k] = 'ERR'; }
  }
  out.extensions = (gl.getSupportedExtensions() || []).slice().sort();
  out.fbo = {};
  const textureFbo = (colorInt, colorType, depthInt, depthAttach) => {
    const fbo = gl.createFramebuffer(), ct = gl.createTexture(), dt = gl.createTexture();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.bindTexture(gl.TEXTURE_2D, ct);
    gl.texImage2D(gl.TEXTURE_2D, 0, colorInt, 64, 64, 0, gl.RGBA, colorType, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ct, 0);
    gl.bindTexture(gl.TEXTURE_2D, dt);
    gl.texImage2D(gl.TEXTURE_2D, 0, depthInt, 64, 64, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, depthAttach, gl.TEXTURE_2D, dt, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo); gl.deleteTexture(ct); gl.deleteTexture(dt);
    return ok;
  };
  try {
    out.fbo.rgba8_depth24 = textureFbo(gl.RGBA8, gl.UNSIGNED_BYTE, gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT);
    out.fbo.rgba16f_depth24 = textureFbo(gl.RGBA16F, gl.HALF_FLOAT, gl.DEPTH_COMPONENT24, gl.DEPTH_ATTACHMENT);
    // two colour attachments (MRT) + depth
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const tex = [0, 1].map(() => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); return t; });
    tex.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    out.fbo.mrt2_rgba8 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  } catch (e) { fail('fbo:' + e.message); }

  out.bench = {};
  try {
    canvas.width = W; canvas.height = H;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    const link = (vs, fs) => { const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(p, s); }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) fail('link:' + gl.getProgramInfoLog(p));
      return p; };
    const FS = '#version 300 es\nprecision lowp float;out vec4 o;void main(){o=vec4(0.5,0.5,0.5,1.0);}';
    gl.useProgram(link('#version 300 es\nlayout(location=0) in vec3 aPos;void main(){gl_Position=vec4(aPos,1.0);}', FS));
    let seed = 0x9e3779b9 >>> 0;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    // 5M random triangles, 6-12 px across, spread over depth
    const MAXTRI = 5000000, data = new Float32Array(MAXTRI * 9);
    let p = 0;
    for (let t = 0; t < MAXTRI; t++) {
      const cx = (rnd() * 2 - 1) * .98, cy = (rnd() * 2 - 1) * .98, z = rnd() * 2 - 1, rot = rnd() * 6.2831853, r = .006 + rnd() * .003;
      for (let k = 0; k < 3; k++) { const a = rot + k * 2.0943951; data[p++] = cx + Math.cos(a) * r; data[p++] = cy + Math.sin(a) * r; data[p++] = z; }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    // gl.finish() does not wait for the GPU in Chrome; reading a pixel back does.
    const scratch = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
    const t0 = performance.now();
    sync();
    out.bench.sync_readpixels_ms = +(performance.now() - t0).toFixed(3);
    const timeCalls = draw => { let best = Infinity; for (let rep = 0; rep < 3; rep++) { const t0 = performance.now();
      for (let d = 0; d < 20; d++) draw(); sync(); best = Math.min(best, (performance.now() - t0) / 20); } return best; };
    for (const [name, tri] of [['100k', 100000], ['1M', 1000000], ['5M', 5000000]]) {
      gl.disable(gl.DEPTH_TEST);
      const ms = timeCalls(() => gl.drawArrays(gl.TRIANGLES, 0, tri * 3));
      out.bench['tri' + name + '_nodepth_ms'] = +ms.toFixed(2);
      if (ms > 60) { out.bench['tri' + name + '_depth_ms'] = 'skipped (slow)'; break; } // software renderer: do not wait minutes
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      out.bench['tri' + name + '_depth_ms'] = +timeCalls(() => gl.drawArrays(gl.TRIANGLES, 0, tri * 3)).toFixed(2);
    }
    // 200k instanced cubes (12 triangles each = 2.4M triangles) with depth
    gl.useProgram(link('#version 300 es\nlayout(location=0) in vec3 aPos;layout(location=1) in vec3 aOff;void main(){gl_Position=vec4(aPos*0.008+aOff,1.0);}', FS));
    // six faces, two triangles each, unit cube
    const F = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,-1,1],[1,1,1],[-1,1,1], [1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,-1,-1],[-1,1,-1],[1,1,-1],
               [1,-1,1],[1,-1,-1],[1,1,-1],[1,-1,1],[1,1,-1],[1,1,1], [-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,-1,-1],[-1,1,1],[-1,1,-1],
               [-1,1,1],[1,1,1],[1,1,-1],[-1,1,1],[1,1,-1],[-1,1,-1], [-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,-1],[1,-1,1],[-1,-1,1]];
    const bufs = [new Float32Array(F.flat()), (() => { const o = new Float32Array(600000); for (let i = 0; i < o.length; i++) o[i] = (rnd() * 2 - 1) * .98; return o; })()];
    bufs.forEach((arr, i) => { gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 0, 0); });
    gl.vertexAttribDivisor(1, 1);
    out.bench.inst200k_cube_depth_ms = +timeCalls(() => gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, 200000)).toFixed(2);
  } catch (e) { fail('bench:' + e.message); }
  return out;
}

(async () => {
  for (const cfg of CONFIGS) {
    console.log(`\n===== ${cfg.tag} | ${cfg.name} | ${headed ? 'headed' : 'headless'} =====`);
    let browser;
    try {
      browser = await chromium.launch({ executablePath: CHROME, args: cfg.args, headless: !headed });
    } catch (e) { console.log(cfg.tag + ' LAUNCH_FAILED ' + String(e.message).split('\n')[0]); continue; }
    try {
      const page = await browser.newPage();
      await page.goto('about:blank');
      const r = await page.evaluate(probeFn);
      const L = (k, v) => console.log(cfg.tag + ' ' + k + '=' + v);
      L('chrome_version', browser.version());
      L('webgl2', r.webgl2);
      if (r.limits) for (const [k, v] of Object.entries(r.limits)) L('limit_' + k, v);
      L('renderer', r.unmasked_renderer);
      L('vendor', r.unmasked_vendor);
      if (r.extensions) L('extensions', r.extensions.join(','));
      for (const [k, v] of Object.entries(r.fbo || {})) L('fbo_' + k, v);
      for (const [k, v] of Object.entries(r.bench || {})) L('bench_' + k, v);
      L('failures', r.failures.length ? r.failures.join(' | ') : 'none');
    } finally { await browser.close(); }
  }
})().catch(e => { console.error('PROBE FAILED', e.stack); process.exit(1); });
