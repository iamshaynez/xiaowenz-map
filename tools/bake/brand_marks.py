"""The chain brands' signboard pictures, drawn here and written out as app/src/landmarks/brandmarks.js.

Each brand gets a 32×32 pixel picture — the board's own colour as the background, the mark drawn over it —
and the page samples its brand's picture out of the atlas it builds from that file (shaders-brands.js).
The order of BRANDS below is the order of pixelcity/brands.py's TABLE: the bake writes brand ids in that
order, and a logo out of place would wear another's sign. (`npm test`'s data-readers checks the page's
copy against index.json's brandMarks; this file is the third copy and is checked by hand after regen.)

绘制到"神似"为止：几何简单的招牌画到一眼认出（金拱门、7 的数字、红白斜纹、UNIQLO 的字母条），
吉祥物画到形似（雪王、汉堡、河马的 H），字标画成字的抽象。全部是像素化的近似，不是商标的扫描件。

Usage: python tools/bake/brand_marks.py     (from the repository root; writes brandmarks.js in place)
"""
import json
from pathlib import Path

S = 32  # the picture is S×S
ROOT = Path(__file__).resolve().parents[2]

# 5×7 letters, for the KFC block and the like ("." off, "#" on)
FONT = {
    "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
    "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
    "C": [".###", "#...", "#...", "#...", "#...", "#...", ".###"],
    "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
    "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
}


class Pic:
    def __init__(self, board):
        self.board = board
        self.pix = {}
        self.legend = {}

    def seat(self, ch, name):
        self.legend[ch] = name

    def rect(self, x0, y0, x1, y1, ch):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                self.pix[(x, y)] = ch

    def rrect(self, x0, y0, x1, y1, r, ch):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                dx = max(x0 + r - x, 0, x - (x1 - r))
                dy = max(y0 + r - y, 0, y - (y1 - r))
                if dx * dx + dy * dy > r * r:
                    continue
                self.pix[(x, y)] = ch

    def disc(self, cx, cy, radius, ch):
        for y in range(cy - radius, cy + radius + 1):
            for x in range(cx - radius, cx + radius + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius + 1:
                    self.pix[(x, y)] = ch

    def ring(self, cx, cy, r_in, r_out, ch):
        for y in range(cy - int(r_out), cy + int(r_out) + 1):
            for x in range(cx - int(r_out), cx + int(r_out) + 1):
                d2 = (x - cx) ** 2 + (y - cy) ** 2
                if r_in * r_in - 1 <= d2 <= r_out * r_out + 1:
                    self.pix[(x, y)] = ch

    def stripe_diag(self, y0, y1, period, thick, ch, phase=0):
        for y in range(y0, y1 + 1):
            for x in range(0, S):
                if (x + y + phase) % period < thick:
                    self.pix[(x, y)] = ch

    def letter(self, x0, y0, letter, ch):
        for ry, row in enumerate(FONT[letter]):
            for rx, c in enumerate(row):
                if c == "#":
                    self.pix[(x0 + rx, y0 + ry)] = ch

    def rows(self):
        out = []
        for y in range(S):
            out.append("".join(self.pix.get((x, y), ".") for x in range(S)))
        return out


def draw():
    """-> {brand id: (board colour, legend, rows)}: one picture a brand, in brands.py TABLE's order."""
    pics = {}

    # 麦当劳：金拱门，双拱门带内空
    p = Pic("brand_red"); p.seat("Y", "brand_gold")
    for x0 in (3, 18):
        p.rect(x0 + 1, 5, x0 + 10, 6, "Y")            # the top, drawn in one bar a arch
        p.rect(x0, 6, x0 + 11, 8, "Y")
        p.rect(x0, 8, x0 + 2, 28, "Y")                # the legs
        p.rect(x0 + 8, 8, x0 + 10, 28, "Y")
    pics["mcd"] = p

    # 肯德基：白块红字 KFC，下面红白斜纹
    p = Pic("brand_red"); p.seat("W", "panel_white"); p.seat("R", "brand_red")
    p.rrect(4, 3, 27, 16, 2, "W")
    p.letter(6, 5, "K", "R"); p.letter(13, 5, "F", "R"); p.letter(20, 5, "C", "R")
    p.stripe_diag(19, 31, 8, 3, "W")
    pics["kfc"] = p

    # 必胜客：白屋顶
    p = Pic("brand_red"); p.seat("W", "panel_white")
    for y in range(6, 23):
        w = 3 + (y - 6) * 9 // 16
        p.rect(16 - w, y, 16 + w, y, "W")
    p.rect(5, 24, 26, 26, "W")
    pics["pizza_hut"] = p

    # 汉堡王：面包夹肉
    p = Pic("brand_orange"); p.seat("Y", "brand_gold", ); p.seat("R", "brand_red")
    p.rrect(5, 5, 26, 12, 4, "Y")
    p.rect(4, 13, 27, 19, "R")
    p.rrect(5, 20, 26, 27, 4, "Y")
    pics["burger_king"] = p

    # 塔斯汀：红框白带
    p = Pic("brand_gold"); p.seat("R", "brand_red"); p.seat("W", "panel_white")
    p.rrect(6, 6, 25, 25, 5, "R")
    p.rect(10, 13, 21, 19, "W")
    p.rect(10, 16, 21, 17, "R")
    pics["tastien"] = p

    # 星巴克：绿底白环白心
    p = Pic("brand_green"); p.seat("W", "panel_white")
    p.ring(16, 16, 10.5, 13.5, "W")
    p.disc(16, 16, 6, "W")
    pics["starbucks"] = p

    # 瑞幸：蓝底白杯
    p = Pic("brand_navy"); p.seat("W", "panel_white"); p.seat("N", "brand_navy")
    for y in range(5, 28):
        half = 10 - (y - 5) // 5
        p.rect(16 - half, y, 16 + half, y, "W")
    p.rect(9, 15, 22, 18, "N")
    pics["luckin"] = p

    # 库迪：红底白环白心
    p = Pic("brand_red"); p.seat("W", "panel_white")
    p.ring(16, 16, 10.5, 13.5, "W")
    p.disc(16, 16, 5, "W")
    pics["cotti"] = p

    # 喜茶：白底深色环心
    p = Pic("panel_white"); p.seat("D", "window_dark")
    p.ring(16, 16, 10.5, 13.5, "D")
    p.disc(16, 16, 5, "D")
    pics["heytea"] = p

    # 奈雪：白底红环红心
    p = Pic("panel_white"); p.seat("R", "brand_red")
    p.ring(16, 16, 10.5, 13.5, "R")
    p.disc(16, 16, 5, "R")
    pics["nayuki"] = p

    # 蜜雪冰城：雪王（白头白身红围巾）
    p = Pic("brand_red"); p.seat("W", "panel_white"); p.seat("R", "brand_red")
    p.disc(16, 10, 6, "W")
    for y in range(17, 29):
        w = 6 + (y - 17) // 2
        p.rect(16 - w, y, 16 + w, y, "W")
    p.rect(9, 17, 23, 19, "R")
    pics["mixue"] = p

    # 茶百道：橙底白杯加吸管
    p = Pic("brand_orange"); p.seat("W", "panel_white")
    p.rect(21, 3, 23, 8, "W")
    for y in range(10, 28):
        w = 7 + (y - 10) // 4
        p.rect(16 - w, y, 16 + w, y, "W")
    for y in range(16, 19):
        for x in range(8, 26):
            p.pix.pop((x, y), None)
    pics["chabaidao"] = p

    # 霸王茶姬：青底白环白心青点
    p = Pic("glass_teal"); p.seat("W", "panel_white"); p.seat("T", "glass_teal")
    p.ring(16, 16, 10.5, 13.5, "W")
    p.disc(16, 16, 7, "W")
    p.disc(16, 16, 3, "T")
    pics["chagee"] = p

    # 海底捞：红底金碗白汽
    p = Pic("brand_red"); p.seat("Y", "brand_gold"); p.seat("W", "panel_white")
    p.disc(16, 16, 12, "Y")
    for y in range(0, 17):
        for x in range(0, 32):
            if (x - 16) ** 2 + (y - 16) ** 2 <= 145 and y < 16:
                p.pix.pop((x, y), None)
    p.rect(12, 27, 19, 29, "Y")
    for x in (11, 20):
        for y in range(6, 13):
            p.pix[(x + (1 if (y // 2) % 2 else 0), y)] = "W"
    pics["haidilao"] = p

    # 全家：蓝底白方块白横带
    p = Pic("brand_blue"); p.seat("W", "panel_white")
    p.rect(4, 4, 10, 10, "W")
    p.rect(3, 17, 28, 22, "W")
    pics["familymart"] = p

    # 7-11：白底绿橙红条加大 7
    p = Pic("panel_white"); p.seat("O", "brand_orange"); p.seat("G", "brand_green"); p.seat("R", "brand_red")
    p.rect(0, 0, 31, 3, "G")
    p.rect(0, 4, 31, 7, "O")
    p.rect(10, 9, 21, 12, "O")
    for y in range(13, 27):
        x0 = 20 - (y - 13) * 12 // 14
        p.rect(x0, y, x0 + 4, y, "O")
    p.rect(0, 28, 31, 31, "R")
    pics["seven_eleven"] = p

    # 罗森：蓝底白环白角块
    p = Pic("brand_blue"); p.seat("W", "panel_white")
    p.ring(16, 16, 10.5, 13.5, "W")
    p.rect(4, 4, 8, 8, "W")
    pics["lawson"] = p

    # 盒马：蓝底白 H
    p = Pic("brand_blue"); p.seat("W", "panel_white")
    p.rect(6, 5, 10, 26, "W")
    p.rect(21, 5, 25, 26, "W")
    p.rect(6, 14, 25, 18, "W")
    pics["hema"] = p

    # 山姆：青底白 S
    p = Pic("glass_teal"); p.seat("W", "panel_white")
    p.rect(7, 5, 24, 9, "W")
    p.rect(7, 10, 11, 15, "W")
    p.rect(7, 15, 24, 18, "W")
    p.rect(20, 19, 24, 24, "W")
    p.rect(7, 24, 24, 28, "W")
    pics["sam"] = p

    # 沃尔玛：蓝底金六芒
    p = Pic("brand_blue"); p.seat("Y", "brand_gold")
    p.rect(15, 4, 16, 27, "Y")
    p.rect(4, 15, 27, 16, "Y")
    for d in range(1, 10):
        for sx, sy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            p.pix[(16 + sx * d, 16 + sy * d)] = "Y"
    pics["walmart"] = p

    # 大润发：橙底红字 RT 白带
    p = Pic("brand_orange"); p.seat("W", "panel_white"); p.seat("R", "brand_red")
    p.rect(4, 12, 27, 20, "W")
    p.letter(6, 13, "R", "R")
    p.rect(14, 13, 20, 14, "R"); p.rect(16, 15, 18, 19, "R")
    pics["rtmart"] = p

    # 优衣库：红底白字母 UNIQLO（4×9 一枚）
    p = Pic("brand_red"); p.seat("W", "panel_white")
    U = ["X..X"] * 7 + ["XXXX", "XXXX"]
    N = ["X..X", "XX.X", "XX.X", "X.XX", "X.XX", "X..X", "X..X", "X..X", "X..X"]
    I = ["XX"] * 9
    Q = ["XXXX", "X..X", "X..X", "X..X", "X..X", "X..X", "X.XX", "XXXX", "...X"]
    L = ["X..X"] * 7 + ["XXXX", "XXXX"]
    O = ["XXXX"] + ["X..X"] * 7 + ["XXXX"]
    for x0, glyph in ((3, U), (8, N), (13, I), (16, Q), (21, L), (26, O)):
        for ry, row in enumerate(glyph):
            for rx, c in enumerate(row):
                if c == "X":
                    p.pix[(x0 + rx, 11 + ry)] = "W"
    pics["uniqlo"] = p

    # 名创优品：红底白圆红 M
    p = Pic("brand_red"); p.seat("W", "panel_white"); p.seat("R", "brand_red")
    p.disc(16, 16, 13, "W")
    p.rect(8, 10, 11, 22, "R")
    p.rect(20, 10, 23, 22, "R")
    for i, (x0, x1) in enumerate(((12, 13), (13, 14), (14, 15), (16, 17), (17, 18), (18, 19))):
        y0 = 11 + i if i < 3 else 16 - i
        p.rect(x0, y0, x1, y0 + 1, "R")
    pics["miniso"] = p

    return pics


def render(pics):
    """-> the file's text: the logo list as brandmarks.js holds it, in brands.py TABLE's order."""
    from importlib import import_module
    import sys
    sys.path.insert(0, str(ROOT / "pipeline"))
    brands_table = import_module("pixelcity.brands").TABLE
    order = list(brands_table)
    missing = [b for b in order if b not in pics]
    extra = [b for b in pics if b not in brands_table]
    if missing or extra:
        raise SystemExit(f"brand marks out of step with brands.py: missing {missing}, extra {extra}")
    header = """// The chain brands' logos, drawn by tools/bake/brand_marks.py and written out here — 32×32 a brand,
// '.' as the board's own colour, letter keys painted in the palette colours of `map`. The order is the
// bake's brand order (pixelcity/brands.py's TABLE; index.json's brandMarks carries it to the page, which
// checks it against this list at boot). This file is generated; to change a picture, change the drawing
// in the tool and re-run it: python tools/bake/brand_marks.py
export const BRAND_LOGOS = ["""
    body = []
    for brand in order:
        p = pics[brand]
        rows = p.rows()
        legend = ", ".join(f"{ch}: '{name}'" for ch, name in sorted(p.legend.items()))
        lines = "\n".join(f"      '{row}'," for row in rows)
        body.append(f"  {{\n    brand: '{brand}', board: '{p.board}', map: {{ {legend} }},\n    rows: [\n{lines}\n    ],\n  }},")
    tail = """];

// the atlas: every logo packed side by side, one RGBA row per authored row (row 0 is the top), nearest
// sampled. Column n of the atlas is the logo of the n-th brand of pixelcity/brands.py's TABLE.
export function brandAtlas(gl) {
  const size = 32, columns = BRAND_LOGOS.length;
  const rgba = new Uint8Array(size * size * columns * 4);
  BRAND_LOGOS.forEach((logo, column) => {
    if (logo.rows.length !== size || logo.rows.some(row => row.length !== size)) {
      throw new Error(`${logo.brand} 的像素画不是 ${size}×${size}`);
    }
    logo.rows.forEach((row, ry) => {
      for (let rx = 0; rx < size; rx++) {
        const ch = row[rx];
        const name = ch === '.' ? logo.board : logo.map[ch];
        if (!name) throw new Error(`${logo.brand} 的像素画里有没定义的颜色 ${ch}`);
        const rgb = PALETTE[name];
        const o = (ry * columns + column) * size * 4 + rx * 4;
        rgba[o] = rgb[0];
        rgba[o + 1] = rgb[1];
        rgba[o + 2] = rgb[2];
        rgba[o + 3] = 255;
      }
    });
  });
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size * columns, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return { texture, columns, size };
}

// the palette names these pictures are painted from, resolved once by the page (the same table that
// setLook reads); filled in by setPaletteColours before any atlas is built
const PALETTE = {};
export function setPaletteColours(colours) {
  for (const [name, rgb] of Object.entries(colours)) PALETTE[name] = rgb;
}
"""
    return header + "\n" + "\n".join(body) + "\n" + tail


if __name__ == "__main__":
    text = render(draw())
    out = ROOT / "app" / "src" / "landmarks" / "brandmarks.js"
    out.write_text(text, encoding="utf-8")
    print(f"-> {out} ({out.stat().st_size:,} bytes)")
