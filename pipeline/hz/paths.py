"""The lines things move along: every street for the cars, the canals and the river for the boats, and a few
routes across West Lake for its own boats. Nothing here is drawn; the app runs vehicles along these lines.

A line is kept whole, however far it runs, and belongs to the tile that holds its middle, as a building
belongs to the tile that holds it: something moving along it never has to be handed over between tiles.

Usage: python -m hz.paths      collects them and reports (the bake collects them itself; nothing is saved)
"""
import struct
import time

import numpy
import shapely
from shapely.strtree import STRtree

from . import ground, region

CAR_CLASSES = (ground.ROAD_MAJOR, ground.ROAD_SECONDARY, ground.ROAD_MINOR, ground.ROAD_SERVICE)   # what carries cars carries people too
FOOT_CLASSES = (ground.ROAD_PEDESTRIAN, ground.PATH)
CANAL, RIVER, LAKE = 200, 201, 202                 # classes of the boat routes; far from the ground classes
ROAD_TOLERANCE_M = 1.5                             # centrelines are simplified to this
WATER_TOLERANCE_M = 6.0
MIN_WATER_LINE_M = 150.0
BOAT_WIDTH_M = {CANAL: 6.0, RIVER: 60.0, LAKE: 12.0}   # the room a route gives its boats: a canal is narrow, the river is not
LAKE_ROUTES = "lake_routes.json"                   # curated: lines across West Lake, in longitude and latitude


def collect(ground_data, osm, height, lake_routes=(), log=print):
    """-> list of (line, class, width, heights) in world metres; heights: a sampler giving the line's level."""
    lines = []

    def add(line, cls, width, level):
        """Keep a line as its parts, each a line of its own: a way cut in two by the region's edge moves nothing across the gap."""
        for part in shapely.get_parts(line):
            if not part.is_empty:
                lines.append((part, int(cls), float(width), level))

    # streets. ground.py kept the centrelines but not the tags; a centreline's middle lies on the mapped
    # way it was cut from, so the way is found again by that (within half a metre, since cutting moves the
    # coordinates in the last decimal; and the shortest of the ways meeting there, for a junction).
    ways = [geom for geom, _ in osm.roads]
    tags_of = [tags for _, tags in osm.roads]
    tree = STRtree(ways) if ways else None
    elevated = 0
    for line, cls, width in ground_data.roads:
        if cls not in CAR_CLASSES + FOOT_CLASSES:
            continue
        simplified = shapely.simplify(line, ROAD_TOLERANCE_M)
        if simplified.length < 12.0:
            continue
        middle = line.interpolate(0.5, normalized=True)
        here = tree.query(middle, predicate="dwithin", distance=0.5) if tree is not None else []
        kinds = [k for k in here if ground.GROUP.get(tags_of[k].get("highway")) == cls]
        tags = tags_of[min(kinds, key=lambda k: ways[k].length)] if kinds else {}
        if ground._elevated(tags):
            # a bridge or viaduct floats `CLEARANCE` above the highest ground under it, as its deck does
            x, y = shapely.get_coordinates(line).T
            top = float(numpy.max(height(x, y))) + ground.CLEARANCE
            add(simplified, cls, width, lambda x, y, top=top: numpy.full(numpy.shape(x), top))
            elevated += 1
        else:
            add(simplified, cls, width, height)
    log(f"streets for traffic: {len(lines)} lines, {elevated} of them on bridges or viaducts")
    # canals and the river
    water_lines = 0
    for geom, tags in osm.water_lines:
        kind = tags.get("waterway")
        if kind not in ("canal", "river") or tags.get("tunnel") or geom.length < MIN_WATER_LINE_M:
            continue
        cls = RIVER if kind == "river" else CANAL
        add(shapely.simplify(geom, WATER_TOLERANCE_M), cls, BOAT_WIDTH_M[cls], height)
        water_lines += 1
    log(f"waterways for boats: {water_lines} lines")
    # West Lake: the routes are given, and have to lie on open water
    kept = 0
    for route in lake_routes:
        x, y = region.project([p[0] for p in route], [p[1] for p in route])
        line = shapely.LineString(numpy.column_stack([x, y]))
        if shapely.contains_xy(ground_data.water, *shapely.get_coordinates(line).T).all():
            add(line, LAKE, BOAT_WIDTH_M[LAKE], height)
            kept += 1
        else:
            log(f"a lake route leaves the water and was dropped: {route[0]} .. {route[-1]}")
    log(f"routes across West Lake: {kept}")
    return lines


def section(lines, x0, y0, height_of):
    """-> bytes: u32 count, then per line u16 points, u8 class, u8 spare, f32 width, f32 length, and per point
    x, y relative to the tile's corner, z, distance from the start of the line (float each)."""
    out = bytearray(struct.pack("<I", len(lines)))
    for line, cls, width, level in lines:
        pts = numpy.asarray(line.coords, dtype="<f8")
        step = numpy.hypot(*numpy.diff(pts, axis=0).T)
        dist = numpy.concatenate([[0.0], numpy.cumsum(step)])
        pts[:, 0] -= x0
        pts[:, 1] -= y0
        z = numpy.broadcast_to(numpy.asarray(level(pts[:, 0] + x0, pts[:, 1] + y0), dtype=float), (len(pts),))
        out += struct.pack("<HBBff", len(pts), cls, 0, width, float(dist[-1]))
        out += numpy.column_stack([pts, z, dist]).astype("<f4").tobytes()
    return bytes(out)


def group_by_tile(lines, tx0, ty0, nx, ny):
    """-> (order, starts): the lines sorted by the tile holding their middle, and where each tile's run begins."""
    mid = numpy.array([line.interpolate(0.5, normalized=True).coords[0] for line, _, _, _ in lines]).reshape(-1, 2)
    ix = numpy.clip(numpy.floor(mid[:, 0] / region.TILE_M).astype(int), tx0, tx0 + nx - 1) - tx0
    iy = numpy.clip(numpy.floor(mid[:, 1] / region.TILE_M).astype(int), ty0, ty0 + ny - 1) - ty0
    key = ix * ny + iy
    order = numpy.argsort(key, kind="stable")
    return order, numpy.searchsorted(key[order], numpy.arange(nx * ny + 1))


if __name__ == "__main__":
    import json

    from .ground import Ground
    from .osm_extract import Layers
    from .terrain import load as load_terrain

    t0 = time.time()
    work = region.WORK
    osm = Layers.load(work / "osm.pkl")
    ground_data = Ground.load(work / "ground.pkl")
    grid, info = load_terrain(work / "terrain.bin")
    height = ground.sample_terrain(grid, info)
    routes = json.loads((region.CURATED / LAKE_ROUTES).read_text(encoding="utf-8"))["routes"]
    lines = collect(ground_data, osm, height, routes)
    print(f"{len(lines)} lines, {sum(line.length for line, _, _, _ in lines):.0f} km, in {time.time() - t0:.0f} s")
