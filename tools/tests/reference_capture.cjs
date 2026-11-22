// Freezes the CPU reference renderer into fixed camera positions and exports, for each of them, the raw
// pixels and depth of the baked static scene and of one full frame, plus every sphere and shadow ellipse.
// The WebGL port is compared against these files by tools/tests/fidelity.cjs.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/reference_capture.cjs [out-dir]
// Output defaults to out/fidelity/cpu. Nothing in the repository is modified.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const out = path.resolve(root, process.argv[2] || 'out/fidelity/cpu');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PRESETS = {
  default: {},
  yaw30: { yaw: Math.PI / 6 },
  yaw180: { yaw: Math.PI },
  pitch50: { pitch: 50 * Math.PI / 180 },
  zoom18: { scale: 18 },
};

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    // the game loop must never run on its own: every frame here is drawn explicitly
    await page.addInitScript(() => { window.requestAnimationFrame = () => 0; window.cancelAnimationFrame = () => {}; });
    await page.goto('file://' + path.join(root, 'tools/reference-cpu/index.html'));
    await page.addScriptTag({ path: path.join(root, 'tools/reference-cpu/freeze.js') });

    fs.writeFileSync(path.join(out, 'constants.json'), JSON.stringify(await page.evaluate(() => window.__freeze.constants())));
    const write = (file, b64) => fs.writeFileSync(path.join(out, file), Buffer.from(b64, 'base64'));
    const save = (tag, buf) => {
      write(`${tag}.pix`, buf.pix);
      write(`${tag}.zb`, buf.zb);
      write(`${tag}.png`, buf.png);
      write(`${tag}.edges`, buf.edges);
      for (const key of ['groundZ', 'ground', 'kinds', 'staticShadow', 'shadowMask']) write(`${tag}.${key}`, buf[key]);
    };
    for (const [name, preset] of Object.entries(PRESETS)) {
      const baked = await page.evaluate(p => window.__freeze.bake(p), preset);
      const stat = await page.evaluate(() => window.__freeze.buffers('static'));
      const dynamic = await page.evaluate(() => window.__freeze.frame());
      const full = await page.evaluate(() => window.__freeze.buffers('full'));
      save(`${name}.static`, stat);
      save(`${name}.full`, full);
      fs.writeFileSync(path.join(out, `${name}.scene.json`), JSON.stringify({ preset, camera: full.camera, bakeMs: baked.bakeMs, static: { spheres: baked.spheres, discs: baked.discs }, dynamic }));
      console.log(name.padEnd(8), 'bake', baked.bakeMs.toFixed(0).padStart(4), 'ms | static spheres', String(baked.spheres.length).padStart(4), 'discs', String(baked.discs.length).padStart(5),
        '| dynamic spheres', String(dynamic.spheres.length).padStart(4), 'discs', String(dynamic.discs.length).padStart(4), '| yaw', full.camera.yaw.toFixed(2), 'pitch', full.camera.pitch.toFixed(2), 'scale', full.camera.scale);
    }
  } finally {
    await browser.close();
  }
  console.log('page errors:', errors.length ? errors : 'none');
  console.log('written to', out);
})().catch(e => { console.error('CAPTURE FAILED', e.stack); process.exit(1); });
