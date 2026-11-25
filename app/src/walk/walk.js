// 走进城市：在地图上操作、行走的体验。三个形态共用这一个入口（main.js 的 G 键和工具按钮）：
//   环视  落在街上，拖动环顾，贴地透视的眼睛（city-camera 的 walking 字段和 GLSL 的 uWalk 分支）；
//   行走  第三人称小人在街上走，避开楼和水面（store.js 的碰撞栅格），车流与行人照常来往；
//   驾驶  在路上按 E 上一辆车，沿路网（瓦片的 PATH 线）街机式开，走高架随其剖面，再按 E 下车。
// 玩家不是特别的渲染：他就是交通系统（life/traffic.js）里的一个行人，开车时是一辆车。
//
// 操控：WASD/方向键 走或开 · Shift 跑 · 拖动 环顾（触屏左半边是摇杆）· E 上/下车 · G 或 Esc 回地图。

const WALK_SPEED = 4.5;      // metres a second at a brisk walk
const RUN_SPEED = 9;
const STICK_RANGE = 55;      // frame pixels a touch joystick spans
const EYE_HEIGHT = 1.7;      // the walking camera's height at the player
const CAR_ACCEL = 7, CAR_BRAKE = 13, CAR_DRAG = 2.2;
const CAR_REVERSE = 6;
const CAR_TOP = { 5: 15, 6: 12.5, 7: 10, 8: 9, 9: 7, 10: 6 };   // by class of road, metres a second
const CAR_STEER = 1.9;       // radians a second at full lock and city speed
const CHASE_BACK = 10.5, CHASE_UP = 4.4;                        // the driving camera, metres
const LOOK_SENS = 0.0028;    // radians of view per pixel of mouse travel (pointer locked)
const DRAG_SENS = 0.0042;    // the same for a held drag (touch, or a mouse without pointer lock)

const clamp = (v, low, high) => Math.min(high, Math.max(low, v));

// the world point and direction of a PATH line at a distance from its start (points: x, y, z, distance,
// tile-relative; the answer in world metres)
function linePoint(tile, line, s) {
  const pts = line.points, n = pts.length / 4;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4, b = a + 4;
    if (s <= pts[b + 3] || i === n - 2) {
      const from = pts[a + 3], to = pts[b + 3];
      const t = to > from ? clamp((s - from) / (to - from), 0, 1) : 0;
      const dx = pts[b] - pts[a], dy = pts[b + 1] - pts[a + 1];
      const len = Math.hypot(dx, dy);
      return { x: tile.x0 + pts[a] + dx * t, y: tile.y0 + pts[a + 1] + dy * t, z: pts[a + 2] + (pts[b + 2] - pts[a + 2]) * t,
        tx: len > 1e-6 ? dx / len : 1, ty: len > 1e-6 ? dy / len : 0 };
    }
  }
  return { x: tile.x0 + pts[0], y: tile.y0 + pts[1], z: pts[2], tx: 1, ty: 0 };
}

// a tile's collision raster as a little canvas, for the minimap's blocks of buildings and water
function solidCanvas(tile) {
  if (tile.solidCanvas) return tile.solidCanvas;
  const n = tile.solid.n;
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(n, n);
  const bytes = tile.solid.bytes;
  for (let i = 0; i < bytes.length; i++) {
    const o = i * 4;
    img.data[o] = 213;
    img.data[o + 1] = 208;
    img.data[o + 2] = 197;
    img.data[o + 3] = bytes[i] ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  tile.solidCanvas = cv;
  return cv;
}

export class Walk {
  constructor({ camera, world, renderer, keys }) {
    this.camera = camera;
    this.world = world;
    this.renderer = renderer;
    this.keys = keys;              // the page's set of held keys, shared with the map's own panning
    this.active = false;
    this.driving = false;
    this.saved = null;             // the map pose to go back to
    this.player = { x: 0, y: 0, z: 0, heading: 0, moving: false };
    this.car = null;               // { tile, line, s, lateral, speed }
    this.stick = null;             // the touch joystick, x right and y forward, in -1..1
    this.stickHome = null;
    this.speedScale = 1;           // what the wheel and the +/− keys multiply the pace by, 0.5..6
    this.camDist = 3.5;            // metres the walking camera stands behind its player, 2..6
    this.mapCanvas = document.getElementById('minimap');
    this.mapCtx = this.mapCanvas?.getContext('2d') ?? null;
    renderer.walk = this;
  }

  // ---- in and out -------------------------------------------------------------------------------------------

  // enter at a point of the world, nudged onto the nearest ground a walker can stand on
  enterAt(x, y) {
    const camera = this.camera;
    // 没有瓦片的地方（区域之外、还没载入的角落）落不下脚：那里既没有地面可站，也没有墙可靠
    const bounds = this.world.index.bounds, [west, south, east, north] = bounds;
    if (x < west - 300 || x > east + 300 || y < south - 300 || y > north + 300) return false;
    const tile = this.world.tileAt(x, y);
    if (!tile) return false;                 // the tile that holds the spot has not loaded yet
    const free = (px, py) => !this.world.solidAt(px, py);
    if (!free(x, y)) {
      let found = null;
      for (let ring = 1; ring <= 6 && !found; ring++) {
        for (let k = 0; k < 8 && !found; k++) {
          const angle = k * Math.PI / 4, px = x + Math.cos(angle) * ring * 4, py = y + Math.sin(angle) * ring * 4;
          if (free(px, py)) found = { x: px, y: py };
        }
      }
      if (!found) return false;
      x = found.x; y = found.y;
    }
    this.saved = { x: camera.x, y: camera.y, scale: camera.scale, pitch: camera.pitch, yaw: camera.yaw };
    this.player = { x, y, z: this.world.groundAt(x, y), heading: this.player.heading ?? 0, moving: false };
    this.driving = false;
    this.car = null;
    this.active = true;
    camera.walking = true;
    camera.scale = 24;             // the map zoom's gates (roofs, brands, facades) read as "close in"
    camera.pitch = 0.42;
    document.body.classList.add('walking');
    document.getElementById('walkhud').hidden = false;
    this.hud('WASD 走 · Shift 跑 · 滚轮/+- 调速 · 点击画面锁定鼠标看四周 · Esc 解锁');
    return true;
  }

  // enter under the middle of the map's view
  enterCentre() {
    const camera = this.camera, p = camera.unproject(camera.width / 2, camera.height / 2);
    return this.enterAt(p.x, p.y);
  }

  exit() {
    const camera = this.camera;
    this.active = false;
    this.driving = false;
    this.car = null;
    camera.walking = false;
    Object.assign(camera, this.saved);
    document.body.classList.remove('walking');
    document.getElementById('walkhud').hidden = true;
  }

  toggle() {
    if (this.active) this.exit();
    else return this.enterCentre() ? 'entered' : false;
    return 'exited';
  }

  // ---- one moment -------------------------------------------------------------------------------------------

  tick(dt) {
    const keys = this.keys;
    if (this.driving) this.driveTick(dt, keys);
    else this.walkTick(dt, keys);
    this.hudRoad();
    this.drawMinimap();
  }

  // ---- the minimap ------------------------------------------------------------------------------------------
  // 左下角的小地图：随行进方向转，路面按等级画线，建筑与水面是淡灰的块（碰撞栅格的画法），中央是
  // 玩家的箭头和视野锥，图缘标着北。驾驶时也一样，箭头随车头转
  drawMinimap() {
    const el = this.mapCanvas, ctx = this.mapCtx;
    if (!el || !ctx) return;
    const W = el.width, H = el.height, anchorY = H - 22;
    const f = this.camera.walkForward();
    const rot = -Math.PI / 2 - Math.atan2(f.y, f.x);
    const k = 0.3;                                   // pixels per metre: the map holds some 300 m across
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#efece4';
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    ctx.translate(W / 2, anchorY);
    ctx.rotate(rot);
    ctx.scale(k, k);
    ctx.translate(-this.player.x, -this.player.y);
    // 建筑与水：碰撞栅格画成淡灰的块
    const { index } = this.world, size = index.tileSize;
    const tx0 = Math.floor(this.player.x / size) - index.ix0, ty0 = Math.floor(this.player.y / size) - index.iy0;
    ctx.imageSmoothingEnabled = false;
    for (let ty = ty0 - 1; ty <= ty0 + 1; ty++) for (let tx = tx0 - 1; tx <= tx0 + 1; tx++) {
      const tile = this.world.tiles.get(`${tx}_${ty}`);
      if (tile?.solid) ctx.drawImage(solidCanvas(tile), tile.x0, tile.y0, size, size);
    }
    // 路面：等级越高线越宽越深
    const STYLE = { 5: ['#43403a', 8], 6: ['#43403a', 7], 7: ['#7d786e', 4.5], 8: ['#7d786e', 3.6], 9: ['#b5afa2', 2.6], 10: ['#b5afa2', 2.6] };
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let ty = ty0 - 1; ty <= ty0 + 1; ty++) for (let tx = tx0 - 1; tx <= tx0 + 1; tx++) {
      const tile = this.world.tiles.get(`${tx}_${ty}`);
      if (!tile?.paths) continue;
      for (const line of tile.paths) {
        const st = STYLE[line.cls];
        if (!st) continue;
        ctx.strokeStyle = st[0];
        ctx.lineWidth = st[1];
        ctx.beginPath();
        const pts = line.points;
        ctx.moveTo(tile.x0 + pts[0], tile.y0 + pts[1]);
        for (let i = 4; i < pts.length; i += 4) ctx.lineTo(tile.x0 + pts[i], tile.y0 + pts[i + 1]);
        ctx.stroke();
      }
    }
    ctx.restore();
    // 玩家的箭头与视野锥，还有图缘的北
    ctx.save();
    ctx.translate(W / 2, anchorY);
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#1c1b19';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 34, -Math.PI / 2 - 0.45, -Math.PI / 2 + 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(0, -7.5);
    ctx.lineTo(5, 5.5);
    ctx.lineTo(0, 2.6);
    ctx.lineTo(-5, 5.5);
    ctx.closePath();
    ctx.fill();
    const north = { x: -Math.sin(rot), y: Math.cos(rot) };
    ctx.fillStyle = '#1c1b19';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('北', W / 2 + north.x * (Math.min(W, H) / 2 - 12), anchorY + north.y * (Math.min(W, H) / 2 - 12));
    ctx.restore();
  }

  walkTick(dt, keys) {
    const camera = this.camera, f = camera.walkForward(), r = camera.walkRight();
    let mx = 0, my = 0;
    if (keys.has('w') || keys.has('arrowup')) { mx += f.x; my += f.y; }
    if (keys.has('s') || keys.has('arrowdown')) { mx -= f.x; my -= f.y; }
    if (keys.has('a') || keys.has('arrowleft')) { mx -= r.x; my -= r.y; }
    if (keys.has('d') || keys.has('arrowright')) { mx += r.x; my += r.y; }
    if (this.stick) { mx += r.x * this.stick.x + f.x * this.stick.y; my += r.y * this.stick.x + f.y * this.stick.y; }
    const length = Math.hypot(mx, my);
    const ground0 = this.world.groundAt(this.player.x, this.player.y);
    const elevated = this.player.z > ground0 + 1.5;
    if (length > 0) {
      mx /= length; my /= length;
      const speed = (keys.has('shift') ? RUN_SPEED : WALK_SPEED) * this.speedScale;
      // 在高处（引桥、桥面、人行桥）的人跟着身边的那条线走：线怎么弯人怎么走，线给高度，走出线
      // 的廊道就是下桥。地面上的行走不贴线，还是自由的
      const onDeckLine = elevated && this.onLine;
      if (onDeckLine) {
        const L = this.onLine;
        const along = mx * L.tx + my * L.ty;
        const across = mx * L.ty - my * L.tx;
        if (Math.abs(across) > 0.72) {
          this.onLine = null;                      // 往桥外走：下桥
        } else {
          const lane = Math.max(1.2, L.width * 0.5);
          L.lateral = clamp(L.lateral + across * speed * dt * 0.8, -lane, lane);
          L.s = clamp(L.s + along * speed * dt, 0, L.length);
          const p = linePoint(L.tile, L.line, L.s);
          this.player.x = p.x + p.ty * L.lateral;
          this.player.y = p.y - p.tx * L.lateral;
          this.player.z = p.z;
          this.player.heading = Math.atan2(p.ty * (along >= 0 ? 1 : -1), p.tx * (along >= 0 ? 1 : -1));
          this.player.moving = true;
          // 线走到了头：接上前面最近的另一条（高度相配的），不然就是桥尾了
          if (L.s <= 0.1 || L.s >= L.length - 0.1) {
            const ahead = this.world.roadsNear(this.player.x + p.tx * (along >= 0 ? 6 : -6), this.player.y + p.ty * (along >= 0 ? 6 : -6),
              10, [5, 6, 7, 8, 9, 10], L.line, this.player.z);
            if (ahead) {
              L.tile = ahead.tile; L.line = ahead.line; L.s = ahead.s; L.tx = ahead.tx; L.ty = ahead.ty; L.length = ahead.line.length;
            } else {
              this.onLine = null;
            }
          }
        }
      }
      if (!(elevated && this.onLine)) {
        let nx = this.player.x + mx * speed * dt, ny = this.player.y + my * speed * dt;
        // the walls: a step is taken only onto free ground, sliding along what blocks it. On a deck the
        // ground below is not underfoot, so its buildings and water do not block
        const solid = elevated ? 0 : this.world.solidAt(nx, ny);
        if (solid) {
          if (!this.world.solidAt(nx, this.player.y)) ny = this.player.y;
          else if (!this.world.solidAt(this.player.x, ny)) nx = this.player.x;
          else { nx = this.player.x; ny = this.player.y; }
        }
        this.player.moving = nx !== this.player.x || ny !== this.player.y;
        this.player.x = nx; this.player.y = ny;
        // 上桥的路：走到一条高度相配的线边（引桥的落地端、台阶、人行桥），人就搭上它
        let z = elevated ? this.player.z : this.world.groundAt(nx, ny);
        const near = this.world.roadsNear(nx, ny, elevated ? 3 : 2.2, [5, 6, 7, 8, 9, 10], null, this.player.z);
        if (near && Math.abs(near.z - this.player.z) < 2.5) {
          z = Math.max(z, near.z);
          // 搭线只搭"高高在上的线"——引桥、桥面、人行桥；地面上的路不收编自由的步行
          const lineIsUp = near.z > this.world.groundAt(near.x, near.y) + 0.6;
          if (elevated || lineIsUp) {
            const dx = this.player.x - near.x, dy = this.player.y - near.y;
            this.onLine = { tile: near.tile, line: near.line, s: near.s, lateral: clamp(dx * near.ty - dy * near.tx, -2, 2),
              tx: near.tx, ty: near.ty, length: near.line.length, width: near.line.width };
          }
        } else if (elevated && !near) {
          this.onLine = null;                        // 桥沿走空了：落回地面
          z = this.world.groundAt(nx, ny);
        }
        this.player.z = z;
        if (this.player.moving) this.player.heading = Math.atan2(my, mx);
      }
    } else {
      this.player.moving = false;
    }
    // the camera stands behind the player, at the distance the user chose: looking down raises it a
    // little, like a boom, and a wall at its back pulls it in towards the player
    const pitch = clamp(camera.pitch, -0.9, 1.35);
    const tilt = Math.max(pitch, 0) * 0.75;
    const cos = Math.cos(tilt), sin = Math.sin(tilt);
    let d = this.camDist;
    for (; d > 0.6; d -= 0.4) {
      if (!this.world.solidAt(this.player.x - f.x * d * cos, this.player.y - f.y * d * cos)) break;
    }
    camera.x = this.player.x - f.x * d * cos;
    camera.y = this.player.y - f.y * d * cos;
    camera.eyeZ = Math.max(this.player.z + EYE_HEIGHT + d * sin, this.world.groundAt(camera.x, camera.y) + 0.7);
  }

  // ---- driving ----------------------------------------------------------------------------------------------

  // take the car that stands nearest (a car appears on the road at the player's feet)
  enterCar() {
    const near = this.world.roadsNear(this.player.x, this.player.y, 60);
    if (!near) { this.hud('附近没有路，走近一点再上车'); return false; }
    this.car = { x: near.x, y: near.y, z: near.z, heading: Math.atan2(near.ty, near.tx), speed: 0, cls: near.line.cls };
    this.driving = true;
    this.player.x = near.x; this.player.y = near.y; this.player.z = near.z;
    this.hud('W/S 油门刹车 · A/D 转向 · E 下车');
    document.getElementById('drive').textContent = '下车 E';
    return true;
  }

  exitCar() {
    if (!this.driving) return;
    const hx = Math.cos(this.car.heading), hy = Math.sin(this.car.heading);
    let x = this.car.x + hy * 3, y = this.car.y - hx * 3;   // out of the door, to the right of the way
    if (this.world.solidAt(x, y)) { x = this.car.x - hy * 3; y = this.car.y + hx * 3; }
    if (this.world.solidAt(x, y)) { x = this.car.x; y = this.car.y; }
    this.player.x = x; this.player.y = y;
    this.player.z = this.world.groundAt(x, y);
    this.player.heading = this.car.heading;
    this.driving = false;
    this.car = null;
    this.camera.pitch = 0.42;
    document.getElementById('drive').textContent = '上车 E';
    this.hud('WASD 走 · E 上车');
  }

  // one moment at the wheel: the car owns its heading (steering turns it, reversing turns the other
  // way), the road only guides it — the nearest line gives the height, decks keep the car in their
  // corridor, and buildings and water block it like they block a walker
  driveTick(dt, keys) {
    const car = this.car, camera = this.camera;
    const forward = keys.has('w') || keys.has('arrowup') || (this.stick && this.stick.y > 0.2);
    const back = keys.has('s') || keys.has('arrowdown') || (this.stick && this.stick.y < -0.2);
    const steer = (keys.has('a') || keys.has('arrowleft') || (this.stick && this.stick.x < -0.2) ? -1 : 0)
      + (keys.has('d') || keys.has('arrowright') || (this.stick && this.stick.x > 0.2) ? 1 : 0);
    const top = Math.min(45, (CAR_TOP[car.cls] ?? 10) * this.speedScale);
    if (forward) car.speed = Math.min(top, car.speed + CAR_ACCEL * dt);
    else if (back) car.speed = Math.max(-CAR_REVERSE, car.speed - CAR_BRAKE * dt);
    else car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), CAR_DRAG * dt);
    // turning needs way on, tightens at city speed and softens on the fast road; in reverse it swaps sides
    const grip = clamp(Math.abs(car.speed) / 6, 0, 1) / (1 + Math.abs(car.speed) / 20);
    car.heading += steer * CAR_STEER * grip * (car.speed < 0 ? -1 : 1) * dt;
    const hx = Math.cos(car.heading), hy = Math.sin(car.heading);
    let nx = car.x + hx * car.speed * dt, ny = car.y + hy * car.speed * dt;
    if (this.world.solidAt(nx, ny)) {
      // a wall: slide along it and lose way
      if (!this.world.solidAt(nx, car.y)) ny = car.y;
      else if (!this.world.solidAt(car.x, ny)) nx = car.x;
      else { nx = car.x; ny = car.y; }
      car.speed *= 0.55;
    }
    // the road under the wheels: the nearest line's level, a deck's corridor, and the deck's own height
    const near = this.world.roadsNear(nx, ny, 12, [5, 6, 7, 8, 9, 10], null, car.z);
    const ground = this.world.groundAt(nx, ny);
    let z = ground;
    if (near) {
      if (near.z > ground + 2) {
        // up on a deck: stay in its corridor, at its height
        const dx = nx - near.x, dy = ny - near.y;
        const lateral = clamp(dx * near.ty - dy * near.tx, -(near.line.width * 1.1 + 0.8), near.line.width * 1.1 + 0.8);
        nx = near.x + near.ty * lateral;
        ny = near.y - near.tx * lateral;
        z = near.z;
      } else if (Math.abs(near.z - ground) < 2) {
        z = near.z;                            // right on the road
      }
    }
    car.x = nx; car.y = ny; car.z = z;
    this.player.x = nx; this.player.y = ny; this.player.z = z;
    this.player.heading = car.heading;
    // the chase: an eye behind the boot, looking the way the car points
    camera.yaw = camera.constructor.yawOf(hx, hy);
    camera.pitch = 0.24;
    const f = camera.walkForward();
    camera.x = nx - f.x * CHASE_BACK;
    camera.y = ny - f.y * CHASE_BACK;
    camera.eyeZ = z + CHASE_UP;
  }

  // ---- the player among the traffic -------------------------------------------------------------------------

  // called by the renderer every frame it draws the walking view: the player is one more box of the
  // traffic's own (a figure of three boxes on foot, a taxi at the wheel)
  place(traffic, colours) {
    const p = this.player;
    const tx = Math.cos(p.heading), ty = Math.sin(p.heading);
    if (this.driving) {
      traffic.box(p.x, p.y, p.z + 0.1, tx, ty, 4.4, 1.8, 1.5, colours[5], colours[1], 0);
    } else {
      traffic.figure(p.x, p.y, p.z + 0.1, tx, ty, 0.3, 0.42, 0.55, colours[2], colours[2], 7);
      traffic.figure(p.x, p.y, p.z + 0.65, tx, ty, 0.32, 0.52, 0.75, colours[11], colours[11], 8);
      traffic.figure(p.x, p.y, p.z + 1.4, tx, ty, 0.36, 0.38, 0.34, colours[10], colours[2], 9);
    }
  }

  // the tiles to ask for while walking
  view() {
    return this.world.visibleAround(this.camera, 1500);
  }

  // ---- input -------------------------------------------------------------------------------------------------

  // the view follows the mouse: right turns right, down looks down
  look(dx, dy) {
    this.camera.yaw += dx * LOOK_SENS;
    this.camera.pitch = clamp(this.camera.pitch + dy * LOOK_SENS, -0.9, 1.35);
  }

  // the pace: a turn of the wheel or a press of +/− multiplies it
  speedBy(delta) {
    this.speedScale = clamp(this.speedScale * Math.exp(-delta * 0.0011), 0.5, 6);
    this.hud();
  }

  speedStep(up) {
    const steps = [0.5, 1, 1.5, 2, 3, 4, 6];
    const at = steps.findIndex(v => v >= this.speedScale - 1e-6);
    const next = up ? Math.min(steps.length - 1, at + 1) : Math.max(0, at - 1);
    this.speedScale = steps[at === -1 ? steps.length - 1 : next];
    this.hud();
  }

  // the camera's stand behind the player, 2 to 6 metres
  camDistStep(farther) {
    const steps = [2, 2.5, 3, 3.5, 4, 5, 6];
    const at = steps.findIndex(v => v >= this.camDist - 1e-6);
    const next = farther ? Math.min(steps.length - 1, at + 1) : Math.max(0, at === -1 ? 0 : at - 1);
    this.camDist = steps[at === -1 ? 0 : next];
    this.hud();
  }

  // a drag on the canvas of the walking view: on the left of the screen a touch joystick (mode 'stick',
  // x and y the pointer's place), anywhere else a look around (dx, dy its motion since the last report)
  beginDrag(mode, x, y) {
    this.stickHome = mode === 'stick' ? { x, y } : null;
    if (mode === 'look') this.stick = null;
  }

  drag(mode, x, y, dx, dy) {
    if (mode === 'stick') {
      if (!this.stickHome) this.stickHome = { x, y };
      this.stick = {
        x: clamp((x - this.stickHome.x) / STICK_RANGE, -1, 1),
        y: clamp((this.stickHome.y - y) / STICK_RANGE, -1, 1),
      };
    } else {
      this.camera.yaw += dx * DRAG_SENS;
      this.camera.pitch = clamp(this.camera.pitch + dy * DRAG_SENS, -0.9, 1.35);
    }
  }

  endDrag() { this.stick = null; this.stickHome = null; }

  // a key that is not held movement: E takes or leaves a car
  key(key) {
    if (key === 'e') {
      if (this.driving) this.exitCar();
      else if (this.active) this.enterCar();
    }
  }

  // ---- the words on the screen ------------------------------------------------------------------------------

  hud(text) {
    this.hudText = text ?? this.hudText ?? '';
    const el = document.getElementById('walkhint');
    if (el) el.textContent = `${this.hudText} · 速度 ×${this.speedScale.toFixed(1)} · 镜头 ${this.camDist.toFixed(1)} 米`;
  }

  // the drive button says what it would do from here, and says nothing while it cannot
  hudRoad() {
    if (this.driving) return;
    const button = document.getElementById('drive');
    if (!button) return;
    const near = this.world.roadsNear(this.player.x, this.player.y, 45);
    button.disabled = !near;
    button.textContent = '上车 E';
  }
}
