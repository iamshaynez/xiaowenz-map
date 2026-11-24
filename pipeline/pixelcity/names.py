"""The names the page searches by: everything OpenStreetMap gives a name to that can be stood on the map, and
the landmarks of the curated list; each with where it is, how far it reaches and, for what runs as a line, the
course to draw over the map.

A road is mapped as many ways under one name, and a name is often used again in another town: the ways of a
name are one road while they lie within JOIN_M of one another, and every group apart from the rest is a road of
its own. A school is a node, an outline and a piece of ground under one name: what shares a name and a place is
one thing, the outline saying where. Not a station: the map names an underground station's box after the square
or the stadium above it, and those are two things. A name that is only a letter or a part's label (A, 3幢, 垂梯)
finds nothing by itself and is left out, and so are the tracks of a yard or a depot. Where the map leaves a stretch
of a road unnamed, the course breaks there: no line is drawn across the gap.

A river is mapped as one sheet of water with no name of its own, and named only by the line drawn along it, which
is coarse: two of its points lie ten kilometres apart, and the course between them crosses land. So a named
watercourse that lies in a nameless sheet takes the water of that sheet (the rows in `sheets`): framed and
measured by it, and drawn by its bank. Where one sheet holds watercourses of several names (the Qiantang and
the two rivers that meet to form it), each takes the water nearest to its own course, and the seam cut between
them is not drawn.

data/baked/<city>/names.bin:
  NAME  JSON: a column a list, and one value in each for every thing
        labels     what a thing is, in a word or two, once each; a thing's `label` is its place in this list
        names      what it is called
        kinds      0 landmark of the curated list, 1 road, 2 railway, 3 building, 4 place, 5 water, 6 chain-brand shop
        x, y       where it stands, world metres; for a line, a point half way along its longest piece
        z          the height of the ground there
        label      its place in `labels`
        size       a line's length in metres; what covers ground, its area in square metres; 0 for a point
        box        [west, south, east, north] of how far it reaches, or null for a point
        line       [first, count] of its points in LINE, or null
        landmark   the landmark's id in data/baked/landmarks.json, or null
        sheets     the rows that are a sheet of water: for them `size` is the area of the water and LINE its bank
        near       only for a name borne by things that lie more than APART_M apart: {index: name} of the nearest
                   village, neighbourhood, suburb or town
        also       only where there are any: {index: "another name;and another"} it is found by as well
  LINE  a point in 10 bytes: x, y (f32, metres from the world origin), z (i16, 12.5 cm). z is the height of the
        ground under the point, or of the deck for a way on a bridge or a viaduct. A point with no position (x and y
        not a number) ends a piece of a course: nothing is drawn from it to the next point

Usage: python -m pixelcity.names <city>
"""
import json
import math
import re
import struct
import sys
from pathlib import Path

import numpy
import shapely
from shapely.geometry import box
from shapely.ops import voronoi_diagram
from shapely.strtree import STRtree

from . import brands, compact, ground
from .city import TILE_M, of
from .bake import FORMAT, MAGIC, TERRAIN_CELLS, container, surface
from .osm_extract import Layers
from .terrain import load as load_terrain

LANDMARK, ROAD, RAIL, BUILDING, PLACE, WATER, BRAND = range(7)
KIND_LABELS = ("landmarks", "roads", "railways", "buildings", "places", "water", "brand shops")
JOIN_M = 1000.0                # ways of one name this close together are one road (a stretch between them is left unnamed); a name reused lies further
SAME_M = 80.0                  # a node, an outline and a piece of ground of one name this close together are one thing
UNDER_LANDMARK_M = 150.0       # what lies this close to a landmark and is called what the landmark is, is that landmark
EDGE_M = 1000.0                # things are kept this far outside the region: the island's ground reaches about as far
NEAR_M = 3000.0                # the nearest of these, within this far, says where a name borne by several things is
APART_M = 1000.0               # ... unless they lie closer together than this: a square and the station under it are one place
YARD = {"siding", "yard", "spur", "crossover"}   # a railway's service: what is not a line to travel or to find
YARD_NAME = re.compile(r"\d+道$|(停车线|存车线|洗车线|折返线|安全线|渡线|牵出线|试车线|走行线|检修线|到发线|尽头线|出入段线|出入场线)")   # a yard's track by its name
POINT_M = 0.25                 # lines are simplified to this: inside any road, however close the page is zoomed
SHEET_M2 = 10000.0             # a sheet of water: a body of water with no name of its own, at least this large
SHEET_SHARE = 0.95             # a named watercourse lies in a sheet when this share of its course is within the sheet
SEED_M = 200.0                 # ... and takes the water nearest to its course, a seed every this far along it, where the sheet is shared
BREAK_M = 2.0                  # pieces of one course whose ends lie further apart than this are drawn apart: nothing is
                               # ... mapped between them, and no line is drawn across
BANK_M = 1.0                   # the bank of a course's water: the part of its outline this close to the sheet's own outline;
                               # ... the rest is the seam cut between two courses' water, and is not drawn
RING_M = 200.0                 # stretches of a bank shorter than this (islets, shoals) are not drawn
OTHER_NAMES = ("alt_name", "old_name", "official_name", "name:zh", "name:en")
STATIONS = {"train_station", "transportation", "station", "terminal"}
ALIASES = "aliases.json"       # curated (cities/<id>/): what a thing is called that the map does not call it
POINT = numpy.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<i2")])

# what a road is, by its class
ROAD_CLASS = {"motorway": "高速公路", "trunk": "快速路", "primary": "主干道", "secondary": "次干道", "tertiary": "支路", "unclassified": "街巷",
              "residential": "住宅区道路", "living_street": "内部道路", "service": "通道", "pedestrian": "步行街", "footway": "人行道", "path": "小径",
              "cycleway": "自行车道", "steps": "台阶", "track": "土路"}
LINKS = {"motorway_link": "匝道", "trunk_link": "匝道", "primary_link": "主干道", "secondary_link": "次干道", "tertiary_link": "支路"}
WATER_KIND = {"lake": "湖", "reservoir": "水库", "canal": "运河", "river": "河流", "riverbank": "河流", "bay": "湾", "pond": "池塘", "basin": "池塘",
              "stream": "溪", "ditch": "沟", "drain": "排水沟"}
WHAT_BUILDING = {"apartments": "住宅", "residential": "住宅", "house": "住宅", "detached": "住宅", "terrace": "住宅", "dormitory": "宿舍", "hotel": "酒店",
            "commercial": "商厦", "retail": "商场", "office": "写字楼", "supermarket": "超市", "department_store": "商场", "university": "大学",
            "college": "学院", "school": "学校", "kindergarten": "幼儿园", "hospital": "医院", "clinic": "诊所", "industrial": "厂房", "warehouse": "仓库",
            "factory": "厂房", "manufacture": "厂房", "storage_tank": "储罐", "hangar": "机库", "temple": "寺庙", "shrine": "庙", "monastery": "寺院",
            "pagoda": "塔", "church": "教堂", "cathedral": "教堂", "mosque": "清真寺", "religious": "宗教建筑", "stadium": "体育场", "grandstand": "看台",
            "museum": "博物馆", "government": "政府机关", "civic": "公共建筑", "public": "公共建筑", "garage": "车库", "garages": "车库", "parking": "车库",
            "roof": "雨棚", "construction": "工地", "ruins": "遗址", "bridge": "桥", "abandoned": "废弃建筑"}
WHAT_AMENITY = {"place_of_worship": "寺庙教堂", "police": "公安", "bank": "银行", "library": "图书馆", "courthouse": "法院", "townhall": "政府机关",
           "theatre": "剧院", "museum": "博物馆", "hospital": "医院", "clinic": "诊所", "school": "学校", "university": "大学", "college": "学院",
           "kindergarten": "幼儿园", "bus_station": "公交枢纽站", "ferry_terminal": "码头", "marketplace": "市场", "community_centre": "社区中心",
           "arts_centre": "艺术中心", "conference_centre": "会议中心", "exhibition_centre": "展览中心", "events_venue": "会展场馆", "fire_station": "消防站",
           "post_office": "邮局", "restaurant": "餐馆", "fast_food": "快餐店", "cafe": "咖啡馆", "fuel": "加油站", "shelter": "亭", "social_facility": "福利机构",
           "research_institute": "研究院所", "public_building": "公共建筑", "prison": "监狱"}
WHAT_SHOP = {"mall": "商场", "department_store": "商场", "supermarket": "超市"}
WHAT_OFFICE = {"government": "政府机关", "company": "公司", "research": "研究机构"}
WHAT_TOURISM = {"hotel": "酒店", "museum": "博物馆", "gallery": "展览馆", "attraction": "景点", "guest_house": "民宿", "theme_park": "主题公园"}
WHAT_HISTORIC = {"building": "历史建筑", "ruins": "遗址", "tomb": "陵墓", "manor": "庄园", "tower": "塔楼", "castle": "城堡", "city_gate": "城门"}
PLACE_LABEL = {("place", "village"): "村庄、社区", ("place", "quarter"): "片区", ("place", "neighbourhood"): "街区", ("place", "suburb"): "街道",
               ("place", "town"): "镇", ("place", "city"): "城市", ("place", "island"): "岛", ("place", "islet"): "岛", ("place", "square"): "广场",
               ("tourism", "attraction"): "景点", ("tourism", "viewpoint"): "观景点", ("tourism", "artwork"): "雕塑", ("tourism", "zoo"): "动物园",
               ("tourism", "aquarium"): "水族馆", ("natural", "peak"): "山峰", ("natural", "hill"): "山", ("natural", "saddle"): "鞍部",
               ("natural", "spring"): "泉", ("natural", "cave_entrance"): "洞口",
               ("man_made", "tower"): "塔、高塔", ("man_made", "bridge"): "桥", ("man_made", "works"): "工厂", ("man_made", "chimney"): "烟囱",
               ("man_made", "observatory"): "天文台", ("man_made", "lighthouse"): "灯塔", ("man_made", "water_tower"): "水塔", ("man_made", "mast"): "塔桅",
               ("man_made", "communications_tower"): "通信塔", ("man_made", "windmill"): "风车", ("man_made", "cross"): "十字架", ("man_made", "pier"): "栈桥",
               ("man_made", "wharf"): "码头",
               ("leisure", "park"): "公园", ("leisure", "garden"): "园林", ("leisure", "stadium"): "体育场", ("leisure", "sports_centre"): "体育中心",
               ("leisure", "nature_reserve"): "保护区", ("leisure", "track"): "运动场", ("leisure", "golf_course"): "高尔夫球场", ("leisure", "marina"): "游艇码头",
               ("leisure", "resort"): "度假村", ("leisure", "slipway"): "船台",
               ("amenity", "school"): "学校", ("amenity", "kindergarten"): "幼儿园", ("amenity", "college"): "学院", ("amenity", "university"): "大学",
               ("amenity", "hospital"): "医院", ("amenity", "place_of_worship"): "寺庙教堂", ("amenity", "marketplace"): "市场", ("amenity", "library"): "图书馆",
               ("amenity", "townhall"): "政府机关", ("amenity", "courthouse"): "法院", ("amenity", "theatre"): "剧院", ("amenity", "arts_centre"): "艺术中心",
               ("amenity", "fountain"): "喷泉", ("amenity", "prison"): "监狱", ("amenity", "monastery"): "寺院", ("amenity", "boat_rental"): "游船码头",
               ("amenity", "public_building"): "公共建筑", ("amenity", "ranger_station"): "管理站", ("amenity", "research_institute"): "研究院所",
               ("amenity", "bus_station"): "公交枢纽站", ("amenity", "ferry_terminal"): "码头", ("amenity", "events_venue"): "会展场馆",
               ("amenity", "exhibition_centre"): "展览中心", ("amenity", "conference_centre"): "会议中心",
               ("railway", "station"): "车站", ("railway", "halt"): "车站", ("public_transport", "station"): "车站", ("public_transport", "stop_area"): "车站",
               ("shop", "mall"): "商场", ("shop", "department_store"): "商场", ("office", "government"): "政府机关", ("office", "association"): "协会",
               ("historic", "building"): "历史建筑", ("historic", "ruins"): "遗址", ("historic", "memorial"): "纪念地", ("historic", "monument"): "纪念碑",
               ("historic", "tomb"): "陵墓", ("historic", "citywalls"): "城墙", ("historic", "archaeological_site"): "考古遗址", ("historic", "manor"): "庄园",
               ("historic", "castle"): "城堡", ("historic", "yes"): "史迹", ("historic", "boundary_stone"): "界碑", ("historic", "tower"): "塔楼",
               ("historic", "city_gate"): "城门",
               ("boundary", "protected_area"): "保护区", ("boundary", "national_park"): "国家公园", ("boundary", "marker"): "界标"}
LAND_LABEL = {("amenity", "school"): "学校", ("amenity", "kindergarten"): "幼儿园", ("amenity", "college"): "学院", ("amenity", "university"): "大学",
              ("amenity", "hospital"): "医院", ("amenity", "bus_station"): "公交枢纽站", ("amenity", "place_of_worship"): "寺庙教堂", ("amenity", "marketplace"): "市场",
              ("amenity", "social_facility"): "福利机构", ("amenity", "research_institute"): "研究院所", ("amenity", "prison"): "监狱",
              ("amenity", "fire_station"): "消防场地", ("amenity", "police"): "公安场地", ("amenity", "parking"): "停车场", ("amenity", "ferry_terminal"): "码头",
              ("leisure", "park"): "公园", ("leisure", "pitch"): "运动场", ("leisure", "stadium"): "体育场", ("leisure", "nature_reserve"): "保护区",
              ("leisure", "garden"): "园林", ("leisure", "sports_centre"): "体育中心", ("leisure", "resort"): "度假村", ("leisure", "golf_course"): "高尔夫球场",
              ("leisure", "playground"): "游乐场",
              ("landuse", "residential"): "住宅区", ("landuse", "industrial"): "厂区", ("landuse", "commercial"): "园区", ("landuse", "retail"): "商圈",
              ("landuse", "construction"): "工地", ("landuse", "religious"): "宗教场所", ("landuse", "railway"): "铁路场地", ("landuse", "orchard"): "果园",
              ("landuse", "cemetery"): "墓园", ("landuse", "farmland"): "农田", ("landuse", "farmyard"): "农家场院", ("landuse", "grass"): "绿地",
              ("landuse", "military"): "军事用地", ("landuse", "brownfield"): "闲置地", ("landuse", "harbour"): "港口", ("landuse", "forest"): "林地",
              ("landuse", "port"): "港口", ("landuse", "garages"): "车库用地",
              ("natural", "wood"): "林地", ("tourism", "theme_park"): "主题公园", ("man_made", "water_works"): "水厂", ("man_made", "wastewater_plant"): "污水处理厂"}
# a name that is only a letter or a number, or a number with the word for a part of a building
NO_NAME = re.compile(r"^[\dA-Za-z#\-–—]+$|^-\d|^[东西南北中]\d+$|^[一二三四五六七八九十零百\d]+(号|号楼|幢|栋|座|层|舍|期|区)$"
                     r"|^[\dA-Za-z\-–— ]+(幢|栋|号楼|号定点|座|单元|层|楼|期|区|组团|排|舍)$")
GENERIC = {"垂梯", "入口", "出口", "楼梯", "电梯", "扶梯", "通道", "换乘通道", "连廊", "门卫", "岗亭", "卫生间", "公厕", "厕所", "配电房", "垃圾房", "楼梯间", "电梯厅", "大堂",
           "南门", "北门", "东门", "西门", "正门", "侧门", "后门", "中门", "大门", "undefined", "null", "未知", "民居", "宿舍",
           "行政楼", "食堂", "教学楼", "实验楼", "综合楼", "报告厅", "图书馆", "操场", "风雨操场", "体育馆", "游泳馆"}


def road_label(tags, name):
    kind = tags.get("highway")
    if kind in LINKS:
        return LINKS[kind]
    if tags.get("tunnel"):
        return "隧道"
    if "立交" in name:
        return "立交"
    if "高架" in name:
        return "高架"
    if tags.get("bridge") not in (None, "no") and "桥" in name:
        return "桥"
    return ROAD_CLASS.get(kind, "道路")


def rail_label(tags, name):
    if "地铁" in name or "轨道交通" in name:
        return "地铁"
    if "城际" in name:
        return "城际铁路"
    if "高速" in name:
        return "高速铁路"
    return "铁路"


def running(tags):
    """Whether a railway is a line (a running line, a metro line) and not one track of a yard or a depot."""
    return tags.get("service") not in YARD and not YARD_NAME.search(str(tags.get("name") or ""))


def water_label(tags, name):
    if name.endswith("江"):
        return "江"
    kind = tags.get("water") or tags.get("waterway") or tags.get("natural") or tags.get("landuse")
    return WATER_KIND.get(kind, "水域")


def building_label(tags):
    """What a named building is, from what is said about it; '' where nothing more is said than that it is one."""
    name = str(tags.get("name") or "")
    for value in str(tags.get("building") or "").split(";"):
        if value in STATIONS:
            return "车辆段" if name.endswith("库") else "棚" if name.endswith("棚") else "车站"      # a depot's sheds are called stations too
    for key, table in (("tourism", WHAT_TOURISM), ("amenity", WHAT_AMENITY), ("historic", WHAT_HISTORIC), ("building", WHAT_BUILDING), ("shop", WHAT_SHOP), ("office", WHAT_OFFICE)):
        label = table.get(tags.get(key))
        if label:
            return label
    return ""


def place_label(tags):
    return PLACE_LABEL.get((tags.get("kind_key"), tags.get("kind")), "")


def land_label(tags):
    for key in ("amenity", "leisure", "landuse", "natural", "tourism", "man_made"):
        label = LAND_LABEL.get((key, tags.get(key)))
        if label:
            return label
    return ""


def meaningful(name):
    """Whether a name finds a thing by itself: not a letter or a number on its own, not a part's label."""
    return not (NO_NAME.match(name) or name in GENERIC)


def _named(tags):
    name = str(tags.get("name") or "").strip()
    return name if name and meaningful(name) else ""


def _also(tags):
    out = []
    for key in OTHER_NAMES:
        for name in str(tags.get(key) or "").split(";"):
            name = name.strip()
            if name and name not in out and not YARD_NAME.search(name):      # a line's alt_name here lists the station tracks it serves
                out.append(name)
    return out


def _middle(geom):
    """A point inside a polygon: its centre where that is inside it, else any point of its own."""
    if geom.geom_type == "Point":
        return geom
    middle = shapely.centroid(geom)
    return middle if shapely.contains(geom, middle) else geom.representative_point()


def _gap(a, b):
    """How far apart two things lie, by the boxes that hold them (a point is a box of no size)."""
    dx = max(0.0, b[0] - a[2], a[0] - b[2])
    dy = max(0.0, b[1] - a[3], a[1] - b[3])
    return math.hypot(dx, dy)


def _groups(geoms, within):
    """[[index, ...], ...]: the geometries that lie within `within` of one another, each index once, in order."""
    if len(geoms) == 1:
        return [[0]]
    i, j = STRtree(geoms).query(geoms, predicate="dwithin", distance=within)
    parent = list(range(len(geoms)))

    def root(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k

    for a, b in zip(i[i < j], j[i < j], strict=True):
        parent[root(int(a))] = root(int(b))
    out = {}
    for k in range(len(geoms)):
        out.setdefault(root(k), []).append(k)
    return list(out.values())


def _features(osm, area):
    """-> [{name, kind, source, geom, label, station, also}]: every named point and polygon worth finding."""
    out = []

    def add(kind, source, geom, tags, label="", station=False):
        name = _named(tags)
        if not name:
            return
        if geom.geom_type == "Point":
            if not shapely.contains(area, geom):
                return
        else:
            geom = geom.intersection(area)
            if geom.is_empty:
                return
        out.append({"name": name, "kind": kind, "source": source, "geom": geom, "label": label, "station": station, "also": _also(tags)})

    for geom, tags in osm.buildings:
        add(BUILDING, "building", geom, tags, building_label(tags), str(tags.get("building") or "").split(";")[0] in STATIONS)
    for geom, tags in osm.road_areas:
        add(PLACE, "ground", geom, tags, "步行街" if "街" in (tags.get("name") or "") else "广场")
    for geom, tags in osm.land:
        add(PLACE, "ground", geom, tags, land_label(tags))
    for geom, tags in osm.places:
        if tags.get("kind") == "subway_entrance":       # its name is a letter (A, B); the station's own name is on its box
            continue
        station = tags.get("kind") in ("station", "halt")
        add(PLACE, "point of interest", geom, tags, "车站" if station else place_label(tags), station)
    for geom, tags in osm.water:
        name = _named(tags)
        if name:
            add(WATER, "water", geom, tags, water_label(tags, name))
    for geom, tags in osm.brands:
        # a chain shop: found by its store's name and by the brand's (the brand rides in as alt_name)
        add(BRAND, "brand", geom, tags, brands.category(tags["brand_id"]))
    return out


def _merged(features, height):
    """-> [entry]: what shares a name and a place is one thing; stations go with stations and nothing else."""
    by_name = {}
    for f in features:
        by_name.setdefault(f["name"], []).append(f)
    out = []
    for name, group in by_name.items():
        for station in (False, True):
            part = [f for f in group if f["station"] == station]
            for members in _groups(numpy.asarray([f["geom"] for f in part], dtype=object), SAME_M):
                things = [part[k] for k in members]
                # an outline says where a thing is best; of what lies flat, the largest
                polygons = [f for f in things if f["geom"].geom_type != "Point"]
                primary = max([f for f in polygons if f["kind"] == BUILDING] or polygons or things, key=lambda f: f["geom"].area if f["geom"].geom_type != "Point" else 0.0)
                at = _middle(primary["geom"])
                # what it is: the point of interest knows best, then the outline, then the ground
                label = next((f["label"] for f in sorted(things, key=lambda f: {"point of interest": 0, "building": 1, "water": 1}.get(f["source"], 2)) if f["label"]), "")
                flat = shapely.union_all([f["geom"] for f in polygons]) if polygons else None
                z = height(numpy.array([at.x]), numpy.array([at.y]))[0]
                out.append({"name": name, "kind": primary["kind"], "label": label, "x": at.x, "y": at.y, "z": z,
                            "size": flat.area if flat is not None else 0.0, "box": flat.bounds if flat is not None else None, "points": None,
                            "also": sorted({other for f in things for other in f["also"] if other != name}), "landmark": None})
    return out


def _outline(edges, height):
    """The pieces of an outline as the page draws them: x, y, z a point, and after each piece a point of no position."""
    rows = []
    for edge in edges:
        pts = numpy.asarray(edge.coords)[:, :2]
        rows += [numpy.column_stack([pts, height(pts[:, 0], pts[:, 1])]), [[numpy.nan, numpy.nan, 0.0]]]
    return numpy.concatenate(rows)


def _shares(sheet, courses):
    """-> a geometry a course: the sheet split among the courses that lie in it, each taking the water nearest to its
    own course. courses: the courses' pieces, lines in world metres."""
    sites, owner = [], []
    for k, pieces in enumerate(courses):
        for x, y in shapely.get_coordinates(shapely.segmentize(shapely.multilinestrings(pieces), SEED_M)):
            sites.append(shapely.Point(x, y))
            owner.append(k)
    near = STRtree(numpy.asarray(sites, dtype=object))
    cells = [[] for _ in courses]
    for cell in shapely.get_parts(voronoi_diagram(shapely.multipoints(sites), envelope=sheet.envelope)):
        cells[owner[int(near.query_nearest(cell.representative_point())[0])]].append(cell)      # the cell belongs to the seed it holds
    return [shapely.union_all(parts).intersection(sheet) for parts in cells]


def _lines(ways, kind, label, area, height, log=print):
    """-> [entry]: one for every group of ways under one name that lie together, each with its course and, as
    `pieces`, the ways it is made of."""
    by_name = {}
    for geom, tags in ways:
        name = _named(tags)
        if not name or (kind == WATER and tags.get("tunnel")):      # a buried stream has no course to draw
            continue
        for part in shapely.get_parts(geom.intersection(area)):
            if part.geom_type == "LineString" and part.length >= 1.0:
                by_name.setdefault(name, []).append((part, tags))
    out = []
    for name, group in by_name.items():
        for members in _groups(numpy.asarray([part for part, _ in group], dtype=object), JOIN_M):
            pieces = [group[k] for k in members]
            longest, tags = max(pieces, key=lambda piece: piece[0].length)
            middle = longest.interpolate(0.5, normalized=True)
            course, last = [], None
            for part, tags_of in pieces:
                pts = numpy.asarray(shapely.simplify(part, POINT_M, preserve_topology=False).coords)[:, :2]
                if len(pts) < 2:
                    continue
                if ground._elevated(tags_of):
                    # a bridge or a viaduct floats above the highest ground under it, as its deck does (ground.deck_mesh)
                    zs = numpy.full(len(pts), float(numpy.max(height(pts[:, 0], pts[:, 1]))) + ground.CLEARANCE)
                else:
                    zs = height(pts[:, 0], pts[:, 1])      # a tunnel's course is drawn on the ground over it
                if last is not None and numpy.hypot(*(pts[0] - last)) > BREAK_M:
                    course.append([[numpy.nan, numpy.nan, 0.0]])     # the map leaves this stretch unnamed: the course breaks here
                course.append(numpy.column_stack([pts, zs]))
                last = pts[-1]
            if not course:
                continue
            z = height(numpy.array([middle.x]), numpy.array([middle.y]))[0]
            if ground._elevated(tags):
                z = float(numpy.max(height(*shapely.get_coordinates(longest).T))) + ground.CLEARANCE
            points = numpy.concatenate(course).astype(numpy.float64)
            box = [float(numpy.nanmin(points[:, 0])), float(numpy.nanmin(points[:, 1])), float(numpy.nanmax(points[:, 0])), float(numpy.nanmax(points[:, 1]))]
            out.append({"name": name, "kind": kind, "label": label(tags, name), "x": middle.x, "y": middle.y, "z": z, "size": sum(part.length for part, _ in pieces),
                        "box": tuple(box), "points": points,
                        "also": sorted({other for _, tags_of in pieces for other in _also(tags_of) if other != name}), "landmark": None,
                        "pieces": [part for part, _ in pieces]})
    return out


def collect(city, osm, landmarks, height, aliases=None, log=print):
    """-> (columns, points): the file's two sections. `landmarks`: data/baked/<city>/landmarks.json as read (world metres)."""
    west, south, east, north = city.bounds()
    area = box(west - EDGE_M, south - EDGE_M, east + EDGE_M, north + EDGE_M)

    # what a landmark of the list stands on, called as the landmark is or as a part of its title, is that landmark:
    # the list's flight is the better view of it. A road is kept: its whole course is worth drawing.
    named = {}
    for row in landmarks:
        for item in [row, *row.get("parts", [])]:
            for name in {row["title"], *row["title"].split("·")}:
                named.setdefault(name, []).append((item["x"], item["y"]))
    entries = [entry for entry in _merged(_features(osm, area), height)
               if not any(numpy.hypot(entry["x"] - x, entry["y"] - y) <= UNDER_LANDMARK_M for x, y in named.get(entry["name"], []))]
    entries += _lines(osm.roads, ROAD, road_label, area, height)
    entries += _lines([(geom, tags) for geom, tags in osm.rail if running(tags)], RAIL, rail_label, area, height)
    entries += _lines(osm.water_lines, WATER, water_label, area, height)

    # A river is one sheet of water with no name of its own in the map, named only by the line drawn along it, and
    # that line is coarse: two of its points lie ten kilometres apart, and the course between them crosses land. So a
    # named watercourse that lies in a nameless sheet takes the water of that sheet: it is framed and measured by it,
    # and drawn by its outline. A sheet that holds watercourses of several names (the Qiantang and the two rivers that
    # meet to form it) is split among them, each taking the water nearest to its own course.
    bare = [geom for geom in (geom.intersection(area) for geom, tags in osm.water if not tags.get("name") and geom.area >= SHEET_M2) if not geom.is_empty]
    if bare:
        tree = STRtree(numpy.asarray(bare, dtype=object))
        holders = {}
        for entry in entries:
            if entry["kind"] != WATER or "pieces" not in entry:      # a lake of its own name is not a watercourse in a sheet
                continue
            course = shapely.multilinestrings(entry["pieces"])
            for k in tree.query(course):
                if shapely.length(bare[int(k)].intersection(course)) >= SHEET_SHARE * course.length:
                    holders.setdefault(int(k), []).append(entry)
                    break
        for k, group in holders.items():
            waters = [bare[k]] if len(group) == 1 else _shares(bare[k], [entry["pieces"] for entry in group])
            for entry, water in zip(group, waters, strict=True):
                if water.is_empty:
                    continue
                # only the bank is drawn, not the seam where the sheet was cut between this course and another's water
                bank = [edge for edge in shapely.get_parts(water.boundary.intersection(bare[k].boundary.buffer(BANK_M)))
                        if edge.geom_type == "LineString" and edge.length > RING_M]
                if not bank:
                    continue
                points = _outline(bank, height)
                entry.update(points=points, size=water.area, sheet=True,
                             box=(float(numpy.nanmin(points[:, 0])), float(numpy.nanmin(points[:, 1])), float(numpy.nanmax(points[:, 0])), float(numpy.nanmax(points[:, 1]))))
    for entry in entries:
        entry.pop("pieces", None)

    # the landmarks themselves
    for row in landmarks:
        x, y, z = float(row["x"]), float(row["y"]), float(row.get("ground") or 0.0)
        entries.append({"name": row["title"], "kind": LANDMARK, "label": row["group"], "x": x, "y": y, "z": z, "size": 0.0, "box": None, "points": None,
                        "also": [part for part in row["title"].split("·") if part != row["title"]], "landmark": row["id"]})

    # what a thing is called that the map does not call it. An alias must point at a name the index has.
    for alias, name in sorted((aliases or {}).items()):
        hits = [entry for entry in entries if entry["name"] == name]
        if not hits:
            raise SystemExit(f"the alias “{alias}” points at nothing in the map: “{name}”")
        for entry in hits:
            if alias not in entry["also"]:
                entry["also"].append(alias)

    entries.sort(key=lambda entry: (entry["kind"], entry["name"]))

    # a name borne by more than one thing that lie apart: the nearest village, neighbourhood, suburb or town says
    # which. What shares a name and lies together (a square and the station under it) is one place, and needs no word.
    districts = [(_middle(geom).x, _middle(geom).y, str(tags.get("name") or "")) for geom, tags in osm.places
                 if tags.get("kind_key") == "place" and tags.get("kind") in ("village", "quarter", "neighbourhood", "suburb", "town", "city")]
    extent = [(entry["box"] if entry["box"] is not None else (entry["x"], entry["y"], entry["x"], entry["y"])) for entry in entries]
    by_name = {}
    for k, entry in enumerate(entries):
        by_name.setdefault(entry["name"], []).append(k)
    borne = {name for name, rows in by_name.items() if len(rows) > 1 and any(_gap(extent[a], extent[b]) > APART_M for i, a in enumerate(rows) for b in rows[:i])}
    near = {}
    if borne and districts:
        here = numpy.asarray([(x, y) for x, y, _ in districts])
        for k, entry in enumerate(entries):
            if entry["name"] in borne:
                best = int(numpy.argmin(numpy.hypot(here[:, 0] - entry["x"], here[:, 1] - entry["y"])))
                if numpy.hypot(here[best, 0] - entry["x"], here[best, 1] - entry["y"]) <= NEAR_M and districts[best][2]:
                    near[str(k)] = districts[best][2]          # keyed by its row, as JSON writes it

    labels = sorted({entry["label"] for entry in entries})
    points, first = [], 0
    columns = {"labels": labels, "names": [], "kinds": [], "x": [], "y": [], "z": [], "label": [], "size": [], "box": [], "line": [], "landmark": [], "near": {}, "also": {},
               "sheets": [k for k, entry in enumerate(entries) if entry.get("sheet")]}
    for k, entry in enumerate(entries):
        columns["names"].append(entry["name"])
        columns["kinds"].append(entry["kind"])
        columns["x"].append(round(float(entry["x"]), 1))
        columns["y"].append(round(float(entry["y"]), 1))
        columns["z"].append(round(float(entry["z"]), 1))
        columns["label"].append(labels.index(entry["label"]))
        columns["size"].append(int(round(entry["size"])))
        columns["box"].append([int(round(v)) for v in entry["box"]] if entry["box"] is not None else None)
        if entry["points"] is not None and len(entry["points"]):
            columns["line"].append([first, len(entry["points"])])
            points.append(entry["points"])
            first += len(entry["points"])
        else:
            columns["line"].append(None)
        columns["landmark"].append(entry["landmark"])
        if str(k) in near:
            columns["near"][str(k)] = near[str(k)]
        if entry["also"]:
            columns["also"][str(k)] = ";".join(entry["also"])
    course = numpy.concatenate(points) if points else numpy.zeros((0, 3))
    packed = numpy.empty(len(course), dtype=POINT)
    packed["x"], packed["y"] = course[:, 0].astype("<f4"), course[:, 1].astype("<f4")
    packed["z"] = compact.i16(course[:, 2], compact.DECK_Z_PER_M, "the height of a point of a named line")
    count = {kind: sum(1 for entry in entries if entry["kind"] == kind) for kind in range(7)}
    log("names: " + ", ".join(f"{label} {count[kind]}" for kind, label in enumerate(KIND_LABELS))
        + f"; {len(borne)} names borne by more than one, {len(columns['sheets'])} of them sheets of water; {len(points)} lines, {len(course)} points")
    return columns, packed


def build(city, log=print):
    osm = Layers.load(city.work / "osm.pkl")
    grid, info = load_terrain(city.work / "terrain.bin")
    height = surface(grid, info, TILE_M / TERRAIN_CELLS)
    landmarks = json.loads((city.baked / "landmarks.json").read_text(encoding="utf-8"))
    alias_file = city.curated(ALIASES)
    aliases = json.loads(alias_file.read_text(encoding="utf-8"))["aliases"] if alias_file else {}
    columns, points = collect(city, osm, landmarks, height, aliases, log=log)
    out = city.baked / "names.bin"
    out.write_bytes(container([
        (b"NAME", json.dumps(columns, ensure_ascii=False, separators=(",", ":")).encode("utf-8")),
        (b"LINE", points.tobytes()),
    ]))
    log(f"-> {out} {out.stat().st_size / 1e6:.1f} MB")
    return out


def read(path):
    """-> (columns, points): a names.bin as the page reads it, for the tests and the report."""
    data = Path(path).read_bytes()
    if data[:4] != MAGIC or struct.unpack_from("<H", data, 4)[0] != FORMAT:
        raise ValueError("not a baked file of this version")
    sections = {}
    for k in range(struct.unpack_from("<H", data, 6)[0]):
        sid, offset, length = struct.unpack_from("<4sII", data, 8 + 12 * k)
        sections[sid.rstrip(b"\0")] = data[offset:offset + length]
    return json.loads(sections[b"NAME"]), numpy.frombuffer(sections[b"LINE"], dtype=POINT)


if __name__ == "__main__":
    build(of(sys.argv))
