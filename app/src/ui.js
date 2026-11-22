// The page around the map: the list of landmarks, the seasons, the tour, the compass, the readout, and the
// flights between places. Quiet, as the pages of pixel-plays are: white paper, small monospace type, words
// that darken when pointed at, nothing framed.

const SEASON_LABELS = { spring: '春', summer: '夏', autumn: '秋', winter: '冬' };
const PIXEL_SIZES = ['细', '中', '粗'];       // how big a pixel is on the page: the frame is cut into that many more or fewer
const TOP_DOWN = 1.483;                      // pitch of the top-down view, 85 degrees

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const lerpAngle = (a, b, t) => a + ((((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) * t;

// app: { camera, renderer, world, landmarks, seasons, season(), setSeason(name), overview(), frame: {W, H} }
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
    const { x, y } = place(anchor, camera.pitch);
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

  // ---- the tour of West Lake -----------------------------------------------------------------------------
  const lake = landmarks.filter(l => l.group === groups[0].name);
  function startTour() {
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
    $('tour').textContent = '西湖导览';
  }
  $('tour').addEventListener('click', () => { if (tour) stopTour(); else startTour(); });

  // Where to fly to for a landmark: a third closer than the table says, and with the landmark's
  // middle, not its foot, at the centre of the frame: the camera centre moves towards the viewer by as
  // much of the ground as the landmark's height takes up on the page.
  function place(landmark, pitch = Math.PI / 6) {
    const focus = landmark.focus ?? 8;
    // the model stands on the ground (bedded into it as the renderer places it), so its middle is that much
    // above the sea; the ground's height is the bake's, good before the tile under it has loaded
    const height = (landmark.ground ?? 0) - (landmark.bed ?? 2) + focus;
    // where the middle of the frame lies from the landmark, in metres along the screen's two axes (across to
    // the right, up the page): nothing for most; a place whose view holds more than the landmark gives it in
    // the table. v grows down the page, so both the offset and the height move the camera up the page.
    const [du, up] = landmark.view.offset ?? [0, 0];
    const dv = -up - height * Math.cos(pitch) / Math.sin(pitch);
    const rx = (du + dv) * Math.SQRT1_2, ry = (dv - du) * Math.SQRT1_2, yaw = camera.yaw;
    return { x: landmark.x + rx * Math.cos(yaw) + ry * Math.sin(yaw), y: landmark.y - rx * Math.sin(yaw) + ry * Math.cos(yaw), scale: Math.min(4, landmark.view.scale * 1.3), pitch };
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

  // whatever the user does to the map ends a flight and the tour, and puts the note away
  function interrupted() {
    stopTour();
    flight = null;
    if (here) {
      here = null;
      hideNote();
    }
  }
  for (const type of ['pointerdown', 'wheel']) app.canvas.addEventListener(type, interrupted, { passive: true });
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key.toLowerCase();
    const digit = '1234'.indexOf(key);
    if (digit >= 0 && app.seasons[digit]) { setSeason(app.seasons[digit]); return; }
    if (key === 'm') { topDown(camera.pitch < 1.2); return; }
    if (key === 't') { if (tour) stopTour(); else startTour(); return; }
    if (key === 'r') { $('home').click(); return; }
    if (key === 'escape') { stopTour(); menu.classList.remove('open'); return; }
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) interrupted();
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
    const dx = b.u - a.u, dy = -(b.v - a.v) * camera.sinPitch, length = Math.hypot(dx, dy) || 1;
    compass.clearRect(0, 0, 44, 44);
    compass.strokeStyle = getComputedStyle(document.body).getPropertyValue('--muted');
    compass.fillStyle = getComputedStyle(document.body).getPropertyValue('--ink');
    compass.lineWidth = 1;
    compass.beginPath();
    compass.moveTo(22 - dx / length * 12, 22 - dy / length * 12);
    compass.lineTo(22 + dx / length * 14, 22 + dy / length * 14);
    compass.stroke();
    compass.font = '600 12px ui-monospace, Menlo, monospace';
    compass.textAlign = 'center';
    compass.textBaseline = 'middle';
    compass.fillText('N', 22 + dx / length * 16, 22 + dy / length * 16);
  }

  return {
    tick,
    paint,
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
    target: () => target,           // the camera pose the last flight was bound for
    touring: () => Boolean(tour),
    tour,
    startTour, stopTour,
    topDown: on => topDown(on),
    groups,
  };
}
