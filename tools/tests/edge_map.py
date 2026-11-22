"""Map of where the two depth buffers put edges differently.

Usage: .venv/bin/python -I tools/tests/edge_map.py out/fidelity-ss8 yaw180 static
'#' both draw an edge of the same kind, 'c' only the reference, 'g' only the GPU, '~' both but different kinds.
"""
import json, math, pathlib, sys
import numpy as np

gpu_dir, case, tag = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
cpu_dir = pathlib.Path("out/fidelity/cpu")
W, H = 360, 280
cpu_z = np.fromfile(cpu_dir / f'{case}.{tag}.zb', np.float32).reshape(H, W)
cpu_gz = np.fromfile(cpu_dir / f'{case}.{tag}.groundZ', np.float32).reshape(H, W)
gpu_z = np.fromfile(gpu_dir / f'{case}.{tag}.gpu.zb', np.float32).reshape(H, W)
gpu_c = np.fromfile(gpu_dir / f'{case}.{tag}.gpu.cls', np.uint8).reshape(H, W, 4)
cam = json.loads((cpu_dir / f'{case}.scene.json').read_text(encoding='utf-8'))['camera']
gy = math.cos(cam['pitch']) / (cam['scale'] * math.sin(cam['pitch']))
EDGE = 0.28

def classify(z, obj, groundish):
    m = np.zeros((H, W), np.uint8)
    d = z[1:-1, 1:-1]
    sil = groundish[:-2, 1:-1] | groundish[2:, 1:-1] | groundish[1:-1, :-2] | groundish[1:-1, 2:]
    warm = (d - z[:-2, 1:-1] - gy > EDGE) | (d - z[1:-1, :-2] > EDGE)
    dark = (z[1:-1, 2:] - d > EDGE) | (z[2:, 1:-1] - gy - d > EDGE)
    m[1:-1, 1:-1] = np.where(obj[1:-1, 1:-1], np.where(sil, 1, np.where(warm, 2, np.where(dark, 3, 0))), 0)
    return m

ec = classify(cpu_z, (cpu_z > -1e8) & (cpu_z != cpu_gz), cpu_z == cpu_gz)
cov = gpu_c[..., 3] > 127
eg = classify(gpu_z, cov & (gpu_c[..., 0] <= 127), ~(cov & (gpu_c[..., 0] <= 127)))
print('by kind: cpu', [(ec == t).sum() for t in (1, 2, 3)], ' gpu', [(eg == t).sum() for t in (1, 2, 3)])
for t, name in [(1, 'silhouette'), (2, 'warm'), (3, 'dark')]:
    a, b = ec == t, eg == t
    print(f'  {name:<10} both {(a & b).sum():>5}  cpu-only {(a & ~b).sum():>5}  gpu-only {(b & ~a).sum():>5}')
cell = 4
for y in range(40, H, cell):
    row = ''
    for x in range(0, W, cell):
        c, g = ec[y:y + cell, x:x + cell], eg[y:y + cell, x:x + cell]
        cb, gb = np.unique(c[c > 0]), np.unique(g[g > 0])
        if len(cb) == 0 and len(gb) == 0: row += ' '
        elif len(cb) and len(gb): row += '#' if set(cb) & set(gb) else '~'
        else: row += 'c' if len(cb) else 'g'
    print(f'{y:3d} {row}')
