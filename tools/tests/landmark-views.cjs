// What can be seen of each landmark in the view its name flies to.
//
// A landmark built by hand is drawn again in one flat colour over the finished frame, with the depth the
// scene left: what passes the depth test can be seen, the rest is hidden behind something (a tree, a
// block of flats that the bake should have cleared). A landmark that is a place, drawn from the map, has
// nothing to redraw; for those the view is checked to be full, not white.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/landmark-views.cjs
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5396;
const SIDES = [0, 2 * Math.PI / 3, 4 * Math.PI / 3];

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// what a landmark built by hand has to show in its view: the least that can be made out, and whether
// what is seen must sit at the centre of the frame (a causeway runs across it instead)
// the colours the models are built from (landmarks/index.js ROLES): a landmark seen in its view must be
// painted in its own colours. It was not, for a while: the buildings' shader read every wall as the first
// colour of the table (D048)
const KIT_COLOURS = ['stone_pale', 'tile_dark', 'whitewash_aged', 'wood_dark', 'metal_pale', 'temple_red', 'paving', 'metal_dark', 'rail',
  'concrete_pale', 'panel_white', 'pitch'];
const OWN_COLOUR_SHARE = 0.25;
const LINEAR = ['1-05', '2-03'];            // the causeway's six bridges, and the pagoda with a kilometre and a half of steel bridge
const BUILT_LEAST = { '1-05': 60, '2-03': 800 };     // the pagoda is small in a view that holds the bridge too
const OFF_CENTRE_PX = 40, SEEN_SHARE = 0.4, PLACE_COVER = 0.4;

(async () => {
  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
  const rows = [];
  try {
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${PORT}/hz`)).ok) break;
      } catch {
        // not up yet
      }
      await wait(200);
    }
    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${PORT}/hz`);
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
    const ids = await page.evaluate(() => window.__city.landmarks.map(l => l.id));

    // every shade of every colour the models are built from, as the page makes them
    const kitColours = await page.evaluate(async names => {
      const { rampOf, channels } = await import('/src/style/core.js');
      const colours = (await fetch('/palette.json').then(r => r.json())).colours;
      return names.flatMap(name => rampOf(colours[name]).map(packed => channels(packed).join(',')));
    }, KIT_COLOURS);

    // the measure in the frame as it stands, made afresh and still (no wind, no traffic moved)
    const measure = id => page.evaluate(async ({ id, kitColours }) => {
      const app = window.__city, own = new Set(kitColours);
      app.freeze(true);
      await app.settle(30000);
      app.renderOnce();
      const W = app.renderer.W, H = app.renderer.H;
      // what the page shows, read back from the canvas: the share of it that is painted
      const shown = new Uint8Array(W * H * 4);
      app.gl.readPixels(0, 0, W, H, app.gl.RGBA, app.gl.UNSIGNED_BYTE, shown);
      const m = app.landmarkMask(id);
      app.renderOnce();
      let middle = 0, whole = 0, seen = 0, painted = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const at = ((H - 1 - y) * W + x) * 4;
        const key = `${shown[at]},${shown[at + 1]},${shown[at + 2]}`;
        if (m.cover && m.cover[y * W + x] === 2) { seen++; if (own.has(key)) painted++; }
        if (shown[at] >= 248 && shown[at + 1] >= 248 && shown[at + 2] >= 248) continue;
        whole++;
        if (Math.abs(x - W / 2) < W / 4 && Math.abs(y - H / 2) < H / 4) middle++;
      }
      const landmark = app.landmarks.find(l => l.id === id);
      return {
        // the ground under the landmark as the page reads it from the tile, against the height the bake wrote
        ground: [app.world.groundAt(landmark.x, landmark.y), landmark.ground ?? 0],
        all: m.all, seen: m.seen, box: m.box,
        centre: m.box ? [Math.round((m.box[0] + m.box[2]) / 2 - W / 2), Math.round((m.box[1] + m.box[3]) / 2 - H / 2)] : null,
        scale: app.camera.scale, cover: middle / (W / 2 * H / 2), whole: whole / (W * H),
        own: seen ? painted / seen : 0,
      };
    }, { id, kitColours });

    // every landmark by its name, seen from three sides: the view is bound afresh for each
    for (const id of ids) {
      const clicks = [];
      for (const yaw of SIDES) {
        await page.evaluate(({ id, yaw }) => { window.__city.camera.yaw = yaw; window.__city.flyTo(id, 0); }, { id, yaw });
        await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 20000 });
        clicks.push(await measure(id));
      }
      const built = await page.evaluate(id => window.__city.landmarks.find(l => l.id === id).parts.length, id);
      rows.push({ id, built, clicks });
    }

    console.log('the view a name flies to, seen from three sides. Built by hand: pixels that can be seen of all that');
    console.log('are in the frame, the box they make, where its middle lies from the centre of the frame, and how much');
    console.log('of what can be seen is painted in the colours of its model. A place: how much of the middle of the');
    console.log('view, and of the whole, is painted.');
    for (const { id, built, clicks } of rows) {
      const cell = m => {
        if (!built) return `${(100 * m.cover).toFixed(0)}% / ${(100 * m.whole).toFixed(0)}%`.padEnd(30);
        if (!m.all) return 'nothing in frame';
        const w = m.box[2] - m.box[0] + 1, h = m.box[3] - m.box[1] + 1;
        return `${String(m.seen).padStart(5)}/${String(m.all).padStart(5)} ${String(w).padStart(3)}x${String(h).padStart(3)} at ${m.centre.join(',')} own ${(100 * m.own).toFixed(0)}%`.padEnd(44);
      };
      console.log(`${id}  ${clicks.map(cell).join('  ')}  ${clicks[0].scale.toFixed(2)} px/m`);
    }
    for (const { id, built, clicks } of rows) {
      if (!built) {
        check(clicks.every(m => m.cover >= PLACE_COVER), `${id}: the middle of the view is a place, not white (${clicks.map(m => `${(100 * m.cover).toFixed(0)}%`).join(', ')})`);
        continue;
      }
      const least = BUILT_LEAST[id] ?? 1500, centred = m => LINEAR.includes(id) || Math.hypot(...m.centre) <= OFF_CENTRE_PX;
      const good = clicks.filter(m => m.seen >= least && m.seen >= m.all * SEEN_SHARE && m.centre && centred(m)).length;
      check(good >= 2, `${id}: seen from ${good} of 3 sides (needs 2): ${clicks.map(m => `${m.seen}/${m.all} at ${m.centre}`).join(', ')}`);
      const painted = clicks.filter(m => m.own >= OWN_COLOUR_SHARE).length;
      check(painted >= 2, `${id}: painted in its own colours from ${painted} of 3 sides (${clicks.map(m => `${(100 * m.own).toFixed(0)}%`).join(', ')} of what can be seen)`);
    }
    const off = rows.flatMap(({ id, clicks }) => clicks.map(m => ({ id, gap: Math.abs(m.ground[0] - m.ground[1]) }))).filter(m => m.gap > 0.05);
    check(off.length === 0, `the ground under a landmark is the same to the page and to the bake (${off.slice(0, 3).map(m => `${m.id} ${m.gap}`).join(', ')})`);
    check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  } catch (error) {
    failures.push(String(error.stack || error.message).split('\n').slice(0, 3).join(' '));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  if (failures.length) {
    console.log('LANDMARK VIEWS FAILED');
    failures.forEach(message => console.log('  -', message));
    process.exitCode = 1;
  } else {
    console.log('landmark views OK');
  }
})();
