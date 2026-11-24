"""cities/<id>/DATA-REPORT.md: what a city's map is made of, counted from the data rather than typed by hand.

Run after the bake:  python -m pixelcity.report <city>

The numbers are the city's own wherever it is; the prose was written for Hangzhou, and a new city wants it read again.
"""
import json
import math
import pickle
import sys
from collections import Counter

import numpy
import shapely

from .city import TILE_M, of
from .buildings import doubles, same_outline_pairs
from .classify import (
    ARCHETYPE_NAMES,
    ROOF_FLAT,
    ROOF_GABLE,
    ROOF_HIP,
    ROOF_SAW,
    ROOF_GREAT,
    VILLAGE_LEVELS,
    circles,
    classify,
)
from .ground import GROUND_COLOURS, Ground
from .landmarks import cleared_around, cleared_mask
from . import names
from .osm_extract import Layers
from .scene import in_water, unholdable
from .terrain import load as load_terrain

HEIGHT_SOURCES = {"osm:height": "OSM 的 height 标签", "osm:levels": "OSM 的层数标签 × 层高", "globfp": "3D-GloBFP 数据集", "inferred": "推断"}
ORIGINS = {"osm": "OSM 的轮廓（高度取自数据集）", "osm-block": "OSM 画成整块的楼群，改用数据集里逐栋的轮廓", "globfp": "3D-GloBFP 的轮廓"}


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    out += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(out)


def build(city, log=print):
    with open(city.work / "buildings.pkl", "rb") as f:
        buildings = pickle.load(f)
    grid, info = load_terrain(city.work / "terrain.bin")
    classify(city, buildings, grid, info, log=lambda *a: None)
    records = buildings
    # what the bake draws: not what stands in water, of a footprint the data set holds twice one record,
    # and what no tile of the grid can hold (tile_anchor: they stand in the dissolving margin)
    all_geoms = numpy.asarray([b["geom"] for b in records], dtype=object)
    afloat = in_water(all_geoms, Ground.load(city.work / "ground.pkl").water)
    afloat = numpy.asarray(afloat, dtype=bool)
    twice = numpy.zeros(len(records), dtype=bool)
    twice[~afloat] = doubles([b for b, a in zip(records, afloat, strict=True) if not a], log=lambda *a: None)
    past = numpy.zeros(len(records), dtype=bool)
    west0, south0, east0, north0 = city.bounds()            # world metres, like the bake's grid
    at = numpy.flatnonzero(~afloat)
    sub = all_geoms[at]
    subc = shapely.centroid(sub)
    past[at] = unholdable(sub, shapely.get_x(subc), shapely.get_y(subc),
                          int(numpy.floor(west0 / TILE_M)), int(numpy.floor(east0 / TILE_M)),
                          int(numpy.floor(south0 / TILE_M)), int(numpy.floor(north0 / TILE_M)))
    buildings = [b for b, a, t, u in zip(records, afloat, twice, past, strict=True) if not a and not t and not u]
    index = json.loads((city.baked / "index.json").read_text(encoding="utf-8"))
    geoms = numpy.asarray([b["geom"] for b in buildings], dtype=object)
    areas = shapely.area(geoms)
    heights = numpy.array([b["height"] for b in buildings])
    levels = numpy.array([b["levels"] for b in buildings])
    west, south, east, north = city.bounds()
    rivers, water = city.look.get("rivers", ()), city.look.get("water")
    region_km2 = shapely.box(0, 0, east - west, north - south).area / 1e6

    out = []
    add = out.append
    add("# 数据报告\n")
    add(f"> 像素{city.name}{city.subtitle}活地图的数据底座。所有数字由 `python -m pixelcity.report {city.id}` 从 `data/work/{city.id}/` 和 `data/baked/{city.id}/` 现算，写进本文件。\n")
    add("## 范围\n")
    add(f"- 经纬 {city.west}–{city.east} E，{city.south}–{city.north} N。投影 UTM {city.epsg - 32600}N（EPSG:{city.epsg}），原点东 {city.origin_e:.0f}、北 {city.origin_n:.0f}。")
    turn = math.degrees(math.atan2(index["island"]["sin"], index["island"]["cos"]))
    add(f"- 外接框 {east - west:.0f} 米东西 × {north - south:.0f} 米南北，约 {region_km2:.0f} 平方公里；范围本身在地面是个转了约 {turn:.1f} 度的四边形（见 `index.json` 的 `island`）。")
    add(f"- 烘焙 {index['tilesBaked']} 块 1 公里瓦片，外加全景包 `overview.bin`。\n")

    add("## 建筑\n")
    centres = shapely.centroid(geoms)
    cx, cy = shapely.get_x(centres), shapely.get_y(centres)
    cleared = cleared_mask(cx, cy, cleared_around(city))
    assert len(buildings) == index["buildings"] and int(afloat.sum()) == index["leftOutOfWater"] and int(twice.sum()) == index["repeatedOutlines"], "the report and the bake count differently"
    add(table(["项目", "数量"], [
        ["合并后的建筑记录", f"{len(records):,}"],
        ["立在水里、不入图", f"{int(afloat.sum()):,}"],
        ["其中数据集重复给的轮廓，只留一条", f"{int(twice.sum()):,}"],
        ["范围外、任何瓦片都放不下的边距楼，不入图", f"{int(past.sum()):,}"],
        ["入图的建筑记录", f"{len(buildings):,}"],
        ["其中给手工搭的地标让位、不画的", f"{int(cleared.sum()):,}"],
    ]))
    add("")
    add("### 轮廓从哪来\n")
    origins = Counter(b["origin"] for b in buildings)
    add(table(["来源", "数量", "占比"], [[ORIGINS.get(k, k), f"{v:,}", f"{100 * v / len(buildings):.1f}%"] for k, v in origins.most_common()]))
    add("")
    add("### 楼高从哪来\n")
    sources = Counter(b["height_source"] for b in buildings)
    add(table(["来源", "数量", "占比"], [[HEIGHT_SOURCES.get(k, k), f"{v:,}", f"{100 * v / len(buildings):.1f}%"] for k, v in sources.most_common()]))
    capped = sum(1 for b in buildings if b.get("village_cap"))
    halls = sum(1 for b in buildings if b.get("temple_hall"))
    pitched = sum(1 for b in buildings if b.get("osm_roof"))
    add("")
    add(f"有来源的（前三类）占 {100 * (1 - sources['inferred'] / len(buildings)):.1f}%。推断的 {sources['inferred']:,} 栋里：{capped:,} 栋是老街区里按村里规矩压层的房子（城市定义 `look.historic` 里 village 为 true 的圈），数据集给的楼高被压到 {VILLAGE_LEVELS} 层以内；{halls:,} 栋是寺庙的殿堂（按 OSM 的标签和名字认出，如“大雄宝殿”），一律按一层高的大殿处理，因为数据集把大屋顶量成了五六层的楼；{pitched:,} 栋是 OSM 记了屋顶形状的房子（如“人字顶、黑色”），按一两层的坡顶房处理；其余按类型和名称关键词估层数。有的寺庙在 OSM 里只有一个节点，它的地面内（`look.templeGrounds`）没有名字、没有高度来源的轮廓也按殿堂处理。")
    add("")
    add(table(["楼高", "米"], [["中位", f"{numpy.median(heights):.0f}"], ["90 分位", f"{numpy.percentile(heights, 90):.0f}"], ["99 分位", f"{numpy.percentile(heights, 99):.0f}"], ["最高", f"{heights.max():.0f}"]]))
    add("")
    add(f"占地中位 {numpy.median(areas):.0f} 平方米；总占地 {areas.sum() / 1e6:.1f} 平方公里，占范围 {100 * areas.sum() / 1e6 / region_km2:.1f}%；总建筑面积（占地 × 层数）约 {(areas * levels).sum() / 1e6:,.0f} 平方公里。")
    add("")
    add("### 类型与屋顶\n")
    kinds = Counter(b["archetype"] for b in buildings)
    roofs = Counter(b["roof"] for b in buildings)
    roof_names = {ROOF_FLAT: "平顶", ROOF_GABLE: "人字", ROOF_HIP: "四坡", ROOF_SAW: "锯齿", ROOF_GREAT: "殿堂大屋顶"}
    add(table(["原型", "数量"], [[ARCHETYPE_NAMES.get(k, k), f"{v:,}"] for k, v in sorted(kinds.items())]))
    add("")
    add(table(["屋顶", "数量"], [[roof_names.get(k, k), f"{v:,}"] for k, v in sorted(roofs.items())]))
    add("")
    add("坡屋顶只给轮廓接近矩形的楼画（最小外接矩形的填充率 ≥ 0.8；寺庙殿堂的大屋顶放宽到 0.65，屋脊也更高）；其余退回平顶。\n")

    add("## 按类型分的概况\n")
    rows = []
    for k, _ in sorted(kinds.items()):
        sel = numpy.array([b["archetype"] == k for b in buildings])
        rows.append([ARCHETYPE_NAMES.get(k, k), f"{sel.sum():,}", f"{numpy.median(heights[sel]):.0f}", f"{numpy.median(areas[sel]):.0f}", f"{numpy.median(levels[sel]):.0f}"])
    add(table(["原型", "数量", "楼高中位（米）", "占地中位（平方米）", "层数中位"], rows))
    add("")

    add("## 分区统计\n")
    add(f"范围按 5 × 5 切成格子，每格约 {(east - west) / 5000:.1f} × {(north - south) / 5000:.1f} 公里；格子里建筑的数量和中位楼高（米）。西到东、北到南。\n")
    centres = shapely.centroid(geoms)
    cx, cy = shapely.get_x(centres), shapely.get_y(centres)
    cols = numpy.clip(((cx - west) / (east - west) * 5).astype(int), 0, 4)
    rows_idx = numpy.clip(((north - cy) / (north - south) * 5).astype(int), 0, 4)
    grid_rows = []
    for r in range(5):
        cells = []
        for c in range(5):
            sel = (cols == c) & (rows_idx == r)
            cells.append(f"{sel.sum():,} / {numpy.median(heights[sel]):.0f}" if sel.sum() else "—")
        grid_rows.append(cells)
    add(table(["", "西", "", "中", "", "东"], [[r + 1] + row for r, row in enumerate(grid_rows)]))
    add("")

    add("## 重复的轮廓\n")
    add("3D-GloBFP 把一部分轮廓给了两条记录：一条带 type，一条不带，轮廓相同，楼高不同。两条都画时它们完全重叠，下半截墙谁露出来取决于深度缓冲的舍入，转动视角就在两种颜色之间闪。所以烘焙时每一组只留最高的一条（它的顶部本来也是能看见的那部分），其余不画；只有数据集来的记录相互比较，OSM 的轮廓不会被去掉。\n")
    from_dataset = numpy.array([b["origin"] in ("globfp", "osm-block") for b in records])
    dataset = [records[k] for k in numpy.flatnonzero(from_dataset & ~afloat)]      # the records the bake compared
    ds_geoms = numpy.asarray([b["geom"] for b in dataset], dtype=object)
    i, j = same_outline_pairs(ds_geoms)
    tall = numpy.array([dataset[k]["height"] for k in i])
    low = numpy.array([dataset[k]["height"] for k in j])
    ratio = numpy.maximum(tall, low) / numpy.maximum(numpy.minimum(tall, low), 0.1)
    parent = list(range(len(dataset)))

    def root(k):
        while parent[k] != k:
            k = parent[k]
        return k

    for a, b in zip(i, j, strict=True):
        parent[root(a)] = root(b)
    add(table(["", ""], [
        ["至少有两条记录的轮廓", f"{len({root(int(k)) for k in numpy.concatenate([i, j])}):,}"],
        ["这样的记录一共", f"{len(numpy.unique(numpy.concatenate([i, j]))):,}"],
        ["不画的记录", f"{int(twice.sum()):,}"],
        ["同一轮廓两条记录的楼高之比", f"中位 {numpy.median(ratio):.2f}，90 分位 {numpy.percentile(ratio, 90):.2f}"],
    ]))
    add("")
    add("留下的那条是较高的，所以每栋楼的高度和原来能看见的天际线一样，变的只是这些楼下半截墙的颜色和屋顶上的小件：原来在两种之间闪，现在固定是较高那条的。\n")
    add("两条记录哪一条更准无从核对：数据集没有说 type 是什么意思，拿 OSM 自己标了楼高的楼去比，两条都差得远、不分高下（D059）。\n")

    add("## 地面与水\n")
    g = Ground.load(city.work / "ground.pkl")
    add(table(["图层", "面积（平方公里）"], [[GROUND_COLOURS.get(c, c), f"{g.layers[c].area / 1e6:.1f}"] for c in sorted(g.layers, key=lambda k: -g.layers[k].area)]))
    add("")
    if water:
        lake = [p for p in shapely.get_parts(g.water) if p.contains(shapely.Point(*[float(v) for v in city.project(*water["at"])]))]
        if lake:
            add(f"{water['name']}水面（OSM 多边形）：{lake[0].area / 1e6:.2f} 平方公里。")
    add(f"桥面、高架（浮在地面上的路和铁路）：{len(g.decks):,} 段。")
    add("")
    add(f"水的颜色按水体分：湖、运河、池塘各有自己的青绿，只有名字里带{"、".join(f"“{word}”" for word in rivers)}的江用江水的土黄色（城市定义的 `look.rivers`）；OSM 把别的水道也标成“河”的，按运河的颜色画。")
    add("")
    add("## 地形与土地覆盖\n")
    add(f"- Copernicus GLO-30，网格 {grid.shape[1]} × {grid.shape[0]}，30 米一格，{grid.min()} 到 {grid.max()} 米。最高 {int(grid.max())} 米。")
    tea = circles(city, "tea")
    add("- ESA WorldCover 2021，10 米：树林、灌木按 1 格 1 棵的概率撒树（保留 55%）" + ("，茶园附近降到 12%" if tea else "") + "；建成区、耕地、草地、裸地直接作地面色。")
    if tea:
        add(f"- 茶园：OSM 里名字带“茶园”的农田多边形，加上城市定义里的茶山（{len(tea)} 处，`cities/{city.id}/city.json` 的 `look.tea`）；圈内卫星图上的“树”当茶田，不撒树。\n")
    else:
        add(f"- 茶园：这座城市没有（`cities/{city.id}/city.json` 的 `look.tea` 留空），撒树只看树林密度。\n")
    add("## 树\n")
    trees = numpy.load(city.work / "trees.npy")
    kinds = Counter(trees["kind"].tolist())
    kind_names = {0: "林地", 1: "草坪、公园", 2: "行道树", 3: "岸边"}
    species = Counter(trees["species"].tolist())
    species_names = {0: "香樟", 1: "垂柳", 2: "法国梧桐", 3: "松", 4: "竹", 5: "花树（桃、樱）"}
    add(table(["来源", "数量"], [[kind_names[k], f"{v:,}"] for k, v in sorted(kinds.items())]))
    add("")
    add(table(["树种", "数量"], [[species_names[k], f"{v:,}"] for k, v in sorted(species.items())]))
    add("")
    add("## 可以走线的路和水道\n")
    routes = city.curated("routes.json")
    add("车、船、行人沿烘焙时存下的线走：机动车道（主路、次路、小路、支路）和人行道、小径的中心线，运河与江的水道中心线，以及城市定义里手工画的游船航线。每条线整条属于它中点所在的那块瓦片。\n")

    add("## 名字\n")
    add("页面搜索用的就是这一份：`data/baked/<id>/names.bin`，由 `pixelcity/names.py` 从 OpenStreetMap 的名字生成（含边距的原始数字见下）。楼高数据集不带名字，所以由它补出来的轮廓搜不到。\n")
    columns, course = names.read(city.baked / "names.bin")
    kind_names = {names.LANDMARK: f"地标（名录里的 {columns['kinds'].count(names.LANDMARK)} 处）", names.ROAD: "道路", names.RAIL: "铁路", names.BUILDING: "建筑", names.PLACE: "地点", names.WATER: "水域"}
    kinds = Counter(columns["kinds"])
    add(table(["类别", "数量"], [[kind_names[k], f"{v:,}"] for k, v in sorted(kinds.items())]))
    add("")
    borne = Counter(columns["names"])
    alias_file = city.curated(names.ALIASES)
    aliases = json.loads(alias_file.read_text(encoding="utf-8"))["aliases"] if alias_file else {}
    add(f"- 不同的名字 {len(borne):,} 个；其中 {len({columns['names'][int(k)] for k in columns['near']}):,} 个被相隔 1 公里以上的几样东西共用（两个镇各有一条“人民路”），候选里用最近的村、社区或街道区分。")
    add(f"- 别名 {len(aliases)} 条（`cities/<id>/aliases.json`），烘焙时逐条核对，指不到东西就停下。")
    add(f"- 水面 {len(columns['sheets'])} 处：一条有名字的水道整个躺在一块没有名字的水面里时，这块水面认这条水道的名字，高亮画它的岸。")
    add(f"- 文件 {(city.baked / 'names.bin').stat().st_size / 1e6:.1f} MB，线路共 {len(course):,} 个点；页面打开三秒后取一次，搜索框先用上时就立刻取，不挡第一次出图。")
    add("")

    osm = Layers.load(city.work / "osm.pkl")
    add("### OpenStreetMap 里有多少东西有名字\n")
    def named(rows):
        return sum(1 for _, tags in rows if tags.get("name"))
    add(table(["", "总数", "有名字", "不同的名字"], [[label, f"{len(rows):,}", f"{named(rows):,}", f"{len({t['name'] for _, t in rows if t.get('name')}):,}"]
                                                   for label, rows in (("道路（段）", osm.roads), ("建筑轮廓", osm.buildings), ("地点（点和平面上的地名）", osm.places), ("土地利用多边形", osm.land),
                                                                       ("铁路（段）", osm.rail), ("水面多边形", osm.water), ("水道中心线（段）", osm.water_lines))]))
    add("")
    add("路名看等级：\n")
    length, named_length = Counter(), Counter()
    for geom, tags in osm.roads:
        kind = tags.get("highway")
        length[kind] += geom.length
        if tags.get("name"):
            named_length[kind] += geom.length
    class_names = {"motorway": "高速", "trunk": "快速路", "primary": "主干道", "secondary": "次干道", "tertiary": "支路", "unclassified": "未分级的路", "residential": "住宅区道路",
                   "service": "服务路", "footway": "人行道", "path": "小径", "pedestrian": "步行街", "cycleway": "自行车道", "steps": "台阶", "living_street": "生活道路", "track": "土路"}
    add(table(["等级", "有名字的（按长度）"], [[class_names.get(k, k), f"{100 * named_length[k] / length[k]:.0f}%"] for k, _ in length.most_common() if k in class_names and not k.endswith("_link")]))
    add("")
    add("所以主路搜得到，小区里的小路和人行道大多搜不到。地铁站的出入口在 OSM 里只有编号（A、B），站名记在站体的轮廓上，索引收站体。\n")

    add("## 地标\n")
    landmarks = json.loads((city.work / "landmarks.json").read_text(encoding="utf-8"))["landmarks"]
    def built(row):
        models = sorted({(item.get("kit") or {}).get("model") for item in [row, *row.get("parts", [])] if item.get("kit")} - {None})
        names = {"pagoda": "塔", "pavilionTower": "楼阁", "archBridge": "石拱桥", "trussBridge": "桁架桥", "lotus": "体育场", "pearlTower": "东方明珠塔", "waibaidu": "钢桁拱桥", "flatiron": "船形大楼", "castleHall": "城堡楼", "pavilionCrown": "斗冠", "spireHall": "金顶展览塔"}
        return "、".join(names.get(m, m) for m in models) or "—"
    add(table(["编号", "名称", "组", "对应 OSM 里的要素", "手工模型"], [[r["id"], r["title"], r["group"], r["source"].replace("OpenStreetMap: ", ""), built(r)] for r in landmarks]))
    add("")
    add("地标的坐标全部从 OpenStreetMap 按名字查出来（`pixelcity/landmarks.py`，地标表在 `cities/<id>/landmarks.json`），没有一个凭记忆写。模型尺寸：塔高、层数取公开数字，其余（檐口出挑、塔身收分、各层高度）按形制估。\n")
    add("## 推断清单\n")
    add("按计划，所有不是直接来自数据的东西列在这里，页面上可以用调试图层查看：\n")
    add(f"- 楼高：{sources['inferred']:,} 栋（{100 * sources['inferred'] / len(buildings):.1f}%）是推断的，其中 {capped:,} 栋是村里的房子被压到 {VILLAGE_LEVELS} 层以内，{halls:,} 栋是寺庙的殿堂，{pitched:,} 栋是 OSM 记了屋顶形状的房子。")
    add("- 寺庙殿堂的高度（大雄宝殿 14 米，其余 9 米，楼、阁两层 18 米）和屋顶是按形制定的，不是测绘的。")
    add("- 屋顶类型：由原型决定，不是测绘的；坡屋顶只给轮廓像矩形的楼画。")
    add(f"- 屋顶上的小件（楼梯间、水箱、太阳能、空调、设备间、通风口）：{index['rooftopProps']:,} 个，按原型和随机数放，不代表任何一栋楼顶上真实有什么。")
    add("- 树的位置：由卫星土地覆盖和 OSM 的林地、草地、街道、岸线推出，不是逐棵调查。")
    add("- 车辆与行人的位置和数量：沿真实的路和水道按固定间隔和时刻摆放，是“一个繁忙午后”的想象。")
    add("- 茶园、历史街区、现代 CBD 的范围：按知名地名画的圈，不是官方边界。")
    if routes:
        add(f"- 游船航线 {len(json.loads(routes.read_text(encoding='utf-8'))['routes'])} 条（`cities/{city.id}/routes.json`）：手工画的，只在开阔水面上，烘焙时核对过。")
    add("- 地标模型的尺寸：塔高和层数是公开数字，檐口出挑、塔身收分是按形制估的。")
    add("- 山体明暗：远景地形按坡向做了明暗，不是真实光照。")
    add("")
    add("## 数据质量备注\n")
    add("- 3D-GloBFP 的楼高是遥感反演值，论文报告在中国的均方根误差约 13 米，单栋楼会有几层的出入。")
    add("- 部分相连的楼在数据集里被画成一个轮廓；OSM 把一片画成整块时改用了数据集的逐栋轮廓。")
    add("- OSM 的水面多边形没有覆盖全部的小河、池塘，卫星图补了一部分，仍有遗漏。")
    add("- 清晰的重复轮廓见上面“重复的轮廓”。")
    add("")
    return "\n".join(out)


if __name__ == "__main__":
    city = of(sys.argv)
    text = build(city)
    out = city.folder / "DATA-REPORT.md"
    out.write_text(text, encoding="utf-8")
    print(f"-> {out}, {len(text)} characters")
