"""Bake the region into what the app loads.

data/baked/overview.bin: the whole region for the overview tier, small enough to load at start-up.
  GRID  heights on a 125 m grid over the region (int16 metres, north row first)
  MASS  one box per 50 m cell that holds a building: centre, base, height, look

data/baked/tiles/b/<x>_<y>.bin: one file per 1 km tile, loaded when it comes into view at the district tier.
  TERR  heights of a 32 x 32 grid over the tile (int16 metres, north row first)
  BLDB  buildings as coarse meshes (flat roofs, outlines simplified to 1.5 m)
  META  JSON

Every building belongs to the tile holding its centre and is drawn whole from there.

Usage: python -m hz.bake [layer ...]      layers: terrain mass buildings (default: all)
"""
import json
import pickle
import struct
import time

import numpy
import shapely
from shapely.geometry.polygon import orient

from . import region

MAGIC = b"HZT1"
COARSE_TOLERANCE_M = 1.5   # outlines are simplified to this at the district tier
MIN_PART_M2 = 3.0          # polygon pieces smaller than this are dropped
MIN_COURTYARD_M2 = 400.0   # courtyards smaller than this are roofed over at the district tier
PROP_FLOATS = 9            # base, height, levels, archetype, roof, wall, roofColour, seed, flags
MASS_CELL_M = 50.0
TERRAIN_CELLS = 32


def container(sections):
    """[(bytes id, bytes payload)] -> one file image: magic, a section table, then the payloads."""
    header = 8 + 12 * len(sections)
    table, body, offset = b"", b"", header
    for sid, payload in sections:
        table += struct.pack("<4sII", sid, offset, len(payload))
        body += payload
        offset += len(payload)
    return struct.pack("<4sHH", MAGIC, 1, len(sections)) + table + body


def tile_origin(ix, iy):
    return ix * region.TILE_M, iy * region.TILE_M


def terrain_section(x0, y0, grid, info):
    """Heights at the grid corners of the tile: the nearest DEM cell to each corner."""
    gx0, gy0, cell, tnx, tny = info
    count = TERRAIN_CELLS + 1
    step = region.TILE_M / TERRAIN_CELLS
    xs = x0 + numpy.arange(count) * step
    ys = y0 + numpy.arange(count) * step
    col = numpy.clip(numpy.rint((xs - gx0) / cell - 0.5).astype(int), 0, tnx - 1)
    row = numpy.clip(numpy.rint((gy0 + tny * cell - ys) / cell - 0.5).astype(int), 0, tny - 1)
    heights = grid[numpy.ix_(row[::-1], col)]  # north to south
    return struct.pack("<HHddd", count, count, x0, y0, step) + heights.astype("<i2").tobytes()


def massing_section(props, ox, oy):
    """One box per cell that holds a building: the tallest building's height, the most common look."""
    cx, cy = props[:, 9], props[:, 10]
    ix = numpy.floor((cx - ox) / MASS_CELL_M).astype(int)
    iy = numpy.floor((cy - oy) / MASS_CELL_M).astype(int)
    key = ix * 1000 + iy
    order = numpy.argsort(key, kind="stable")
    key = key[order]
    uniq, starts = numpy.unique(key, return_index=True)
    out = bytearray(struct.pack("<I", len(uniq)))
    for n, start in enumerate(starts):
        sl = order[start:starts[n + 1] if n + 1 < len(starts) else len(order)]
        rep = sl[numpy.argmax(props[sl, 1])]  # the tallest building in the cell gives the cell its height and its look
        cell_x, cell_y = (ix[sl[0]] + 0.5) * MASS_CELL_M, (iy[sl[0]] + 0.5) * MASS_CELL_M
        out += struct.pack("<4fBBBB", cell_x, cell_y, float(props[rep, 0]), float(props[rep, 1]), int(props[rep, 3]),
                           int(props[rep, 5]), int(props[rep, 6]), int(props[rep, 7] % 255))
    return bytes(out)


def coarse_mesh(polys, owner, base, top, ox, oy):
    """Walls and flat roofs for simplified polygons.

    -> (vertices float32[n, 6], indices uint32[m]); a vertex is x, y, z, nx, ny, building, with x and y
    relative to the tile. A wall quad carries the outward normal of its wall so the light can be taken
    from it for any camera angle; roof vertices carry (0, 0) for "up".
    """
    verts, index = [], []
    vertex_count = 0
    for n, poly in enumerate(polys):
        building = owner[n]  # several polygons may belong to one building
        ground, roof_z = base[building], top[building]
        for ring in (poly.exterior, *[r for r in poly.interiors if r.area >= MIN_COURTYARD_M2]):
            pts = numpy.asarray(ring.coords)[:-1]  # drop the closing point
            if len(pts) < 3:
                continue
            nxt = numpy.roll(pts, -1, axis=0)
            dx, dy = nxt[:, 0] - pts[:, 0], nxt[:, 1] - pts[:, 1]
            length = numpy.hypot(dx, dy)
            ok = length > 1e-6
            if not ok.any():
                continue
            ax, ay = pts[ok, 0] - ox, pts[ok, 1] - oy
            bx, by = nxt[ok, 0] - ox, nxt[ok, 1] - oy
            # counter-clockwise exteriors get their outward normal, clockwise holes the one facing into the courtyard
            nx, ny = dy[ok] / length[ok], -dx[ok] / length[ok]
            count = int(ok.sum())
            quad = numpy.empty((count, 4, 6), dtype=numpy.float32)
            quad[:, 0, :2], quad[:, 1, :2], quad[:, 2, :2], quad[:, 3, :2] = numpy.column_stack([ax, ay]), numpy.column_stack([bx, by]), numpy.column_stack([bx, by]), numpy.column_stack([ax, ay])
            quad[:, :, 2] = ground
            quad[:, 2:, 2] = roof_z
            quad[:, :, 3], quad[:, :, 4] = nx[:, None], ny[:, None]
            quad[:, :, 5] = building
            verts.append(quad.reshape(-1, 6))
            t = numpy.arange(count) * 4 + vertex_count
            index.append(numpy.column_stack([t, t + 1, t + 2, t, t + 2, t + 3]).reshape(-1))
            vertex_count += count * 4
        faces = shapely.constrained_delaunay_triangles(poly)
        if not faces.is_empty:
            # each triangle comes back as a closed ring of four points, the first three of which are its corners
            corners = numpy.asarray(shapely.get_coordinates(faces), dtype=numpy.float32).reshape(-1, 4, 2)[:, :3].reshape(-1, 2)
            cap = numpy.zeros((len(corners), 6), dtype=numpy.float32)
            cap[:, :2] = corners - [ox, oy]
            cap[:, 2] = roof_z
            cap[:, 5] = building
            verts.append(cap)
            index.append(numpy.arange(len(cap), dtype=numpy.uint32) + vertex_count)
            vertex_count += len(cap)
    if not verts:
        return numpy.zeros((0, 6), dtype=numpy.float32), numpy.zeros(0, dtype=numpy.uint32)
    return numpy.concatenate(verts), numpy.concatenate(index).astype(numpy.uint32)


def coarse_outlines(geoms):
    """The polygons the coarse meshes are built from, and which building each belongs to.

    -> (polygons, owner): outlines simplified to COARSE_TOLERANCE_M, pieces smaller than MIN_PART_M2
    dropped, exteriors counter-clockwise and holes clockwise so that one rule gives every wall its normal.
    """
    polys = shapely.get_parts(geoms)
    parts_per_building = numpy.array([len(g.geoms) if g.geom_type == "MultiPolygon" else 1 for g in geoms], dtype=int)
    owner = numpy.repeat(numpy.arange(len(geoms)), parts_per_building)
    keep = shapely.area(polys) >= MIN_PART_M2
    polys = numpy.asarray([orient(p) for p in shapely.simplify(polys[keep], COARSE_TOLERANCE_M)], dtype=object)
    owner = owner[keep]
    valid = shapely.area(polys) > 1.0
    return polys[valid], owner[valid]


def buildings_section(geoms, props, ox, oy):
    polys, owner = coarse_outlines(geoms)
    verts, index = coarse_mesh(polys, owner, props[:, 0], props[:, 0] + props[:, 1], ox, oy)
    head = struct.pack("<III", len(geoms), len(verts), len(index))
    return head + props[:, :PROP_FLOATS].astype("<f4").tobytes() + verts.tobytes() + index.tobytes()


def coarse_grid_section(grid, info, cell_m=125.0):
    """Heights of the whole region on a coarse grid: one mesh for the overview tier, loaded once."""
    gx0, gy0, cell, tnx, tny = info
    west, south, east, north = region.region_bounds()
    pad = region.MARGIN_M
    x0 = float(numpy.floor((west - pad) / cell_m) * cell_m)
    y0 = float(numpy.floor((south - pad) / cell_m) * cell_m)
    nx = int(numpy.ceil((east + pad - x0) / cell_m)) + 1
    ny = int(numpy.ceil((north + pad - y0) / cell_m)) + 1
    col = numpy.clip(numpy.rint((x0 + numpy.arange(nx) * cell_m - gx0) / cell - 0.5).astype(int), 0, tnx - 1)
    row = numpy.clip(numpy.rint((gy0 + tny * cell - (y0 + numpy.arange(ny) * cell_m)) / cell - 0.5).astype(int), 0, tny - 1)
    heights = grid[numpy.ix_(row[::-1], col)]  # north to south
    return struct.pack("<HHddd", nx, ny, x0, y0, cell_m) + heights.astype("<i2").tobytes()


def bake(only=None, log=print):
    """-> data/baked/overview.bin (coarse terrain, massing cells) and data/baked/tiles/b/<x>_<y>.bin per tile."""
    only = set(only or ("terrain", "mass", "buildings"))
    t0 = time.time()
    with open(region.WORK / "buildings.pkl", "rb") as f:
        buildings = pickle.load(f)
    from .classify import classify
    from .terrain import load as load_terrain
    grid, info = load_terrain(region.WORK / "terrain.bin")
    classify(buildings, grid, info, log=log)
    palette = json.loads((region.CURATED / "palette.json").read_text(encoding="utf-8"))["colours"]
    colour_index = {name: i for i, name in enumerate(palette)}

    geoms = numpy.asarray([b["geom"] for b in buildings], dtype=object)
    centres = shapely.centroid(geoms)
    cx, cy = shapely.get_x(centres), shapely.get_y(centres)
    # per building: the nine property floats, then the centre, for grouping
    props = numpy.array([[b["base"], b["height"], b["levels"], b["archetype"], b["roof"], colour_index[b["wall"]], colour_index[b["roof_colour"]], b["seed"], 0, x, y]
                         for b, x, y in zip(buildings, cx, cy, strict=True)], dtype=numpy.float64)

    west, south, east, north = region.region_bounds()
    tx0, tx1 = int(numpy.floor(west / region.TILE_M)), int(numpy.floor(east / region.TILE_M))
    ty0, ty1 = int(numpy.floor(south / region.TILE_M)), int(numpy.floor(north / region.TILE_M))
    nx_tiles, ny_tiles = tx1 - tx0 + 1, ty1 - ty0 + 1
    ix = numpy.clip(numpy.floor(cx / region.TILE_M).astype(int), tx0, tx1) - tx0
    iy = numpy.clip(numpy.floor(cy / region.TILE_M).astype(int), ty0, ty1) - ty0
    order = numpy.argsort(ix * ny_tiles + iy, kind="stable")
    bounds = numpy.searchsorted((ix * ny_tiles + iy)[order], numpy.arange(nx_tiles * ny_tiles + 1))

    region.BAKED.mkdir(parents=True, exist_ok=True)
    out_dir = region.BAKED / "tiles" / "b"
    out_dir.mkdir(parents=True, exist_ok=True)
    for f in out_dir.glob("*.bin"):
        f.unlink()

    overview = []
    if "terrain" in only:
        overview.append((b"GRID", coarse_grid_section(grid, info)))
    if "mass" in only:
        overview.append((b"MASS", massing_section(props, 0.0, 0.0)))
    (region.BAKED / "overview.bin").write_bytes(container(overview))

    total_vertices, files = 0, 0
    for tx in range(nx_tiles):
        for ty in range(ny_tiles):
            k = tx * ny_tiles + ty
            sl = order[bounds[k]:bounds[k + 1]]
            ox, oy = tile_origin(tx + tx0, ty + ty0)
            sections = []
            if "terrain" in only:
                sections.append((b"TERR", terrain_section(ox, oy, grid, info)))
            if "buildings" in only and len(sl):
                section = buildings_section(geoms[sl], props[sl], ox, oy)
                total_vertices += struct.unpack_from("<I", section, 4)[0]
                sections.append((b"BLDB", section))
            sections.append((b"META", json.dumps({"x0": ox, "y0": oy, "buildings": int(len(sl))}).encode("utf-8")))
            (out_dir / f"{tx}_{ty}.bin").write_bytes(container(sections))
            files += 1
    index = {"tileSize": region.TILE_M, "ix0": tx0, "iy0": ty0, "nx": nx_tiles, "ny": ny_tiles, "palette": list(palette),
             "origin": [region.ORIGIN_E, region.ORIGIN_N], "epsg": region.EPSG, "bounds": [west, south, east, north], "coarseTolerance": COARSE_TOLERANCE_M}
    (region.BAKED / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    size = sum(f.stat().st_size for f in out_dir.glob("*.bin"))
    log(f"baked overview.bin ({(region.BAKED / 'overview.bin').stat().st_size / 1048576:.1f} MB) and {files} tiles: "
        f"{len(buildings)} buildings, {total_vertices} mesh vertices, {size / 1048576:.0f} MB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    import sys

    bake(sys.argv[1:] or None)
