"""The 24 landmarks: where they are, how each is built, and how the camera is set to look at it.

Writes data/curated/landmarks.json. The positions come from OpenStreetMap: each landmark names the mapped
feature it stands on (a pagoda's outline, the viewpoint node, the bridge's way), and the script looks that
up, so no coordinate here is typed from memory. What is not in the map is given by hand in the table below
and said to be: the dimensions of the buildings put together by hand (kits), how far around them the mapped
buildings are cleared away, the camera of the fly-to, and the one-line note.

Usage: python -m hz.landmarks
"""
import json
import math

import numpy
import shapely

from . import region
from .bake import surface
from .osm_extract import Layers
from .region import TILE_M

GROUPS = ["西湖", "山水", "运河", "现代"]

# metres each side of a bridge's middle line inside which nothing mapped is drawn: the bridge's own deck and
# the lines along it, and no more (the houses at a bridge's two ends are the place itself)
BRIDGE_CLEAR_M = 9

# (title, group, matched to: layer, exact name, a tag and its value (or None), kit and its sizes (or None),
#  metres around it cleared of mapped buildings, fly-to: pixels per metre, note)
TABLE = [
    # ---- West Lake: the twelve views ------------------------------------------------------------------------------
    ("断桥残雪", "西湖", "roads", "断桥", ("highway", "pedestrian"), ("archBridge", {"length": 105, "width": 8, "rise": 3.6}), BRIDGE_CLEAR_M, 2.4,
     "白堤东端的单孔石拱桥，西湖十景“断桥残雪”。"),
    ("保俶塔", "西湖", "places", "保俶塔", ("man_made", "tower"), ("pagoda", {"storeys": 7, "width": 10, "storeyHeight": 4.8, "eave": 0.3, "taper": 0.07}), 40, 2.6,
     "宝石山上的七层砖塔，高约 45 米，西湖北岸的标志。"),
    ("雷峰塔", "西湖", "buildings", "雷峰塔", ("building", "pagoda"), ("pagoda", {"storeys": 5, "width": 46, "storeyHeight": 7.6, "platform": 5}), 80, 1.8,
     "夕照山上的五层八面塔，高 71.7 米，“雷峰夕照”。"),
    ("三潭印月·湖心亭", "西湖", "places", "三潭印月", ("tourism", "attraction"), None, 0, 0.9,
     "湖中小岛，与北面的湖心亭隔水相望；三座石塔立于岛南。"),
    ("苏堤六桥", "西湖", "roads", "苏堤", ("highway", "pedestrian"), ("causeway", None), 0, 0.32,
     "贯穿西湖南北的长堤，2.8 公里，六座石拱桥。"),
    ("孤山", "西湖", "places", "孤山", ("place", "island"), None, 0, 1.3,
     "湖中唯一的岛，平湖秋月、西泠印社、浙江省博物馆都在上面。"),
    ("曲院风荷", "西湖", "places", "曲院风荷", ("tourism", "viewpoint"), None, 0, 1.3,
     "西湖西北的荷塘，“曲院风荷”。"),
    ("花港观鱼", "西湖", "places", "花港观鱼", ("tourism", "viewpoint"), None, 0, 1.3,
     "苏堤南口西侧的园林，“花港观鱼”。"),
    ("柳浪闻莺", "西湖", "places", "柳浪闻莺", ("tourism", "viewpoint"), None, 0, 1.3,
     "东南岸的柳林，“柳浪闻莺”。"),
    ("净慈寺", "西湖", "places", "净慈寺", ("amenity", "place_of_worship"), None, 0, 1.6,
     "南屏山下的古寺，雷峰塔对面，“南屏晚钟”。"),
    ("吴山城隍阁", "西湖", "buildings", "城隍阁", ("building", "yes"), ("pavilionTower", {"storeys": 3, "width": 40, "storeyHeight": 8.5}), 95, 2.4,
     "吴山之巅的三层楼阁，高 41.6 米，俯瞰西湖和老城。"),
    ("湖滨", "西湖", "places", "三公园", ("leisure", "park"), None, 0, 1.6,
     "湖滨的湖岸步道，音乐喷泉所在。"),
    # ---- Hills and water: four ------------------------------------------------------------------------------------
    ("灵隐寺·飞来峰", "山水", "buildings", "大雄宝殿", ("building", "yes"), None, 0, 1.3,
     "灵隐寺的主殿，飞来峰下。"),
    ("龙井茶园", "山水", "places", "茶博物馆", ("tourism", "museum"), None, 0, 0.7,
     "龙井茶园：狮峰、龙井村一带的茶山。"),
    ("六和塔·钱塘江大桥", "山水", "buildings", "六和塔", ("building", "pagoda"), ("pagoda", {"storeys": 13, "width": 32, "storeyHeight": 3.0, "eave": 0.5, "platform": 1}), 60, 1.0,
     "钱塘江边的十三层八面塔，高 59.9 米；脚下的钱塘江大桥建于 1937 年。"),
    ("西溪湿地东区", "山水", "places", "西溪国家湿地公园", ("boundary", "national_park"), ("parkEast", None), 0, 0.6,
     "西溪湿地东区，水道与池塘交错。"),
    # ---- The canal: three -----------------------------------------------------------------------------------------
    ("拱宸桥·桥西直街", "运河", "roads", "拱宸桥", ("highway", "steps"),
     ("archBridge", {"length": 92, "width": 7, "rise": 6.5, "arches": [[0.08, 0.3], [0.36, 0.64], [0.7, 0.92]]}), BRIDGE_CLEAR_M, 2.2,
     "京杭大运河最南端的三孔石拱桥，桥西是桥西直街。"),
    ("大兜路·小河直街", "运河", "roads", "小河直街", ("highway", "pedestrian"), None, 0, 1.5,
     "运河边的历史街区，小河直街与大兜路。"),
    ("武林门码头·西湖文化广场", "运河", "places", "水上巴士-武林门站", ("amenity", "ferry_terminal"), None, 0, 1.2,
     "武林门码头与西湖文化广场。"),
    # ---- Modern: five ---------------------------------------------------------------------------------------------
    ("钱江新城", "现代", "buildings", "市民中心", ("building", "yes"), None, 0, 0.6,
     "钱江新城：市民中心、来福士双塔、大剧院与国际会议中心。"),
    ("奥体中心", "现代", "buildings", "奥体中心", None, ("lotus", {"a": 150, "b": 160}), 290, 0.6,
     "“大莲花”，2022 年亚运会主场馆。"),
    ("河坊街·南宋御街", "现代", "roads", "河坊街", ("highway", "pedestrian"), None, 0, 1.7,
     "吴山脚下的老街，与南宋御街（中山中路）相交。"),
    ("杭州东站", "现代", "buildings", "杭州东", ("building", "train_station"), None, 0, 0.5,
     "杭州东站，亚洲最大的铁路枢纽之一。"),
    ("阿里巴巴西溪园区", "现代", "land", "阿里巴巴西溪A区", ("landuse", "commercial"), None, 0, 0.8,
     "阿里巴巴西溪园区。"),
]

# the six bridges of the causeway, matched by name; and the steel bridge by the pagoda
CAUSEWAY_BRIDGES = ["映波桥", "锁澜桥", "望山桥", "压堤桥", "东浦桥", "跨虹桥"]
CAUSEWAY_ARCH = {"model": "archBridge", "length": 40, "width": 6, "rise": 2.6}
TRUSS = {"model": "trussBridge", "length": 1453, "width": 11, "deckHeight": 9, "truss": 10}
PART_KEYS = ("title", "lon", "lat", "angle", "kit", "clear", "clearSpan")


def cleared_around(path=None):
    """-> [(x, y, radius)] or [(x, y, radius, half length, angle)]: the ground, in world metres, around landmarks
    built by hand inside which nothing mapped is drawn: a pagoda's own outline, a bridge's deck and the lines
    along it. A disc for what stands in one place; for a bridge, which is mapped as a line, a corridor from
    its middle for `half length` each way along `angle`, `radius` to each side."""
    data = json.loads((path or region.CURATED / "landmarks.json").read_text(encoding="utf-8"))
    areas = []
    for row in data["landmarks"]:
        for item in [row, *row.get("parts", [])]:
            if not item.get("clear"):
                continue
            x, y = region.project(item["lon"], item["lat"])
            if item.get("clearSpan") and item.get("angle") is not None:
                areas.append((float(x), float(y), float(item["clear"]), float(item["clearSpan"]), float(item["angle"])))
            else:
                areas.append((float(x), float(y), float(item["clear"])))
    return areas


def cleared_mask(cx, cy, areas):
    """Which of these points (world metres, arrays) lie in any of the areas of cleared_around()."""
    inside = numpy.zeros(len(cx), dtype=bool)
    for area in areas:
        x, y, radius = area[:3]
        dx, dy = cx - x, cy - y
        if len(area) == 3:
            inside |= dx * dx + dy * dy <= radius * radius
            continue
        half, angle = area[3], area[4]
        along = dx * math.cos(angle) + dy * math.sin(angle)
        across = -dx * math.sin(angle) + dy * math.cos(angle)
        inside |= (numpy.abs(along) <= half) & (numpy.abs(across) <= radius)
    return inside


def find(osm, layer, name, wanted=None):
    """The mapped feature: the largest one called exactly `name` whose tag `wanted[0]` has the value `wanted[1]`."""
    features = [(g, t) for g, t in getattr(osm, layer) if t.get("name") == name]
    hits = [(g, t) for g, t in features if wanted is None or t.get(wanted[0]) == wanted[1]] or features   # the tag if it is there, else the name alone
    if not hits:
        raise SystemExit(f"landmark not found in the map: {layer} {name}")
    size = lambda g: g.length if g.geom_type in ("LineString", "MultiLineString") else g.area if g.geom_type != "Point" else 0.0
    return max(hits, key=lambda gt: size(gt[0]))[0]


def placed(geom):
    """The point a landmark stands on, and for a line the direction it runs in (radians, from the map's x axis)."""
    if geom.geom_type in ("LineString", "MultiLineString"):
        longest = max(getattr(geom, "geoms", [geom]), key=lambda p: p.length)
        a, b = longest.coords[0], longest.coords[-1]
        middle = longest.interpolate(0.5, normalized=True)
        return float(middle.x), float(middle.y), math.atan2(b[1] - a[1], b[0] - a[0]), longest.length / 2
    c = geom.centroid
    return float(c.x), float(c.y), None, None


def entry(osm, title, group, layer, name, wanted, kit, clear, scale, note):
    """One landmark of the table, as the app reads it."""
    x, y, angle, span = placed(find(osm, layer, name, wanted))
    lon, lat = region.unproject(x, y)
    item = {"title": title, "group": group, "lon": round(float(lon), 6), "lat": round(float(lat), 6), "view": {"scale": scale}, "note": note,
            "source": f"OpenStreetMap: {layer} “{name}”"}
    if angle is not None:
        item["angle"] = round(float(angle), 5)
    if kit:
        # a kit is given either as (model, sizes) or ready made
        item["kit"], item["clear"] = (kit if isinstance(kit, dict) else {"model": kit[0], **(kit[1] or {})}), clear
    if clear and span is not None:
        item["clearSpan"] = round(float(span) + 2.0, 1)      # the whole length of the line the model stands on
    return item


def part(item):
    """A landmark that goes with another one: only what places and builds it."""
    return {key: item[key] for key in PART_KEYS if key in item}


def build(log=print):
    osm = Layers.load(region.WORK / "osm.pkl")
    landmarks = [entry(osm, *row) for row in TABLE]
    counters = {}                                   # ids: the group's number, then the order within it
    for row in landmarks:
        counters[row["group"]] = counters.get(row["group"], 0) + 1
        row["id"] = f"{GROUPS.index(row['group']) + 1}-{counters[row['group']]:02d}"
    causeway = next(row for row in landmarks if row.get("kit") and row["kit"]["model"] == "causeway")
    causeway["parts"] = [part(entry(osm, bridge, causeway["group"], "roads", bridge, ("highway", "pedestrian"), CAUSEWAY_ARCH, BRIDGE_CLEAR_M, 0, ""))
                         for bridge in CAUSEWAY_BRIDGES]
    # the steel bridge below the pagoda: the road over it is one mapped line, so the model stands on its middle
    liuhe = next(row for row in landmarks if row.get("kit", {}).get("model") == "pagoda" and row["kit"].get("storeys") == 13)
    liuhe["parts"] = [part(entry(osm, "钱塘江大桥", liuhe["group"], "roads", "钱塘江大桥", ("bridge", "yes"), TRUSS, BRIDGE_CLEAR_M, 0, ""))]
    # the view holds both: the pagoda on its hill in the upper part of the frame, the bridge leaving across the
    # river below it. offset: where the middle of the frame lies from the pagoda, in metres (across to the
    # right, up the page)
    liuhe["view"]["offset"] = [60, -230]
    # Xixi: the east part of the park
    xixi = next(row for row in landmarks if row.get("kit", {}).get("model") == "parkEast")
    park = find(osm, "places", "西溪国家湿地公园", ("boundary", "national_park"))
    west, south, east, north = park.bounds
    c = shapely.box(west + 0.6 * (east - west), south, east, north).intersection(park).representative_point()
    lon, lat = region.unproject(float(c.x), float(c.y))
    xixi.update(lon=round(float(lon), 6), lat=round(float(lat), 6))
    for marker in ("causeway", "parkEast"):                 # these two named a marker in the table, not a model
        row = next(row for row in landmarks if row.get("kit", {}).get("model") == marker)
        del row["kit"], row["clear"]
    out = region.CURATED / "landmarks.json"
    out.write_text(json.dumps({"_comment": __doc__, "groups": GROUPS, "landmarks": landmarks}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"{len(landmarks)} landmarks -> {out}")
    # and the same for the app, placed on the map: world metres instead of longitude and latitude
    region.BAKED.mkdir(parents=True, exist_ok=True)
    baked = region.BAKED / "landmarks.json"
    baked.write_text(json.dumps([forApp(row) for row in landmarks], ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"-> {baked}")
    return landmarks


def forApp(row):
    """A landmark as the app loads it: on the map's metres, with what places and builds it and nothing else."""
    x, y = region.project(row["lon"], row["lat"])
    item = {key: row[key] for key in ("id", "title", "group", "note", "view", "angle", "kit", "clear", "clearSpan") if key in row}
    item.update(x=float(x), y=float(y), parts=[forApp({**part, "id": "", "group": row["group"]}) for part in row.get("parts", [])])
    return item


def place(grid, info, log=print):
    """Stand the landmarks on the ground: write into the baked list the height of the ground under each, read
    the way the app reads it from a tile. The camera of a flight is set from it before the tile is loaded."""
    from .bake import TERRAIN_CELLS
    ground = surface(grid, info, TILE_M / TERRAIN_CELLS)        # what the app's renderer will read under the landmark
    path = region.BAKED / "landmarks.json"
    rows = json.loads(path.read_text(encoding="utf-8"))
    for row in rows:
        for item in [row, *row.get("parts", [])]:
            item["ground"] = round(float(ground([item["x"]], [item["y"]])[0]), 2)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"{len(rows)} landmarks placed on the ground -> {path}")


if __name__ == "__main__":
    build()
