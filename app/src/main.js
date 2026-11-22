// 像素杭州：主城区活地图。启动、输入和帧循环。
import { createContext } from './gl/context.js';
import { CityRenderer } from './render/city.js';
import { DISTRICT_SCALE, TREE_SCALE, World } from './world/store.js';

const canvas = document.getElementById('c');
const readout = document.getElementById('readout');
const DATA = '../data';
const MAX_WIDTH = 960, MAX_HEIGHT = 540;

const tierName = scale => scale < DISTRICT_SCALE ? '全景' : scale < 4 ? '城区' : '街区';
const pixelSize = scale => {
  const metres = 1 / scale;
  return metres < 1 ? `${Math.round(metres * 100)} 厘米` : `${Math.round(metres * 10) / 10} 米`;
};

async function boot() {
  const pixelScale = Math.max(1, Math.ceil(Math.max(innerWidth / MAX_WIDTH, innerHeight / MAX_HEIGHT)));
  const width = Math.max(160, Math.floor(innerWidth / pixelScale)), height = Math.max(120, Math.floor(innerHeight / pixelScale));
  const [index, paletteFile] = await Promise.all([
    fetch(`${DATA}/baked/index.json`).then(r => r.json()),
    fetch(`${DATA}/curated/palette.json`).then(r => r.json()),
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
  renderer.updatePalette();
  const place = name => {
    const at = names.indexOf(name);
    if (at < 0) throw new Error(`调色板里没有 ${name}`);
    return at;
  };
  renderer.setLook(index, place);

  const world = new World(gl, index, `${DATA}/baked`);
  await world.loadOverview();

  // start above the middle of the region with all of it in view
  const camera = renderer.city;
  const [west, south, east, north] = index.bounds;
  camera.x = (west + east) / 2;
  camera.y = (south + north) / 2;
  camera.pitch = Math.PI / 6;
  const overview = () => {
    const corners = [[west, south], [west, north], [east, south], [east, north]].map(([x, y]) => camera.project(x, y, 0));
    const spanX = Math.max(...corners.map(c => c.sx)) - Math.min(...corners.map(c => c.sx));
    const spanY = Math.max(...corners.map(c => c.sy)) - Math.min(...corners.map(c => c.sy));
    camera.scale = Math.min(0.9 * width / spanX, 0.86 * height / spanY);
    camera.x = (west + east) / 2;
    camera.y = (south + north) / 2;
  };
  overview();

  // ---- input -------------------------------------------------------------------------
  const pointers = new Map();
  let pinch = null;
  const toFrame = e => ({ x: e.clientX - canvas.getBoundingClientRect().left, y: e.clientY - canvas.getBoundingClientRect().top });
  canvas.addEventListener('pointerdown', e => {
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, toFrame(e));
    if (pointers.size === 2) pinch = pinchState();
  });
  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };
  canvas.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const was = pointers.get(e.pointerId), now = toFrame(e);
    pointers.set(e.pointerId, now);
    if (pointers.size === 2 && pinch) {
      const state = pinchState();
      const kept = camera.unproject(pinch.x, pinch.y);
      camera.zoomAt(state.x, state.y, camera.scale * state.distance / pinch.distance);
      const after = camera.unproject(pinch.x, pinch.y);
      camera.x += kept.x - after.x;
      camera.y += kept.y - after.y;
      pinch = state;
    } else if (pointers.size === 1) {
      camera.yaw -= (now.x - was.x) * 0.006;
      camera.pitch = Math.min(1.45, Math.max(0.26, camera.pitch + (now.y - was.y) * 0.005));
    }
  });
  const release = e => { pointers.delete(e.pointerId); pinch = null; };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const at = toFrame(e);
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
    camera.zoomAt(at.x, at.y, Math.min(24, Math.max(0.004, camera.scale * factor)));
  }, { passive: false });
  const keys = new Set();
  canvas.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'r'].includes(key)) {
      if (key === 'r') overview(); else keys.add(key);
      e.preventDefault();
    }
  });
  canvas.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  const pan = dt => {
    let right = 0, up = 0;   // screen directions
    if (keys.has('a') || keys.has('arrowleft')) right -= 1;
    if (keys.has('d') || keys.has('arrowright')) right += 1;
    if (keys.has('w') || keys.has('arrowup')) up += 1;
    if (keys.has('s') || keys.has('arrowdown')) up -= 1;
    if (!right && !up) return false;
    const step = height / camera.scale * 0.9 * dt;   // most of the screen's height in a second
    // right on screen is +u, up the screen is +v scaled by the squash of the ground
    const du = right * step, dv = up * step / camera.sinPitch;
    const rx = (du + dv) * Math.SQRT1_2, ry = (dv - du) * Math.SQRT1_2;
    camera.x += rx * camera.cos + ry * camera.sin;
    camera.y += -rx * camera.sin + ry * camera.cos;
    return true;
  };

  // ---- loop ----------------------------------------------------------------------------
  // the wind and the water only show once trees are drawn; farther out a frame is made only when something changes
  const animated = () => camera.scale >= TREE_SCALE && !frozen;
  let dirty = true, frozen = false, last = performance.now();
  const frame = now => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (pan(dt)) dirty = true;
    if (!frozen) renderer.time = now / 1000;
    // tiles are only wanted from the district tier on; the overview draws from its own package
    if (camera.scale >= DISTRICT_SCALE * 0.5) world.request(world.visible(camera), 10);
    world.upload(4);
    if (dirty || world.pending.size || animated()) {
      renderer.present(renderer.render(world));
      dirty = false;
      readout.textContent = `${tierName(camera.scale)} · 1 像素 ≈ ${pixelSize(camera.scale)} · 瓦片 ${world.tiles.size}${world.pending.size ? '（加载中）' : ''} · 三角形 ${Math.round(renderer.drawn.triangles / 1000)} 千`;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // for tests and the console
  window.__hz = {
    camera, renderer, world, index, gl,
    renderOnce: () => { renderer.present(renderer.render(world)); dirty = false; },
    overview,
    touch: () => { dirty = true; },
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
    // resolve once every tile the current tier needs has been uploaded
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
  readout.textContent = `启动失败：${error.message}`;
  throw error;
});
