"""Where do the GPU and CPU frames differ? Prints a breakdown for one case.

Usage: .venv/bin/python -I tools/tests/fidelity_diag.py out/fidelity default static
"""
import sys
import pathlib
import numpy as np

out, case, tag = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
cpu_dir, gpu_dir = out / 'cpu', out

def load(dirpath, name, dtype):
    return np.fromfile(dirpath / name, dtype=dtype)

W, H = 360, 280
cpu = load(cpu_dir, f'{case}.{tag}.pix', np.uint8).reshape(H, W, 4)[..., :3].astype(int)
cpu_z = load(cpu_dir, f'{case}.{tag}.zb', np.float32).reshape(H, W)
cpu_gz = load(cpu_dir, f'{case}.{tag}.groundZ', np.float32).reshape(H, W)
cpu_k = load(cpu_dir, f'{case}.{tag}.kinds', np.uint8).reshape(H, W)
gpu = load(gpu_dir, f'{case}.{tag}.gpu.pix', np.uint8).reshape(H, W, 4)[..., :3].astype(int)
gpu_c = load(gpu_dir, f'{case}.{tag}.gpu.cls', np.uint8).reshape(H, W, 4)
gpu_z = load(gpu_dir, f'{case}.{tag}.gpu.zb', np.float32).reshape(H, W)

c_non, g_non = ~(cpu == 255).all(-1), ~(gpu == 255).all(-1)
print(f'non-white pixels: cpu {c_non.sum()}  gpu {g_non.sum()}  both {(c_non & g_non).sum()}  cpu-only {(c_non & ~g_non).sum()}  gpu-only {(g_non & ~c_non).sum()}')
for name, m in [('cpu', c_non), ('gpu', g_non)]:
    ys, xs = np.nonzero(m)
    print(f'  {name} bbox x {xs.min()}..{xs.max()}  y {ys.min()}..{ys.max()}')

c_ground = cpu_z == cpu_gz          # includes void in the cpu's convention
c_vis_ground = (cpu_k > 0) & c_ground
g_cov = gpu_c[..., 3] > 127
g_ground = gpu_c[..., 0] > 127
print(f'visible ground: cpu {c_vis_ground.sum()}  gpu {g_ground.sum()}')
print('kind histogram (cpu kinds / gpu class.g):', {k: (int(((cpu_k == k) & c_vis_ground).sum()), int(((gpu_c[..., 1] == k) & g_ground).sum())) for k in range(4)})
same_ground = c_vis_ground & g_ground & (cpu_k == gpu_c[..., 1])
d = np.abs(cpu - gpu).sum(-1)
print(f'ground pixels with same kind: {same_ground.sum()}  mean |diff| per channel {d[same_ground].sum() / max(1, same_ground.sum()) / 3:.2f}  max {d[same_ground].max() if same_ground.any() else 0}')
both = c_non & g_non
print(f'all overlapping pixels: mean |diff| per channel {d[both].sum() / max(1, both.sum()) / 3:.2f}')
obj_c = c_non & ~c_vis_ground
obj_g = g_non & ~g_ground
print(f'object pixels: cpu {obj_c.sum()}  gpu {obj_g.sum()}  both {(obj_c & obj_g).sum()}')
both_obj = obj_c & obj_g
dz = cpu_z[both_obj] - gpu_z[both_obj]
print(f'depth on shared object pixels: mean {dz.mean():.3f}  |median| {np.median(np.abs(dz)):.3f}  within 0.05: {(np.abs(dz) < 0.05).mean() * 100:.1f}%')
print('gpu depth percentiles 0/1/50/99/100:', np.percentile(gpu_z, [0, 1, 50, 99, 100]).round(2).tolist(), '| outside [-1000, 1000]:', int(((gpu_z < -1000.5) | (gpu_z > 1000.5)).sum()))
print('cpu depth on objects percentiles 1/50/99:', np.percentile(cpu_z[obj_c], [1, 50, 99]).round(2).tolist(), '| gpu depth on gpu objects:', np.percentile(gpu_z[obj_g], [1, 50, 99]).round(2).tolist())

# coarse map: where only one of the two has something
cell = 8
rows = []
for y in range(0, H, cell):
    row = ''
    for x in range(0, W, cell):
        c, g = c_non[y:y + cell, x:x + cell].sum(), g_non[y:y + cell, x:x + cell].sum()
        row += '.' if c == 0 and g == 0 else ('#' if c and g and abs(c - g) <= cell else ('C' if c else 'G'))
    rows.append(row)
print('map (# both, C cpu-only, G gpu-only, . nothing), 8x8 cells:')
print('\n'.join(rows))

# ---- where the colour differs ----------------------------------------------------------------
cpu_shadow = load(cpu_dir, f'{case}.{tag}.staticShadow', np.uint8).reshape(H, W)
diff = np.abs(cpu - gpu).mean(-1)
def line(label, mask):
    n = int(mask.sum())
    if n:
        mean_rgb = (cpu[mask].mean(0).round(1).tolist(), gpu[mask].mean(0).round(1).tolist())
        print(f'  {label:<34} n={n:>6}  mean|diff|={diff[mask].mean():6.2f}  >30: {(diff[mask] > 30).mean() * 100:5.1f}%  cpu mean rgb {mean_rgb[0]}  gpu {mean_rgb[1]}')
print('colour difference by region:')
moving_shadow = load(cpu_dir, f'{case}.{tag}.shadowMask', np.uint8).reshape(H, W) if tag == 'full' else np.zeros((H, W), np.uint8)
for k, name in [(1, 'ground: beach'), (2, 'ground: water'), (3, 'ground: grass')]:
    line(f'{name}, not in static shadow', (cpu_k == k) & c_vis_ground & (gpu_c[..., 1] == k) & g_ground & (cpu_shadow == 0))
    line(f'{name}, in static shadow', (cpu_k == k) & c_vis_ground & (gpu_c[..., 1] == k) & g_ground & (cpu_shadow > 0))
if tag == 'full':
    line('ground, in a moving shadow (cpu)', c_vis_ground & g_ground & (moving_shadow > 0))
    line('ground, not in any shadow (cpu)', c_vis_ground & g_ground & (cpu_shadow == 0) & (moving_shadow == 0))
    # pixels the cpu draws on top of the ground after the bake: tufts, water streaks
    tinted = np.zeros((H, W), bool)
    line('cpu ground pixels whose colour is not a pure ground tone', c_vis_ground & g_ground & (diff > 20) & (cpu_shadow == 0) & (moving_shadow == 0))
same_depth = both_obj & (np.abs(cpu_z - gpu_z) < 0.02)
line('objects, same depth', same_depth)
line('objects, different depth', both_obj & ~same_depth)
print('colour difference map (mean |diff| per 8x8 cell, digits 0-9 = 0-90+):')
for y in range(0, H, 8):
    row = ''
    for x in range(0, W, 8):
        row += '.' if not c_non[y:y + 8, x:x + 8].any() else str(min(9, int(diff[y:y + 8, x:x + 8].mean() / 10)))
    print('  ' + row)

# ---- edges by type ---------------------------------------------------------------------------
import json, math
cam = json.loads((cpu_dir / f'{case}.scene.json').read_text(encoding='utf-8'))['camera']
gy = math.cos(cam['pitch']) / (cam['scale'] * math.sin(cam['pitch']))
EDGE = 0.28

def classify(z, obj, groundish):
    m = np.zeros((H, W), np.uint8)
    z, o, g = z[1:-1, 1:-1], obj[1:-1, 1:-1], groundish
    sil = g[:-2, 1:-1] | g[2:, 1:-1] | g[1:-1, :-2] | g[1:-1, 2:]
    warm = (z - g_ if False else (z - zz[1:-1, 1:-1])) if False else None
    return m

def classify(z, obj, groundish):
    m = np.zeros((H, W), np.uint8)
    d = z[1:-1, 1:-1]
    o = obj[1:-1, 1:-1]
    sil = groundish[:-2, 1:-1] | groundish[2:, 1:-1] | groundish[1:-1, :-2] | groundish[1:-1, 2:]
    warm = (d - z[:-2, 1:-1] - gy > EDGE) | (d - z[1:-1, :-2] > EDGE)
    dark = (z[1:-1, 2:] - d > EDGE) | (z[2:, 1:-1] - gy - d > EDGE)
    m[1:-1, 1:-1] = np.where(o, np.where(sil, 1, np.where(warm, 2, np.where(dark, 3, 0))), 0)
    return m

def dil(m):
    out = m.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            out |= np.roll(np.roll(m, dy, 0), dx, 1)
    return out

c_obj = (cpu_z > -1e8) & (cpu_z != cpu_gz)
g_cov = gpu_c[..., 3] > 127
ec = classify(cpu_z, c_obj, cpu_z == cpu_gz)
eg = classify(gpu_z, g_cov & (gpu_c[..., 0] <= 127), ~(g_cov & (gpu_c[..., 0] <= 127)))
for t, name in [(1, 'silhouette'), (2, 'warm rim'), (3, 'dark rim')]:
    a, b = ec == t, eg == t
    print(f'edge {name:<11} cpu {a.sum():>5}  gpu {b.sum():>5}  jaccard {(a & b).sum() / max(1, (a | b).sum()):.3f}')
a, b = ec > 0, eg > 0
print(f'edges any: cpu {a.sum()} gpu {b.sum()} | cpu-only {(a & ~b).sum()}, of which within 1px of a gpu edge {((a & ~b) & dil(b)).sum()} | gpu-only {(b & ~a).sum()}, of which within 1px of a cpu edge {((b & ~a) & dil(a)).sum()}')

# ---- the worst differing pixels on objects --------------------------------------------------
bad = np.argwhere(same_depth & (diff > 30))
if len(bad):
    print(f'same-depth object pixels differing by more than 30: {len(bad)}; clusters of 16x16 cells with most of them:')
    counts = {}
    for y, x in bad:
        counts[(y // 16, x // 16)] = counts.get((y // 16, x // 16), 0) + 1
    for (cy, cx), n in sorted(counts.items(), key=lambda kv: -kv[1])[:6]:
        ys, xs = np.nonzero(same_depth & (diff > 30))
        sel = (ys // 16 == cy) & (xs // 16 == cx)
        y, x = ys[sel][0], xs[sel][0]
        print(f'  cell rows {cy * 16}-{cy * 16 + 15} cols {cx * 16}-{cx * 16 + 15}: {n} px | sample ({x},{y}) cpu rgb {cpu[y, x].tolist()} gpu {gpu[y, x].tolist()} depth {cpu_z[y, x]:.2f}')
