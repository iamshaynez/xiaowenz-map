"""Bake everything the app loads.

Every file starts with the magic HZT1, a version (u16: 2) and the number of sections. The forms are
compact.py's: numbers in the smallest integers that hold them, and what the page can work out for itself
left out. The page reads them in app/src/world/data.js, which this module's docstrings mirror.

data/baked/overview.bin: the whole region for the overview tier, small enough to load at start-up.
  GRID  heights on a 125 m grid over the region (int16 metres, north row first)
  MASS  one box per 50 m cell that holds a building: count (u32), then 12 bytes a cell: column, row (i16,
        from the world origin),
        the tallest building's base (i16, 2.5 cm) and height (u16, a centimetre), archetype, wall colour,
        roof colour, seed
  LCV   cells across and up (u16), west and south edge (f64), cell size (f64); then the ground
        class of every 50 m cell (one byte), rows from the north
  URB   the same header; then for every 50 m cell how much of it is built over and how tall (two bytes)
  RIBA  main roads, railways and canals as strips, for drawing as thin lines from far away: parts (u32);
        per part points (u16), class (u8), half width (u8, quarter-metres), the points (x, y: i32 metres
        from the world origin) and a direction per segment (u16, the turn in 65536ths of a circle). The
        page takes each strip's height off GRID, and which side a vertex is on from its place in the quad

data/baked/tiles/b/<x>_<y>.bin: one file per 1 km tile, loaded when it comes into view at the district tier.
  TERR  heights on a 37 x 37 grid over the tile and two rings (62.5 m) beyond it on every side (int16
        metres, north row first): the page draws the inner 33 x 33 and reads ground heights off the whole
  BASE  the satellite land cover of each terrain cell, as a ground class (one byte), rows from the north
  BLDB  buildings as coarse meshes (outlines simplified to 1.5 m): flat roofs, or a gable or a hip roof
        where a building is given one and its outline fills a rectangle. buildings, corners, indices
        (u32 each), bytes per index (u8); 11 bytes of properties a building (base, height, levels,
        archetype, roof, wall colour, roof colour, seed, flags); 12 bytes a corner (x, y in 4 cm, z in
        2.5 cm, the level part of the normal in two i16, the building it belongs to); the indices
  ROOF  what is put on flat roofs by rule (stair heads, tanks, solar heaters, air-conditioning units), as
        boxes: count (u32), then 11 bytes each: x, y relative to the tile, base, height, half width, half
        depth, wall colour, roof colour. Inferred, not mapped
  WATR  water surfaces: corners once each (x, y in 4 cm, class; the height is the ground's under the
        corner plus the lift of its class, read off TERR), then the triangle indices
  ROAD  carriageways, walkways and railways on the ground: a mesh in the same form
  LAND  parks, woods, farmland, yards and urban ground: a mesh in the same form
  DECK  bridges and viaducts: a mesh in the same form with each corner's height (a deck is not at the
        ground's own height), walls included
  PATH  the lines things move along (streets, canals, the river, routes across West Lake), each whole and
        belonging to this tile: count (u32), then per line points (u16), class (u8), spare (u8), width and
        length (f32), and per point x, y relative to the tile, z, distance from the start (f32)
  TREE  the trees of the tile, sorted into squares of 250 m: cells per side (u32), count (u32), where
        each cell's run starts (u32 per cell, and one more), then 7 bytes a tree: x, y relative to the
        tile (i16, 4 cm), species and kind (a byte: 3 bits each), crown radius in half-metres, seed (a
        byte each). The height is the ground's under it, read off TERR
  PLCE  JSON: the named places of the tile: [name, kind key, kind, x, y]
  META  JSON

Every building and tree belongs to the tile holding it and is drawn whole from there; ground is
drawn wherever it reaches into a tile, so that neighbouring tiles meet.

Usage: python -m hz.scene [--limit N]      (N bakes only the first N tiles, for trying things out)
"""
import json
import pickle
import struct
import sys
import time

import numpy
import shapely

from . import compact, ground, region
from . import trees as tree_data
from .bake import (
    FLAG_CLEARED,
    FORMAT,
    MASS_CELL_M,
    TERRAIN_CELLS,
    buildings_section,
    coarse_grid_section,
    container,
    massing_section,
    roof_boxes_section,
    rooftop_props,
    surface,
    terrain_section,
    tile_origin,
)
from .buildings import doubles
from .classify import classify, in_historic_villages, in_tea_zones
from .ground import (
    FARMLAND,
    FOREST,
    GRASS,
    GROUND_COLOURS,
    LAND_CLASSES,
    LIFT,
    PITCH,
    RAIL,
    ROAD_CLASSES,
    ROCK,
    SAND,
    TEA,
    URBAN,
    WATER_CANAL,
    WATER_CLASSES,
    WATER_LAKE,
    WATER_POND,
    WATER_RIVER,
    WATERWAY_WIDTH,
    WETLAND,
    YARD,
    Ground,
    deck_mesh,
    mesh,
)
from .landcover import (
    BARE,
    BUILT,
    CROPLAND,
    GRASSLAND,
    MANGROVE,
    MOSS,
    SHRUB,
    SNOW,
    TREE,
    WATER,
    class_at,
)
from .landcover import WETLAND as COVER_WETLAND
from .landcover import load as load_cover
from .landmarks import cleared_around, cleared_mask
from .osm_extract import Layers
from .paths import collect as collect_paths
from .paths import group_by_tile as group_lines_by_tile
from .paths import section as paths_section
from .terrain import load as load_terrain

# what the satellite map's classes mean on the ground
COVER_TO_GROUND = {TREE: FOREST, SHRUB: FOREST, MANGROVE: FOREST, GRASSLAND: GRASS, CROPLAND: FARMLAND, BUILT: URBAN,
                   BARE: ROCK, SNOW: ROCK, MOSS: ROCK, WATER: WATER_POND, COVER_WETLAND: WETLAND}
# where mapped ground overlaps, the later ones in this list win
GROUND_PRIORITY = (URBAN, YARD, ROCK, SAND, WETLAND, PITCH, GRASS, FARMLAND, TEA, FOREST,
                   *(c for c in ROAD_CLASSES if c != ground.PATH), ground.PATH, RAIL, WATER_POND, WATER_CANAL, WATER_RIVER, WATER_LAKE)
RIBBON_TOLERANCE_M = 6.0
LANDCOVER_TEA = 255         # classes the land-cover map does not have: stand for tea in the tea hills, and for
LANDCOVER_YARD = 254        # the yard of a house in a village of the historic kind
FLAG_ROOFTOP, FLAG_INFERRED_HEIGHT, FLAG_VILLAGE_CAP, FLAG_DATASET_OUTLINE, FLAG_REPLACED_BLOCK = 1, 2, 4, 8, 16
RIBBON_ROAD_CLASSES = (ground.ROAD_MAJOR, ground.ROAD_SECONDARY)


def mesh_section(vertices, indices, height_stored):
    """A mesh of the ground (compact.ground_corners): corner count, index count (u32), bytes per index (u8),
    the corners, then the triangle indices."""
    indices = numpy.asarray(indices, dtype=numpy.int64)
    records, ids, count = compact.ground_corners(vertices, height_stored)
    body, width = compact.indices(ids[indices], count)
    return struct.pack("<IIB", count, len(indices), width) + records + body


def base_section(x0, y0, cover):
    """The ground class at the centre of each terrain cell of a tile, read off the satellite map."""
    step = region.TILE_M / TERRAIN_CELLS
    across = x0 + (numpy.arange(TERRAIN_CELLS) + 0.5) * step
    up = y0 + (numpy.arange(TERRAIN_CELLS) + 0.5) * step
    xs, ys = numpy.tile(across, TERRAIN_CELLS), numpy.repeat(up, TERRAIN_CELLS)
    classes = reclassify_cover(xs, ys, class_at(cover, xs, ys), squares=True).reshape(TERRAIN_CELLS, TERRAIN_CELLS)
    return COVER_TABLE[classes][::-1].tobytes()  # the northern row first


def cell_grid(bounds, cell):
    """Square cells over a box: -> (x0, y0, nx, ny, centres x, centres y) with the centres running north to south."""
    west, south, east, north = bounds
    x0, y0 = float(numpy.floor(west / cell) * cell), float(numpy.floor(south / cell) * cell)
    nx, ny = int(numpy.ceil((east - x0) / cell)), int(numpy.ceil((north - y0) / cell))
    xs = x0 + (numpy.arange(nx) + 0.5) * cell
    ys = y0 + (numpy.arange(ny) + 0.5) * cell
    return x0, y0, nx, ny, xs, ys[::-1]


COVER_TABLE = numpy.zeros(256, dtype=numpy.uint8)
for _source, _target in COVER_TO_GROUND.items():
    COVER_TABLE[_source] = _target
COVER_TABLE[LANDCOVER_TEA] = TEA
COVER_TABLE[LANDCOVER_YARD] = YARD


def reclassify_cover(x, y, classes, squares=False):
    """The satellite map's classes, corrected where the place is known: what it takes for trees, or for bare
    ground, in the tea hills is tea; what it takes for built-up land in the historic villages is the yard of a
    house. `squares`: for the base of a tile, which is read cell by cell: its water would come out in squares,
    so it is left to the water the bake lays on as polygons."""
    classes = numpy.array(classes, copy=True)
    tea = in_tea_zones(x, y)
    classes[tea & numpy.isin(classes, (TREE, SHRUB, MANGROVE, BARE))] = LANDCOVER_TEA
    classes[in_historic_villages(x, y) & (classes == BUILT)] = LANDCOVER_YARD
    if squares:
        classes[classes == WATER] = GRASSLAND
    return classes


def reclassify_ground(x, y, cls):
    """The same for a polygon of ground: the scenic area's "forest" is tea in the tea hills."""
    if cls == FOREST and in_tea_zones(numpy.array([x]), numpy.array([y]))[0]:
        return TEA
    return cls


def overview_rasters(props, areas, ground_data, cover, bounds, height, cell=MASS_CELL_M):
    """LCV and URB: what covers each cell of the overview, and how much of it is built over."""
    x0, y0, nx, ny, xs, ys = cell_grid(bounds, cell)
    cx, cy = numpy.tile(xs, ny), numpy.repeat(ys, nx)
    kinds = COVER_TABLE[reclassify_cover(cx, cy, class_at(cover, cx, cy))]
    on_tea = in_tea_zones(cx, cy)
    for cls in GROUND_PRIORITY:
        if cls not in ground_data.layers:
            continue
        on_layer = shapely.contains_xy(ground_data.layers[cls], cx, cy)
        if cls == FOREST:
            on_layer &= ~on_tea                    # the scenic area's "forest" is tea in the tea hills
        kinds[on_layer] = cls
    lcv = struct.pack("<HHddd", nx, ny, x0, y0, cell) + kinds.astype("u1").tobytes()

    # built-over share and tallest building of a cell, from the buildings whose centre falls in it
    bx, by = props[:, 9], props[:, 10]
    col = numpy.clip(((bx - x0) / cell).astype(int), 0, nx - 1)
    row = numpy.clip(((y0 + ny * cell - by) / cell).astype(int), 0, ny - 1)
    at = row * nx + col
    cover_share = numpy.zeros(nx * ny)
    tallest = numpy.zeros(nx * ny)
    numpy.add.at(cover_share, at, areas)
    numpy.maximum.at(tallest, at, props[:, 1])
    share = numpy.clip(numpy.rint(255 * numpy.minimum(1.0, cover_share / (cell * cell) * 1.5)), 0, 255)
    # height on a logarithmic scale: 3 m is 0, 1 km would be 255
    tall = numpy.clip(numpy.rint(255 * numpy.log2(1 + tallest / 3.0) / numpy.log2(1 + 1000.0 / 3.0)), 0, 255)
    urb = struct.pack("<HHddd", nx, ny, x0, y0, cell) + numpy.column_stack([share, tall]).astype("u1").tobytes()
    return lcv, urb


def in_water(geoms, water, share=0.6, log=None):
    """-> a mask of the buildings that stand mostly in open water: boats and echoes on the river, not buildings.

    How much of a building is over the water is measured with a lattice of 25 points over its box,
    counted where they fall inside the building. The river's box covers the whole city, so every
    building is tested against it; that is only quick with the river prepared, as the first argument.
    """
    parts = numpy.asarray(shapely.get_parts(water), dtype=object)
    over = numpy.zeros(len(geoms))
    inside = numpy.zeros(len(geoms))
    if not len(parts):
        return over > share
    parts = parts[shapely.area(parts) > 100.0]
    min_x, min_y, max_x, max_y = shapely.bounds(geoms).T
    offsets = numpy.linspace(0.1, 0.9, 5)
    across, up = numpy.meshgrid(offsets, offsets)
    across, up = across.ravel(), up.ravel()
    for part in parts:
        west, south, east, north = part.bounds
        near = numpy.flatnonzero((min_x <= east) & (max_x >= west) & (min_y <= north) & (max_y >= south))
        if not len(near):
            continue
        shapely.prepare(part)
        hits = near[shapely.intersects(part, geoms[near])]
        if not hits.size:
            continue
        west_b, south_b, east_b, north_b = shapely.bounds(geoms[hits]).T
        xs = west_b[:, None] + (east_b - west_b)[:, None] * across
        ys = south_b[:, None] + (north_b - south_b)[:, None] * up
        within = shapely.contains_xy(numpy.repeat(geoms[hits], across.size), xs.ravel(), ys.ravel()).reshape(xs.shape)
        wet = shapely.contains_xy(part, xs.ravel(), ys.ravel()).reshape(xs.shape)
        over[hits] += (within & wet).sum(axis=1)
        inside[hits] = numpy.maximum(inside[hits], within.sum(axis=1))
    return (inside > 0) & (over > share * inside)


def within(x, y, areas):
    """Whether a point (world metres) lies in any of the areas of landmarks.cleared_around()."""
    return bool(cleared_mask(numpy.array([x]), numpy.array([y]), areas)[0])


def ribbon_section(lines, tolerance=RIBBON_TOLERANCE_M):
    """Strips along lines, for the overview, in compact.py's form: parts (u32); per part its points (u16), class
    (u8) and half width (u8, quarter-metres), its points (x, y: i32 metres from the world origin), and the
    direction of each of its segments (u16, the turn from the map's x axis in 65536ths of a circle).

    The direction lets the app widen a strip on the screen to at least one pixel however far out it is viewed from;
    the strip's height it takes off the overview's grid, as the bake did.
    """
    parts = []
    for line, cls, half in lines:
        for part in shapely.get_parts(shapely.simplify(line, tolerance)):
            pts = numpy.asarray(part.coords)
            if len(pts) < 2:
                continue
            a, b = pts[:-1], pts[1:]
            dx, dy = b[:, 0] - a[:, 0], b[:, 1] - a[:, 1]
            length = numpy.hypot(dx, dy)
            ok = length > 0.5
            if not ok.any():
                continue
            a, b, dx, dy = a[ok], b[ok], dx[ok] / length[ok], dy[ok] / length[ok]
            # the points of the part: where each segment starts, and where the last one ends
            points = numpy.vstack([a, b[-1]])
            points = numpy.column_stack([compact.i32(points[:, 0], compact.RIBBON_UNIT, "a ribbon point's x"), compact.i32(points[:, 1], compact.RIBBON_UNIT, "a ribbon point's y")])
            parts.append(struct.pack("<HBB", len(points), int(cls), int(compact.u8(half, compact.RIBBON_HALF_PER_M, "a ribbon's half width")[0]))
                         + points.astype("<i4").tobytes() + compact.ribbon_turns(dx, dy).tobytes())
    if not parts:
        return struct.pack("<I", 0)
    return struct.pack("<I", len(parts)) + b"".join(parts)


def overview_lines(osm, ground_data):
    """The lines worth drawing as such from far away: main roads, railways, canals and rivers."""
    lines = [(line, cls, width / 2) for line, cls, width in ground_data.roads if cls in RIBBON_ROAD_CLASSES and line.length >= 150]
    lines += [(geom, RAIL, 3.5) for geom, tags in osm.rail if tags.get("railway") == "rail" and not tags.get("tunnel") and geom.length >= 150]
    lines += [(geom, WATER_CANAL, WATERWAY_WIDTH.get(t.get("waterway"), 6) / 2)
              for geom, t in osm.water_lines if t.get("waterway") in ("canal", "river") and not t.get("tunnel") and geom.length >= 80]
    return lines


def group_by_tile(x, y, tx0, ty0, nx, ny):
    """-> (order, starts): indices of the items sorted by tile, and where each tile's run begins."""
    ix = numpy.clip(numpy.floor(x / region.TILE_M).astype(int), tx0, tx0 + nx - 1) - tx0
    iy = numpy.clip(numpy.floor(y / region.TILE_M).astype(int), ty0, ty0 + ny - 1) - ty0
    key = ix * ny + iy
    order = numpy.argsort(key, kind="stable")
    return order, numpy.searchsorted(key[order], numpy.arange(nx * ny + 1))


def flag_cleared(props, clears):
    """Flag, in the properties the app reads, every building whose centre lies where a landmark is built by
    hand: the height data set sees a pagoda as a few very tall "buildings", OSM as one great hall, and they
    would bury the landmark; a bridge's own mapped deck is drawn by the model instead. The app leaves
    flagged buildings out of the tile, of the overview and
    of the sun's picture, and nothing is put on their roofs.

    props: rows of nine property floats, then the centre x and y. clears: as landmarks.cleared_around().
    -> a mask of the rows that were flagged.
    """
    flags = props[:, 8].astype(numpy.int64)                 # they are bits, held in floats
    cleared = cleared_mask(props[:, 9], props[:, 10], clears)
    flags[cleared] |= FLAG_CLEARED
    props[:, 8] = flags
    return cleared


def bake(limit=None, log=print):
    t0 = time.time()
    work = region.WORK
    clears = cleared_around()            # discs around landmarks built by hand: nothing mapped is drawn inside them
    with open(work / "buildings.pkl", "rb") as f:
        buildings = pickle.load(f)
    grid, info = load_terrain(work / "terrain.bin")
    classify(buildings, grid, info, log=log)
    height = surface(grid, info, region.TILE_M / TERRAIN_CELLS)       # the ground as the app draws it: everything laid on it follows the mesh, not the DEM
    ground_data = Ground.load(work / "ground.pkl")
    cover = load_cover(work / "landcover.npz")
    trees = numpy.load(work / "trees.npy")
    # the map ends at the region's outline; trees farther out than the island's fringe would never be seen
    region_polygon = shapely.Polygon(region.region_corners()).buffer(60.0)
    inside = shapely.contains_xy(region_polygon, trees["x"], trees["y"])
    trees = trees[inside]
    osm = Layers.load(work / "osm.pkl")
    palette = json.loads((region.CURATED / "palette.json").read_text(encoding="utf-8"))["colours"]
    colour_index = {name: i for i, name in enumerate(palette)}

    west, south, east, north = region.region_bounds()
    bounds = (west - region.MARGIN_M, south - region.MARGIN_M, east + region.MARGIN_M, north + region.MARGIN_M)
    # what stands mostly in open water is a boat or an echo on the water, not a building
    geoms = numpy.asarray([b["geom"] for b in buildings], dtype=object)
    afloat = in_water(geoms, ground_data.water)
    if afloat.any():
        log(f"left out {int(afloat.sum())} buildings standing in water")
        buildings = [b for b, a in zip(buildings, afloat, strict=True) if not a]
        geoms = geoms[~afloat]
    # the height data set holds about a third of its footprints twice: one record of each is kept, decided
    # among the buildings that stay (one left out as standing in water must not take its twin with it). The
    # list stays whole until the roofs have been filled in: their boxes come from one stream of random
    # numbers over the buildings in order, so one left out would move what stands on every roof after it
    repeated_pairs = []
    twice = doubles(buildings, pairs=repeated_pairs, log=log)
    areas = shapely.area(geoms)
    centres = shapely.centroid(geoms)
    cx, cy = shapely.get_x(centres), shapely.get_y(centres)
    # per building: the nine property floats, then the centre, for grouping
    # flags (the ninth): what is known about the building and what was inferred; the app can show them
    flags = numpy.array([FLAG_INFERRED_HEIGHT * (b["height_source"] == "inferred") + FLAG_VILLAGE_CAP * bool(b.get("village_cap"))
                         + FLAG_DATASET_OUTLINE * (b["origin"] == "globfp") + FLAG_REPLACED_BLOCK * (b["origin"] == "osm-block") for b in buildings])
    props = numpy.array([[b["base"], b["height"], b["levels"], b["archetype"], b["roof"], colour_index[b["wall"]], colour_index[b["roof_colour"]], b["seed"], f, x, y]
                         for b, f, x, y in zip(buildings, flags, cx, cy, strict=True)], dtype=numpy.float64)
    cleared = flag_cleared(props, clears)
    log(f"{int(cleared.sum())} mapped buildings give way to landmarks built by hand")
    # what was left out and what was kept in its place, for the data report and for tools/tests/bake-compare.cjs

    def look(k):
        """levels, archetype, roof, wall colour, roof colour, seed and flags: what tells a record apart"""
        return [int(props[k, c]) for c in range(2, 9)]

    (work / "repeated-outlines.json").write_text(json.dumps({"leftOut": [look(a) for a, b in repeated_pairs], "kept": [look(b) for a, b in repeated_pairs]}))

    # what stands on the flat roofs: not buildings, drawn like them, in a section of their own so that the
    # app can leave them out until they are more than a pixel. Made over every record, kept or not (see above)
    roof_geoms, roof_rows = rooftop_props(geoms, props, colour_index)
    repeated = int(twice.sum())
    if repeated:
        on_kept = ~twice[roof_rows[:, 11].astype(numpy.int64)]
        roof_geoms, roof_rows = roof_geoms[on_kept], roof_rows[on_kept]
        buildings = [b for b, t in zip(buildings, twice, strict=True) if not t]
        geoms, areas, cx, cy, flags, props, cleared = geoms[~twice], areas[~twice], cx[~twice], cy[~twice], flags[~twice], props[~twice], cleared[~twice]
    live = props[~cleared]             # what is drawn, for the overview tier
    live_areas = areas[~cleared]

    tx0, tx1 = int(numpy.floor(west / region.TILE_M)), int(numpy.floor(east / region.TILE_M))
    ty0, ty1 = int(numpy.floor(south / region.TILE_M)), int(numpy.floor(north / region.TILE_M))
    nx_tiles, ny_tiles = tx1 - tx0 + 1, ty1 - ty0 + 1
    by_tile, tile_starts = group_by_tile(cx, cy, tx0, ty0, nx_tiles, ny_tiles)
    tree_tile, tree_starts = group_by_tile(trees["x"].astype(float), trees["y"].astype(float), tx0, ty0, nx_tiles, ny_tiles)

    # the lines things move along, each belonging to the tile that holds its middle
    lake_routes = json.loads((region.CURATED / "lake_routes.json").read_text(encoding="utf-8"))["routes"]
    moving = collect_paths(ground_data, osm, height, lake_routes, log=log)
    # a bridge built by hand carries its own deck: the mapped one, and the lines along it, give way
    ground_data.set_decks([deck for deck in ground_data.decks if not within(deck[2].interpolate(0.5, normalized=True).x, deck[2].interpolate(0.5, normalized=True).y, clears)])
    moving = [line for line in moving if not within(line[0].interpolate(0.5, normalized=True).x, line[0].interpolate(0.5, normalized=True).y, clears)]
    path_tile, path_starts = group_lines_by_tile(moving, tx0, ty0, nx_tiles, ny_tiles)

    # named places, by tile
    places = {}
    for geom, tags in osm.places:
        name = tags.get("name")
        if not name:
            continue
        at = geom if geom.geom_type == "Point" else geom.representative_point()
        tx, ty = region.tile_index(at.x, at.y)
        places.setdefault((tx, ty), []).append([name, tags.get("kind_key"), tags.get("kind"), round(at.x, 1), round(at.y, 1)])

    # ---- the overview package ----
    region.BAKED.mkdir(parents=True, exist_ok=True)
    lcv, urb = overview_rasters(live, live_areas, ground_data, cover, bounds, height)

    roof_tile, roof_starts = group_by_tile(roof_rows[:, 9], roof_rows[:, 10], tx0, ty0, nx_tiles, ny_tiles)
    real = len(props)
    log(f"rooftop props: {len(roof_rows)}")
    (region.BAKED / "overview.bin").write_bytes(container([
        (b"GRID", coarse_grid_section(grid, info)),
        (b"MASS", massing_section(live, 0.0, 0.0)),
        (b"LCV", lcv),
        (b"URB", urb),
        (b"RIBA", ribbon_section(overview_lines(osm, ground_data))),
    ]))
    log(f"overview.bin {(region.BAKED / 'overview.bin').stat().st_size / 1048576:.1f} MB")

    # ---- the tiles ----
    out_dir = region.BAKED / "tiles" / "b"
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in out_dir.glob("*.bin"):
        f.unlink()
    totals = {"vertices": 0, "ground_triangles": 0}
    made = 0
    for tx in range(nx_tiles):
        for ty in range(ny_tiles):
            if limit is not None and made >= limit:
                break
            k = tx * ny_tiles + ty
            sl = by_tile[tile_starts[k]:tile_starts[k + 1]]
            x0, y0 = tile_origin(tx + tx0, ty + ty0)
            sections = [(b"TERR", terrain_section(x0, y0, grid, info)), (b"BASE", base_section(x0, y0, cover))]
            if len(sl):
                section = buildings_section(geoms[sl], props[sl], x0, y0)
                totals["vertices"] += struct.unpack_from("<I", section, 4)[0]
                sections.append((b"BLDB", section))
            ground_parts = [mesh(ground_data, classes, x0, y0, height, reclassify=reclassify_ground)
                            for classes in (WATER_CLASSES, ROAD_CLASSES + (RAIL,), LAND_CLASSES)]
            deck = deck_mesh(ground_data, x0, y0, height)
            for sid, (vertices, indices) in zip((b"WATR", b"ROAD", b"LAND", b"DECK"), (*ground_parts, deck), strict=True):
                if len(indices):
                    sections.append((sid, mesh_section(vertices, indices, sid == b"DECK")))
                    totals["ground_triangles"] += len(indices) // 3
            trees_here = trees[tree_tile[tree_starts[k]:tree_starts[k + 1]]]
            if len(trees_here):
                sections.append((b"TREE", tree_data.section(trees_here, x0, y0)))
            if (tx + tx0, ty + ty0) in places:
                sections.append((b"PLCE", json.dumps(places[(tx + tx0, ty + ty0)], ensure_ascii=False).encode("utf-8")))
            here = path_tile[path_starts[k]:path_starts[k + 1]]
            if len(here):
                sections.append((b"PATH", paths_section([moving[j] for j in here], x0, y0, height)))
            roof_here = roof_tile[roof_starts[k]:roof_starts[k + 1]]
            if len(roof_here):
                sections.append((b"ROOF", roof_boxes_section(roof_geoms[roof_here], roof_rows[roof_here], x0, y0)))
            sections.append((b"META", json.dumps({"x0": x0, "y0": y0, "buildings": len(sl), "rooftop": len(roof_here),
                                                  "trees": len(trees_here)}).encode("utf-8")))
            (out_dir / f"{tx}_{ty}.bin").write_bytes(container(sections))
            made += 1
        if limit is not None and made >= limit:
            break

    index = {
        "tileSize": region.TILE_M, "ix0": tx0, "iy0": ty0, "format": FORMAT, "nx": nx_tiles, "ny": ny_tiles, "tilesBaked": made,
        "palette": list(palette), "origin": [region.ORIGIN_E, region.ORIGIN_N], "epsg": region.EPSG, "bounds": [west, south, east, north],
        "coarseTolerance": 1.5,
        "buildings": real, "leftOutOfWater": int(afloat.sum()), "repeatedOutlines": repeated, "rooftopProps": len(roof_rows),
        "inferredHeights": int((flags & FLAG_INFERRED_HEIGHT != 0).sum()), "villageCaps": int((flags & FLAG_VILLAGE_CAP != 0).sum()),
        "datasetOutlines": int((flags & FLAG_DATASET_OUTLINE != 0).sum()), "replacedBlocks": int((flags & FLAG_REPLACED_BLOCK != 0).sum()),
        "flags": {"rooftop": 1, "inferredHeight": 2, "villageCap": 4, "datasetOutline": 8, "replacedBlock": 16, "cleared": 32},
        "clearedForLandmarks": int(cleared.sum()),
        "island": region.region_shape(),
        "groundClasses": {str(cls): {"colour": GROUND_COLOURS[cls], "lift": LIFT[cls]} for cls in GROUND_COLOURS},
        "treeCell": tree_data.CELL_M,
        "treeSpecies": {str(s): {"name": n, "crown": list(tree_data.CROWN_RADIUS_M[s])} for s, n in tree_data.SPECIES_NAMES.items()},
        "treeKinds": {str(k): n for k, n in tree_data.KIND_NAMES.items()},
    }
    (region.BAKED / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    size = sum(f.stat().st_size for f in out_dir.glob("*.bin"))
    log(f"baked {made} tiles: {real} buildings (+{len(roof_rows)} rooftop props), {totals['vertices']} building vertices, {totals['ground_triangles']} ground triangles, "
        f"{len(trees)} trees, {size / 1048576:.0f} MB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    bake(limit)
