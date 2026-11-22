"""Terrain: the Copernicus GLO-30 DEM -> one regular grid in world metres.

The GeoTIFF is a 1 x 1 degree tiled cloud-optimised file in lat/lon. Only the window that covers the
region is read, and it is resampled onto the same square grid that the baked tiles use, so every tile
is a sub-rectangle of one array.

Usage: python -m hz.terrain
"""
import struct

import numpy
import tifffile

from . import region

SOURCE = region.RAW / "copernicus_N30_E120.tif"
CELL_M = 30.0       # the source's ground sample distance; finer would only interpolate
NODATA = -32768     # stored value for "no elevation"
MAGIC = b"HZTE"
HEADER = "<4s3d2q"  # magic, west edge, south edge, cell size, cells across, cells up

_grid = None


def grid_bounds():
    """(x0, y0, nx, ny, cell): west and south edge in world metres, cell counts, cell size in metres."""
    west, south, east, north = region.region_bounds()
    pad = region.MARGIN_M
    x0 = float(numpy.floor((west - pad) / CELL_M) * CELL_M)
    y0 = float(numpy.floor((south - pad) / CELL_M) * CELL_M)
    nx = int(numpy.ceil((east + pad - x0) / CELL_M)) + 1
    ny = int(numpy.ceil((north + pad - y0) / CELL_M)) + 1
    return x0, y0, nx, ny, CELL_M


def _fill(grid):
    """Replace missing cells with the mean of their valid neighbours, repeating until none are left."""
    missing = numpy.isnan(grid)
    while missing.any():
        padded = numpy.pad(numpy.where(missing, 0, grid), 1)
        known = numpy.pad((~missing).astype(float), 1)
        total = numpy.zeros_like(grid)
        count = numpy.zeros_like(grid)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            sl = (slice(dy, dy + grid.shape[0]), slice(dx, dx + grid.shape[1]))
            total += padded[sl]
            count += known[sl]
        fillable = missing & (count > 0)
        grid[fillable] = total[fillable] / count[fillable]
        missing &= ~fillable
    return grid


def build(path=None, log=print):
    """Read the DEM window and resample it; returns int16 metres, rows from north to south."""
    path = str(path or SOURCE)
    x0, y0, nx, ny, cell = grid_bounds()
    # the centre of every grid cell, in lon/lat. The transform is done for each cell rather than per axis:
    # grid north is about 1.4 degrees off true north here, so longitude drifts by almost a kilometre across the region
    cx = x0 + (numpy.arange(nx) + 0.5) * cell
    cy = y0 + (numpy.arange(ny) + 0.5) * cell
    lon, lat = region.unproject(numpy.tile(cx, ny), numpy.repeat(cy, nx))
    lon, lat = lon.reshape(ny, nx), lat.reshape(ny, nx)  # rows from south to north

    with tifffile.TiffFile(path) as tif:
        page = tif.pages[0]
        sx, sy = page.tags["ModelPixelScaleTag"].value[:2]   # degrees per pixel, x and y
        ox, oy = page.tags["ModelTiepointTag"].value[3:5]    # geographic position of pixel (0, 0)'s corner
        width, height = page.imagewidth, page.imagelength
    col0 = max(int(numpy.floor((lon.min() - ox) / sx)), 0)
    col1 = min(int(numpy.ceil((lon.max() - ox) / sx)) + 1, width)
    row0 = max(int(numpy.floor((oy - lat.max()) / sy)), 0)
    row1 = min(int(numpy.ceil((oy - lat.min()) / sy)) + 1, height)
    window = tifffile.imread(path)[row0:row1, col0:col1].astype(numpy.float64)  # the whole page is 46 MB; reading it beats pulling in zarr
    window[window < -1000] = numpy.nan  # Copernicus marks voids with a large negative value

    # bilinear resampling from the lat/lon window; pixels are areas, so their centres are half a pixel in
    wlon = ox + (numpy.arange(col0, col1) + 0.5) * sx
    wlat = oy - (numpy.arange(row0, row1) + 0.5) * sy
    fx = numpy.clip((lon - wlon[0]) / sx, 0, len(wlon) - 1.000001)  # continuous index: i is the pixel at or above-left, t the part beyond
    fy = numpy.clip((wlat[0] - lat) / sy, 0, len(wlat) - 1.000001)
    ix, iy = fx.astype(int), fy.astype(int)
    tx, ty = fx - ix, fy - iy
    top = window[iy, ix] * (1 - tx) + window[iy, ix + 1] * tx
    bottom = window[iy + 1, ix] * (1 - tx) + window[iy + 1, ix + 1] * tx
    grid = top * (1 - ty) + bottom * ty
    voids = int(numpy.isnan(grid).sum())
    grid = _fill(grid)
    metres = numpy.clip(numpy.rint(grid), NODATA + 1, 32767).astype(numpy.int16)[::-1]  # row 0 is the northernmost
    log(f"terrain: {nx} x {ny} cells of {cell:.0f} m, {metres.min()}..{metres.max()} m, {voids} void cells filled from neighbours")
    return metres


def save(grid, path):
    x0, y0, nx, ny, cell = grid_bounds()
    with open(path, "wb") as f:
        f.write(struct.pack(HEADER, MAGIC, x0, y0, cell, nx, ny))
        f.write(grid.astype("<i2").tobytes())


def load(path):
    """-> (int16 metres north to south, (x0, y0, cell, nx, ny))."""
    with open(path, "rb") as f:
        magic, x0, y0, cell, nx, ny = struct.unpack(HEADER, f.read(struct.calcsize(HEADER)))
        if magic != MAGIC:
            raise ValueError(f"{path} is not a terrain grid")
        grid = numpy.frombuffer(f.read(), dtype="<i2").reshape(ny, nx)
    return grid, (x0, y0, cell, nx, ny)


if __name__ == "__main__":
    region.WORK.mkdir(parents=True, exist_ok=True)
    out = region.WORK / "terrain.bin"
    grid = build()
    save(grid, out)
    print("->", out, f"{out.stat().st_size / 1048576:.1f} MB")
