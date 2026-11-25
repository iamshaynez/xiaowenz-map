// 像素城市：一座城的活地图，是哪座城看它的地址（/hz）；/ 是首页，一颗星球几座城（home/main.js）。启动、输入和帧循环。页面上地图以外的部分（名录、搜索、季节、导览、飞行）在 ui.js。
import { createContext } from './gl/context.js';
import { CityRenderer } from './render/city.js';
import { loadNames } from './world/names.js';
import { DISTRICT_SCALE, LIFE_SCALE, World } from './world/store.js';
import { CHANNELS, cityAsked, openCity, openCities } from './world/source.js';
import { DATA_ORIGIN } from './config.js';
import { buildLandmarks } from './landmarks/index.js';
import { BRAND_LOGOS } from './landmarks/brandmarks.js';
import { Walk } from './walk/walk.js';
import { createInterface } from './ui.js';

const MAX_WIDTH = 960, MAX_HEIGHT = 540;   // the frame at the middle pixel size; finer and coarser sizes scale it
const MIN_WIDTH = 320;                       // but never narrower than this: on a phone a pixel is one CSS pixel

// The city to show: the one its address names (/hz), read through the channel the address names (?channel=next:
// what is published as next; world/source.js). Where the address names no city (/), that is the homepage: the
// globe and the cities there are (home/main.js), and it is not this boot's business.
async function cityOnShow(id) {
  const askedFor = new URLSearchParams(location.search).get('channel'), channel = CHANNELS.includes(askedFor) ? askedFor : CHANNELS[0];
  return openCity(DATA_ORIGIN, id, channel);
}

async function boot() {
  // the address decides: one that names a city is that city's page; the root (/) is the homepage, a page
  // of its own (the globe, home/main.js), and it shares this file and the paper it is drawn on
  const cityId = cityAsked(location.pathname);
  if (!cityId) {
    const { bootHome } = await import('./home/main.js');
    return bootHome();
  }
  // how big a pixel is on the page: the middle size keeps the frame within 960 x 540, the fine one has
  // half the pixels of that each way, the coarse one twice; ?px= overrides for tests
  const auto = Math.max(1, Math.ceil(Math.max(innerWidth / MAX_WIDTH, innerHeight / MAX_HEIGHT)));
  const size = Number(new URLSearchParams(location.search).get('px') ?? localStorage.getItem('pixel-size') ?? 1);
  const pixelScale = Math.max(1, Math.min(auto - 1 + size, Math.floor(innerWidth / MIN_WIDTH)));
  const width = Math.max(160, Math.floor(innerWidth / pixelScale)), height = Math.max(120, Math.floor(innerHeight / pixelScale));
  const canvas = document.getElementById('c'), $ = id => document.getElementById(id);
  // the city comes first: everything else here is a file of it, except the palette, which is the page's own
  const city = await cityOnShow(cityId);
  const [index, paletteFile] = await Promise.all([
    fetch(city.url('index.json')).then(r => r.json()),
    fetch(new URL('../palette.json', import.meta.url)).then(r => r.json()),
  ]);
  const gl = createContext(canvas);
  // supersampling only decides whether a pixel is covered (D015): four samples each way on a desktop,
  // two on a touch screen, where the frame is smaller and the GPU slower; ?ss= overrides
  const asked = Number(new URLSearchParams(location.search).get('ss'));
  const supersampling = [1, 2, 3, 4].includes(asked) ? asked : matchMedia('(pointer: coarse)').matches ? 2 : 4;
  const renderer = new CityRenderer(gl, width, height, supersampling);
  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width * pixelScale}px`;
  canvas.style.height = `${height * pixelScale}px`;

  // The baked data refers to colours by their place in the list that was current when it was baked.
  // That list comes first; anything added to the palette since is appended, so old data stays valid.
  const colours = paletteFile.colours;
  const names = index.palette.slice();
  for (const name of Object.keys(colours)) if (!names.includes(name)) names.push(name);
  renderer.palette.seat(names.map(name => colours[name]));
  // the brands' pixel logos are drawn from the references by tools/bake/brand_logos.mjs; the bake's
  // list of brands and the atlas's must agree, brand for brand, or a shop would wear another's sign
  const bakedBrands = index.brandMarks || [];
  if (bakedBrands.length && bakedBrands.some((brand, k) => BRAND_LOGOS[k]?.brand !== brand)) {
    throw new Error('烘焙的品牌表和页面的招牌画对不上，请更新页面（brandMarks 与 brandmarks.js）');
  }
  renderer.updatePalette();
  const place = name => {
    const at = names.indexOf(name);
    if (at < 0) throw new Error(`调色板里没有 ${name}`);
    return at;
  };
  renderer.setLook(index, place);

  // the seasons: each replaces some of the colours; winter also lays snow and strips the deciduous trees
  const seasons = paletteFile.seasons || {};
  const seasonNames = seasons.order || Object.keys(seasons).filter(name => !name.startsWith('_'));
  let season = new URLSearchParams(location.search).get('season');
  if (!seasonNames.includes(season)) season = seasonNames.includes('summer') ? 'summer' : seasonNames[0];
  const setSeason = name => {
    if (!seasonNames.includes(name)) throw new Error(`没有 ${name} 这个季节`);
    const changed = (seasons[name] || {}).colours || {};
    renderer.setSeason(names.map(n => changed[n] || colours[n]), seasons[name] || {});
    season = name;
    document.body.dataset.season = name;
  };
  setSeason(season);
  // the map without the words around it, for pictures
  const quiet = new URLSearchParams(location.search).get('ui') === 'off';
  if (quiet) document.body.classList.add('quiet');
  // the index of names, for the search: fetched the first time it is wanted
  const book = { promise: null, load() { return this.promise ||= loadNames(city.url('names.bin')); } };

  const world = new World(gl, index, city);
  await world.loadOverview();
  // the landmarks built by hand, standing where the bake placed them. The list with the models in it is
  // the one the page uses as well: a landmark is looked at half-way up, and only its model knows how high
  // that is.
  const list = await fetch(city.url('landmarks.json')).then(r => r.json());
  const landmarks = buildLandmarks(gl, list, place);
  renderer.landmarks = landmarks;
  renderer.groundAt = (x, y) => world.groundAt(x, y);

  // start above the middle of the region with all of it in view
  const camera = renderer.city;
  // 走进城市：街景环视、行走、驾驶（walk/walk.js）。工具面板的按钮和 G 键进出，E 上/下车
  const walk = new Walk({ camera, world, renderer, keys: null });
  const [west, south, east, north] = index.bounds;
  camera.pitch = Math.PI / 6;
  // the camera that holds the whole region, with a margin, at this pitch and yaw. The region's extent is
  // taken at a zoom of one pixel to a metre, whatever the camera's zoom is now: this is asked for from any
  // zoom (R, the home button), and it once came out divided by the zoom it was asked at, so that R pressed
  // at the overview zoomed in to a pixel a metre (D057).
  const overviewTarget = () => {
    const corners = [[west, south], [west, north], [east, south], [east, north]].map(([x, y]) => camera.axes(x, y));
    const spanX = Math.max(...corners.map(c => c.u)) - Math.min(...corners.map(c => c.u));
    const spanY = (Math.max(...corners.map(c => c.v)) - Math.min(...corners.map(c => c.v))) * camera.sinPitch;
    return { x: (west + east) / 2, y: (south + north) / 2, scale: Math.min(0.9 * width / spanX, 0.84 * height / spanY) };
  };
  Object.assign(camera, overviewTarget());
  const overview = () => Object.assign(camera, overviewTarget());
  // 从首页的地球过来的（?from=globe）：先停在很高很高的地方，ui 到位后按平时飞行的缓动落进全景——
  // 地球把人推近到白光一闪，这里接的是那一闪之后的一段。嫌动画的人（prefers-reduced-motion）不绕这一趟
  const fromGlobe = new URLSearchParams(location.search).get('from') === 'globe' && matchMedia('(prefers-reduced-motion: no-preference)').matches;
  if (fromGlobe) Object.assign(camera, { ...overviewTarget(), scale: overviewTarget().scale * 0.05, pitch: 1.47 });

  // ---- input ------------------------------------------------------------------------------------------
  const pointers = new Map();
  let pinch = null;            // two fingers: how far apart they were when the gesture was last applied, their middle, and what is drawn under it
  let drag = null;             // one pointer holding the canvas: whether it turns the view, and the height of what it took hold of
  let wheelZoom = null;        // a turn of the wheel not yet applied: where the cursor is, and by how much to zoom
  // a pointer's position in the frame's own pixels. The canvas shows each of them as pixelScale CSS pixels,
  // and the camera works in the frame's pixels.
  const toFrame = e => {
    const box = canvas.getBoundingClientRect();
    return { x: (e.clientX - box.left) * width / box.width, y: (e.clientY - box.top) * height / box.height };
  };
  // the height of what is drawn at a point of the frame: what a zoom holds on to. Where nothing is drawn
  // yet (tiles on their way, the white outside the island) it is the ground from the overview's grid.
  const surfaceAt = at => {
    const depth = renderer.depthAt(at.x, at.y);
    if (depth !== null) return camera.heightAt(at.x, at.y, depth);
    const ground = camera.unproject(at.x, at.y);
    return world.groundAt(ground.x, ground.y);
  };
  // A mouse drags the map along with its left button and turns the view with its right one (D055). A touch
  // is the same the other way round (D061): one finger pans, two fingers together turn and tilt.
  const turns = e => e.pointerType === 'mouse' && e.button === 2;
  canvas.addEventListener('pointerdown', e => {
    if (e.button !== 0) e.preventDefault();          // no middle-click autoscroll, nothing else the browser does with a button
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    const at = toFrame(e);
    pointers.set(e.pointerId, at);
    if (walk.active) {
      // walking: a mouse is locked to the view (the browser hands the raw motion over, Esc unlocks it);
      // a touch drives the view by drag, and the left of the screen holds the joystick
      if (e.pointerType === 'mouse' && !document.pointerLockElement && canvas.requestPointerLock) {
        const locked = canvas.requestPointerLock();
        if (locked && locked.catch) locked.catch(() => {});
        return;
      }
      const mode = at.x < width * 0.3 && e.pointerType !== 'mouse' ? 'stick' : 'look';
      drag = { walk: mode };
      walk.beginDrag(mode, at.x, at.y);
      return;
    }
    if (pointers.size === 1) drag = { turn: turns(e), height: surfaceAt(at) };
    if (pointers.size === 2) pinch = { ...pinchState(), height: surfaceAt(pinchState()) };
  });
  // the locked mouse's raw motion: the view follows it, no button held
  document.addEventListener('mousemove', e => {
    if (walk.active && document.pointerLockElement === canvas) walk.look(e.movementX, e.movementY);
  });
  // the right button is for turning the view: it brings no menu of its own
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const was = pointers.get(e.pointerId), now = toFrame(e);
    pointers.set(e.pointerId, now);
    if (walk.active) {
      // with the mouse locked in, the view is already driven by the raw mousemove above
      if (drag?.walk && document.pointerLockElement !== canvas) walk.drag(drag.walk, now.x, now.y, (now.x - was.x) * pixelScale, (now.y - was.y) * pixelScale);
      dirty = true;
      return;
    }
    if (pointers.size === 2) {
      // two fingers: nothing is done here. The browser reports one finger at a time, and the distance
      // between them half way through a move is neither the old nor the new one; the gesture is applied in
      // the frame loop, once for the latest position of both fingers
    } else if (pointers.size === 1 && drag) {
      if (drag.turn) {
        // turn the city, and tilt it with a pull up or down, by how far the hand moved on the page (CSS
        // pixels), whatever the size of a frame's pixel
        const across = (now.x - was.x) * pixelScale, down = (now.y - was.y) * pixelScale;
        camera.yaw += across * 0.006;
        camera.pitch = Math.min(1.45, Math.max(0.26, camera.pitch + down * 0.005));
        ui.follow();               // turns around the landmark last flown to, if there is one
      } else {
        // drag the map along: what was taken hold of stays under the pointer. At the height of what was under
        // the pointer when it touched, so that a roof or a hill taken hold of goes with it and does not slip
        const before = camera.unprojectAt(was.x, was.y, camera.scale, drag.height);
        const after = camera.unprojectAt(now.x, now.y, camera.scale, drag.height);
        camera.x += before.x - after.x;
        camera.y += before.y - after.y;
        ui.release();              // the map is being panned: from now on the view turns around the middle of it
      }
    }
    dirty = true;
  });
  const release = e => {
    pointers.delete(e.pointerId);
    pinch = null;
    if (walk.active) walk.endDrag();
    drag = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    if (walk.active) {
      walk.speedBy(e.deltaY);                        // walking: the wheel sets the pace
      dirty = true;
      return;
    }
    // not applied here: the zoom holds on to what the frame on show draws under the cursor, so it is done
    // just before the next frame is drawn (see the loop), and turns that pile up between two frames are
    // done together
    const at = toFrame(e), factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
    wheelZoom = wheelZoom ? { x: at.x, y: at.y, factor: wheelZoom.factor * factor } : { x: at.x, y: at.y, factor };
    dirty = true;
  }, { passive: false });
  const keys = new Set();
  walk.keys = keys;
  const pan = dt => {
    let right = 0, up = 0;   // screen directions
    if (keys.has('a') || keys.has('arrowleft')) right -= 1;
    if (keys.has('d') || keys.has('arrowright')) right += 1;
    if (keys.has('w') || keys.has('arrowup')) up += 1;
    if (keys.has('s') || keys.has('arrowdown')) up -= 1;
    if (!right && !up) return false;
    ui.release();                 // panning: from now on the camera turns around the middle of the view
    const step = height / camera.scale * 0.9 * dt;   // most of the screen's height in a second
    // right on screen is +u, up the screen is +v scaled by the squash of the ground
    const du = right * step, dv = up * step / camera.sinPitch;
    const rx = (du + dv) * Math.SQRT1_2, ry = (dv - du) * Math.SQRT1_2;
    camera.x += rx * camera.cos + ry * camera.sin;
    camera.y += -rx * camera.sin + ry * camera.cos;
    return true;
  };
  const PAN_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'];
  // keys are heard wherever the focus is: after clicking a name in the list the focus stays on that button
  window.addEventListener('keydown', e => {
    // not the keys of a box to write in: those are that box's own
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target instanceof Element && e.target.closest('input, textarea'))) return;
    const key = e.key.toLowerCase();
    if (walk.active && (key === '=' || key === '+' || key === '-')) {
      if (!e.repeat) walk.speedStep(key === '-');
      e.preventDefault();
      return;
    }
    if (key === 'g' || (walk.active && key === 'escape' && !document.pointerLockElement)) {
      // 指针锁定时 Esc 由浏览器解锁鼠标，先不解散行走
      if (!e.repeat) {
        const go = document.getElementById('walkgo');
        if (walk.toggle() === false) {
          go.textContent = '这里落不下脚';
          setTimeout(() => { go.textContent = '走进城市 G'; }, 1600);
        }
      }
      e.preventDefault();
      return;
    }
    if (walk.active && key === 'e') {
      if (!e.repeat) walk.key('e');
      e.preventDefault();
      return;
    }
    if (PAN_KEYS.includes(key)) {
      keys.add(key);
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  // ---- the page around the map ------------------------------------------------------------------------------
  const ui = createInterface({
    camera, renderer, world, canvas, landmarks, seasons: seasonNames,
    season: () => season, setSeason: name => { setSeason(name); dirty = true; },
    overview, overviewTarget, names: book, quiet, tour: city.tour,
  });
  ui.onDirty(() => { dirty = true; });
  if (fromGlobe) ui.enter(overviewTarget(), 2.8);   // 从高空落到全景：飞行的缓动和途中的俯冲都是现成的（ui.js）
  // the words that name the city: the title of the page, its heading, and what the canvas is said to be
  const titled = `像素${city.name}`;
  document.title = city.subtitle ? `${titled} · ${city.subtitle}` : titled;
  $('city-name').textContent = titled;
  $('city-subtitle').textContent = city.subtitle;
  $('city-subtitle').hidden = !city.subtitle;
  canvas.setAttribute('aria-label', `${titled}：可以旋转、缩放的立体地图`);
  // the other cities there are, once their list has come: another city is the same page at its own address
  openCities(DATA_ORIGIN).then(list => ui.cities(list, city.id), () => {});
  // opened at a place: ?find=<a name> flies to the first thing that answers it
  const openedAt = new URLSearchParams(location.search).get('find');
  if (openedAt) ui.find(openedAt, 0).catch(error => console.error(error));

  // the walking view's own buttons: into the streets, and the car and the way back while in them
  const walkgo = document.getElementById('walkgo');
  if (walkgo) walkgo.addEventListener('click', () => {
    if (walk.toggle() === false) {
      walkgo.textContent = '这里落不下脚';
      setTimeout(() => { walkgo.textContent = '走进城市 G'; }, 1600);
    }
  });
  const drive = document.getElementById('drive');
  if (drive) drive.addEventListener('click', () => walk.key('e'));
  const walkback = document.getElementById('walkback');
  if (walkback) walkback.addEventListener('click', () => walk.exit());

  // ---- loop --------------------------------------------------------------------------------------------------
  // boats, cars and the wind only show once the view is close enough; farther out a frame is made only
  // when something changes
  let dirty = true, frozen = false, last = performance.now();
  const frame = now => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (walk.active) {
      walk.tick(dt);
      dirty = true;
    } else if (ui.tick(now) || pan(dt)) dirty = true;
    if (wheelZoom && !walk.active) {
      // zoom about the point under the cursor; that point is read from the frame on show, so this comes
      // before the frame is drawn again
      const { x, y, factor } = wheelZoom;
      wheelZoom = null;
      camera.zoomAt(x, y, Math.min(24, Math.max(0.004, camera.scale * factor)), surfaceAt({ x, y }));
      dirty = true;
    }
    if (!walk.active && pinch && pointers.size === 2) {
      // two fingers: zoom by how far apart they are, about the middle of them (the wheel's job on a mouse),
      // and how they have moved together turns the city and tilts it (the right button's). All at the height
      // of what was under the middle when the second finger touched: the thing seen there stays under the
      // fingers. Applied here, once a frame, for the reasons in the pointermove handler
      const state = pinchState(), { x, y, height } = pinch;
      // the zoom anchors at the middle of the fingers where they touched: one anchor for the whole
      // gesture, so that a zoom whose anchor wobbles with the fingers does not leave the map shifted
      camera.zoomAt(x, y, camera.scale * state.distance / pinch.distance, height);
      const across = (state.x - pinch.x) * pixelScale, down = (state.y - pinch.y) * pixelScale;
      camera.yaw += across * 0.006;
      camera.pitch = Math.min(1.45, Math.max(0.26, camera.pitch + down * 0.005));
      if (across || down) ui.follow();      // turns around the landmark last flown to, if there is any
      pinch = { ...state, height };
      dirty = true;
    }
    if (!frozen) renderer.time = now / 1000;
    // tiles are only wanted from the district tier on; the overview draws from its own package. While a flight
    // is on, only what its destination needs is asked for (D071), and what is on its way but of no use there
    // is let go: the flight passes over tiles it would never wait for, and the overview is drawn meanwhile.
    // Walking asks for what stands around the player, whatever the zoom the map was left at.
    const flyingToTiles = ui.flying() && ui.target().scale >= DISTRICT_SCALE * 0.5;
    if (walk.active) {
      if (world.flightTarget) world.endFlight();
      world.request(walk.view(), 8);
    } else if (flyingToTiles) {
      const view = world.viewOf(ui.target(), camera);
      if (!world.flightTarget) world.beginFlight(view);
      world.request(view, 10);
    } else {
      if (world.flightTarget) world.endFlight();
      if (camera.scale >= DISTRICT_SCALE * 0.5) world.request(world.visible(camera), 10);
    }
    world.upload(4);
    if (dirty || world.pending.size || walk.active || (camera.scale >= LIFE_SCALE && !frozen)) {
      renderer.present(renderer.render(world));
      dirty = false;
      ui.paint(now);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // for tests and the console
  window.__city = {
    camera, renderer, world, manifest: index, gl, ui,
    landmarks, city, walk,
    renderOnce: () => { renderer.present(renderer.render(world)); dirty = false; },
    // how much of a landmark is in the frame and how much of it is hidden behind other things
    landmarkMask: id => renderer.landmarkMask(id),
    // the world point drawn at a position on the page (CSS pixels from the canvas's corner): what a zoom
    // there holds on to
    under(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      const at = { x: (clientX - box.left) * width / box.width, y: (clientY - box.top) * height / box.height };
      const z = surfaceAt(at), point = camera.unproject(at.x, at.y, z);
      return { x: point.x, y: point.y, z };
    },
    overview,
    overviewTarget,                     // the pose `overview()` flies to, for tests
    touch: () => { dirty = true; },
    season: () => season,
    setSeason: name => ui.setSeason(name),
    seasons: seasonNames,
    flyTo: (id, seconds) => ui.flyTo(id, seconds),
    flying: () => ui.flying(),
    // the search by name: the answers to some words; the flight to the first of them (with 0 seconds it jumps);
    // the thing found last, and what is drawn over the map for it
    search: query => ui.search(query),
    find: (query, seconds = 0) => ui.find(query, seconds),
    found: () => ui.found(),
    mark: () => ui.mark(),
    index: () => ui.index(),
    // hold the wind and the water still, so that two frames of the same view are the same
    freeze(value = true) { frozen = value; if (value) renderer.time = 0; },
    // average time of a frame, measured the only way a browser lets you: by reading a pixel back
    bench(frames = 60) {
      const start = performance.now();
      for (let k = 0; k < frames; k++) renderer.render(world, { edges: true });
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      const first = gl.getError();
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.frame.workBFbo);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      const ms = (performance.now() - start) / frames;
      renderer.present(renderer.frame.workBFbo);
      return { ms: +ms.toFixed(2), frames, glError: first || gl.getError(), drawn: { ...renderer.drawn }, tiles: world.tiles.size, pending: world.pending.size, scale: camera.scale, frame: [renderer.W, renderer.H, renderer.SS] };
    },
    // resolve once every tile the current view needs has been uploaded
    async settle(budget = 60000) {
      const start = performance.now();
      while (performance.now() - start < budget) {
        if (camera.scale >= DISTRICT_SCALE * 0.5) world.request(world.visible(camera), 16);
        world.upload(8);
        if (!world.pending.size) break;
        await new Promise(r => setTimeout(r, 30));
      }
      renderer.present(renderer.render(world));
      return { tiles: world.tiles.size, drawn: { ...renderer.drawn }, ms: Math.round(performance.now() - start) };
    },
  };
  document.body.dataset.ready = '1';
}

boot().catch(error => {
  // 首页和城页各有一条读数栏，谁在就写在谁那里
  for (const at of ['readout-line', 'readout-home']) {
    const line = document.getElementById(at);
    if (line) line.textContent = `启动失败：${error.message}`;
  }
  throw error;
});
