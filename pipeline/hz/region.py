"""The piece of the world the map covers, and the projection used everywhere in the pipeline and the app."""
from pathlib import Path

import numpy
import pyproj

# main urban Hangzhou, west/south/east/north, degrees
WEST, SOUTH, EAST, NORTH = 120.00, 30.12, 120.40, 30.44
MARGIN_M = 3000  # features may reach this far outside before they are dropped

# UTM zone 51N: metres, north up. The app's world is these metres minus ORIGIN.
EPSG = 32651
ORIGIN_E, ORIGIN_N = 200000.0, 3340000.0

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "data" / "raw"
WORK = ROOT / "data" / "work"
BAKED = ROOT / "data" / "baked"
CURATED = ROOT / "data" / "curated"

TILE_M = 1000  # baked tiles are squares of this many metres

_TO_WORLD = pyproj.Transformer.from_crs("EPSG:4326", f"EPSG:{EPSG}", always_xy=True)
_TO_LONLAT = pyproj.Transformer.from_crs(f"EPSG:{EPSG}", "EPSG:4326", always_xy=True)


def project(x, y):
    """lon/lat (numbers or arrays) -> world metres from ORIGIN, as numpy arrays (x east, y north)."""
    east, north = _TO_WORLD.transform(numpy.asarray(x, dtype=float), numpy.asarray(y, dtype=float))
    return numpy.asarray(east) - ORIGIN_E, numpy.asarray(north) - ORIGIN_N


def unproject(x, y):
    """world metres -> lon/lat."""
    return _TO_LONLAT.transform(numpy.asarray(x, dtype=float) + ORIGIN_E, numpy.asarray(y, dtype=float) + ORIGIN_N)


def region_bounds():
    """(west, south, east, north) of the region itself, in world metres."""
    xs, ys = project([WEST, EAST, EAST, WEST], [SOUTH, SOUTH, NORTH, NORTH])
    return float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())


def world_bounds():
    """(west, south, east, north) of the region plus its margin, in world metres."""
    west, south, east, north = region_bounds()
    return west - MARGIN_M, south - MARGIN_M, east + MARGIN_M, north + MARGIN_M


def tile_index(x, y):
    """world metres -> 1 km tile indices (ix, iy)."""
    return int(x // TILE_M), int(y // TILE_M)
