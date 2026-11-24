// The page around the map: the list of landmarks, the search by name, the seasons, the tour, the compass, the
// readout, and the flights between places. Quiet, as the pages of pixel-plays are: white paper, small monospace
// type, words that darken when pointed at, nothing framed.

import { course, said, search } from './world/names.js';
import { Mark } from './render/mark.js';

const SEASON_LABELS = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
const PIXEL_SIZES = ['细', '中', '粗'];       // how big a pixel is on the page: the frame is cut into that many more or fewer
const TOP_DOWN = 1.483;                      // pitch of the top-down view, 85 degrees
// how close the flight to a thing found by name comes when the thing is a point: by what it is. A line and what
// covers ground are held whole instead, as far out as they are long
const CLOSE = { 车站: 1.6, 公交枢纽站: 1.6, 码头: 1.6, 游艇码头: 1.6, 船台: 1.6, 洞口: 1.6, 喷泉: 1.6, 雕塑: 1.6, 纪念碑: 1.6, 界碑: 1.6, 界标: 1.6, 泉: 1.2, 观景点: 1.2,
                山峰: 0.6, 山: 0.6, 鞍部: 0.6, 岛: 0.3, 国家公园: 0.3, 保护区: 0.3, '村庄、社区': 0.4, 片区: 0.4, 街区: 0.4, 街道: 0.35, 镇: 0.25, 城市: 0.12 };
const STREET = 1.2;                          // anything else: a street's view

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const lerpAngle = (a, b, t) => a + ((((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * t;

// app: { camera, renderer, world, canvas, landmarks, seasons, season(), setSeason(name), overview(), overviewTarget(),
//        names: { load() }, quiet, tour }   tour: { label } where the city has a tour, null where it has none
export function createInterface(app) {
  const { camera, landmarks } = app;
  const $ = id => document.getElementById(id);
  const menu = $('landmarks'), note = $('note'), noteTitle = $('note-title'), noteText = $('note-text'), readout = $('readout-line');
  const compass = $('compass').getContext('2d');
  const coarse = matchMedia('(pointer: coarse)').matches;
  let flight = null;            // a flight in progress
  let target = null;            // where the last flight went
  let tour = null;              // { list, index, holdUntil } the tour in progress
  let here = null;              // the landmark the camera is at, if any
  let anchor = null;            // the landmark last flown to: the camera turns around its middle until the map is panned
  let found = null;             // the thing last found by name that is not one of the list's landmarks: drawn over the map, and named, until it is cleared
  let pitchBeforeTop = Math.PI / 6;
  const hooks = { dirty: () => {}, stop: () => {} };

  // ---- the list of landmarks ----------------------------------------------------------------------------
  const groups = [];
  for (const landmark of landmarks) {
    let group = groups.find(g => g.name === landmark.group);
    if (!group) groups.push(group = { name: landmark.group, items: [] });
    group.items.push(landmark);
  }
  for (const group of groups) {
    const line = document.createElement('div');
    line.className = 'group';
    const label = document.createElement('span');
    label.textContent = group.name;
    line.append(label);
    for (const landmark of group.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = landmark.title;
      button.dataset.id = landmark.id;
      button.title = landmark.note;
      button.addEventListener('click', () => { stopTour(); goTo({ ...place(landmark), landmark }, 1.8); });
      line.append(button);
    }
    menu.append(line);
  }
  $('toggle').addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    $('toggle').setAttribute('aria-expanded', String(open));
  });

  // ---- seasons ------------------------------------------------------------------------------------------
  for (const name of app.seasons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = SEASON_LABELS[name] || name;
    button.dataset.season = name;
    button.setAttribute('aria-pressed', String(name === app.season()));
    button.addEventListener('click', () => setSeason(name));
    $('seasons').append(button);
  }
  function setSeason(name) {
    app.setSeason(name);
    for (const button of $('seasons').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.season === name));
    hooks.dirty();
  }

  // ---- flights ------------------------------------------------------------------------------------------
  // From where the camera is to a place: the position and the angle ease in and out, and the zoom dips
  // out a little on the way when the road is long, so that the city is seen to pass underneath.
  function goTo(pose, seconds = 1.8, then = null) {
    if (found && pose.landmark !== found) clearFound();     // one thing is drawn over the map at a time
    const from = { x: camera.x, y: camera.y, scale: camera.scale, pitch: camera.pitch, yaw: camera.yaw };
    const to = { ...from, ...pose };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const dip = 0.5 * Math.min(1, distance / 5000) + 0.5 * Math.min(1, Math.abs(Math.log(to.scale / from.scale)) / Math.log(40));
    flight = { from, to, start: performance.now(), seconds, dip, then };
    target = to;
    here = pose.landmark || null;
    anchor = pose.landmark || null;
    if (here) showNote(here);
  }

  // After the camera has turned or tilted: keep the anchor's middle where it was, at the centre of the
  // frame. A landmark's middle is looked at by standing the camera's centre a little down the page from
  // it (place); when the camera turns, that spot turns with the picture, so it is found again.
  function follow() {
    if (!anchor) return false;
    const { x, y } = place(anchor, camera.pitch, true);
    camera.x = x;
    camera.y = y;
    return true;
  }

  function tick(now) {
    let moved = false;
    if (flight) {
      const t = Math.min(1, (now - flight.start) / (flight.seconds * 1000)), e = smooth(t), { from, to } = flight;
      camera.x = lerp(from.x, to.x, e);
      camera.y = lerp(from.y, to.y, e);
      camera.pitch = lerp(from.pitch, to.pitch, e);
      camera.yaw = lerpAngle(from.yaw, to.yaw, e);
      camera.scale = Math.exp(lerp(Math.log(from.scale), Math.log(to.scale), e) - flight.dip * Math.sin(Math.PI * e));
      moved = true;
      if (t >= 1) {
        const done = flight;
        flight = null;
        if (done.then) done.then();
      }
    }
    if (tour) {
      // between stops the view turns slowly, so that the place is seen from more than one side
      if (!flight && now < tour.holdUntil) camera.yaw += 0.0025;
      if (!flight) follow();
      if (!flight && now >= tour.holdUntil) nextStop();
      moved = true;
    }
    return moved;
  }

  // ---- the tour: the landmarks of the first group, one after another ---------------------------------------------
  // Whether the city has a tour, and what its button is called, the city says (cities/<id>/city.json, "tour").
  const lake = app.tour ? landmarks.filter(l => l.group === groups[0].name) : [];
  $('tour').hidden = !lake.length;
  $('tour').textContent = app.tour?.label || '';
  function startTour() {
    if (!lake.length) return;
    tour = { index: 0 };
    $('tour').setAttribute('aria-pressed', 'true');
    $('tour').textContent = '停止导览';
    nextStop();
  }
  function nextStop() {
    const stop = lake[tour.index % lake.length];
    goTo({ ...place(stop), landmark: stop }, 2.2);
    tour.index++;
    tour.holdUntil = performance.now() + 7600;      // the flight, then a slow turn
  }
  function stopTour() {
    if (!tour) return;
    tour = null;
    $('tour').setAttribute('aria-pressed', 'false');
    $('tour').textContent = app.tour.label;
  }
  $('tour').addEventListener('click', () => { if (tour) stopTour(); else startTour(); });

  // Where to fly to for a landmark: a third closer than the table says, and with the landmark's
  // middle, not its foot, at the centre of the frame: the camera centre moves towards the viewer by as
  // much of the ground as the landmark's height takes up on the page.
  function place(landmark, pitch = Math.PI / 6, keepYaw = false) {
    const focus = landmark.focus ?? 8;
    // the model stands on the ground (bedded into it as the renderer places it), so its middle is that much
    // above the sea; the ground's height is the bake's, good before the tile under it has loaded
    const height = (landmark.ground ?? 0) - (landmark.bed ?? 2) + focus;
    // where the middle of the frame lies from the landmark, in metres along the screen's two axes (across to
    // the right, up the page): nothing for most; a place whose view holds more than the landmark gives it in
    // the table. The model's middle stands `height` up the page from its ground point (project draws the
    // ground's far axis up the page), so the camera moves that much farther along it, plus the offset.
    // A landmark may hold a yaw of its own — its standard portrait: the camera stands on that side of it and
    // the flight turns to look along it. The rest keep the direction the visitor was looking in. When the
    // map only follows (a pan or a turn), the visitor's yaw is kept even for a portrait: the standard shot
    // is where a flight arrives, not where the visitor is held.
    const [du, up] = landmark.view.offset ?? [0, 0];
    const dv = up + height * Math.cos(pitch) / Math.sin(pitch);
    const portrait = landmark.view.yaw;
    const yaw = portrait === undefined || keepYaw ? camera.yaw : portrait;
    const rx = (du + dv) * Math.SQRT1_2, ry = (dv - du) * Math.SQRT1_2;
    const pose = { x: landmark.x + rx * Math.cos(yaw) + ry * Math.sin(yaw), y: landmark.y - rx * Math.sin(yaw) + ry * Math.cos(yaw), scale: Math.min(4, landmark.view.scale * 1.3), pitch };
    if (portrait !== undefined && !keepYaw) pose.yaw = portrait;
    return pose;
  }

  // ---- the other buttons and the keys --------------------------------------------------------------------
  const topDown = on => {
    if (on) {
      pitchBeforeTop = camera.pitch;
      goTo({ pitch: TOP_DOWN }, 0.7);
    } else goTo({ pitch: pitchBeforeTop }, 0.7);
    $('topdown').setAttribute('aria-pressed', String(on));
  };
  $('topdown').addEventListener('click', () => { stopTour(); topDown(camera.pitch < 1.2); });
  $('home').addEventListener('click', () => {
    stopTour();
    here = null;
    anchor = null;
    hideNote();
    clearFound();
    // back to the whole city, by a flight like any other
    goTo({ ...app.overviewTarget(), landmark: null }, 1.6);
  });

  // the size of a pixel on the page: kept for the next visit, and applied by loading the page again with it
  const sizes = Number(localStorage.getItem('pixel-size') || 1);
  $('pixels').textContent = `像素${PIXEL_SIZES[sizes]}`;
  $('pixels').addEventListener('click', () => {
    const next = (sizes + 1) % PIXEL_SIZES.length;
    localStorage.setItem('pixel-size', String(next));
    const url = new URL(location.href);
    url.searchParams.set('reload', String(Date.now()));
    location.replace(url);
  });

  // whatever the user does to the map ends a flight and the tour, and puts the note away -- except for a thing found
  // by name, which stays drawn and stays named until it is cleared: it is what the map is being looked at around
  function interrupted() {
    stopTour();
    flight = null;
    if (here && !found) {
      here = null;
      hideNote();
    }
  }
  for (const type of ['pointerdown', 'wheel']) app.canvas.addEventListener(type, interrupted, { passive: true });
  app.canvas.addEventListener('pointerdown', closeSearch, { passive: true });
  // keys typed into the box are the box's own
  const typing = e => e.target instanceof Element && e.target.closest('input, textarea');
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && e.target !== findBox) { e.preventDefault(); findBox.focus(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
    const key = e.key.toLowerCase();
    if (key === '/') { e.preventDefault(); findBox.focus(); return; }           // a line to write a name in
    const digit = '1234'.indexOf(key);
    if (digit >= 0 && app.seasons[digit]) { setSeason(app.seasons[digit]); return; }
    if (key === 'm') { topDown(camera.pitch < 1.2); return; }
    if (key === 't') { if (tour) stopTour(); else startTour(); return; }
    if (key === 'r') { $('home').click(); return; }
    if (key === 'escape') { stopTour(); menu.classList.remove('open'); closeSearch(); clearFound(); return; }
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) interrupted();
  });

  // ---- finding a place by name ----------------------------------------------------------------------------
  // The words in the box are answered from the index of names the pipeline baked (app/src/world/names.js), fetched
  // the first time it is wanted. What is chosen is flown to and held in the middle of the frame, drawn over the map,
  // and named in the note until it is cleared.
  const findBox = $('find'), answers = $('results');
  const hex = text => text.trim().match(/\w\w/g).map(digit => parseInt(digit, 16));
  const mark = new Mark($('mark'), camera.width, camera.height, { ink: hex(getComputedStyle(document.documentElement).getPropertyValue('--ink')), paper: [255, 255, 255] });
  let names = null;            // the index, once it is here
  let trouble = null;          // why it never came
  let waiting = null;          // its fetching, once begun
  let results = [];            // what answers the words in the box
  let current = 0;             // which of them the arrow keys are on

  // the index, fetched once: when the box is first used, or before then once the page has had a moment to itself
  function index() {
    if (!waiting) {
      waiting = app.names.load().then(book => { names = book; }, error => { trouble = error.message; }).then(answer);
    }
    return waiting;
  }
  if (!app.quiet) setTimeout(index, 3000);

  function waitingRow(text) {
    const li = document.createElement('li');
    li.className = 'waiting';
    li.textContent = text;
    answers.append(li);
  }

  // the box's words, answered
  function answer() {
    const words = findBox.value.trim();
    results = words && names ? search(names, words) : [];
    current = 0;
    answers.replaceChildren();
    if (!words) return;
    if (!names) { waitingRow(trouble ? `名字索引读不到：${trouble}` : '载入中'); return; }
    if (!results.length) { waitingRow('地图数据里没有这个名字'); return; }
    // where more than one thing in the list bears one name, each says where it is
    const twice = new Set(results.filter((r, k) => results.some((o, j) => j !== k && o.name === r.name)).map(r => r.name));
    for (const [k, result] of results.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = k === current ? 'current' : '';
      const title = document.createElement('span'), what = document.createElement('span');
      title.textContent = result.name + (twice.has(result.name) && result.near ? `（${result.near}）` : '');
      what.className = 'what';
      what.textContent = said(names, result.k);
      button.append(title, what);
      button.addEventListener('pointerenter', () => choose(k));
      button.addEventListener('click', () => { pick(k); findBox.blur(); });
      const li = document.createElement('li');
      li.append(button);
      answers.append(li);
    }
  }

  function choose(k) {
    current = (k + results.length) % results.length;
    Array.from(answers.children).forEach((li, j) => li.firstElementChild?.classList.toggle('current', j === current));
    answers.children[current]?.firstElementChild?.scrollIntoView({ block: 'nearest' });
  }

  function closeSearch() {
    results = [];
    current = 0;
    answers.replaceChildren();
  }

  // the pose that holds a thing found by name: itself at the middle of the frame, and with it as much of the frame
  // taken up as it has extent
  function hold(target, result) {
    const centre = place(target, camera.pitch);           // the thing's own point at the middle of the frame (see place)
    const points = result.line ? course(names, result.k) : result.box ? [result.box[0], result.box[1], target.ground, result.box[2], result.box[1], target.ground,
      result.box[2], result.box[3], target.ground, result.box[0], result.box[3], target.ground] : null;
    if (!points) return { ...centre, scale: CLOSE[result.label] ?? STREET };
    // its extent on the page at one pixel a metre, seen from there
    let u0 = Infinity, u1 = -Infinity, s0 = Infinity, s1 = -Infinity;
    for (let k = 0; k < points.length; k += 3) {
      if (!Number.isFinite(points[k])) continue;                         // a break between two pieces of a course
      const { u, v } = camera.about(centre.x, centre.y, points[k], points[k + 1]);
      const s = -(v * camera.sinPitch + points[k + 2] * camera.cosPitch);   // where it comes on the page, before the zoom
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); s0 = Math.min(s0, s); s1 = Math.max(s1, s);
    }
    const [least, most] = result.line ? [0.004, 1.6] : [0.25, 3];
    const scale = Math.min(most, Math.max(least, Math.min(0.86 * camera.width / (u1 - u0), 0.8 * camera.height / (s1 - s0))));
    // the middle of its extent, not of its own point, at the middle of the frame: the camera moves by that on the page's two axes
    const du = (u0 + u1) / 2, dv = -(s0 + s1) / 2 / camera.sinPitch;
    const rx = (du + dv) * Math.SQRT1_2, ry = (dv - du) * Math.SQRT1_2;
    return { x: centre.x + rx * camera.cos + ry * camera.sin, y: centre.y - rx * camera.sin + ry * camera.cos, scale };
  }

  function clearFound() {
    if (!found) return;
    const was = found;
    found = null;
    mark.hide();
    if (here === was) {
      here = null;
      hideNote();
    }
  }

  // fly to one of the answers. A landmark of the list goes the way its name in the list goes; anything else is a
  // landmark of a moment, to be turned about and named like one
  function pick(k, seconds = 1.8) {
    const result = results[k];
    closeSearch();
    if (!result) return null;
    stopTour();
    if (result.landmark) {
      const landmark = landmarks.find(l => l.id === result.landmark);
      goTo({ ...place(landmark), landmark }, seconds);
      return result;
    }
    found = { title: result.name, note: [said(names, result.k), result.near].filter(Boolean).join(' · '), x: result.x, y: result.y, ground: result.z, bed: 0, focus: 0, view: {} };
    mark.show({ x: found.x, y: found.y, z: found.ground }, result.line ? course(names, result.k) : null);
    mark.paint(camera);
    goTo({ ...hold(found, result), landmark: found }, seconds);
    return result;
  }

  // answered at once with what is here, and again once the index is
  const asked = () => { answer(); index(); };
  // the answers to what is already written come back, and the words are chosen whole: writing replaces them
  findBox.addEventListener('focus', () => { findBox.select(); if (findBox.value.trim()) asked(); });
  findBox.addEventListener('input', asked);
  findBox.addEventListener('keydown', e => {
    if (e.isComposing) return;                                           // an input method's own keys, while a Chinese name is being chosen
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (results.length) choose(current + (e.key === 'ArrowDown' ? 1 : -1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(current); findBox.blur(); }
    else if (e.key === 'Escape') {
      // the words go first, then the box lets go of the keys
      e.stopPropagation();
      if (findBox.value || results.length) { findBox.value = ''; closeSearch(); } else findBox.blur();
    }
  });

  // ---- the note, the readout and the compass -------------------------------------------------------------
  function showNote(landmark) {
    note.hidden = false;
    noteTitle.textContent = landmark.title;
    noteText.textContent = landmark.note;
  }
  function hideNote() { note.hidden = true; }
  if (here) showNote(here);

  function paint(now) {
    const scale = camera.scale, metres = 1 / scale;
    const tier = scale < 0.125 ? '全景' : scale < 4 ? '城区' : '街区';
    const size = metres < 1 ? `${Math.round(metres * 100)} 厘米` : `${Math.round(metres * 10) / 10} 米`;
    const pending = app.world.pending.size;
    readout.textContent = `${tier} · 1 像素 ≈ ${size} · ${pending ? '载入中' : '就绪'}`;
    // which way is north on the page: the direction of the map's north, seen through the camera
    const a = camera.axes(0, 0), b = camera.axes(0, 1);
    // 北在画面上的方向：u 直接是屏幕横向，v 走 sy = -v·sinPitch（project），屏幕 y 向下长，故 dy 取负
    const dx = b.u - a.u, dy = -(b.v - a.v) * camera.sinPitch, length = Math.hypot(dx, dy) || 1;
    const ux = dx / length, uy = dy / length;
    compass.clearRect(0, 0, 44, 44);
    compass.strokeStyle = getComputedStyle(document.body).getPropertyValue('--muted');
    compass.fillStyle = getComputedStyle(document.body).getPropertyValue('--ink');
    compass.lineWidth = 1;
    compass.beginPath();
    compass.moveTo(22 - ux * 11, 22 - uy * 11);
    compass.lineTo(22 + ux * 9, 22 + uy * 9);
    compass.stroke();
    // an arrowhead on the north end: a bare line's two ends read either way
    compass.beginPath();
    compass.moveTo(22 + ux * 14, 22 + uy * 14);
    compass.lineTo(22 + ux * 9 - uy * 4, 22 + uy * 9 + ux * 4);
    compass.lineTo(22 + ux * 9 + uy * 4, 22 + uy * 9 - ux * 4);
    compass.closePath();
    compass.fill();
    compass.font = '600 12px ui-monospace, Menlo, monospace';
    compass.textAlign = 'center';
    compass.textBaseline = 'middle';
    compass.fillText('N', 22 + dx / length * 16, 22 + dy / length * 16);
    if (found) mark.paint(camera);         // what was found by name, over the frame just made
  }

  // ---- the other cities -------------------------------------------------------------------------------------------
  // The cities there are (world/source.js), as buttons: the current one marked, each other one the same page at
  // its own address.
  function cities(list, current) {
    const row = $('cities');
    for (const said of list) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = said.name;
      button.title = said.subtitle;
      button.className = said.id === current ? 'current' : '';
      button.setAttribute('aria-pressed', String(said.id === current));
      if (said.id !== current) button.addEventListener('click', () => { location.assign(`/${said.id}`); });
      row.append(button);
    }
    row.hidden = !list.length;
  }

  return {
    tick,
    paint,
    cities,
    onDirty: hook => { hooks.dirty = hook; },
    setSeason,
    flyTo: (id, seconds = 1.8) => { const landmark = landmarks.find(l => l.id === id); if (!landmark) throw new Error(`没有 ${id} 这处地标`); stopTour(); goTo({ ...place(landmark), landmark }, seconds); },
    // where the middle of a landmark should be in the frame, in pixels from its centre (a view may hold more
    // than the landmark: see place): as far to the left as the frame's middle is to the right of it, and as
    // far down as the frame's middle is up the page from it
    expected: landmark => { const [du, up] = landmark.view.offset ?? [0, 0]; return [-du * camera.scale, up * camera.sinPitch * camera.scale]; },
    follow,                         // after the camera has been turned: keep the landmark last flown to in the middle
    release: () => { anchor = null; },   // the map is being panned: from now on the camera turns around the middle of the view
    turnTo: yaw => { camera.yaw = yaw; follow(); },
    flying: () => Boolean(flight),
    // 开场：从相机此刻所在的地方飞到一个姿态（首页的地球把人送过来后，从高空落进全景的那一段）
    enter: (pose, seconds = 2.8) => goTo(pose, seconds),
    target: () => target,           // the camera pose the last flight was bound for
    touring: () => Boolean(tour),
    tour,
    startTour, stopTour,
    topDown: on => topDown(on),
    groups,
    // for tests and the console: the answers to a name, and the flight to the first of them
    search: async query => { await index(); return search(names, query); },
    find: async (query, seconds = 1.8) => { findBox.value = query; await index(); answer(); return results.length ? pick(0, seconds) : null; },   // nothing to pick: the box says so
    found: () => found,
    mark: () => ({ ...mark.measure(), centre: mark.centre(camera) }),
    index: () => names,           // the index of names, once it is here (count, bytes, rows, points)
  };
}
