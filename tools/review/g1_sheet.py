"""Side-by-side sheet for gate G1: the CPU reference, the GPU render and their difference.

Usage: python3 -I tools/review/g1_sheet.py out/fidelity-ss4 out/fidelity/g1-sheet.png
Each row is one camera position: static scene (reference | GPU | difference), then the full frame.
Needs Pillow; run it with a Python that has it.
"""
import pathlib
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

gpu_dir, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
cpu_dir = pathlib.Path('out/fidelity/cpu')
SCALE, LABEL = 2, 34
CASES = [('default', '原视角'), ('yaw30', '转 30°'), ('yaw180', '背面'), ('pitch50', '抬高到 50°'), ('zoom18', '拉近 1.8 倍')]


def font(size):
    for candidate in ('/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/System/Library/Fonts/PingFang.ttc'):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


title, small = font(20), font(15)
first = Image.open(cpu_dir / 'default.static.png')
w, h = first.size[0] * SCALE, first.size[1] * SCALE
cols = ['静态帧：参照版', '静态帧：显卡版', '差异（放大 4 倍）', '完整帧：参照版', '完整帧：显卡版', '差异（放大 4 倍）']
margin, header = 16, 76
sheet = Image.new('RGB', (margin + len(cols) * (w + margin), header + len(CASES) * (h + LABEL + margin)), (250, 249, 246))
draw = ImageDraw.Draw(sheet)
draw.text((margin, 12), '闸门 G1：显卡版与参照版逐像素对照（参照版是 pixel-plays 原引擎，显卡版是移植后的 WebGL2 引擎）', fill=(28, 27, 25), font=title)
draw.text((margin, 44), '差异图里越亮差别越大；外圈的细碎亮点是地面溶解边缘和轮廓线的亚像素偏移。', fill=(110, 106, 98), font=small)
for c, name in enumerate(cols):
    draw.text((margin + c * (w + margin) + 4, header - 26), name, fill=(60, 58, 52), font=small)


def load(path):
    return Image.open(path).convert('RGB').resize((w, h), Image.NEAREST)


for r, (case, label) in enumerate(CASES):
    x0, y0 = margin, header + r * (h + LABEL + margin)
    draw.text((x0 + 4, y0 - 2), label, fill=(28, 27, 25), font=title)
    y0 += LABEL - 6
    for tag, col in (('static', 0), ('full', 3)):
        cpu = load(cpu_dir / f'{case}.{tag}.png')
        gpu = load(gpu_dir / f'{case}.{tag}.gpu.png')
        diff = ImageChops.difference(cpu, gpu).point(lambda v: min(255, v * 4))
        for k, im in enumerate((cpu, gpu, diff)):
            sheet.paste(im, (x0 + (col + k) * (w + margin), y0))
            draw.rectangle([x0 + (col + k) * (w + margin) - 1, y0 - 1, x0 + (col + k) * (w + margin) + w, y0 + h], outline=(200, 197, 190))
target.parent.mkdir(parents=True, exist_ok=True)
sheet.save(target, optimize=True)
print(f'{target}  {sheet.size[0]}x{sheet.size[1]}  {target.stat().st_size // 1024} KB')
