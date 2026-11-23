// What was found by name, drawn over the map on a canvas of the map's own pixels: the course of a road, a river or
// a railway as a dashed line, a ring round a building or a place. In the page's ink on a halo of its paper, so that
// it reads over anything the map puts underneath; and drawn a pixel at a time, so that it sits on the pixel grid
// however much the page is scaled up.
const PERIOD = 12, ON = 7;          // the dashes: seven pixels of ink, then five of paper

export class Mark {
  constructor(canvas, width, height, { ink, paper }) {
    canvas.width = width;
    canvas.height = height;
    this.context = canvas.getContext('2d');
    this.image = this.context.createImageData(width, height);
    this.pixels = new Uint32Array(this.image.data.buffer);      // one pixel in the machine's own order of bytes
    this.width = width;
    this.height = height;
    const little = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    const pixel = ([r, g, b], alpha) => (little ? (alpha << 24 | b << 16 | g << 8 | r) : (r << 24 | g << 16 | b << 8 | alpha)) >>> 0;
    this.ink = pixel(ink, 255);
    this.paper = pixel(paper, 204);
    this.target = null;          // { x, y, z }: the thing, in the world
    this.points = null;          // its course, x, y, z a point, or null
  }

  show(target, points) {
    this.target = target;
    this.points = points || null;
  }

  hide() {
    this.target = this.points = null;
    this.pixels.fill(0);
    this.context.putImageData(this.image, 0, 0);
  }

  // draw it as the camera sees it now
  paint(camera) {
    const { pixels, width: W, height: H, target, points } = this;
    if (!target) return;
    pixels.fill(0);
    // paper goes only where nothing is yet, so that it never covers ink already laid
    const paper = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H && !pixels[y * W + x]) pixels[y * W + x] = this.paper; };
    const ink = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) pixels[y * W + x] = this.ink; };
    if (points) {
      let run = 0;                                                     // pixels along the course so far: the dashes run on from one piece to the next
      for (let k = 0; k + 5 < points.length; k += 3) {
        const a = camera.project(points[k], points[k + 1], points[k + 2]), b = camera.project(points[k + 3], points[k + 4], points[k + 5]);
        run = this.segment(a.sx, a.sy, b.sx, b.sy, run, paper, ink);
      }
    } else {
      // a ring round the thing, with a hole in the middle so that the thing itself stays seen
      const { sx, sy } = camera.project(target.x, target.y, target.z);
      const cx = Math.round(sx), cy = Math.round(sy);
      for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
        const d = Math.hypot(x, y);
        if (d > 3.5 && d <= 4.3) paper(cx + x, cy + y);                // a circle of radius 4
        else if (d > 2.5 && d <= 3.5) ink(cx + x, cy + y);             // one of radius 3
      }
    }
    this.context.putImageData(this.image, 0, 0);
  }

  // one piece of the course, from (ax, ay) to (bx, by) in the frame's pixels, starting `run` pixels along it.
  // -> the run at its far end. Only the part in the frame is drawn; the dashes run on over the rest all the same,
  // so that they do not shift when the map is dragged.
  segment(ax, ay, bx, by, run, paper, ink) {
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy);
    if (!(length > 0)) return run;                                      // nothing to draw: the ends are one, or one of them is a break
    let from = 0, to = 1;                                              // Liang–Barsky: the frame grown by a pixel for the halo
    for (const [p, q] of [[-dx, ax + 1], [dx, this.width - ax + 1], [-dy, ay + 1], [dy, this.height - ay + 1]]) {
      if (p === 0) {
        if (q < 0) return run + length;                                // beside the frame and parallel to its edge
        continue;
      }
      if (p < 0) from = Math.max(from, q / p); else to = Math.min(to, q / p);
    }
    if (from > to) return run + length;
    const share = to - from, sx = ax + dx * from, sy = ay + dy * from, span = length * share, steps = Math.ceil(span);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, x = Math.round(sx + dx * share * t), y = Math.round(sy + dy * share * t);
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) paper(x + ox, y + oy);
      if ((run + span * t) % PERIOD < ON) ink(x, y);
    }
    return run + length;
  }

  // where the thing itself is on the page, in the frame's pixels, as the camera sees it now
  centre(camera) {
    if (!this.target) return null;
    const { sx, sy } = camera.project(this.target.x, this.target.y, this.target.z);
    return [sx, sy];
  }

  // what the last frame drew: counts of pixels of ink and of paper, and the box they make; or null for nothing
  measure() {
    if (!this.target) return null;
    let ink = 0, paper = 0, x0 = this.width, y0 = this.height, x1 = -1, y1 = -1;
    this.pixels.forEach((pixel, k) => {
      if (!pixel) return;
      if (pixel === this.ink) ink++; else paper++;
      const x = k % this.width, y = (k - x) / this.width;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    });
    return { ink, paper, box: ink + paper ? [x0, y0, x1, y1] : null };
  }
}
