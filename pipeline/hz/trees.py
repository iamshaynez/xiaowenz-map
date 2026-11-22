"""Where the trees are, and what kind.

Four sources, each with its own kinds and sizes:
  woods    the tree cover of the ESA WorldCover map, thinned, and OSM woods and nature reserves
  lawns    parks, gardens and other grass in OSM
  streets  rows of street trees along both sides of the quieter streets: plane trees along the main
           roads, camphors along the local ones
  shores   willows along the shores of lakes, with a blossoming tree between every two of them

No tree stands on a building, on a road or on water.

A tree is 16 bytes: x and y in world metres (float), z (float), species, size, seed and kind (a byte
each). Size is the radius of the crown in half-metres. Within a tile the trees are sorted into squares
of 250 m so that a view can take only the near ones.
"""
import struct

import numpy
import shapely
from shapely.geometry.polygon import orient
from shapely.strtree import STRtree

from . import ground
from .ground import (FOREST, GRASS, PATH, ROAD_MAJOR, ROAD_MINOR, ROAD_PEDESTRIAN, ROAD_SECONDARY, ROAD_SERVICE, WATER_LAKE)
from .landcover import TREE, class_at

CAMPHOR, WILLOW, PLANE, PINE, BAMBOO, BLOSSOM = range(6)
SPECIES_NAMES = {CAMPHOR: "camphor", WILLOW: "willow", PLANE: "plane", PINE: "pine", BAMBOO: "bamboo", BLOSSOM: "blossom"}
KIND_NAMES = {0: "woods", 1: "lawns", 2: "streets", 3: "shores"}
WOODS, LAWNS, STREETS, SHORES = range(4)
RECORD = numpy.dtype([("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("species", "u1"), ("size", "u1"), ("seed", "u1"), ("kind", "u1")])   # 16 bytes

CROWN_RADIUS_M = {CAMPHOR: (3.8, 5.6), WILLOW: (3.6, 5.0), PLANE: (3.8, 5.8), PINE: (2.6, 3.8), BAMBOO: (2.0, 3.0), BLOSSOM: (2.4, 3.4)}
WOODS_MIX = (CAMPHOR, CAMPHOR, CAMPHOR, PINE, PINE, BAMBOO, BAMBOO, PLANE)      # what a Hangzhou hill is made of
LAWN_MIX = (CAMPHOR, CAMPHOR, CAMPHOR, CAMPHOR, PLANE, WILLOW, WILLOW, BLOSSOM, BLOSSOM, PINE)
COVER_KEEP = 0.55           # the share of the satellite map's tree cells that get a tree of their own
OSM_WOOD_M2 = 110.0         # one tree per this many square metres of OSM wood outside those cells
LAWN_M2 = 550.0             # ... of lawn
STREET_TREE_M = 8.5         # one street tree per this many metres of street, on each side
STREET_SETBACK_M = 1.7      # between the kerb and the trunk
STREET_CLASSES = {ROAD_MAJOR: PLANE, ROAD_SECONDARY: PLANE, ROAD_MINOR: CAMPHOR}
SHORE_TREE_M = 9.0          # one shore tree per this many metres of shore
SHORE_SETBACK_M = 3.2       # between the water's edge and the trunk
CELL_M = 250.0              # trees are stored in squares of this size


def _pick(mix, count, rng):
    return numpy.asarray(mix, dtype=numpy.int64)[rng.integers(0, len(mix), count)]


def _crown(species, rng):
    low, high = numpy.asarray([CROWN_RADIUS_M[int(s)] for s in species]).T
    return low + (high - low) * rng.random(len(species))


def _scatter(polygon, count, rng):
    """`count` random points inside a polygon: points in its bounding box, the outside ones thrown away."""
    minx, miny, maxx, maxy = polygon.bounds
    xs, ys = [], []
    while sum(len(a) for a in xs) < count:
        cx = rng.uniform(minx, maxx, count * 2)
        cy = rng.uniform(miny, maxy, count * 2)
        keep = shapely.contains_xy(polygon, cx, cy)
        xs.append(cx[keep])
        ys.append(cy[keep])
    return numpy.concatenate(xs)[:count], numpy.concatenate(ys)[:count]


def _rows_along(line, spacing, jitter, rng):
    """Points along a line, one every `spacing` metres, and the unit direction of the line there."""
    count = max(int(line.length / spacing), 0)
    if not count:
        return numpy.zeros((0, 2)), numpy.zeros((0, 2))
    distance = (numpy.arange(count) + 0.5 + rng.uniform(-jitter, jitter, count)) * spacing
    points = shapely.get_coordinates(shapely.line_interpolate_point(line, distance))
    ahead = shapely.get_coordinates(shapely.line_interpolate_point(line, numpy.minimum(distance + 1.0, line.length)))
    behind = shapely.get_coordinates(shapely.line_interpolate_point(line, numpy.maximum(distance - 1.0, 0.0)))
    direction = ahead - behind
    return points, direction / (numpy.hypot(direction[:, 0], direction[:, 1])[:, None] + 1e-9)


def generate(ground_data, buildings, height, cover, bounds, rng, log=print):
    """-> tree records in world metres.

    ground_data: ground.Ground. buildings: building footprints. height: terrain sampler.
    cover: (classes, x0, y0, step) from landcover. bounds: (west, south, east, north) in world metres.
    """
    west, south, east, north = bounds
    building_tree = STRtree(buildings)
    # carriageways only: a street tree stands on the pavement, which must not count as road
    carriageways = (ROAD_MAJOR, ROAD_SECONDARY, ROAD_MINOR, ROAD_SERVICE, ROAD_PEDESTRIAN, PATH)
    paved = shapely.union_all([ground_data.layers[c] for c in (*carriageways, ground.RAIL) if c in ground_data.layers])
    shapely.prepare(paved)
    water = ground_data.water
    shapely.prepare(water)

    def free(x, y, clearance):
        """Which of the points do not stand on a building (within `clearance` metres), a road or water."""
        blocked = numpy.zeros(len(x), dtype=bool)
        if len(x):
            blocked[building_tree.query(shapely.points(x, y), predicate="dwithin", distance=clearance)[0]] = True
        return ~blocked & ~shapely.contains_xy(paved, x, y) & ~shapely.contains_xy(water, x, y)

    def make(x, y, species, kind):
        alive = free(x, y, 1.0 if kind in (WOODS, LAWNS) else 0.6)
        x, y, species = x[alive], y[alive], species[alive]
        out = numpy.zeros(len(x), dtype=RECORD)
        out["x"], out["y"], out["z"] = x, y, height(x, y)
        out["species"] = species
        out["size"] = numpy.clip(numpy.rint(_crown(species, rng) * 2), 3, 255).astype("u1")
        out["seed"] = rng.integers(0, 256, len(x))
        out["kind"] = kind
        return out

    groups = []

    # ---- woods from the satellite map: one tree in most of the cells it calls tree cover ----
    classes, cx0, cy0, step = cover
    rows, cols = numpy.nonzero(classes == TREE)
    keep = rng.random(len(rows)) < COVER_KEEP
    rows, cols = rows[keep], cols[keep]
    x = cx0 + (cols + rng.random(len(cols))) * step
    y = cy0 + (classes.shape[0] - rows - 0.5 + rng.random(len(rows))) * step   # row 0 is the northernmost
    in_region = (x > west - 2000) & (x < east + 2000) & (y > south - 2000) & (y < north + 2000)
    x, y = x[in_region], y[in_region]
    woods = make(x, y, _pick(WOODS_MIX, len(x), rng), WOODS)
    groups.append(woods)
    log(f"trees from the satellite map: {len(woods)}")

    # ---- OSM woods outside those cells, and lawns ----
    for cls, per_m2, mix, kind in ((FOREST, OSM_WOOD_M2, WOODS_MIX, WOODS), (GRASS, LAWN_M2, LAWN_MIX, LAWNS)):
        xs, ys = [], []
        for polygon in ground_data.parts.get(cls, []):
            count = int(rng.poisson(polygon.area / per_m2))
            if count:
                px, py = _scatter(polygon, count, rng)
                xs.append(px)
                ys.append(py)
        if not xs:
            continue
        x, y = numpy.concatenate(xs), numpy.concatenate(ys)
        if cls == FOREST:
            fresh = class_at(cover, x, y) != TREE      # the other cells already have a tree of their own
            x, y = x[fresh], y[fresh]
        made = make(x, y, _pick(mix, len(x), rng), kind)
        groups.append(made)
        log(f"trees on OSM {ground.GROUND_COLOURS[cls]}: {len(made)}")

    # ---- street trees: a row on each side of the quieter streets ----
    xs, ys, kinds = [], [], []
    for line, cls, width in ground_data.roads:
        if cls not in STREET_CLASSES:
            continue
        points, direction = _rows_along(line, STREET_TREE_M, 0.18, rng)
        if not len(points):
            continue
        offset = width / 2 + STREET_SETBACK_M
        for sign in (1, -1):
            # sideways to the direction of the street
            xs.append(points[:, 0] + sign * direction[:, 1] * offset)
            ys.append(points[:, 1] - sign * direction[:, 0] * offset)
            kinds.append(numpy.full(len(points), STREET_CLASSES[cls]))
    if xs:
        made = make(numpy.concatenate(xs), numpy.concatenate(ys), numpy.concatenate(kinds), STREETS)
        groups.append(made)
        log(f"street trees: {len(made)}")

    # ---- willows along the shores of lakes ----
    xs, ys, kinds = [], [], []
    for polygon in ground_data.parts.get(WATER_LAKE, []):
        # with the exterior counter-clockwise and the holes clockwise, the water is always on the left
        polygon = orient(polygon, 1.0)
        for ring in (polygon.exterior, *polygon.interiors):
            points, direction = _rows_along(shapely.LineString(ring.coords), SHORE_TREE_M, 0.12, rng)
            if not len(points):
                continue
            xs.append(points[:, 0] + direction[:, 1] * SHORE_SETBACK_M)
            ys.append(points[:, 1] - direction[:, 0] * SHORE_SETBACK_M)
            kinds.append(numpy.where(numpy.arange(len(points)) % 2 == 0, WILLOW, BLOSSOM))
    if xs:
        made = make(numpy.concatenate(xs), numpy.concatenate(ys), numpy.concatenate(kinds), SHORES)
        groups.append(made)
        log(f"shore trees: {len(made)}")

    trees = numpy.concatenate(groups) if groups else numpy.zeros(0, dtype=RECORD)
    return trees[numpy.lexsort((trees["y"], trees["x"]))]


def section(records, x0, y0, size=1000.0):
    """-> bytes: the trees of one tile. They are sorted into squares of CELL_M, a cell's trees in one run:
    cells per side (u32), count (u32), where each cell's run starts (u32 per cell, and one more), then the trees."""
    cells = int(size // CELL_M)
    cx = numpy.clip((records["x"] - x0) // CELL_M, 0, cells - 1).astype(int)
    cy = numpy.clip((records["y"] - y0) // CELL_M, 0, cells - 1).astype(int)
    keys = cy * cells + cx
    order = numpy.argsort(keys, kind="stable")
    local = records[order].copy()
    local["x"] -= x0
    local["y"] -= y0
    starts = numpy.searchsorted(keys[order], numpy.arange(cells * cells + 1))
    return struct.pack("<II", cells, len(local)) + starts.astype("<u4").tobytes() + local.tobytes()
