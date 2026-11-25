// 走进城市：在地图上操作、行走的体验。三个形态共用这一个入口（main.js 的 G 键和工具按钮）：
//   环视  落在街上，拖动环顾，贴地透视的眼睛（city-camera 的 walking 字段和 GLSL 的 uWalk 分支）；
//   行走  第三人称小人在街上走，避开楼和水面（store.js 的碰撞栅格），车流与行人照常来往；
//   驾驶  在路上按 E 上一辆车，沿路网（瓦片的 PATH 线）街机式开，走高架随其剖面，再按 E 下车。
// 玩家不是特别的渲染：他就是交通系统（life/traffic.js）里的一个行人，开车时是一辆车。
//
// 操控：WASD/方向键 走或开 · Shift 跑 · 拖动 环顾（触屏左半边是摇杆）· E 上/下车 · G 或 Esc 回地图。

const WALK_SPEED = 1.7;      // metres a second at a stroll
const RUN_SPEED = 4.4;
const STICK_RANGE = 55;      // frame pixels a touch joystick spans
const CAM_BACK = 4.8;        // metres the walking camera stands behind its player
const CAR_ACCEL = 7, CAR_BRAKE = 13, CAR_DRAG = 2.2;
const CAR_REVERSE = 6;
const CAR_TOP = { 5: 15, 6: 12.5, 7: 10, 8: 9, 9: 7, 10: 6 };   // by class of road, metres a second
const CHASE_BACK = 10.5, CHASE_UP = 4.4;                        // the driving camera, metres

const clamp = (v, low, high) => Math.min(high, Math.max(low, v));

// the point and direction of a PATH line at a distance from its start (points: x, y, z, distance, tile-relative)
function alongLine(points, s) {
  const n = points.length / 4;
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4, b = a + 4;
    const from = points[a + 3], to = points[b + 3];
    if (s <= to || i === n - 2) {
      const t = to > from ? clamp((s - from) / (to - from), 0, 1) : 0;
      const dx = points[b] - points[a], dy = points[b + 1] - points[a + 1];
      const length = Math.hypot(dx, dy);
      return {
        x: points[a] + dx * t, y: points[a + 1] + dy * t, z: points[a + 2] + (points[b + 2] - points[a + 2]) * t,
        tx: length > 1e-6 ? dx / length : 1, ty: length > 1e-6 ? dy / length : 0,
      };
    }
  }
  return { x: points[0], y: points[1], z: points[2], tx: 1, ty: 0 };
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
    renderer.walk = this;
  }

  // ---- in and out -------------------------------------------------------------------------------------------

  // enter at a point of the world, nudged onto the nearest ground a walker can stand on
  enterAt(x, y) {
    const camera = this.camera;
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
    this.hud('WASD 走 · Shift 跑 · 拖动环顾');
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
    if (length > 0) {
      mx /= length; my /= length;
      const speed = keys.has('shift') ? RUN_SPEED : WALK_SPEED;
      let nx = this.player.x + mx * speed * dt, ny = this.player.y + my * speed * dt;
      // the walls: a step is taken only onto free ground, sliding along what blocks it
      const solid = this.world.solidAt(nx, ny);
      if (solid) {
        if (!this.world.solidAt(nx, this.player.y)) ny = this.player.y;
        else if (!this.world.solidAt(this.player.x, ny)) nx = this.player.x;
        else { nx = this.player.x; ny = this.player.y; }
      }
      this.player.moving = nx !== this.player.x || ny !== this.player.y;
      this.player.x = nx; this.player.y = ny;
      this.player.z = this.world.groundAt(nx, ny);
      if (this.player.moving) this.player.heading = Math.atan2(my, mx);
    } else {
      this.player.moving = false;
    }
    // the camera stands behind the player's shoulder and looks at his head
    const pitch = clamp(camera.pitch, -0.45, 1.2);
    const slant = 0.5 + pitch * 0.6;                       // how high the eye rides as the view tilts down
    const back = CAM_BACK * Math.cos(slant);
    camera.x = this.player.x - f.x * back;
    camera.y = this.player.y - f.y * back;
    camera.eyeZ = this.player.z + 1.7 + CAM_BACK * Math.sin(slant) + Math.max(0, pitch) * 1.5;
  }

  // ---- driving ----------------------------------------------------------------------------------------------

  // take the car that stands nearest (a car appears on the road at the player's feet)
  enterCar() {
    const near = this.world.roadsNear(this.player.x, this.player.y, 45);
    if (!near) { this.hud('附近没有路，走近一点再上车'); return false; }
    const lane = Math.max(2, near.line.width * 1.05);
    this.car = { tile: near.tile, line: near.line, s: near.s, lateral: clamp(lateralTo(near, this.player) , -lane, lane), speed: 0 };
    this.driving = true;
    this.hud('W/S 油门刹车 · A/D 转向 · E 下车');
    document.getElementById('drive').textContent = '下车 E';
    return true;
  }

  exitCar() {
    if (!this.driving) return;
    const p = this.carSpot();
    const side = { x: p.ty, y: -p.tx };                    // out of the door, to the right of the way
    let x = p.x + side.x * 3, y = p.y + side.y * 3;
    if (this.world.solidAt(x, y)) { x = p.x - side.x * 3; y = p.y - side.y * 3; }
    if (this.world.solidAt(x, y)) { x = p.x; y = p.y; }
    this.player.x = x; this.player.y = y;
    this.player.z = this.world.groundAt(x, y);
    this.player.heading = Math.atan2(p.ty, p.tx);
    this.driving = false;
    this.car = null;
    this.camera.pitch = 0.42;
    document.getElementById('drive').textContent = '上车 E';
    this.hud('WASD 走 · E 上车');
  }

  // where the car stands now
  carSpot() {
    const car = this.car, p = alongLine(car.line.points, car.s);
    const x = car.tile.x0 + p.x + p.ty * car.lateral, y = car.tile.y0 + p.y - p.tx * car.lateral;
    return { x, y, z: p.z, tx: p.tx, ty: p.ty };
  }

  driveTick(dt, keys) {
    const car = this.car, camera = this.camera;
    const forward = keys.has('w') || keys.has('arrowup') || (this.stick && this.stick.y > 0.2);
    const back = keys.has('s') || keys.has('arrowdown') || (this.stick && this.stick.y < -0.2);
    const steer = (keys.has('a') || keys.has('arrowleft') || (this.stick && this.stick.x < -0.2) ? -1 : 0)
      + (keys.has('d') || keys.has('arrowright') || (this.stick && this.stick.x > 0.2) ? 1 : 0);
    const top = CAR_TOP[car.line.cls] ?? 10;
    if (forward) car.speed = Math.min(top, car.speed + CAR_ACCEL * dt);
    else if (back) car.speed = Math.max(-CAR_REVERSE, car.speed - CAR_BRAKE * dt);
    else car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), CAR_DRAG * dt);
    const lane = Math.max(2, car.line.width * 1.05);
    car.lateral = clamp(car.lateral + steer * car.speed * dt * 0.6, -lane, lane);
    car.s += car.speed * dt;
    if (car.s >= car.line.length - 0.2) this.hopLine(1);
    else if (car.s <= 0.2 && car.speed < 0) this.hopLine(-1);
    const spot = this.carSpot();
    this.player.x = spot.x; this.player.y = spot.y; this.player.z = spot.z;
    this.player.heading = Math.atan2(spot.ty, spot.tx);
    // the chase: an eye behind the boot, looking the way the car points
    camera.yaw = this.camera.constructor.yawOf(spot.tx, spot.ty);
    camera.pitch = 0.24;
    const f = camera.walkForward();
    camera.x = spot.x - f.x * CHASE_BACK;
    camera.y = spot.y - f.y * CHASE_BACK;
    camera.eyeZ = spot.z + CHASE_UP;
  }

  // the road ran out: take up the nearest other line ahead of (or behind) the car
  hopLine(direction) {
    const car = this.car;
    const edge = direction > 0 ? car.line.length - 0.2 : 0.2;
    const p = alongLine(car.line.points, edge);
    const wx = car.tile.x0 + p.x, wy = car.tile.y0 + p.y;
    const probe = { x: wx + p.tx * direction * 40, y: wy + p.ty * direction * 40 };
    const next = this.world.roadsNear(probe.x, probe.y, 80, [5, 6, 7, 8, 9, 10], car.line);
    if (!next) { car.s = clamp(car.s, 0.2, car.line.length - 0.2); car.speed = 0; this.hud('前面没路了，掉个头（A/D 一边倒着转）'); return; }
    car.tile = next.tile; car.line = next.line; car.s = next.s; car.lateral = 0;
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
      this.camera.yaw += dx * 0.005;
      this.camera.pitch = clamp(this.camera.pitch - dy * 0.004, -0.45, 1.2);
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
    const el = document.getElementById('walkhint');
    if (el) el.textContent = text;
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

// the lateral offset a car would need to stand at the player's place on a line
function lateralTo(near, player) {
  const dx = player.x - near.x, dy = player.y - near.y;
  return dx * near.ty - dy * near.tx;
}
