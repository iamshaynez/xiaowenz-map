"""The building meshes of a tile, and the small binary forms that the baked files are made of.

scene.py is the entry point that bakes everything. This module holds the pieces that turn outlines into
meshes (coarse_mesh, buildings_section), the height grids (terrain_section, coarse_grid_section), the
massing cells (massing_section) and the container every baked file is written in (container).
"""
import struct

import numpy
import shapely
from shapely.geometry.polygon import orient

from . import region

MAGIC = b"HZT1"                  # the first four bytes of every baked file
COARSE_TOLERANCE_M = 1.5   # outlines are simplified to this at the district tier
MIN_PART_M2 = 3.0          # polygon pieces smaller than this are dropped
MIN_COURTYARD_M2 = 400.0   # courtyards smaller than this are roofed over at the district tier
PROP_FLOATS = 9            # base, height, levels, archetype, roof, wall, roofColour, seed, flags
FLAG_ROOFTOP = 1           # flags: not a building but something standing on a roof, put there by rule
FLAG_CLEARED = 32          # flags: not drawn, because a landmark put together by hand stands in its place
ROOF_FLAT, ROOF_GABLE, ROOF_HIP, ROOF_SAW, ROOF_GREAT = 0, 1, 2, 3, 4   # as classify.py; a pitched roof is drawn over outlines that fill a rectangle
RECTANGLE_FILL = 0.80      # ... at least this much of the smallest rectangle that holds them
ROOF_SLOPE = 0.58          # rise per metre of run, about thirty degrees: the dark tiles of Jiangnan
ROOF_RISE_MAX_M = 4.5
GREAT_ROOF_RISE_MAX_M = 9.0   # a temple hall's roof climbs higher than a house's
GREAT_RECTANGLE_FILL = 0.65   # ... and a hall with wings fills less of its rectangle than a house does
EAVE_M = 0.45              # the eaves overhang the walls by this much
ROOFTOP_INSET_M = 1.8      # nothing stands closer than this to the edge of a flat roof
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


def surface(grid, info, step, extent=None):
    """-> f(x, y): the terrain as the app draws it, for arrays of world metres.

    A mesh is a grid of corners `step` metres apart, each the nearest cell of the DEM (as terrain_section
    and coarse_grid_section write them), each cell two triangles (as the app's gridMesh draws them).
    Whatever is laid on the ground (water, roads, the feet of bridges and trees, the base of a building)
    is read off this surface, not off the DEM: read bilinearly off the DEM it can lie a metre or more
    under the mesh, and a canal sank out of sight between its banks.

    extent: (west edge, south edge, cells a side) of one mesh over the whole region, the overview's;
    None for the tiles, each point read from the kilometre it lies in.
    """
    gx0, gy0, cell, tnx, tny = info
    top = gy0 + tny * cell

    def height(x, y):
        x, y = numpy.asarray(x, dtype=numpy.float64), numpy.asarray(y, dtype=numpy.float64)
        if extent is None:
            ox, oy = numpy.floor(x / region.TILE_M) * region.TILE_M, numpy.floor(y / region.TILE_M) * region.TILE_M
            cells = TERRAIN_CELLS
        else:
            ox, oy, cells = extent[0], extent[1], extent[2] - 1
        fx, fy = (x - ox) / step, (y - oy) / step
        i = numpy.clip(numpy.floor(fx).astype(int), 0, cells - 1)
        j = numpy.clip(numpy.floor(fy).astype(int), 0, cells - 1)
        u, v = fx - i, fy - j

        def corner(a, b):                 # the corner (a, b) of the cell's grid: the nearest cell of the DEM
            col = numpy.clip(numpy.rint((ox + a * step - gx0) / cell - 0.5), 0, tnx - 1).astype(int)
            row = numpy.clip(numpy.rint((top - (oy + b * step)) / cell - 0.5), 0, tny - 1).astype(int)
            return grid[row, col].astype(numpy.float64)

        sw, se, nw, ne = corner(i, j), corner(i + 1, j), corner(i, j + 1), corner(i + 1, j + 1)
        low = sw + (se - sw) * u + (nw - sw) * v                   # the triangle south-west, north-west, south-east
        high = ne + (nw - ne) * (1 - u) + (se - ne) * (1 - v)      # the other: south-east, north-west, north-east
        return numpy.where(u + v <= 1, low, high)

    return height


def coarse_grid_extent(cell_m=125.0):
    """(west edge, south edge, cells a side) of the overview's coarse mesh, as coarse_grid_section lays it out."""
    west, south, east, north = region.region_bounds()
    pad = region.MARGIN_M
    x0 = float(numpy.floor((west - pad) / cell_m) * cell_m)
    y0 = float(numpy.floor((south - pad) / cell_m) * cell_m)
    return x0, y0, int(numpy.ceil((east + pad - x0) / cell_m)) + 1, int(numpy.ceil((north + pad - y0) / cell_m)) + 1


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


def pitched_roof(corners, eave, hip, building, ox, oy, rise_max=ROOF_RISE_MAX_M):
    """A roof of two slopes over a rectangle, meeting in a ridge along its long axis: a hip roof, whose ends
    slope too, or a gable roof, whose ends are upright triangles of wall. The eaves overhang the walls.

    corners: the rectangle's four corners in order. -> (vertices float32[n, 6], indices uint32[m]), the
    indices counting from 0. A vertex carries the level part of its normal: (0, 0) is a flat face, a wall's
    normal is a unit vector, and a slope's is as long as the slope is steep.
    """
    c = numpy.asarray(corners, dtype=float)[:4, :2]
    if numpy.linalg.norm(c[2] - c[1]) > numpy.linalg.norm(c[1] - c[0]):
        c = numpy.roll(c, -1, axis=0)                 # c0 -> c1 is a long side
    centre = c.mean(axis=0)
    along = c[1] - c[0]
    u = along / numpy.linalg.norm(along)
    w = (c[3] - c[0]) / numpy.linalg.norm(c[3] - c[0])   # from the long side c0-c1 towards the other
    a = numpy.linalg.norm(along) / 2 + EAVE_M
    b = numpy.linalg.norm(c[2] - c[1]) / 2 + EAVE_M
    rise = min(b * ROOF_SLOPE, rise_max)
    ridge = a - b if hip else a                       # half the length of the ridge: a gable's reaches the ends
    low, high = eave, eave + rise
    ux, uy, wx, wy, cx, cy = u[0], u[1], w[0], w[1], centre[0], centre[1]

    def point(along, across, z):
        return cx + ux * along + wx * across, cy + uy * along + wy * across, z

    p0, p1 = point(-a, -b, low), point(a, -b, low)      # the two long sides of the eave
    p2, p3 = point(a, b, low), point(-a, b, low)
    r1, r2 = point(-ridge, 0.0, high), point(ridge, 0.0, high)   # the ends of the ridge
    slope = numpy.hypot(b, rise)
    faces = [([p0, p1, r2], (-wx * rise / slope, -wy * rise / slope)), ([p0, r2, r1], (-wx * rise / slope, -wy * rise / slope)),
             ([p3, r1, r2], (wx * rise / slope, wy * rise / slope)), ([p3, r2, p2], (wx * rise / slope, wy * rise / slope))]
    if hip:
        end = numpy.hypot(b, rise)
        faces += [([p1, p2, r2], (ux * rise / end, uy * rise / end)), ([p3, p0, r1], (-ux * rise / end, -uy * rise / end))]
    else:
        faces += [([p1, p2, r2], (ux, uy)), ([p3, p0, r1], (-ux, -uy))]
    verts = numpy.array([[x - ox, y - oy, z, nx, ny, building] for points, (nx, ny) in faces for x, y, z in points], dtype=numpy.float32)
    return verts, numpy.arange(len(verts), dtype=numpy.uint32)


def rectangle_of(poly, fill=RECTANGLE_FILL):
    """The smallest rectangle turned to hold an outline, if the outline fills it: -> its corners, or None."""
    with numpy.errstate(all="ignore"):                 # outlines with a repeated point make GEOS divide by zero
        box = shapely.minimum_rotated_rectangle(poly)
    corners = numpy.asarray(box.exterior.coords)[:4] if box.geom_type == "Polygon" and len(box.exterior.coords) == 5 else None
    if corners is None or not numpy.isfinite(corners).all() or poly.area < fill * box.area:
        return None
    return corners


def coarse_mesh(polys, owner, base, top, ox, oy, roofs=None):
    """Walls and roofs for simplified polygons: flat, or pitched where the building is given a gable or a hip
    roof and its outline fills a rectangle (roofs: the roof type of each building, as classify.py numbers them).

    -> (vertices float32[n, 6], indices uint32[m]); a vertex is x, y, z, nx, ny, building, with x and y
    relative to the tile. A wall quad carries the outward normal of its wall so the light can be taken
    from it for any camera angle; flat roof vertices carry (0, 0) for "up" and a slope's normal its tilt.
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
        pitched = None
        shape = roofs[building] if roofs is not None else None
        if shape in (ROOF_GABLE, ROOF_HIP, ROOF_GREAT) and not any(r.area >= MIN_COURTYARD_M2 for r in poly.interiors):
            corners = rectangle_of(poly, GREAT_RECTANGLE_FILL if shape == ROOF_GREAT else RECTANGLE_FILL)
            if corners is not None:
                pitched = pitched_roof(corners, roof_z, shape != ROOF_GABLE, building, ox, oy, GREAT_ROOF_RISE_MAX_M if shape == ROOF_GREAT else ROOF_RISE_MAX_M)
                verts.append(pitched[0])
                index.append(pitched[1] + vertex_count)
                vertex_count += len(pitched[0])
        faces = shapely.constrained_delaunay_triangles(poly) if pitched is None else shapely.Polygon()
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
    verts, index = coarse_mesh(polys, owner, props[:, 0], props[:, 0] + props[:, 1], ox, oy, roofs=props[:, 4])
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


# What stands on the flat roofs of Hangzhou, by archetype: (name, width, depth, height, wall, roof, the most
# of them). Inferred, not mapped: put there by rule, and flagged so that the app can show it is.
ROOFTOP_KINDS = {
    "stair": ("stair head", 2.6, 3.4, 2.7, None, "roof_flat_grey"),      # wall: the building's own
    "tank": ("water tank", 1.4, 1.4, 1.6, "tile_red", "roof_flat_dark"),
    "solar": ("solar heater", 1.9, 1.2, 0.5, "metal_pale", "roof_silver"),
    "unit": ("air-conditioning unit", 0.9, 0.9, 0.8, "metal_pale", "metal_dark"),
    "plant": ("plant room", 4.0, 6.0, 3.6, "concrete_grey", "roof_flat_grey"),
    "vent": ("vent or skylight", 1.5, 1.5, 0.6, "metal_pale", "metal_dark"),
}
ROOFTOP_RULES = {   # archetype -> [(kind, chance of having any, the most of them)]
    2: [("stair", 1.0, 1), ("tank", 0.8, 1), ("solar", 0.7, 2), ("unit", 0.5, 1)],      # old walk-ups
    3: [("tank", 0.9, 1), ("solar", 0.6, 1), ("unit", 0.4, 1)],                         # village houses
    4: [("plant", 1.0, 1), ("unit", 0.9, 2)],                                           # towers
    5: [("plant", 1.0, 1), ("unit", 0.8, 2)],                                           # offices
    6: [("vent", 0.7, 3)],                                                              # factories
    7: [("plant", 0.8, 1), ("unit", 0.6, 2)],                                           # public buildings
}


def rooftop_props(geoms, props, colour_index, seed=20261123):
    """Boxes on the flat roofs of buildings: stair heads, tanks, solar heaters and the rest.

    -> (outlines, property rows) in the form of the buildings they stand on, each flagged FLAG_ROOFTOP.
    """
    rng = numpy.random.default_rng(seed)
    geoms = numpy.asarray(geoms, dtype=object)
    flags = props[:, 8].astype(numpy.int64)              # they are bits, held in floats
    flat = (props[:, 4] == ROOF_FLAT) & ((flags & (FLAG_ROOFTOP | FLAG_CLEARED)) == 0) & numpy.isin(props[:, 3].astype(int), list(ROOFTOP_RULES))
    out_geoms, out_rows = [], []
    for n in numpy.flatnonzero(flat):
        room = geoms[n].buffer(-ROOFTOP_INSET_M)
        if room.is_empty:
            continue
        west, south, east, north = room.bounds
        gx = numpy.arange(west, east, 2.6) + rng.uniform(0, 2.6)
        gy = numpy.arange(south, north, 2.6) + rng.uniform(0, 2.6)
        xs, ys = numpy.meshgrid(gx, gy)
        inside = shapely.contains_xy(room, xs.ravel(), ys.ravel())
        spots = numpy.column_stack([xs.ravel()[inside], ys.ravel()[inside]])
        if not len(spots):
            continue
        spots = spots[rng.permutation(len(spots))]
        archetype, top, wall = int(props[n, 3]), float(props[n, 0] + props[n, 1]), int(props[n, 5])
        mine = []                                    # what has been put on this roof so far
        for kind, chance, most in ROOFTOP_RULES[archetype]:
            if rng.random() > chance:
                continue
            _, width, depth, height, kind_wall, kind_roof = ROOFTOP_KINDS[kind]
            placed = 0
            for x, y in spots:
                if placed >= most:
                    break
                box = shapely.box(x - width / 2, y - depth / 2, x + width / 2, y + depth / 2)
                if not room.contains(box) or any(box.distance(other) < 0.4 for other in mine):
                    continue
                mine.append(box)
                out_geoms.append(box)
                out_rows.append([top, height, 1, archetype, ROOF_FLAT, wall if kind_wall is None else colour_index[kind_wall],
                                 colour_index[kind_roof], int(rng.integers(0, 255)), FLAG_ROOFTOP, x, y])
                placed += 1
    if not out_rows:
        return numpy.zeros(0, dtype=object), numpy.zeros((0, props.shape[1]))
    return numpy.asarray(out_geoms, dtype=object), numpy.array(out_rows, dtype=numpy.float64)


def roof_boxes_section(geoms, props, ox, oy):
    """The boxes put on flat roofs, as instances: u32 count, then 8 floats each: x, y relative to the tile's
    corner, base, height, half width, half depth, wall colour, roof colour."""
    if not len(geoms):
        return struct.pack("<I", 0)
    west, south, east, north = shapely.bounds(geoms).T
    records = numpy.column_stack([(west + east) / 2 - ox, (south + north) / 2 - oy, props[:, 0], props[:, 1], (east - west) / 2, (north - south) / 2,
                                  props[:, 5], props[:, 6]]).astype("<f4")
    return struct.pack("<I", len(records)) + records.tobytes()
