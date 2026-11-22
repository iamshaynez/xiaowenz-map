// Gate G2: how long a frame takes at each zoom tier, on this machine's real GPU, with the real data.
//
// The gate in the plan: at least 60 frames a second, and the 95th percentile of frames under 20 ms,
// for the overview tier at 960x540 and for the district and street tiers at 640x400.
//
// Each frame is timed on its own. The only way a browser lets you know that the GPU has finished is
// to read a pixel back, so every timed frame ends with a 1-pixel read; that read costs about 0.8 ms
// and is part of what is measured, which errs on the safe side.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/throughput.cjs [--ss 2,4] [--frames 200] [--only a,b] [--out name]
//   --out name   also saves the results to out/g2/<name>.json
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5397;
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const SUPERSAMPLING = flag('--ss', '2,4').split(',').map(Number);
const FRAMES = Number(flag('--frames', '200'));

// The densest part of the old city (120.168 E, 30.279 N), where the most buildings are on screen at each
// tier; in world metres, as the pipeline's projection places it.
const CENTRE = [27572.51, 13097.93];
// (120.132 E, 30.229 N) and (120.150 E, 30.261 N) in the same metres
const LONGJING = [23968.08, 7640.83], BEISHAN = [25790.19, 11145.42];   // from hz.region.project, not from memory
const CASES = [
  { name: 'overview', viewport: [1920, 1080], frame: [960, 540], setup: '' },
  { name: 'district-widest', viewport: [1920, 1080], frame: [960, 540], setup: 'c.scale = 0.125;' },
  { name: 'district-640', viewport: [1280, 800], frame: [640, 400], setup: 'c.scale = 0.125;' },
  { name: 'street-640', viewport: [1280, 800], frame: [640, 400], setup: 'c.scale = 6;' },
  // trees are only drawn from 0.4 pixels per metre up: the wooded hills south-west of West Lake, where
  // a frame holds the most of them, and the plane trees of Beishan Street along the lake
  { name: 'woods-640', viewport: [1280, 800], frame: [640, 400], setup: 'c.scale = 0.5;', centre: LONGJING },
  { name: 'street-trees-640', viewport: [1280, 800], frame: [640, 400], setup: 'c.scale = 3;', centre: BEISHAN },
];
const ONLY = flag('--only', '').split(',').filter(Boolean);
const OUT = flag('--out', '');

async function run() {
  const results = [];
  for (const ss of SUPERSAMPLING) {
    for (const test of CASES) {
      if (ONLY.length && !ONLY.includes(test.name)) continue;
      const browser = await chromium.launch({ executablePath: CHROME, headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: test.viewport[0], height: test.viewport[1] } });
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        await page.goto(`http://127.0.0.1:${PORT}/app/?ss=${ss}`);
        await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
        const result = await page.evaluate(async ({ setup, centre, frames }) => {
          const app = window.__hz, c = app.camera, gl = app.gl;
          [c.x, c.y] = centre;
          new Function('c', setup)(c);
          app.touch();
          await new Promise(resolve => setTimeout(resolve, 100));
          const settled = await app.settle(120000);
          // warm up, then time each frame on its own
          const pixel = new Uint8Array(4), times = [];
          for (let k = 0; k < 20; k++) { app.renderer.render(app.world); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); }
          for (let k = 0; k < frames; k++) {
            const start = performance.now();
            app.renderer.render(app.world);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            times.push(performance.now() - start);
          }
          app.touch();
          const sorted = times.slice().sort((a, b) => a - b);
          return {
            ms: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
            p50: +sorted[Math.floor(frames * 0.5)].toFixed(2),
            p95: +sorted[Math.floor(frames * 0.95)].toFixed(2),
            max: +sorted[frames - 1].toFixed(2),
            tiles: settled.tiles, drawn: { ...app.renderer.drawn }, frame: [app.renderer.W, app.renderer.H, app.renderer.SS],
            glError: gl.getError(),
          };
        }, { setup: test.setup, centre: test.centre || CENTRE, frames: FRAMES });
        results.push({ ss, ...test, ...result, errors });
        console.log(`ss ${ss}  ${test.name.padEnd(15)} ${result.frame.join('x').padEnd(10)} tiles ${String(result.drawn.tiles).padStart(3)}  triangles ${String(Math.round(result.drawn.triangles)).padStart(8)}  trees ${String(result.drawn.trees).padStart(6)}  mean ${String(result.ms).padStart(6)} ms  p95 ${String(result.p95).padStart(6)} ms  max ${String(result.max).padStart(6)} ms  gl ${result.glError}${errors.length ? '  ERRORS ' + errors[0] : ''}`);
      } finally {
        await browser.close();
      }
    }
  }
  return results;
}

(async () => {
  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/app/`)).ok) break;
      } catch {
        // not up yet
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const results = await run();
    console.log('JSON ' + JSON.stringify(results));
    if (OUT) {
      fs.mkdirSync(path.join(root, 'out/g2'), { recursive: true });
      fs.writeFileSync(path.join(root, `out/g2/${OUT}.json`), JSON.stringify({ date: new Date().toISOString(), results }, null, 1) + '\n');
    }
  } catch (error) {
    console.error('THROUGHPUT TEST FAILED', error.stack || error);
    process.exitCode = 2;
  } finally {
    server.kill();
  }
})();
