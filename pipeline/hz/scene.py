"""Bake everything the app loads.

data/baked/overview.bin: the whole region for the overview tier, small enough to load at start-up.
  GRID  heights on a 125 m grid over the region (int16 metres, north row first)
  MASS  one box per 50 m cell that holds a building: centre, base, height, look
  LCV   the ground class of every 50 m cell (one byte), rows from the north
  URB   for every 50 m cell: how much of it is built over, and how tall (two bytes)
  RIBA  main roads, railways and canals as strips: for drawing as thin lines from far away

data/baked/tiles/b/<x>_<y>.bin: one file per 1 km tile, loaded when it comes into view at the district tier.
  TERR  heights of a 32 x 32 grid over the tile (int16 metres, north row first)
  BASE  the satellite land cover of each terrain cell, as a ground class (one byte), rows from the north
  BLDB  buildings as coarse meshes (flat roofs, outlines simplified to 1.5 m)
  WATR  water surfaces: a mesh whose vertices carry x, y, z, class, seed
  ROAD  carriageways, walkways and railways on the ground: a mesh in the same form
  LAND  parks, woods, farmland, yards and urban ground: a mesh in the same form
  DECK  bridges and viaducts: a mesh in the same form, walls included
  TREE  the trees of the tile, sorted into squares of 250 m
  PLCE  JSON: the named places of the tile
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

from . import ground, region
from . import trees as tree_data
from .bake import MASS_CELL_M, TERRAIN_CELLS, buildings_section, coarse_grid_section, container, massing_section, terrain_section, tile_origin
from .classify import classify
from .ground import (
    FOREST, FARMLAND, GRASS, PITCH, RAIL, ROCK, SAND, URBAN, WATER_CANAL, WATER_LAKE, WATER_POND, WATER_RIVER, WATERWAY_WIDTH,
    WETLAND, YARD, LAND_CLASSES, LIFT, ROAD_CLASSES, WATER_CLASSES, GROUND_COLOURS, Ground, deck_mesh, mesh, sample_terrain,
)
from .landcover import BARE, BUILT, CROPLAND, GRASSLAND, MANGROVE, MOSS, SHRUB, SNOW, TREE, WATER, WETLAND as COVER_WETLAND, class_at, load as load_cover
from .osm_extract import Layers
from .terrain import load as load_terrain

# what the satellite map's classes mean on the ground
COVER_TO_GROUND = {TREE: FOREST, SHRUB: FOREST, MANGROVE: FOREST, GRASSLAND: GRASS, CROPLAND: FARMLAND, BUILT: URBAN,
                   BARE: ROCK, SNOW: ROCK, MOSS: ROCK, WATER: WATER_POND, COVER_WETLAND: WETLAND}
# where mapped ground overlaps, the later ones in this list win
GROUND_PRIORITY = (URBAN, YARD, ROCK, SAND, WETLAND, PITCH, GRASS, FARMLAND, FOREST,
                   *(c for c in ROAD_CLASSES if c != ground.PATH), ground.PATH, RAIL, WATER_POND, WATER_CANAL, WATER_RIVER, WATER_LAKE)
RIBBON_TOLERANCE_M = 6.0
RIBBON_ROAD_CLASSES = (ground.ROAD_MAJOR, ground.ROAD_SECONDARY)


def mesh_section(vertices, indices):
    """A mesh: vertex count, index count, vertices (x, y, z, class, seed as floats), indices."""
    return struct.pack("<II", len(vertices), len(indices)) + vertices.astype("<f4").tobytes() + indices.astype("<u4").tobytes()


def base_section(x0, y0, cover):
    """The ground class at the centre of each terrain cell of a tile, read off the satellite map."""
    step = region.TILE_M / TERRAIN_CELLS
    across = x0 + (numpy.arange(TERRAIN_CELLS) + 0.5) * step
    up = y0 + (numpy.arange(TERRAIN_CELLS) + 0.5) * step
    classes = class_at(cover, numpy.tile(across, TERRAIN_CELLS), numpy.repeat(up, TERRAIN_CELLS)).reshape(TERRAIN_CELLS, TERRAIN_CELLS)
    table = numpy.zeros(256, dtype=numpy.uint8)
    for source, target in COVER_TO_GROUND.items():
        table[source] = target
    return table[classes][::-1].tobytes()  # the northern row first


def cell_grid(bounds, cell):
    """Square cells over a box: -> (x0, y0, nx, ny, centres x, centres y) with the centres running north to south."""
    west, south, east, north = bounds
    x0, y0 = float(numpy.floor(west / cell) * cell), float(numpy.floor(south / cell) * cell)
    nx, ny = int(numpy.ceil((east - x0) / cell)), int(numpy.ceil((north - y0) / cell))
    xs = x0 + (numpy.arange(nx) + 0.5) * cell
    ys = y0 + (numpy.arange(ny) + 0.5) * cell
    return x0, y0, nx, ny, xs, ys[::-1]


def overview_rasters(props, areas, ground_data, cover, bounds, height, cell=MASS_CELL_M):
    """LCV and URB: what covers each cell of the overview, and how much of it is built over."""
    x0, y0, nx, ny, xs, ys = cell_grid(bounds, cell)
    cx, cy = numpy.tile(xs, ny), numpy.repeat(ys, nx)
    table = numpy.zeros(256, dtype=numpy.uint8)
    for source, target in COVER_TO_GROUND.items():
        table[source] = target
    kinds = table[class_at(cover, cx, cy)]
    for cls in GROUND_PRIORITY:
        if cls in ground_data.layers:
            kinds[shapely.contains_xy(ground_data.layers[cls], cx, cy)] = cls
    lcv = struct.pack("<ddd", x0, y0, cell) + kinds.astype("u1").tobytes()

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
    urb = struct.pack("<ddd", x0, y0, cell) + numpy.column_stack([share, tall]).astype("u1").tobytes()
    return lcv, urb


def ribbon_section(lines, height, tolerance=RIBBON_TOLERANCE_M):
    """Strips along lines, for the overview: a vertex is x, y, z, lateral (-1 or 1), half width, class."""
    verts, index = [], []
    count = 0
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
            n = len(a)
            quad = numpy.zeros((n, 4, 6), dtype=numpy.float32)
            quad[:, 0, :2], quad[:, 1, :2], quad[:, 2, :2], quad[:, 3, :2] = a, a, b, b
            quad[:, 0, :2] -= numpy.column_stack([dy, -dx]) * half
            quad[:, 1, :2] += numpy.column_stack([dy, -dx]) * half
            quad[:, 2, :2] += numpy.column_stack([dy, -dx]) * half
            quad[:, 3, :2] -= numpy.column_stack([dy, -dx]) * half
            quad[:, :, 2] = height(quad[:, :, 0].ravel(), quad[:, :, 1].ravel()).reshape(n, 4) + LIFT.get(int(cls), 0.02)
            quad[:, :, 3] = (-1, 1, 1, -1)
            quad[:, :, 4] = half
            quad[:, :, 5] = cls
            v = quad.reshape(-1, 6)
            verts.append(v)
            t = numpy.arange(n) * 4 + count
            index.append(numpy.column_stack([t, t + 1, t + 2, t, t + 2, t + 3]).reshape(-1).astype("<u4"))
            count += len(v)
    if not verts:
        return struct.pack("<II", 0, 0)
    return struct.pack("<II", count, sum(len(i) for i in index)) + numpy.concatenate(verts).astype("<f4").tobytes() + numpy.concatenate(index).tobytes()


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


def bake(limit=None, log=print):
    t0 = time.time()
    work = region.WORK
    with open(work / "buildings.pkl", "rb") as f:
        buildings = pickle.load(f)
    grid, info = load_terrain(work / "terrain.bin")
    classify(buildings, grid, info, log=log)
    height = sample_terrain(grid, info)
    ground_data = Ground.load(work / "ground.pkl")
    cover = load_cover(work / "landcover.npz")
    trees = numpy.load(work / "trees.npy")
    osm = Layers.load(work / "osm.pkl")
    palette = json.loads((region.CURATED / "palette.json").read_text(encoding="utf-8"))["colours"]
    colour_index = {name: i for i, name in enumerate(palette)}

    west, south, east, north = region.region_bounds()
    bounds = (west - region.MARGIN_M, south - region.MARGIN_M, east + region.MARGIN_M, north + region.MARGIN_M)
    geoms = numpy.asarray([b["geom"] for b in buildings], dtype=object)
    areas = shapely.area(geoms)
    centres = shapely.centroid(geoms)
    cx, cy = shapely.get_x(centres), shapely.get_y(centres)
    # per building: the nine property floats, then the centre, for grouping
    props = numpy.array([[b["base"], b["height"], b["levels"], b["archetype"], b["roof"], colour_index[b["wall"]], colour_index[b["roof_colour"]], b["seed"], 0, x, y]
                         for b, x, y in zip(buildings, cx, cy, strict=True)], dtype=numpy.float64)

    tx0, tx1 = int(numpy.floor(west / region.TILE_M)), int(numpy.floor(east / region.TILE_M))
    ty0, ty1 = int(numpy.floor(south / region.TILE_M)), int(numpy.floor(north / region.TILE_M))
    nx_tiles, ny_tiles = tx1 - tx0 + 1, ty1 - ty0 + 1
    by_tile, tile_starts = group_by_tile(cx, cy, tx0, ty0, nx_tiles, ny_tiles)
    tree_tile, tree_starts = group_by_tile(trees["x"].astype(float), trees["y"].astype(float), tx0, ty0, nx_tiles, ny_tiles)

    # named places, by tile
    places = {}
    for geom, tags in osm.places:
        name = tags.get("name")
        if not name:
            continue
        at = geom if geom.geom_type == "Point" else geom.representative_point()
        tx, ty = region.tile_index(at.x, at.y)
        places.setdefault((tx, ty), []).append([name, tags.get("kind_key"), tags.get("kind")])

    # ---- the overview package ----
    region.BAKED.mkdir(parents=True, exist_ok=True)
    lcv, urb = overview_rasters(props, areas, ground_data, cover, bounds, height)
    (region.BAKED / "overview.bin").write_bytes(container([
        (b"GRID", coarse_grid_section(grid, info)),
        (b"MASS", massing_section(props, 0.0, 0.0)),
        (b"LCV", lcv),
        (b"URB", urb),
        (b"RIBA", ribbon_section(overview_lines(osm, ground_data), height)),
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
            ground_parts = [mesh(ground_data, classes, x0, y0, height) for classes in (WATER_CLASSES, ROAD_CLASSES + (RAIL,), LAND_CLASSES)]
            deck = deck_mesh(ground_data, x0, y0, height)
            for sid, (vertices, indices) in zip((b"WATR", b"ROAD", b"LAND", b"DECK"), (*ground_parts, deck), strict=True):
                if len(indices):
                    sections.append((sid, mesh_section(vertices, indices)))
                    totals["ground_triangles"] += len(indices) // 3
            trees_here = trees[tree_tile[tree_starts[k]:tree_starts[k + 1]]]
            if len(trees_here):
                sections.append((b"TREE", tree_data.section(trees_here, x0, y0)))
            if (tx + tx0, ty + ty0) in places:
                sections.append((b"PLCE", json.dumps(places[(tx + tx0, ty + ty0)], ensure_ascii=False).encode("utf-8")))
            sections.append((b"META", json.dumps({"x0": x0, "y0": y0, "buildings": int(len(sl)), "trees": int(len(trees_here))}).encode("utf-8")))
            (out_dir / f"{tx}_{ty}.bin").write_bytes(container(sections))
            made += 1
        if limit is not None and made >= limit:
            break

    index = {
        "tileSize": region.TILE_M, "ix0": tx0, "iy0": ty0, "nx": nx_tiles, "ny": ny_tiles, "tilesBaked": made,
        "palette": list(palette), "origin": [region.ORIGIN_E, region.ORIGIN_N], "epsg": region.EPSG, "bounds": [west, south, east, north],
        "coarseTolerance": 1.5,
        "groundClasses": {str(cls): {"colour": GROUND_COLOURS[cls], "lift": LIFT[cls]} for cls in GROUND_COLOURS},
        "treeCell": tree_data.CELL_M,
        "treeSpecies": {str(s): {"name": n, "crown": list(tree_data.CROWN_RADIUS_M[s])} for s, n in tree_data.SPECIES_NAMES.items()},
        "treeKinds": {str(k): n for k, n in tree_data.KIND_NAMES.items()},
    }
    (region.BAKED / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    size = sum(f.stat().st_size for f in out_dir.glob("*.bin"))
    log(f"baked {made} tiles: {len(buildings)} buildings, {totals['vertices']} building vertices, {totals['ground_triangles']} ground triangles, "
        f"{len(trees)} trees, {size / 1048576:.0f} MB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    bake(limit)
