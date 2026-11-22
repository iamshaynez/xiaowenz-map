"""Build the rotatable-camera experiment from an unmodified pixel-plays checkout.

Usage: python3 -I patch.py <path-to-pixel-plays> <output-dir>

Every replacement asserts its match count, so a change in the upstream files fails loudly
instead of producing a half-patched copy. Scene lines are matched on their stripped content
so the patch does not depend on remembering indentation. The result is derived from
pixel-plays (MIT); see LICENSE.pixel-plays next to this script.
"""
import pathlib
import re
import sys

src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)


def sub(text, old, new, count=1):
    found = text.count(old)
    if found != count:
        raise SystemExit(f"expected {count} match(es), found {found}: {old[:80]!r}")
    return text.replace(old, new)


def after_lines(text, code, extra, count=1):
    """Append `extra` (same indentation as the matched line) after every whole line equal to `code`."""
    lines = text.split("\n")
    hits = [i for i, line in enumerate(lines) if line.strip() == code]
    if len(hits) != count:
        raise SystemExit(f"expected {count} line(s) {code[:70]!r}, found {len(hits)}")
    for i in reversed(hits):
        indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
        lines[i + 1:i + 1] = [indent + part if part else "" for part in extra.split("\n")]
    return "\n".join(lines)


# ---------------------------------------------------------------- engine.js
engine = (src / "engine.js").read_text(encoding="utf-8")

engine = sub(engine, "const W = 360, H = 280, S = 10;\nconst SIN = 0.5, COS = Math.sqrt(3) / 2, R2 = Math.SQRT2;\nconst OX = W / 2, OY = H / 2 + (SCENE.originY || 0);",
"""const W = 360, H = 280, R2 = Math.SQRT2;
// EXPERIMENT (not part of pixel-plays): movable camera. The original fixed S = 10 and a 30-degree
// pitch (SIN = 0.5) with no yaw, and never moved.
const CAM = { yaw: 0, pitch: Math.PI / 6, scale: 10, panX: 0, panY: 0, bakeMs: 0 };
let S = 10, SIN = .5, COS = Math.sqrt(3) / 2;
let OX = W / 2, OY = H / 2 + (SCENE.originY || 0);
let YAW_C = 1, YAW_S = 0;""")

engine = sub(engine, "const GRADIENT_Y = COS / (S * SIN), EDGE = .28;",
             "let GRADIENT_Y = COS / (S * SIN); const EDGE = .28; // EXPERIMENT: gradient now depends on the camera")

engine = sub(engine, "  const u = (x - y) / R2, v = (x + y) / R2;",
             "  const rx = x * YAW_C - y * YAW_S, ry = x * YAW_S + y * YAW_C, u = (rx - ry) / R2, v = (rx + ry) / R2; // EXPERIMENT: yaw")

engine = sub(engine, "  const u = (sx - OX) / S, v = (sy - OY) / (S * SIN);\n  return { x: (u + v) / R2, y: (v - u) / R2 };",
             "  const u = (sx - OX) / S, v = (sy - OY) / (S * SIN), rx = (u + v) / R2, ry = (v - u) / R2;\n  return { x: rx * YAW_C + ry * YAW_S, y: -rx * YAW_S + ry * YAW_C }; // EXPERIMENT: yaw")

engine = sub(engine, "let capture = null; // when set, sphere() records pixels instead of drawing them",
"""// EXPERIMENT: apply yaw / pitch / scale / pan and derive everything the passes depend on
function setCamera(patch) {
  Object.assign(CAM, patch);
  S = CAM.scale; SIN = Math.sin(CAM.pitch); COS = Math.cos(CAM.pitch);
  GRADIENT_Y = COS / (S * SIN);
  OX = W / 2 + CAM.panX;
  OY = H / 2 + (SCENE.originY || 0) * S / 10 + CAM.panY;
  YAW_C = Math.cos(CAM.yaw); YAW_S = Math.sin(CAM.yaw);
}
// depth of a ground point, for scene code that fills the ground buffer directly
function groundDepth(x, y) {
  return (x * YAW_C - y * YAW_S + x * YAW_S + y * YAW_C) / R2 * COS;
}
let capture = null; // when set, sphere() records pixels instead of drawing them""")

# box(): the original paints only the two faces its fixed camera could see
engine = sub(engine, "  for (let a = x0; a <= x1; a += step) for (let b = z0; b <= z1; b += step) paint(a, y1, b, 2.3, noise(a * .8 + seed, b * 9));\n  for (let a = y0; a <= y1; a += step) for (let b = z0; b <= z1; b += step) paint(x1, a, b, 1.2, noise(a * .8 + seed, b * 9));",
"""  for (let a = x0; a <= x1; a += step) for (let b = z0; b <= z1; b += step) paint(a, y1, b, 2.3, noise(a * .8 + seed, b * 9));
  for (let a = y0; a <= y1; a += step) for (let b = z0; b <= z1; b += step) paint(x1, a, b, 1.2, noise(a * .8 + seed, b * 9));
  // EXPERIMENT: the two faces the original camera never saw, shaded as the turned-away sides
  for (let a = x0; a <= x1; a += step) for (let b = z0; b <= z1; b += step) paint(a, y0, b, 1, noise(a * .8 + seed, b * 9));
  for (let a = y0; a <= y1; a += step) for (let b = z0; b <= z1; b += step) paint(x0, a, b, 1.7, noise(a * .8 + seed, b * 9));""")

(dst / "engine.js").write_text(engine, encoding="utf-8")

# ---------------------------------------------------------------- stari-most/index.html
page = (src / "stari-most" / "index.html").read_text(encoding="utf-8")

page = sub(page, "<title>Stari Most</title>", "<title>Rotatable camera experiment \u2014 Stari Most (pixel-plays)</title>")
page = sub(page, "</style>", """  /* EXPERIMENT: the game HUD is hidden; this page only orbits the baked scene */
  .hud, #scores { display: none; }
  #cam-caption { position: fixed; left: 50%; bottom: max(14px, env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 6; text-align: center; color: #8b877f; white-space: nowrap; pointer-events: none; }
  #cam-caption b { display: block; font-weight: 400; color: #1c1b19; }
</style>""")

# drop the menu/credits shell and the game mount, but keep the line that sets window.PP_SCENE
# (shadow direction and vertical offset): it sits between the two and defines the scene's own look
page, n = re.subn(r'<script src="\.\./shell\.js"></script>\s*<script>\s*PixelPlays\.mount\(\{.*?\}\);\s*</script>',
                  '<!-- Experiment derived from pixel-plays by AmirMushich (MIT); concept by abhi. Not part of the original project. -->',
                  page, flags=re.S)
if n != 1:
    raise SystemExit(f"shell/mount script block: expected 1 match, found {n}")
page = sub(page, '<script src="../engine.js"></script>', '<script src="engine.js"></script>')

# ground depth must follow the yawed camera
page = after_lines(page, "zb[i] = (g.x + g.y) / R2 * COS;",
                   "zb[i] = groundDepth(g.x, g.y); // EXPERIMENT")

# close the geometry: every hand-built wall and gable existed only on the two visible sides
page = after_lines(page, "for (let a = x0; a <= x1; a += step) for (let z = 0; z <= z1; z += step) plot(a, y1, z, masonry(a, z, 3));",
                   "for (let a = x0; a <= x1; a += step) for (let z = 0; z <= z1; z += step) plot(a, y0, z, masonry(a, z, 1)); // EXPERIMENT: far wall",
                   count=2)  # squareTower() and house()
page = after_lines(page, "for (let a = y0; a <= y1; a += step) for (let z = 0; z <= z1; z += step) plot(x1, a, z, masonry(a, z, 2));",
                   "for (let a = y0; a <= y1; a += step) for (let z = 0; z <= z1; z += step) plot(x0, a, z, masonry(a, z, 1.5)); // EXPERIMENT: far wall",
                   count=2)

page = after_lines(page, "for (let h = 0; h <= rise * (1 - q); h += step) plot(x1, y, z + h, masonry(y, z + h, 2));",
                   "for (let h = 0; h <= rise * (1 - q); h += step) plot(x0, y, z + h, masonry(y, z + h, 1)); // EXPERIMENT: second gable")

page = after_lines(page, "plot(x, HALF_W, z, masonry(x, z, 3));",
                   "plot(x, -HALF_W, z, masonry(x, z, 1)); // EXPERIMENT: far wall of the bridge")

page = after_lines(page, "plot(a, y1 + .14, z, rampOf(DARK)[Math.abs(a - cx) < .03 ? 3 : 1]);",
                   "plot(a, y0 - .14, z, rampOf(DARK)[Math.abs(a - cx) < .03 ? 3 : 1]); // EXPERIMENT: windows on the far side")

page, n = re.subn(r"/\* ---------- input ---------- \*/.*?/\* ---------- sound ---------- \*/",
                  "/* ---------- input: removed in this experiment; the camera script at the end owns the pointer ---------- */\n/* ---------- sound ---------- */",
                  page, flags=re.S)
if n != 1:
    raise SystemExit(f"input block: expected 1 match, found {n}")

CONTROLS = r"""<script>
// EXPERIMENT (not part of pixel-plays): drag to orbit, wheel or a pinch to zoom, WASD / arrows to pan, R to reset.
// Every camera change re-bakes the static scene, exactly as the original did once at start-up.
(function () {
  const caption = document.createElement('div');
  caption.id = 'cam-caption';
  caption.innerHTML = '<span>拖动 旋转/俯仰 · 滚轮或双指 缩放 · WASD/方向键 平移 · R 复位</span><b></b>';
  document.body.append(caption);
  const readout = caption.querySelector('b');
  let dirty = false;
  function apply() {
    setCamera(CAM);
    tufts.length = 0; leaves.length = 0; kinds.fill(0); // grass, leaves and the surface-kind buffer are all filled per view
    const t = performance.now();
    bake();
    CAM.bakeMs = performance.now() - t;
    readout.textContent = 'yaw ' + ((Math.round(CAM.yaw * 180 / Math.PI) % 360) + 360) % 360 + '\u00b0 \u00b7 pitch ' + Math.round(CAM.pitch * 180 / Math.PI) +
      '\u00b0 \u00b7 zoom ' + (CAM.scale / 10).toFixed(2) + '\u00d7 \u00b7 \u91cd\u70d8 ' + CAM.bakeMs.toFixed(0) + ' ms';
  }
  const toCanvas = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
  let drag = null;
  canvas.addEventListener('pointerdown', e => { canvas.focus({ preventScroll: true }); canvas.setPointerCapture(e.pointerId); drag = toCanvas(e); });
  canvas.addEventListener('pointermove', e => {
    if (!drag) return;
    const p = toCanvas(e), dx = p.x - drag.x, dy = p.y - drag.y;
    drag = p;
    CAM.yaw -= dx * .008;
    CAM.pitch = clamp(CAM.pitch + dy * .006, .26, 1.4);
    dirty = true;
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', e => { e.preventDefault(); CAM.scale = clamp(CAM.scale * (e.deltaY > 0 ? 1 / 1.12 : 1.12), 5, 24); dirty = true; }, { passive: false });
  canvas.addEventListener('keydown', e => {
    const step = 24;
    if (e.key === 'ArrowLeft' || e.key === 'a') CAM.panX += step;
    else if (e.key === 'ArrowRight' || e.key === 'd') CAM.panX -= step;
    else if (e.key === 'ArrowUp' || e.key === 'w') CAM.panY += step;
    else if (e.key === 'ArrowDown' || e.key === 's') CAM.panY -= step;
    else if (e.key === 'r') Object.assign(CAM, { yaw: 0, pitch: Math.PI / 6, scale: 10, panX: 0, panY: 0 });
    else return;
    e.preventDefault(); dirty = true;
  });
  (function loop() { if (dirty) { dirty = false; apply(); } requestAnimationFrame(loop); })();
  window.__cam = { CAM, apply };
  apply();
})();
</script>
</body>"""

page = sub(page, "</body>", CONTROLS)
(dst / "index.html").write_text(page, encoding="utf-8")

for name in ("engine.js", "index.html"):
    text = (dst / name).read_text(encoding="utf-8")
    print(f"{name}: {len(text.splitlines())} lines, {text.count('EXPERIMENT')} experiment markers")
