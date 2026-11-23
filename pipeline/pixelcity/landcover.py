"""ESA World Cover 2021 (10 m land cover) for the region, on a square grid in world metres.

The satellite map says what covers the ground where OpenStreetMap has no polygon: woods, shrub, grass,
crops, built-up land, bare ground, water, wetland. It also decides where the trees on the hills stand.

Usage: python -m pixelcity.landcover <city>      writes data/work/<city>/landcover.npz
"""
import sys
import time

import numpy
import tifffile

from .city import of
from .sources import ensure, landcover_file
TREE, SHRUB, GRASSLAND, CROPLAND, BUILT, BARE, SNOW, WATER, WETLAND, MANGROVE, MOSS = 10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100
NAMES = {TREE: "tree", SHRUB: "shrub", GRASSLAND: "grass", CROPLAND: "crop", BUILT: "built", BARE: "bare", SNOW: "snow",
         WATER: "water", WETLAND: "wetland", MANGROVE: "mangrove", MOSS: "moss", 0: "none"}
STEP_M = 10.0


def world_grid(city, bounds, step=STEP_M, path=None, log=print):
    """-> (classes uint8[ny, nx], x0, y0, step): the class at the centre of each square; row 0 is the northernmost."""
    west, south, east, north = bounds
    x0, y0 = float(numpy.floor(west / step) * step), float(numpy.floor(south / step) * step)
    nx, ny = int(numpy.ceil((east - x0) / step)), int(numpy.ceil((north - y0) / step))
    xs = x0 + (numpy.arange(nx) + 0.5) * step
    ys = y0 + (numpy.arange(ny) + 0.5) * step
    lon, lat = city.unproject(numpy.tile(xs, ny), numpy.repeat(ys, nx))
    source = str(path or landcover_file(city))
    with tifffile.TiffFile(source) as tif:
        page = tif.pages[0]
        scale_x, scale_y = page.tags["ModelPixelScaleTag"].value[:2]      # degrees per pixel
        origin_lon, origin_lat = page.tags["ModelTiepointTag"].value[3:5]  # the corner of pixel (0, 0): north-west
        width, height = page.imagewidth, page.imagelength
    t0 = time.time()
    image = tifffile.imread(source)  # the whole page; reading a window would need the zarr package
    col = numpy.clip(numpy.floor((lon - origin_lon) / scale_x).astype(int), 0, width - 1)
    row = numpy.clip(numpy.floor((origin_lat - lat) / scale_y).astype(int), 0, height - 1)
    classes = image[row, col].reshape(ny, nx)
    log(f"WorldCover: {nx} x {ny} cells of {step:.0f} m read in {time.time() - t0:.0f} s; "
        + ", ".join(f"{NAMES.get(int(k), k)} {v:.0f}%" for k, v in _shares(classes)))
    return classes, x0, y0, step


def _shares(classes):
    values, counts = numpy.unique(classes, return_counts=True)
    total = counts.sum()
    ranked = sorted(zip(values, counts, strict=True), key=lambda pair: -pair[1])
    return [(int(kind), 100.0 * count / total) for kind, count in ranked if count / total >= 0.005]


def save(grid, path):
    classes, x0, y0, step = grid
    numpy.savez_compressed(path, classes=classes, x0=x0, y0=y0, step=step)


def load(path):
    with numpy.load(path) as data:
        return data["classes"], float(data["x0"]), float(data["y0"]), float(data["step"])


def class_at(grid, x, y):
    """The WorldCover class at world positions."""
    classes, x0, y0, step = grid
    col = numpy.clip(((x - x0) / step).astype(int), 0, classes.shape[1] - 1)
    row = numpy.clip((classes.shape[0] - 1 - (y - y0) / step).astype(int), 0, classes.shape[0] - 1)
    return classes[row, col]


if __name__ == "__main__":
    c = of(sys.argv)
    ensure(c)
    west, south, east, north = c.bounds()
    pad = 2000
    c.work.mkdir(parents=True, exist_ok=True)
    out = c.work / "landcover.npz"
    save(world_grid(c, (west - pad, south - pad, east + pad, north + pad)), out)
    print("->", out, f"{out.stat().st_size / 1048576:.0f} MB")
    sys.exit(0)
