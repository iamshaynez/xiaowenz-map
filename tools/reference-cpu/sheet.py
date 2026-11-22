"""Compose the rendered camera views into one labelled contact sheet.

Usage: python3 -I sheet.py <render-output-dir>

Tiles are upscaled 2x with nearest-neighbour so every canvas pixel stays a crisp 2x2 block.
"""
import json
import pathlib
import sys

from PIL import Image, ImageDraw, ImageFont

out = pathlib.Path(sys.argv[1])
report = json.loads((out / "report.json").read_text(encoding="utf-8"))
shots = report["shots"]

SCALE, COLS, GAP, LABEL_H = 2, 4, 12, 30
first = Image.open(out / (shots[0]["id"] + ".png"))
tw, th = first.size[0] * SCALE, first.size[1] * SCALE
rows = -(-len(shots) // COLS)
sheet = Image.new("RGB", (GAP + COLS * (tw + GAP), GAP + rows * (th + LABEL_H + GAP)), (250, 249, 246))
draw = ImageDraw.Draw(sheet)


def font(size):
    for candidate in ("/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/System/Library/Fonts/PingFang.ttc"):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


label_font, small_font = font(17), font(14)
for k, shot in enumerate(shots):
    x = GAP + (k % COLS) * (tw + GAP)
    y = GAP + (k // COLS) * (th + LABEL_H + GAP)
    tile = Image.open(out / (shot["id"] + ".png")).convert("RGB").resize((tw, th), Image.NEAREST)
    sheet.paste(tile, (x, y))
    draw.rectangle([x - 1, y - 1, x + tw, y + th], outline=(200, 197, 190))
    draw.text((x + 2, y + th + 5), shot["label"], fill=(28, 27, 25), font=label_font)
    note = f"重烘 {shot['bakeMs']:.0f} ms · 场景占画面 {shot['nonWhite'] * 100:.0f}%"
    draw.text((x + tw - 2 - draw.textlength(note, font=small_font), y + th + 9), note, fill=(139, 135, 127), font=small_font)

target = out / "contact-sheet.png"
sheet.save(target, optimize=True)
print(f"{target}  {sheet.size[0]}x{sheet.size[1]}  {target.stat().st_size // 1024} KB")
