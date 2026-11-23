"""Terrain: the Copernicus GLO-30 DEM -> one regular grid in world metres.

The GeoTIFFs are 1 x 1 degree tiled cloud-optimised files in lat/lon. The window that covers the region is
read out of every tile named in city.json, the pieces are put side by side on the pixel grid they share, and
the whole is resampled onto the same square grid that the baked tiles use, so every tile is a sub-rectangle
of one array.

Usage: python -m pixelcity.terrain <city>
"""
import struct
import sys

import numpy
import tifffile

from .city import MARGIN_M, of
from .sources import dem_cell, dem_files, ensure
CELL_M = 30.0       # the source's ground sample distance; finer would only interpolate
NODATA = -32768     # stored value for "no elevation"
MAGIC = b"HZTE"
HEADER = "<4s3d2q"  # magic, west edge, south edge, cell size, cells across, cells up

_grid = None


def grid_bounds(city):
    """(x0, y0, nx, ny, cell): west and south edge in world metres, cell counts, cell size in metres."""
    west, south, east, north = city.bounds()
    pad = MARGIN_M
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


def build(city, paths=None, log=print):
    """Read the DEM window of every tile named and resample it; returns int16 metres, rows from north to south."""
    paths = list(paths or dem_files(city))
    x0, y0, nx, ny, cell = grid_bounds(city)
    # the centre of every grid cell, in lon/lat. The transform is done for each cell rather than per axis:
    # grid north is about 1.4 degrees off true north here, so longitude drifts by almost a kilometre across the region
    cx = x0 + (numpy.arange(nx) + 0.5) * cell
    cy = y0 + (numpy.arange(ny) + 0.5) * cell
    lon, lat = city.unproject(numpy.tile(cx, ny), numpy.repeat(cy, nx))
    lon, lat = lon.reshape(ny, nx), lat.reshape(ny, nx)  # rows from south to north

    pieces, scale = [], None
    for path in paths:
        with tifffile.TiffFile(path) as tif:
            page = tif.pages[0]
            sx, sy = page.tags["ModelPixelScaleTag"].value[:2]   # degrees per pixel, x and y
            ox, oy = page.tags["ModelTiepointTag"].value[3:5]    # geographic position of pixel (0, 0)'s corner
            width, height = page.imagewidth, page.imagelength
        if scale is None:
            scale = (sx, sy)
        elif (sx, sy) != scale:
            raise SystemExit(f"{path} is not on the pixel grid of {paths[0].name}: {sx}, {sy} against {scale[0]}, {scale[1]} degrees a pixel")
        col0 = max(int(numpy.floor((lon.min() - ox) / sx)), 0)
        col1 = min(int(numpy.ceil((lon.max() - ox) / sx)) + 1, width)
        row0 = max(int(numpy.floor((oy - lat.max()) / sy)), 0)
        row1 = min(int(numpy.ceil((oy - lat.min()) / sy)) + 1, height)
        if col1 <= col0 or row1 <= row0:
            continue                                    # this tile does not reach the region and its margin
        piece = tifffile.imread(path)[row0:row1, col0:col1].astype(numpy.float64)  # the whole page is 46 MB; reading it beats pulling in zarr
        piece[piece < -1000] = numpy.nan  # Copernicus marks voids with a large negative value
        pieces.append((ox, oy, col0, row0, piece))
    if not pieces:
        raise SystemExit(f"none of the terrain tiles named in city.json ({', '.join(path.name for path in paths)}) reaches the region")

    # the tiles share one pixel grid (one pixel scale, corners on whole degrees), so the pieces go side by side,
    # located against the west and north edges of the westernmost and northernmost tile that came in; the window
    # is the union of the pieces, so a tile read alone gives exactly the window it gave before
    ox0, oy0 = min(piece[0] for piece in pieces), max(piece[1] for piece in pieces)
    placed = [(col0 + int(round((ox - ox0) / sx)), row0 + int(round((oy0 - oy) / sy)), piece) for ox, oy, col0, row0, piece in pieces]
    at_west = min(at_col for at_col, _, _ in placed)
    at_north = min(at_row for _, at_row, _ in placed)
    ncols = max(at_col + piece.shape[1] for at_col, _, piece in placed) - at_west
    nrows = max(at_row + piece.shape[0] for _, at_row, piece in placed) - at_north
    window = numpy.full((nrows, ncols), numpy.nan)
    for at_col, at_row, piece in placed:
        window[at_row - at_north:at_row - at_north + piece.shape[0], at_col - at_west:at_col - at_west + piece.shape[1]] = piece

    # bilinear resampling from the lat/lon window; pixels are areas, so their centres are half a pixel in.
    # Only the region itself must lie on tiles: the margin outside it may sample from the tile edge
    wlon = ox0 + (numpy.arange(ncols) + at_west + 0.5) * sx
    wlat = oy0 - (numpy.arange(nrows) + at_north + 0.5) * sy
    corners = numpy.column_stack(city.corners())
    rlon, rlat = city.unproject(corners[0], corners[1])
    in_region = (lon >= rlon.min()) & (lon <= rlon.max()) & (lat >= rlat.min()) & (lat <= rlat.max())
    outside = in_region & ((lon < wlon[0] - sx / 2) | (lon > wlon[-1] + sx / 2) | (lat > wlat[0] + sy / 2) | (lat < wlat[-1] - sy / 2))
    if outside.any():
        raise SystemExit(f"the terrain tiles named in city.json do not cover the region: add {dem_cell(float(lon[outside][0]), float(lat[outside][0]))}")
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
    log(f"terrain: {len(pieces)} tile{'s' if len(pieces) != 1 else ''} read, {nx} x {ny} cells of {cell:.0f} m, {metres.min()}..{metres.max()} m, {voids} void cells filled from neighbours")
    return metres


def save(city, grid, path):
    x0, y0, nx, ny, cell = grid_bounds(city)
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
    c = of(sys.argv)
    ensure(c)
    c.work.mkdir(parents=True, exist_ok=True)
    out = c.work / "terrain.bin"
    save(c, build(c), out)
    print("->", out, f"{out.stat().st_size / 1048576:.1f} MB")
