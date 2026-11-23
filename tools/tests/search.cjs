// Finding a place by name, in the real page. What is checked: the box and the answers under it, the keys (the
// box's own keys stay in the box), the flight to what is chosen, that what is drawn over the map lies on the
// street or the place itself, that the note names it without covering the readout, that Escape and the way back
// clear it, that a landmark of the list goes the way its name in the list goes, ?find=<name> on opening, and the
// same on a phone.
//
// Usage: NODE_PATH="$(npm root -g)" node tools/tests/search.cjs [out-dir]
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const outDir = path.resolve(root, process.argv[2] || 'out/search');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 5392;
const INK = [28, 27, 25];        // the page's ink (index.html: --ink)
const RING = [];                 // the ring round a place: where its pixels lie from its centre
for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) if (Math.hypot(x, y) > 2.5 && Math.hypot(x, y) <= 3.5) RING.push([x, y]);
const ON_COURSE_PX = 2;          // ink may lie this far from the course the index holds, in pixels
const ON_STREET_M = 5;           // ... and the course this far from the street the map draws traffic on, in metres
const OFF_STREET_SHARE = 0.1;    // ... save for this share of its points: a piece the traffic does not use (a short slip road, a tunnel)

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const same = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-9);

// what the page shows around a search
const state = page => page.evaluate(() => {
  const app = window.__city, note = document.getElementById('note');
  const rect = id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; };
  const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  return {
    camera: [app.camera.x, app.camera.y, app.camera.scale, app.camera.pitch, app.camera.yaw],
    season: document.body.dataset.season, touring: app.ui.touring(), flying: app.flying(),
    focused: document.activeElement ? document.activeElement.id : null,
    words: document.getElementById('find').value,
    answers: [...document.querySelectorAll('#results button')].map(b => ({ text: b.textContent, current: b.classList.contains('current') })),
    waiting: [...document.querySelectorAll('#results .waiting')].map(li => li.textContent),
    found: app.found() ? app.found().title : null,
    note: note.hidden ? null : [document.getElementById('note-title').textContent, document.getElementById('note-text').textContent],
    noteOverReadout: !note.hidden && overlaps(rect('note'), rect('readout')),
    boxes: { map: rect('c'), mark: rect('mark'), find: rect('find'), answers: rect('results'), tools: rect('tools') },
    frame: [app.camera.width, app.camera.height],
    overflow: document.scrollingElement.scrollWidth > innerWidth || document.scrollingElement.scrollHeight > innerHeight,
  };
});

// where the ink is on the page's own pixel grid
const inkPixels = page => page.evaluate(ink => {
  const canvas = document.getElementById('mark'), data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, out = [];
  for (let k = 0; k < data.length; k += 4) if (data[k + 3] === 255 && data[k] === ink[0] && data[k + 1] === ink[1] && data[k + 2] === ink[2]) out.push([(k / 4) % canvas.width, Math.floor(k / 4 / canvas.width)]);
  return out;
}, INK);

// how far the ink lies from the course of the thing found, as the camera sees it
const onCourse = page => page.evaluate(async limit => {
  const app = window.__city, { course } = await import('/src/world/names.js');
  const found = app.found(), row = (await app.search(found.title)).find(r => r.name === found.title && r.x === found.x && r.y === found.y);
  const points = row ? course(app.index(), row.k) : null;
  if (!points) return { row: Boolean(row), ink: 0, far: 0, worst: 0 };
  const camera = app.camera, projected = [];
  for (let at = 0; at < points.length; at += 3) {
    const x = points[at], y = points[at + 1], z = points[at + 2];
    if (Number.isFinite(x)) { const p = camera.project(x, y, z); projected.push([p.sx, p.sy]); } else projected.push(null);   // a break between pieces
  }
  const canvas = document.getElementById('mark'), data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const toSegment = (px, py, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t);
  };
  let ink = 0, far = 0, worst = 0;
  for (let k = 0; k < data.length; k += 4) {
    if (data[k + 3] !== 255 || data[k] !== 28 || data[k + 1] !== 27 || data[k + 2] !== 25) continue;
    const px = (k / 4) % canvas.width, py = Math.floor(k / 4 / canvas.width);
    ink++;
    let best = Infinity;
    for (let s = 1; s < projected.length; s++) if (projected[s - 1] && projected[s]) best = Math.min(best, toSegment(px, py, projected[s - 1], projected[s]));
    worst = Math.max(worst, best);
    if (best > limit) far++;
  }
  return { row: true, ink, far, worst };
}, ON_COURSE_PX);

// how far the course of the thing found lies from the streets the map draws traffic on (the tiles' PATH lines)
const onStreet = page => page.evaluate(async limit => {
  const app = window.__city, { course } = await import('/src/world/names.js');
  const found = app.found(), row = (await app.search(found.title)).find(r => r.name === found.title && r.x === found.x && r.y === found.y);
  const points = course(app.index(), row.k), world = app.world, size = world.index.tileSize;
  const toSegment = (px, py, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t);
  };
  let worst = 0, count = 0, missing = 0;
  const off = [];
  for (let at = 0; at < points.length; at += 3) {
    const x = points[at], y = points[at + 1];
    if (!Number.isFinite(x)) continue;                                     // a break between pieces
    let best = Infinity;
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {      // the tile the point is in, and those round it
      const tile = world.tiles.get(`${Math.floor(x / size) - world.index.ix0 + ox}_${Math.floor(y / size) - world.index.iy0 + oy}`);
      for (const line of (tile && tile.paths) || []) {
        if (line.cls < 5 || line.cls > 10) continue;                         // streets and walkways, not boat routes
        for (let i = 4; i < line.points.length; i += 4) best = Math.min(best, toSegment(x, y, [tile.x0 + line.points[i - 4], tile.y0 + line.points[i - 3]], [tile.x0 + line.points[i], tile.y0 + line.points[i - 1]]));
      }
    }
    if (best === Infinity) { missing++; continue; }
    worst = Math.max(worst, best);
    count++;
    if (best > limit) off.push([Math.round(x - points[0]), Math.round(y - points[1]), Math.round(best)]);
  }
  return { count, missing, worst, off };
}, ON_STREET_M);

// fly to the first thing answering a name, at once, and let the tiles come in
async function find(page, name) {
  const result = await page.evaluate(name => window.__city.find(name, 0), name);
  await page.evaluate(() => window.__city.settle(30000));
  await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 20000 });
  await wait(300);
  return result;
}

async function opened(browser, url, options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 60000 });
  await page.waitForFunction(() => window.__city.index() !== null, null, { timeout: 60000 });
  return { context, page, errors };
}

(async () => {
  const server = spawn('node', [path.join(root, 'serve.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  let browser;
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
    fs.mkdirSync(outDir, { recursive: true });

    // ---- on a desktop -----------------------------------------------------------------------------------------
    const { context, page, errors } = await opened(browser, `http://127.0.0.1:${PORT}/hz`, { viewport: { width: 960, height: 540 } });
    const book = await page.evaluate(() => ({ count: window.__city.index().count, bytes: window.__city.index().bytes, sheets: window.__city.index().sheets.size }));
    check(book.count > 20000 && book.bytes > 1e6, `the index is here (${book.count} things, ${book.bytes} bytes)`);
    const start = await state(page);
    check(same(start.boxes.map, start.boxes.mark), `what is drawn over the map covers the map and no more (${start.boxes.map} against ${start.boxes.mark})`);
    check((await inkPixels(page)).length === 0, 'nothing is drawn over the map before anything is found');
    check(start.boxes.find[2] > start.boxes.find[0] && start.boxes.find[3] < 120, 'the box to write a name in is at the top left');

    // the slash key gives the box the keys; the box's own keys stay in it
    await page.keyboard.press('/');
    check((await state(page)).focused === 'find', '/ puts the keys into the box');
    await page.keyboard.type('wasd1234mtr', { delay: 20 });
    let now = await state(page);
    check(same(now.camera, start.camera) && now.season === start.season && !now.touring, `letters typed into the box do not move the map, change the season or start the tour (${now.words})`);
    await page.evaluate(() => { document.getElementById('find').value = ''; });
    await page.keyboard.press('Control+k');
    check((await state(page)).focused === 'find', 'Ctrl+K comes back to the box');

    // answers come as the name is written
    await page.evaluate(() => { document.getElementById('find').value = ''; document.getElementById('find').dispatchEvent(new Event('input')); });
    await page.keyboard.type('文三路', { delay: 40 });
    now = await state(page);
    check(now.answers.length >= 3 && now.answers.length <= 12, `a handful of answers to 文三路 (${now.answers.length})`);
    check(now.answers[0] && now.answers[0].text.startsWith('文三路') && /道路 · 次干道 · [\d.]+ 公里/.test(now.answers[0].text), `the road comes first (${now.answers[0] && now.answers[0].text})`);
    check(now.answers[0].current && now.answers.slice(1).every(a => !a.current), 'the first answer is the one chosen');
    check(now.boxes.answers[1] >= now.boxes.find[3] && now.boxes.answers[3] <= 540, 'the answers lie under the box, inside the page');
    await page.screenshot({ path: path.join(outDir, 'desktop-answers.png') });
    const beforeEnter = now.camera;
    // an input method's Enter (choosing a Chinese character) is not ours to take
    await page.evaluate(() => document.getElementById('find').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
    await wait(200);
    now = await state(page);
    check(now.answers.length >= 3 && same(now.camera, beforeEnter), 'Enter while a name is still being composed chooses nothing');
    await page.keyboard.press('ArrowDown');
    check((await state(page)).answers[1].current, 'the down arrow moves to the second answer');
    await page.keyboard.press('ArrowUp');
    check((await state(page)).answers[0].current, 'and the up arrow back to the first');

    // the flight, and what is left on the page
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 20000 });
    await page.evaluate(() => window.__city.settle(30000));
    await wait(400);
    now = await state(page);
    check(now.found === '文三路', `the road is what was found (${now.found})`);
    check(now.note && now.note[0] === '文三路' && /^道路 · 次干道 · [\d.]+ 公里$/.test(now.note[1]), `the note names it and says what it is (${now.note})`);
    check(!now.noteOverReadout, 'the note does not cover the readout');
    check(now.answers.length === 0 && now.words === '文三路' && now.focused !== 'find', 'the answers go, the words stay, and the keys go back to the map');
    const indexRow = await page.evaluate(async () => (await window.__city.search('文三路'))[0]);
    check(Math.hypot(now.camera[0] - indexRow.x, now.camera[1] - indexRow.y) < 5000 && now.camera[2] > 0.05 && now.camera[2] <= 1.6, `the camera is at the road (${now.camera[2].toFixed(2)} pixels a metre)`);
    const drawn = await onCourse(page);
    check(drawn.row && drawn.ink > 300 && drawn.far === 0, `the ink lies along the course of the road (${drawn.ink} pixels, ${drawn.far} of them off it, the farthest ${drawn.worst.toFixed(1)} pixels)`);
    const street = await onStreet(page);
    check(street.count > 20 && street.missing <= 2 && street.off.length <= OFF_STREET_SHARE * street.count && street.worst <= 20, `the course lies on the street the map draws (${street.count} points, ${street.missing} without their tile, ${street.off.length} more than ${ON_STREET_M} metres from a street, the farthest ${street.worst.toFixed(1)} metres; off: ${JSON.stringify(street.off.slice(0, 4))})`);
    await page.screenshot({ path: path.join(outDir, 'desktop-road.png') });
    const inkBefore = (await inkPixels(page)).length;

    // dragging the map keeps what was found, drawn and named; Escape clears it
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(720, 330, { steps: 8 });
    await page.mouse.up();
    await wait(400);
    now = await state(page);
    const inkAfter = (await inkPixels(page)).length;
    check(now.found === '文三路' && now.note && now.note[0] === '文三路', 'a drag of the map leaves the road found and named');
    check(Math.abs(inkAfter - inkBefore) < inkBefore * 0.3, `... and drawn afresh where it is now (${inkBefore} pixels of ink before, ${inkAfter} after)`);
    check((await onCourse(page)).far === 0, '... still along the course');
    await page.keyboard.press('Escape');
    now = await state(page);
    check(now.found === null && now.note === null && (await inkPixels(page)).length === 0, 'Escape clears it: nothing found, nothing named, nothing drawn');
    await page.screenshot({ path: path.join(outDir, 'desktop-cleared.png') });

    // a place: found by an alias, a ring drawn round it
    let result = await find(page, '岳庙');
    now = await state(page);
    check(result && result.name === '岳王庙' && now.found === '岳王庙', `岳庙 finds 岳王庙 (${result && result.name})`);
    const ring = await page.evaluate(() => window.__city.mark());
    const ink = await inkPixels(page);
    const cx = Math.round(ring.centre[0]), cy = Math.round(ring.centre[1]);
    const places = pixels => pixels.map(([x, y]) => `${x},${y}`).sort();
    check(ring.ink === RING.length && JSON.stringify(places(ink)) === JSON.stringify(places(RING.map(([x, y]) => [cx + x, cy + y]))), `a ring of ink round the place (${ring.ink} pixels)`);
    check(Math.abs(cx - now.frame[0] / 2) < 200 && Math.abs(cy - now.frame[1] / 2) < 150, `the ring is near the middle of the frame (${cx}, ${cy} in ${now.frame})`);
    check(now.camera[2] > 0.5, `the flight came close (${now.camera[2].toFixed(2)} pixels a metre)`);
    await page.screenshot({ path: path.join(outDir, 'desktop-place.png') });

    // a river: the water of its sheet, drawn by its bank
    result = await find(page, '钱塘江');
    now = await state(page);
    const river = await onCourse(page);
    check(result && result.kind === 5 && now.found === '钱塘江' && /水域 · 江 · \d+\.\d 平方公里/.test(now.note[1]), `钱塘江 is found as its water (${now.note && now.note[1]})`);
    check(river.ink > 500 && river.far === 0, `the ink lies along its bank (${river.ink} pixels, ${river.far} off it)`);
    await page.screenshot({ path: path.join(outDir, 'desktop-river.png') });

    // a landmark of the list goes the way its name in the list goes; nothing is drawn for it
    result = await find(page, '断桥');
    now = await state(page);
    check(result && result.landmark === '1-01' && now.found === null && now.note && now.note[0] === '断桥残雪', `断桥 is the landmark 断桥残雪, by its note (${now.note && now.note[0]})`);
    check((await inkPixels(page)).length === 0, 'nothing is drawn over a landmark of the list: its flight is the view of it');
    check(now.camera[2] > 1.5, `the view of the landmark is close (${now.camera[2].toFixed(2)} pixels a metre)`);
    result = await find(page, '大莲花');
    check(result && result.landmark === '4-02', `大莲花 finds 奥体中心 by its alias (${result && result.name})`);
    result = await find(page, '武林广场');
    check(result && result.label === '广场', `武林广场 is the square first (${result && result.label})`);
    result = await find(page, '武林广场站');
    check(result && result.label === '车站', `武林广场站 is the station (${result && result.label})`);
    result = await find(page, '没有这么一个地方的名字');
    check(result === null && (await state(page)).answers.length === 0 && (await state(page)).waiting[0] === '地图数据里没有这个名字', 'a name that is not in the map says so');
    await page.evaluate(() => { document.getElementById('find').value = ''; });

    // what was found gives way to a landmark of the list, and the way back to the whole city clears it
    await find(page, '文三路');
    await page.click('#landmarks button[data-id="1-03"]');
    await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 20000 });
    now = await state(page);
    check(now.found === null && now.note && now.note[0] === '雷峰塔' && (await inkPixels(page)).length === 0, 'choosing a landmark of the list replaces what was found');
    await find(page, '文三路');
    await page.keyboard.press('r');
    await page.waitForFunction(() => !window.__city.flying(), null, { timeout: 20000 });
    now = await state(page);
    check(now.found === null && now.note === null && (await inkPixels(page)).length === 0, 'R, back to the whole city, clears it');

    // Escape in the box: the words go first
    await page.click('#find');
    await page.keyboard.type('西湖');                                     // the words already there are chosen whole: these replace them
    now = await state(page);
    check(now.words === '西湖' && now.answers.length >= 1, `writing into the box with words in it replaces them (${now.words})`);
    await page.keyboard.press('Escape');
    now = await state(page);
    check(now.words === '' && now.answers.length === 0 && now.focused === 'find', 'Escape in the box empties it');
    // the canvas takes the answers away
    await page.keyboard.type('西湖');
    await page.mouse.click(700, 400);
    now = await state(page);
    check(now.answers.length === 0 && now.words === '西湖', 'touching the map puts the answers away');
    // finding is quick enough to answer every letter as it is typed
    const ms = await page.evaluate(async () => { const { search } = await import('/src/world/names.js'); const t = performance.now(); for (let k = 0; k < 50; k++) search(window.__city.index(), '路'); return (performance.now() - t) / 50; });
    check(ms < 5, `one search over the whole index takes ${ms.toFixed(2)} ms`);
    check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
    await context.close();

    // ---- opened at a place ------------------------------------------------------------------------------------
    const at = await opened(browser, `http://127.0.0.1:${PORT}/hz?find=%E6%96%87%E4%B8%89%E8%B7%AF`);
    now = await state(at.page);
    await at.page.evaluate(() => window.__city.settle(30000));
    check(now.found === '文三路' && now.words === '文三路' && now.note && now.note[0] === '文三路', `?find=文三路 opens at the road (${now.found})`);
    check((await onCourse(at.page)).far === 0, '... with it drawn');
    check(at.errors.length === 0, `no page errors on opening at a place (${at.errors.slice(0, 3).join(' | ')})`);
    await at.page.screenshot({ path: path.join(outDir, 'desktop-opened.png') });
    await at.context.close();

    // ---- on a phone -------------------------------------------------------------------------------------------
    const phone = await opened(browser, `http://127.0.0.1:${PORT}/hz`, devices['iPhone 13']);
    const p = phone.page;
    now = await state(p);
    const clear = (a, b) => a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
    check(now.boxes.find[2] - now.boxes.find[0] > 100 && now.boxes.find[2] <= 390 && clear(now.boxes.find, now.boxes.tools), 'the box to write in is on the phone\'s page, whole and clear of the tools at the top right');
    await p.tap('#find');
    await p.keyboard.type('西湖', { delay: 60 });
    now = await state(p);
    check(now.answers.length >= 1 && now.boxes.answers[2] <= 390 && now.boxes.answers[2] - now.boxes.answers[0] > 300 && !now.overflow, 'the answers come out across the page, and nothing runs off it');
    const whole = await p.evaluate(() => [...document.querySelectorAll('#results button')].every(b => { const text = b.querySelector('.what'), r = b.getBoundingClientRect(); return text.scrollWidth <= text.clientWidth + 1 && document.elementFromPoint(r.left + 8, r.top + r.height / 2) === b || b.contains(document.elementFromPoint(r.left + 8, r.top + r.height / 2)); }));
    check(whole, 'every answer can be read whole: nothing lies over it');
    await p.screenshot({ path: path.join(outDir, 'phone-answers.png') });
    await p.tap('#results button');
    await p.waitForFunction(() => !window.__city.flying(), null, { timeout: 20000 });
    await p.evaluate(() => window.__city.settle(30000));
    await wait(500);
    now = await state(p);
    check(now.found === '西湖' && now.note && now.note[0] === '西湖' && !now.noteOverReadout && !now.overflow, `the lake is found and named on the phone (${now.note})`);
    check((await inkPixels(p)).length > 0, '... and marked on the map');
    await p.screenshot({ path: path.join(outDir, 'phone-found.png') });
    check(phone.errors.length === 0, `no page errors on the phone (${phone.errors.slice(0, 3).join(' | ')})`);
    await phone.context.close();
  } catch (error) {
    failures.push(String(error.stack || error.message).split('\n').slice(0, 3).join(' '));
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
  if (failures.length) {
    console.log(`SEARCH FAILED (${failures.length})`);
    failures.forEach(message => console.log('  -', message));
    process.exitCode = 1;
  } else {
    console.log(`search OK: pictures in ${path.relative(root, outDir)}`);
  }
})();
