// The long roam: for a while the page is driven at random — flights to landmarks, jumps across the city,
// drags, zooms, keys, seasons — while it is watched for errors, a lost graphics context, and memory that
// keeps growing. Nothing should happen; the point is to prove it by running long enough.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/roam.cjs [--minutes 10] [--seed 7]
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const outDir = path.join(root, 'out/roam');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5394;
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : fallback);
const MINUTES = flag('--minutes', 1);
let seed = flag('--seed', 20261123);
const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const median = values => { const s = [...values].sort((a, b) => a - b); return s[s.length >> 1]; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/app/`)).ok) break;
      } catch {
        // not up yet
      }
      await wait(200);
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    page.on('crash', () => errors.push('page crashed'));
    await page.goto(`http://127.0.0.1:${PORT}/app/`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    const ids = await page.evaluate(() => window.__hz.landmarks.map(l => l.id));
    const bounds = await page.evaluate(() => window.__hz.index.bounds);
    const seasons = await page.evaluate(() => window.__hz.seasons);

    const sample = () => page.evaluate(() => {
      const app = window.__hz;
      return {
        heap: performance.memory ? performance.memory.usedJSHeapSize : null,
        tiles: app.world.tiles.size, pending: app.world.pending.size,
        traffic: app.renderer.traffic.boxes.length + app.renderer.traffic.folks.length,
        lost: app.gl.isContextLost(), glError: app.gl.getError(),
        scale: app.camera.scale,
      };
    });
    const samples = [];
    const frames = [];
    const actions = { fly: 0, jump: 0, drag: 0, zoom: 0, keys: 0, season: 0, turn: 0 };
    const start = Date.now();
    let lastBench = 0, lastSample = 0;
    while (Date.now() - start < MINUTES * 60000) {
      const pick = random();
      if (pick < 0.22) {
        await page.evaluate(id => window.__hz.flyTo(id, 1.2), ids[(random() * ids.length) | 0]);
        actions.fly++;
      } else if (pick < 0.40) {
        // a jump to anywhere, at any zoom
        await page.evaluate(({ x, y, scale, pitch, yaw }) => {
          const c = window.__hz.camera;
          Object.assign(c, { x, y, scale: Math.exp(scale), pitch, yaw });
          window.__hz.touch();
        }, { x: bounds[0] + random() * (bounds[2] - bounds[0]), y: bounds[1] + random() * (bounds[3] - bounds[1]), scale: Math.log(0.004) + random() * (Math.log(24) - Math.log(0.004)), pitch: 0.26 + random() * 1.19, yaw: random() * 6.283 });
        actions.jump++;
      } else if (pick < 0.60) {
        const x = 400 + random() * 1100, y = 200 + random() * 700;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + (random() - 0.5) * 500, y + (random() - 0.5) * 300, { steps: 4 + ((random() * 8) | 0) });
        await page.mouse.up();
        actions.drag++;
      } else if (pick < 0.72) {
        await page.mouse.move(960, 540);
        await page.mouse.wheel(0, (random() - 0.5) * 2400);
        actions.zoom++;
      } else if (pick < 0.86) {
        const key = ['w', 'a', 's', 'd', 'ArrowUp', 'ArrowLeft'][ (random() * 6) | 0];
        await page.keyboard.down(key);
        await wait(150 + random() * 500);
        await page.keyboard.up(key);
        actions.keys++;
      } else if (pick < 0.92) {
        await page.evaluate(name => window.__hz.setSeason(name), seasons[(random() * seasons.length) | 0]);
        actions.season++;
      } else {
        await page.keyboard.press(random() < 0.5 ? 'm' : 'r');
        actions.turn++;
      }
      await wait(120 + random() * 500);
      const elapsed = Date.now() - start;
      if (elapsed - lastSample > 5000) {
        lastSample = elapsed;
        samples.push({ t: Math.round(elapsed / 1000), ...(await sample()) });
      }
      if (elapsed - lastBench > 30000) {
        lastBench = elapsed;
        // a frame timed where the camera happens to be, at a low resolution so that the GPU is the limit
        frames.push({ t: Math.round(elapsed / 1000), ...(await page.evaluate(() => { const b = window.__hz.bench(30); return { ms: b.ms, scale: +b.scale.toFixed(3), glError: b.glError }; })) });
      }
    }
    await page.evaluate(() => window.__hz.setSeason('summer'));
    await page.screenshot({ path: path.join(outDir, 'end.png') });

    // ---- the verdict ----------------------------------------------------------------------------------------
    const lost = samples.filter(s => s.lost).length;
    const glErrors = samples.filter(s => s.glError).length + frames.filter(f => f.glError).length;
    check(errors.length === 0, `page errors: ${errors.slice(0, 5).join(' | ')}`);
    check(lost === 0, `the graphics context was lost in ${lost} samples`);
    check(glErrors === 0, `GL errors in ${glErrors} samples`);
    const heaps = samples.map(s => s.heap).filter(Number.isFinite);
    let heapReport = 'heap sizes not available';
    if (heaps.length > 6) {
      const first = median(heaps.slice(0, Math.max(3, heaps.length >> 2))), last = median(heaps.slice(-Math.max(3, heaps.length >> 2)));
      heapReport = `JS heap: median ${first} early, ${last} late (${(100 * last / first - 100).toFixed(0)}%)`;
      check(last < first * 1.5, heapReport);
    }
    const maxTiles = Math.max(...samples.map(s => s.tiles));
    check(maxTiles <= 300, `at most 300 tiles kept (${maxTiles})`);
    const trafficMax = Math.max(...samples.map(s => s.traffic));
    check(frames.length === 0 || frames.every(f => f.ms < 20), `every timed frame under 20 ms: ${frames.map(f => f.ms.toFixed(1)).join(', ')}`);
    const report = {
      minutes: MINUTES, actions, samples: samples.length,
      maxTiles, trafficMax, heapReport,
      frames: frames.map(f => `${f.t}s ${f.ms.toFixed(2)} ms at ${f.scale} px/m`),
      errors,
    };
    fs.writeFileSync(path.join(outDir, `roam-${MINUTES}m.json`), JSON.stringify({ ...report, samples }, null, 1));
    console.log(JSON.stringify({ ...report, errors: errors.slice(0, 5) }, null, 1));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
}

main().catch(error => {
  failures.push(String(error.stack || error.message).split('\n').slice(0, 3).join(' '));
}).finally(() => {
  if (failures.length) {
    console.log('ROAM FAILED');
    failures.forEach(message => console.log('  -', message));
    process.exitCode = 1;
  } else {
    console.log('roam OK');
  }
});
