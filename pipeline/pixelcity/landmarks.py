"""The landmarks of a city: where each is, how each is built, and how the camera is set to look at it.

Which landmarks a city has is said in cities/<id>/landmarks.json: a table where each landmark names the mapped
feature it stands on (a pagoda's outline, the viewpoint node, the bridge's way), and gives by hand what is not in
the map: the dimensions of the buildings put together by hand (kits), how far around them the mapped buildings are
cleared away, the camera of the fly-to, and the one-line note. A landmark may carry `parts`, built with it (the six
bridges of a causeway), and may `place` itself on one side of its feature. No coordinate is typed from memory: this
module looks each feature up in the map.

build() writes two lists: data/work/<id>/landmarks.json with longitude and latitude, for the data report, and
data/baked/<id>/landmarks.json for the app, on the map's metres. place() then stands them on the ground, writing
into the baked list the height of the ground under each, read the way the app reads it from a tile: the camera of a
flight is set from it before the tile is loaded.

Usage: python -m pixelcity.landmarks <city>
"""
import json
import math
import sys

import numpy
import shapely

from .bake import surface
from .city import TILE_M, of
from .osm_extract import Layers

TABLE = "landmarks.json"
PART_KEYS = ("title", "lon", "lat", "angle", "kit", "clear", "clearSpan")
SIDES = ("east",)          # the sides of its feature a landmark may be placed on, besides its middle (see standing)


def cleared_around(c, path=None):
    """-> [(x, y, radius)] or [(x, y, radius, half length, angle)]: the ground, in world metres, around landmarks
    built by hand inside which nothing mapped is drawn: a pagoda's own outline, a bridge's deck and the lines
    along it. A disc for what stands in one place; for a bridge, which is mapped as a line, a corridor from
    its middle for `half length` each way along `angle`, `radius` to each side."""
    data = json.loads((path or c.work / "landmarks.json").read_text(encoding="utf-8"))
    areas = []
    for row in data["landmarks"]:
        for item in [row, *row.get("parts", [])]:
            if not item.get("clear"):
                continue
            x, y = c.project(item["lon"], item["lat"])
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


def standing(geom, where):
    """The point a landmark stands on: its own middle (placed), or with `where` ({side, share}) the representative
    point of that share of one side of its feature: a landmark of the east part of a great park stands in that part.
    -> (x, y, angle, half length), the last two None for what does not run as a line."""
    if not where:
        return placed(geom)
    if where["side"] not in SIDES:
        raise SystemExit(f"a landmark can be placed on the {', '.join(SIDES)} of its feature so far, not {where['side']!r}")
    west, south, east, north = geom.bounds
    part = shapely.box(west + float(where["share"]) * (east - west), south, east, north).intersection(geom)
    point = part.representative_point()
    return float(point.x), float(point.y), None, None


def entry(c, osm, group, row):
    """One landmark of the table, as the app reads it, stood on the feature it names and placed by longitude and latitude."""
    x, y, angle, span = standing(find(osm, row["layer"], row["name"], row.get("tag")), row.get("place"))
    lon, lat = c.unproject(x, y)
    view = row.get("view", {"scale": 0})          # a part is not flown to on its own: no view is given for it
    item = {"title": row["title"], "group": group, "lon": round(float(lon), 6), "lat": round(float(lat), 6),
            "view": {"scale": view["scale"], **{key: value for key, value in view.items() if key != "scale"}},
            "note": row.get("note", ""), "source": f"OpenStreetMap: {row['layer']} “{row['name']}”"}
    if angle is not None:
        item["angle"] = round(float(angle), 5)
    if row.get("kit"):
        # what is built by hand clears the ground around it; a landmark that is only flown to clears nothing
        item["kit"], item["clear"] = row["kit"], row.get("clear", 0)
    if row.get("kit") and row.get("clear") and span is not None:
        item["clearSpan"] = round(float(span) + 2.0, 1)      # the whole length of the line the model stands on
    return item


def part(item):
    """A landmark that goes with another one: only what places and builds it."""
    return {key: item[key] for key in PART_KEYS if key in item}


def build(c, log=print):
    """Look the city's landmarks up in the map and stand them on it: the list with longitude and latitude for the
    data report, and the same for the app, on the map's metres."""
    osm = Layers.load(c.work / "osm.pkl")
    table = c.curated(TABLE)
    if table is None:
        raise SystemExit(f"{c.folder} has no {TABLE}: the landmarks of a city are said there")
    table = json.loads(table.read_text(encoding="utf-8"))
    groups = table["groups"]
    rows = []
    for row in table["landmarks"]:
        if row["group"] not in groups:
            raise SystemExit(f"the landmark {row['title']!r} is in the group {row['group']!r}, which is not among the city's: {', '.join(groups)}")
        rows.append(entry(c, osm, row["group"], row))
    counters = {}                                   # ids: the group's number, then the order within it
    for row, said in zip(rows, table["landmarks"], strict=True):
        counters[row["group"]] = counters.get(row["group"], 0) + 1
        row["id"] = f"{groups.index(row['group']) + 1}-{counters[row['group']]:02d}"
        row["parts"] = [part(entry(c, osm, row["group"], sub)) for sub in said.get("parts", [])]
    out = c.work / "landmarks.json"
    out.write_text(json.dumps({"_comment": f"Written by pixelcity.landmarks from cities/{c.id}/{TABLE}: the landmarks with where the map puts them.",
                               "groups": groups, "landmarks": rows}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"{len(rows)} landmarks -> {out}")
    # and the same for the app, placed on the map: world metres instead of longitude and latitude
    c.baked.mkdir(parents=True, exist_ok=True)
    baked = c.baked / "landmarks.json"
    baked.write_text(json.dumps([forApp(c, row) for row in rows], ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"-> {baked}")
    return rows


def forApp(c, row):
    """A landmark as the app loads it: on the map's metres, with what places and builds it and nothing else."""
    x, y = c.project(row["lon"], row["lat"])
    item = {key: row[key] for key in ("id", "title", "group", "note", "view", "angle", "kit", "clear", "clearSpan") if key in row}
    item.update(x=float(x), y=float(y), parts=[forApp(c, {**part, "id": "", "group": row["group"]}) for part in row.get("parts", [])])
    return item


def place(c, grid, info, log=print):
    """Stand the landmarks on the ground: write into the baked list the height of the ground under each, read
    the way the app reads it from a tile. The camera of a flight is set from it before the tile is loaded."""
    from .bake import TERRAIN_CELLS
    ground = surface(grid, info, TILE_M / TERRAIN_CELLS)        # what the app's renderer will read under the landmark
    path = c.baked / "landmarks.json"
    rows = json.loads(path.read_text(encoding="utf-8"))
    for row in rows:
        for item in [row, *row.get("parts", [])]:
            item["ground"] = round(float(ground([item["x"]], [item["y"]])[0]), 2)
    path.write_text(json.dumps(rows, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"{len(rows)} landmarks placed on the ground -> {path}")


if __name__ == "__main__":
    build(of(sys.argv))
