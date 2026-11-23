// 首页：一颗星球，几座城。地球（globe.js）居中，城是它上面的红点和两张字（本地名、英文名）；
// 点一处，星球把那座城转到正前方，推近，白光一闪，落到那座城的地址上去（/hz?from=globe，
// 城的开场俯冲在 ui.js）。页面其余的部分——题字、读数、仪器环——都围着这颗球。
import { DATA_ORIGIN } from '../config.js';
import { createGlobe } from './globe.js';

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const COARSE = matchMedia('(pointer: coarse)').matches;
const $ = id => document.getElementById(id);

// 城市在球上的位置：定义里的范围取中心。经度在东为正，纬度在北为正
const place = said => ({ lat: (said.bounds[1] + said.bounds[3]) / 2, lon: (said.bounds[0] + said.bounds[2]) / 2 });

export async function bootHome() {
  document.body.dataset.page = 'home';
  const [listFile, paletteFile, land] = await Promise.all([
    fetch(`${DATA_ORIGIN}/cities.json`).then(r => r.json()),
    fetch(new URL('../../palette.json', import.meta.url)).then(r => r.json()),
    fetch(new URL('../../globe-land.json', import.meta.url)).then(r => r.json()),
  ]);
  const cities = listFile.cities.map(said => ({ ...said, ...place(said) }));
  const globe = createGlobe({ canvas: $('globe'), land, colours: paletteFile.colours, holdStill: REDUCED });
  const ring = $('globe-ring').getContext('2d');
  const stage = $('home-stage');

  // ---- 大小 ------------------------------------------------------------------------------------------
  // 和城里一个道理：先定内部画布多大（一颗像素几个 CSS 像素），球占视口短边的一半出头。
  // 仪器环的画布只装得下环和经度的字就够了，不必盖满整页
  let ringSide = 0;
  const sizeTo = () => {
    const css = Math.max(210, Math.min(470, Math.round(Math.min(innerWidth, innerHeight) * 0.52)));
    globe.resize(css, COARSE ? 2 : 3);
    const dpr = Math.min(2, devicePixelRatio || 1);
    ringSide = Math.round(css * 1.17 + 80);
    const canvas = $('globe-ring');
    canvas.width = Math.round(ringSide * dpr);
    canvas.height = canvas.width;
    canvas.style.width = `${ringSide}px`;
    canvas.style.height = `${ringSide}px`;
    ring.setTransform(dpr, 0, 0, dpr, 0, 0);
    ring.translate(ringSide / 2, ringSide / 2);   // 从此以环心为原点说话
  };
  sizeTo();
  addEventListener('resize', sizeTo);

  // ---- 城，作为球上的按钮 -----------------------------------------------------------------------------
  // 红点是画出来的吗？不是：点就是按钮本身，字是字（全分辨率，不参加像素化）。每帧挪到该在的地方。
  const markers = cities.map(city => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'marker';
    button.dataset.city = city.id;
    button.setAttribute('aria-label', `进入 ${city.name} ${city.en} 的地图`);
    button.innerHTML = `<i class="dot" aria-hidden="true"></i><span class="tag"><b>${city.name}</b><small>${(city.en || '').toUpperCase()}</small></span>`;
    button.addEventListener('click', () => enter(city));
    button.addEventListener('pointerenter', () => globe.hold(true));
    button.addEventListener('pointerleave', () => globe.hold(false));
    $('markers').append(button);
    return { city, button, seen: false };
  });
  // 名录里同样一行（键盘和读屏的人不必到球上找）
  for (const marker of markers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${marker.city.name} ${marker.city.en}`;
    button.addEventListener('click', () => enter(marker.city));
    $('home-cities').append(button);
  }
  $('home-cities').hidden = !markers.length;
  if (!markers.length) $('home-empty').hidden = false;

  // ---- 动画的账 ---------------------------------------------------------------------------------------
  const born = performance.now();
  let diving = null;                           // { city, at, phase } 潜入走到了哪一步
  const ping = { at: 0 };                      // 声呐圈：从红点荡开的一圈（圈心每帧跟着红点）

  function enter(city) {
    if (diving) return;
    diving = { city, phase: 'approach' };
    globe.hold(true);
    document.body.classList.add('diving');     // 其他的城让开（CSS 渐隐），选中这颗点留着引路
    for (const marker of markers) if (marker.city !== city) marker.button.style.opacity = '';
    $('readout-home').textContent = `目标 ${city.name} ${city.en} · N ${city.lat.toFixed(1)}° E ${city.lon.toFixed(1)}°`;
    if (REDUCED) return go(city);              // 不折腾的人：一闪就走
    markers.find(m => m.city === city)?.button.classList.add('chosen');
    globe.diveTo(city.lat, city.lon, 1.15, () => {
      diving.phase = 'zoom';
      document.body.classList.add('zooming');  // 球被推近：CSS 把像素放大，红点留在原地
      ping.at = performance.now();
      setTimeout(() => { $('flash').classList.add('on'); }, 720);
      setTimeout(() => go(city), 1060);
    });
  }
  function go(city) {
    if (diving?.gone) return;
    if (diving) diving.gone = true;
    location.assign(`/${city.id}?from=globe${location.search && location.search !== '?from=globe' ? `&${location.search.slice(1)}` : ''}`);
  }

  // ---- 拖动 -------------------------------------------------------------------------------------------
  // 横着拖是自转，竖着拖是倾角；放开手里的劲还在，慢慢散掉
  const hand = { at: null, spins: [] };
  stage.addEventListener('pointerdown', e => {
    if (diving || e.target.closest('.marker')) return;
    stage.setPointerCapture(e.pointerId);
    hand.at = { x: e.clientX, y: e.clientY };
    hand.spins = [];
    globe.hold(true);
  });
  stage.addEventListener('pointermove', e => {
    if (!hand.at || diving) return;
    const radius = globe.internal * globe.cssScale / 2;
    const dSpin = -(e.clientX - hand.at.x) / radius * 0.9, dTilt = (e.clientY - hand.at.y) / radius * 0.9;
    globe.nudge(dSpin, dTilt);
    hand.spins.push({ at: performance.now(), dSpin });
    hand.at = { x: e.clientX, y: e.clientY };
  });
  const letGo = () => {
    if (!hand.at) return;
    hand.at = null;
    globe.hold(false);
    const now = performance.now();
    const recent = hand.spins.filter(s => now - s.at < 120);
    const sum = recent.reduce((a, s) => a + s.dSpin, 0);
    if (recent.length) globe.fling(Math.max(-3, Math.min(3, sum * 6)), 0);
  };
  stage.addEventListener('pointerup', letGo);
  stage.addEventListener('pointercancel', letGo);

  // ---- 帧环 -------------------------------------------------------------------------------------------
  const ease = t => t * t * (3 - 2 * t);
  const fade = (z, a, b) => Math.max(0, Math.min(1, (z - a) / (b - a)));   // 球缘附近渐隐
  const Muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#8b877f';
  const Red = getComputedStyle(document.documentElement).getPropertyValue('--a').trim() || '#b5392b';

  function drawRing(now) {
    const radius = globe.internal * globe.cssScale / 2;
    ring.clearRect(-ringSide / 2, -ringSide / 2, ringSide, ringSide);
    // 仪器环：球缘外一圈虚线，刻度随自转走。开页时画满一圈，算是给这颗星球开笔
    const R = radius * 1.17, grow = REDUCED ? 1 : ease(Math.min(1, (now - born - 150) / 1100));
    if (grow <= 0) return;
    const { spin } = globe.angles();
    ring.strokeStyle = Muted;
    ring.lineWidth = 1;
    ring.setLineDash([1, 4]);
    ring.beginPath();
    ring.arc(0, 0, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * grow);
    ring.stroke();
    ring.setLineDash([]);
    if (grow < 1) return;
    const step = Math.PI / 18;                 // 十度一小格，三十度一大格
    ring.beginPath();
    for (let k = 0; k < 36; k++) {
      const major = k % 3 === 0, a = k * step - spin;
      ring.moveTo(Math.cos(a) * R, Math.sin(a) * R);
      ring.lineTo(Math.cos(a) * (R + (major ? 5 : 2.5)), Math.sin(a) * (R + (major ? 5 : 2.5)));
    }
    ring.stroke();
    // 经度的字：0°、东经、180°、西经，字随刻度走，人始终正着读
    ring.font = '10px ui-monospace, Menlo, monospace';
    ring.textAlign = 'center';
    ring.textBaseline = 'middle';
    for (const [deg, word] of [[0, '0°'], [90, '90°E'], [180, '180°'], [-90, '90°W']]) {
      const a = deg * Math.PI / 180 - spin;
      ring.fillStyle = Muted;
      ring.fillText(word, Math.cos(a) * (R + 24), Math.sin(a) * (R + 24));
    }
    // 声呐圈：从红点荡开（红点跟着球走，圈也跟着）
    if (ping.at && diving) {
      const at = globe.project(diving.city.lat, diving.city.lon);
      const px = at.x * globe.cssScale - radius, py = at.y * globe.cssScale - radius;
      const t = (now - ping.at) / 850;
      if (t < 1) {
        ring.strokeStyle = Red;
        ring.globalAlpha = 1 - t;
        ring.beginPath();
        ring.arc(px, py, 6 + t * radius * 1.6, 0, Math.PI * 2);
        ring.stroke();
        ring.globalAlpha = 1;
      } else ping.at = 0;
    }
  }

  let readoutAt = 0;
  function frame(now) {
    globe.paint(now);
    drawRing(now);
    // 城市标注：投影到全分辨率的页面上；靠球缘的渐隐，转过身去的藏起来。潜入时只挪选中那一颗，
    // 其余的交给 CSS 渐隐（每帧写内联透明度会把渐隐盖掉）
    const radius = globe.internal * globe.cssScale / 2;
    for (const marker of markers) {
      if (diving && marker.city !== diving.city) continue;
      const at = globe.project(marker.city.lat, marker.city.lon);
      const alpha = fade(at.z, 0.12, 0.38);
      const present = at.facing && alpha > 0;
      if (present !== marker.seen) {
        marker.seen = present;
        marker.button.classList.toggle('seen', present);
        if (present && !REDUCED) marker.button.classList.add('arrive');
        else marker.button.classList.remove('arrive');
      }
      if (present) {
        const x = at.x * globe.cssScale - radius, y = at.y * globe.cssScale - radius;
        const flip = x > radius * 0.55;        // 靠右半球的城，字往左放
        marker.button.style.transform = `translate(${x}px, ${y}px)`;
        if (!diving) marker.button.style.opacity = alpha.toFixed(2);
        marker.button.classList.toggle('flip', flip);
      }
    }
    // 读数：每 200 毫秒对一次表（窄屏上只报面向，城的名录就在左上）
    if (now - readoutAt > 200 && !diving) {
      readoutAt = now;
      const { lat, lon } = globe.facing();
      const ew = lon >= 0 ? 'E' : 'W', ns = lat >= 0 ? 'N' : 'S';
      const suffix = innerWidth > 720 && markers.length ? ` · 已上线 ${markers.length} 座城` : '';
      $('readout-home').textContent = `面向 ${ew} ${Math.abs(lon).toFixed(1)}° ${ns} ${Math.abs(lat).toFixed(1)}°${suffix}`;
    }
    requestAnimationFrame(frame);
  }

  // 开笔：先画一帧，再让球和字登台（body.home-in 里写好了各自登场的缓急）
  globe.paint(performance.now());
  requestAnimationFrame(frame);
  requestAnimationFrame(() => document.body.classList.add('home-in'));
  document.body.dataset.ready = '1';
  window.__home = { globe, cities, enter };    // 给测试和控制台的把手
}
