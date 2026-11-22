// Renders the rotatable-camera experiment from a set of camera positions and reports the re-bake cost.
// Usage: NODE_PATH=$(npm root -g) node render.cjs <output-dir>
// Read-only towards the experiment page: it sets the camera, steps the animation and reads the canvas.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2];
fs.mkdirSync(outDir, { recursive: true });
const page = 'file://' + path.resolve(__dirname, 'index.html');
const D = Math.PI / 180;
const SHOTS = [
  { id: '01-default', label: '原视角 yaw 0 pitch 30 zoom 1.0', cam: {} },
  { id: '02-yaw030', label: 'yaw 30', cam: { yaw: 30 * D } },
  { id: '03-yaw045', label: 'yaw 45', cam: { yaw: 45 * D } },
  { id: '04-yaw090', label: 'yaw 90', cam: { yaw: 90 * D } },
  { id: '05-yaw180', label: 'yaw 180（背面）', cam: { yaw: 180 * D } },
  { id: '06-yaw270', label: 'yaw 270', cam: { yaw: 270 * D } },
  { id: '07-pitch015', label: '压低 pitch 15', cam: { pitch: 15 * D } },
  { id: '08-pitch055', label: '抬高 pitch 55', cam: { pitch: 55 * D } },
  { id: '09-zoomout', label: '拉远 zoom 0.5', cam: { scale: 5 } },
  { id: '10-zoomin', label: '拉近 zoom 1.8', cam: { scale: 18 } },
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const tab = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 1 });
  const errors = [];
  tab.on('pageerror', e => errors.push('pageerror: ' + e.message));
  tab.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await tab.goto(page);
  await tab.waitForTimeout(800);
  const report = [];
  for (const shot of SHOTS) {
    const r = await tab.evaluate(async (cam) => {
      Object.assign(window.__cam.CAM, { yaw: 0, pitch: Math.PI / 6, scale: 10, panX: 0, panY: 0 }, cam);
      // time several re-bakes of the same view and keep the median
      const times = [];
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        window.__cam.apply();
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      for (let i = 0; i < 40; i++) window.__stari.step(1 / 60, false); // let wind, water and tourists settle
      const c = document.getElementById('c'), d = new Uint32Array(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.buffer);
      let white = 0; const colors = new Set();
      for (let i = 0; i < d.length; i++) { colors.add(d[i]); if ((d[i] & 0xffffff) === 0xffffff) white++; }
      return { bakeMs: +times[3].toFixed(1), nonWhite: +(1 - white / d.length).toFixed(3), colors: colors.size, leaves: leaves.length, tufts: tufts.length, png: c.toDataURL('image/png') };
    }, shot.cam);
    fs.writeFileSync(path.join(outDir, shot.id + '.png'), Buffer.from(r.png.split(',')[1], 'base64'));
    delete r.png;
    report.push({ id: shot.id, label: shot.label, ...r });
    console.log(shot.id.padEnd(13), shot.label.padEnd(24), JSON.stringify(r));
  }
  // what one interactive frame costs while nothing about the camera changes
  const idle = await tab.evaluate(() => { const t = performance.now(); for (let i = 0; i < 300; i++) window.__stari.step(1 / 60, false); return +((performance.now() - t) / 300).toFixed(2); });
  // how a re-bake splits between the per-screen-pixel ground pass and the world-sampled geometry
  const split = await tab.evaluate(() => {
    Object.assign(window.__cam.CAM, { yaw: 0, pitch: Math.PI / 6, scale: 10, panX: 0, panY: 0 });
    window.__cam.apply();
    const g = []; let groundPx = 0;
    for (let k = 0; k < 5; k++) {
      const t = performance.now(); groundPx = 0;
      for (let iy = 0; iy < H; iy++) for (let ix = 0; ix < W; ix++) {
        const p = unproject(ix + .5, iy + .5), i = iy * W + ix;
        if (groundColor(p.x, p.y, ix, iy, i)) groundPx++;
      }
      g.push(performance.now() - t);
    }
    g.sort((a, b) => a - b);
    return { groundPassMs: +g[2].toFixed(1), groundPx };
  });
  console.log('idle frame (camera unchanged):', idle, 'ms | ground pass alone:', JSON.stringify(split));
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ idleFrameMs: idle, bakeSplit: split, shots: report, errors }, null, 2));
  console.log('page errors:', errors.length ? errors : 'none');
  await browser.close();
})().catch(e => { console.error('RENDER FAILED', e.message); process.exit(1); });
