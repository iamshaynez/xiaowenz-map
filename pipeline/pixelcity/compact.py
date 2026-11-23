"""The small forms in which the baked files carry things: numbers in the smallest integer that holds them.

A tile used to hold every number as a 4-byte float and every triangle with corners of its own, which came
to 1,123 MB for the main urban area. What a file carries now, and what it leaves to the page:

  positions      16-bit integers in 24ths of a metre (4 cm: a pixel on the page is 0.4 to 8 m)
  heights        16-bit integers in 40ths of a metre (2.5 cm)
  wall normals   two 16-bit integers in 16384ths; a wall's normal is a unit vector, so one of them is
                 exactly +-1 and the roof/wall test on the page comes out as before
  the height of water, roads and land    the ground's own under that point, plus the lift of the class:
                 the page reads it off the tile's height grid (the same lattice, read the same way)
  a tree's height    the ground's: read off the same grid
  ground seeds   0 for water, roads and land; a deck's walls are a class that does not read the seed
  the corners of a ground triangle    shared with the triangles beside it
  a ribbon's height and side   read off the overview's grid; the side from the vertex's place in its quad

Everything is little-endian. The units are powers of two where they could be, so that the page's decoding
(an integer divided by the unit, into a float) is exact.
"""
import math
import struct

import numpy

XY_PER_M = 24                # positions relative to a tile's corner, in 24ths of a metre (4.2 cm): +-1365 m. Ground is
                             # drawn 60 m beyond a tile, and a building may reach much further past its tile's edge
Z_PER_M = 40                 # heights of buildings, rooftop boxes and massing cells: 2.5 cm, +-819 m
DECK_Z_PER_M = 8             # a deck's height: 12.5 cm, plenty for a surface six metres above what it crosses
NORMAL_UNIT = 16384          # the level part of a wall's or a roof slope's normal
BASE_PER_M = 40              # the base of a building: 2.5 cm
HEIGHT_PER_M = 100           # a building's height: a centimetre
ROOF_UNIT = 10               # the sizes of a rooftop box: a decimetre
MASS_BASE_PER_M = 40         # the overview's boxes
MASS_HEIGHT_PER_M = 100
RIBBON_HALF_PER_M = 4        # a ribbon's half width: a quarter-metre
RIBBON_UNIT = 1               # a ribbon's points: metres from the world origin, in 32-bit integers (a railway or a canal
                              # that the overview draws reaches tens of kilometres past the region)
TERRAIN_RINGS = 2            # the height grid of a tile reaches this many rings (62.5 m) beyond the tile: ground
                             # is drawn 60 m beyond it, and the page reads the height of those corners off the grid


class OutOfRange(ValueError):
    """A number that its integer cannot carry: a bake error, not something to clip away quietly."""


def _fixed(values, unit, low, high, what):
    """values (metres, or the unit itself when `unit` is 1) -> the nearest count of units, as float64."""
    raw = numpy.atleast_1d(numpy.rint(numpy.asarray(values, dtype=numpy.float64) * unit))
    bad = (raw < low) | (raw > high) | ~numpy.isfinite(raw)
    if bad.any():
        first = numpy.asarray(values)[bad][0]
        raise OutOfRange(f"{what}: {int(bad.sum())} values cannot be held, the first being {first}")
    return raw


def i16(values, unit, what):
    return _fixed(values, unit, -32768, 32767, what).astype("<i2")


def i32(values, unit, what):
    return _fixed(values, unit, -2147483648, 2147483647, what).astype("<i4")


def u16(values, unit, what):
    return _fixed(values, unit, 0, 65535, what).astype("<u2")


def u8(values, unit, what):
    return _fixed(values, unit, 0, 255, what).astype("u1")


def _bytes_of(column):
    """A column of little-endian integers -> its bytes, one row per integer."""
    return column.view("u1").reshape(-1, column.itemsize)


def building_properties(props):
    """The nine properties of each building in 11 bytes: base (i16, 2.5 cm), height (u16, a centimetre), then
    levels, archetype, roof, wall colour, roof colour, seed and flags, a byte each.

    The base and the height are rounded to single precision first: the mesh is built in single precision, so a
    wall's foot is the single-precision base, and the two must come out as one number or a wall would stand
    a unit above or below the base its building says."""
    props = numpy.asarray(props, dtype=numpy.float64)
    base, height = props[:, 0].astype(numpy.float32), props[:, 1].astype(numpy.float32)
    out = numpy.empty((len(props), 11), dtype="u1")
    out[:, 0:2] = _bytes_of(i16(base, BASE_PER_M, "the base of a building"))
    out[:, 2:4] = _bytes_of(u16(height, HEIGHT_PER_M, "the height of a building"))
    for k, column in enumerate(range(2, 9)):
        out[:, 4 + k] = u8(props[:, column], 1, f"property {column} of a building")
    return out.tobytes()


def building_vertices(vertices):
    """A vertex in 12 bytes: x, y (i16, 4 cm), z (i16, 2.5 cm), the level part of its normal (two i16 in
    16384ths), the building it belongs to (u16). `vertices`: rows of x, y, z, nx, ny, building as floats."""
    out = numpy.empty((len(vertices), 12), dtype="u1")
    columns = [i16(vertices[:, 0], XY_PER_M, "a building corner's x"), i16(vertices[:, 1], XY_PER_M, "a building corner's y"),
               i16(vertices[:, 2], Z_PER_M, "a building corner's height"), i16(vertices[:, 3], NORMAL_UNIT, "a wall normal's x"),
               i16(vertices[:, 4], NORMAL_UNIT, "a wall normal's y"), u16(vertices[:, 5], 1, "a vertex's building")]
    for k, column in enumerate(columns):
        out[:, 2 * k:2 * k + 2] = _bytes_of(column)
    return out.tobytes()


def indices(indices, count):
    """Triangle indices over `count` corners: two bytes each where that holds every corner (fewer than
    65,536), else four. -> (bytes, bytes per index)"""
    if count < 65536:
        return indices.astype("<u2").tobytes(), 2
    return indices.astype("<u4").tobytes(), 4


def ground_corners(vertices, height_stored):
    """Water, roads, land and decks: the mesh with every triangle's corners of its own (rows of x, y, z,
    class, seed) -> its corners once each, in order of first use.

    -> (records bytes, indices, corner count). A corner is x, y (i16, 4 cm) and its class (u8); a deck's
    keeps its height too (i16, 12.5 cm), because a deck is not at the ground's own height. The height of the
    others is a function of their position and class, so it does not tell corners apart; nor does the seed.
    A deck's record is eight bytes for seven: the spare one is written as nought. The page never reads it, but
    a file is named by its bytes when it is published, so the same bake must be the same bytes every time.
    """
    key = vertices[:, [0, 1, 2, 3]] if height_stored else vertices[:, [0, 1, 3]]
    _, first, inverse = numpy.unique(key, axis=0, return_index=True, return_inverse=True)
    inverse = inverse.reshape(-1)
    order = numpy.argsort(first, kind="stable")
    rank = numpy.empty(len(order), dtype=numpy.int64)
    rank[order] = numpy.arange(len(order))
    ids = rank[inverse]                          # the corner of each of the mesh's vertices
    corners = vertices[first[order]]
    width = 8 if height_stored else 5
    out = numpy.zeros((len(corners), width), dtype="u1")
    out[:, 0:2] = _bytes_of(i16(corners[:, 0], XY_PER_M, "a ground corner's x"))
    out[:, 2:4] = _bytes_of(i16(corners[:, 1], XY_PER_M, "a ground corner's y"))
    if height_stored:
        out[:, 4:6] = _bytes_of(i16(corners[:, 2], DECK_Z_PER_M, "a deck corner's height"))
    out[:, width - 1] = u8(corners[:, 3], 1, "a ground corner's class")
    return out.tobytes(), ids, len(corners)


def tree_records(records):
    """A tree in 7 bytes: x, y (i16, 4 cm), its species (3 bits) and kind (3 bits), the radius of its crown in
    half-metres, and its seed. `records`: the structured array of trees.py, x and y already tile-relative."""
    out = numpy.empty((len(records), 7), dtype="u1")
    out[:, 0:2] = _bytes_of(i16(records["x"], XY_PER_M, "a tree's x"))
    out[:, 2:4] = _bytes_of(i16(records["y"], XY_PER_M, "a tree's y"))
    out[:, 4] = u8(records["species"], 1, "a tree's species") + 8 * u8(records["kind"], 1, "a tree's kind")
    out[:, 5] = u8(records["size"], 1, "a tree's crown radius")
    out[:, 6] = u8(records["seed"], 1, "a tree's seed")
    return out.tobytes()


def roof_boxes(records):
    """A rooftop box in 11 bytes: x, y (i16, 4 cm), base (i16, 2.5 cm), height, half width and half depth (u8,
    decimetres), wall colour and roof colour (u8). `records`: rows of those eight as floats."""
    out = numpy.empty((len(records), 11), dtype="u1")
    out[:, 0:2] = _bytes_of(i16(records[:, 0], XY_PER_M, "a rooftop box's x"))
    out[:, 2:4] = _bytes_of(i16(records[:, 1], XY_PER_M, "a rooftop box's y"))
    out[:, 4:6] = _bytes_of(i16(records[:, 2], Z_PER_M, "a rooftop box's base"))
    for k, (column, what) in enumerate([(3, "height"), (4, "half width"), (5, "half depth")]):
        out[:, 6 + k] = u8(records[:, column], ROOF_UNIT, f"a rooftop box's {what}")
    out[:, 9] = u8(records[:, 6], 1, "a rooftop box's wall colour")
    out[:, 10] = u8(records[:, 7], 1, "a rooftop box's roof colour")
    return out.tobytes()


def massing_cells(columns, rows, props):
    """A massing cell in 12 bytes: the cell's column and row (i16: the region lies on both sides of the world
    origin), the tallest building's base (i16, 2.5 cm) and
    height (u16, a centimetre), its archetype, wall colour, roof colour and seed (u8). `props`: that
    building's properties, a row each."""
    out = numpy.empty((len(columns), 12), dtype="u1")
    out[:, 0:2] = _bytes_of(i16(columns, 1, "a massing cell's column"))
    out[:, 2:4] = _bytes_of(i16(rows, 1, "a massing cell's row"))
    out[:, 4:6] = _bytes_of(i16(props[:, 0], MASS_BASE_PER_M, "a massing cell's base"))
    out[:, 6:8] = _bytes_of(u16(props[:, 1], MASS_HEIGHT_PER_M, "a massing cell's height"))
    out[:, 8], out[:, 9], out[:, 10] = u8(props[:, 3], 1, "archetype"), u8(props[:, 5], 1, "wall colour"), u8(props[:, 6], 1, "roof colour")
    out[:, 11] = u8(props[:, 7] % 255, 1, "seed")
    return out


def ribbon_turns(dx, dy):
    """The direction of ribbon segments (unit vectors) -> u16: the turn from the map's x axis, in 65536ths of a
    circle from -pi to pi."""
    turn = (numpy.arctan2(dy, dx) + math.pi) / (2 * math.pi)
    return numpy.clip(numpy.rint(turn * 65536), 0, 65535).astype("<u2")     # a full turn is the no-turn


# ---- reading it back -------------------------------------------------------------------------------------------
# What the page does with these forms (app/src/world/data.js), written again here for the tests: the
# page's reading of a section must give back what went into it, to within half a unit.

def _rows(payload, width):
    return numpy.frombuffer(payload, dtype="u1").reshape(-1, width)


def _column(rows, at, dtype):
    return rows[:, at:at + numpy.dtype(dtype).itemsize].copy().view(dtype).reshape(-1).astype(numpy.float64)


def read_buildings(payload):
    """A BLDB section -> (properties float64[n, 9], corners float64[m, 6] of x, y, z, nx, ny, building, indices int64)."""
    buildings, corners, count, width = struct.unpack_from("<IIIB", payload, 0)
    at = 13
    rows = _rows(payload[at:at + buildings * 11], 11)
    props = numpy.empty((buildings, 9))
    props[:, 0], props[:, 1] = _column(rows, 0, "<i2") / BASE_PER_M, _column(rows, 2, "<u2") / HEIGHT_PER_M
    props[:, 2:] = rows[:, 4:11]
    at += buildings * 11
    rows = _rows(payload[at:at + corners * 12], 12)
    vertices = numpy.column_stack([_column(rows, 0, "<i2") / XY_PER_M, _column(rows, 2, "<i2") / XY_PER_M, _column(rows, 4, "<i2") / Z_PER_M,
                                   _column(rows, 6, "<i2") / NORMAL_UNIT, _column(rows, 8, "<i2") / NORMAL_UNIT, _column(rows, 10, "<u2")])
    at += corners * 12
    return props, vertices, numpy.frombuffer(payload[at:at + count * width], dtype="<u2" if width == 2 else "<u4").astype(numpy.int64)


def read_ground(payload, height_stored):
    """WATR, ROAD, LAND, DECK -> (corners float64[n, 4] of x, y, z (0 unless stored), class; indices int64)."""
    corners, count, width = struct.unpack_from("<IIB", payload, 0)
    size = 8 if height_stored else 5
    rows = _rows(payload[9:9 + corners * size], size)
    out = numpy.zeros((corners, 4))
    out[:, 0], out[:, 1] = _column(rows, 0, "<i2") / XY_PER_M, _column(rows, 2, "<i2") / XY_PER_M
    out[:, 3] = rows[:, size - 1]
    if height_stored:
        out[:, 2] = _column(rows, 4, "<i2") / DECK_Z_PER_M
    at = 9 + corners * size
    return out, numpy.frombuffer(payload[at:at + count * width], dtype="<u2" if width == 2 else "<u4").astype(numpy.int64)


def read_trees(payload):
    """The trees of a TREE section -> the structured array of trees.py without the heights (x, y tile-relative)."""
    cells, count = struct.unpack_from("<II", payload, 0)
    at = 8 + (cells * cells + 1) * 4
    rows = _rows(payload[at:at + count * 7], 7)
    out = numpy.zeros(count, dtype=[("x", "<f4"), ("y", "<f4"), ("species", "u1"), ("size", "u1"), ("seed", "u1"), ("kind", "u1")])
    out["x"], out["y"] = _column(rows, 0, "<i2") / XY_PER_M, _column(rows, 2, "<i2") / XY_PER_M
    out["species"], out["kind"] = rows[:, 4] % 8, rows[:, 4] // 8
    out["size"], out["seed"] = rows[:, 5], rows[:, 6]
    return out


def read_roof_boxes(payload):
    """A ROOF section -> float64[n, 8]: x, y, base, height, half width, half depth, wall colour, roof colour."""
    rows = _rows(payload[4:], 11)
    return numpy.column_stack([_column(rows, 0, "<i2") / XY_PER_M, _column(rows, 2, "<i2") / XY_PER_M, _column(rows, 4, "<i2") / Z_PER_M,
                               _column(rows, 6, "u1") / ROOF_UNIT, _column(rows, 7, "u1") / ROOF_UNIT, _column(rows, 8, "u1") / ROOF_UNIT, rows[:, 9], rows[:, 10]])


def read_massing(payload):
    """A MASS section -> float64[n, 8]: centre x, y; base; height; archetype, wall colour, roof colour, seed."""
    rows = _rows(payload[4:], 12)
    return numpy.column_stack([(_column(rows, 0, "<i2") + 0.5) * 50.0, (_column(rows, 2, "<i2") + 0.5) * 50.0,
                               _column(rows, 4, "<i2") / MASS_BASE_PER_M, _column(rows, 6, "<u2") / MASS_HEIGHT_PER_M, rows[:, 8:12]])


def read_ribbons(payload):
    """A RIBA section -> [(class, half width, points float64[n, 2] in world metres, directions float64[n - 1, 2])], a part each."""
    cells = struct.unpack_from("<I", payload, 0)[0]
    at, out = 4, []
    for _ in range(cells):
        count, cls, half = struct.unpack_from("<HBB", payload, at)
        at += 4
        points = numpy.frombuffer(payload[at:at + count * 8], dtype="<i4").reshape(-1, 2).astype(numpy.float64) / RIBBON_UNIT
        at += count * 8
        turn = numpy.frombuffer(payload[at:at + (count - 1) * 2], dtype="<u2").astype(numpy.float64)
        at += (count - 1) * 2
        angle = turn / 65536 * 2 * math.pi - math.pi
        out.append((cls, half / RIBBON_HALF_PER_M, points, numpy.column_stack([numpy.cos(angle), numpy.sin(angle)])))
    if at != len(payload):
        raise ValueError("truncated ribbons")
    return out
