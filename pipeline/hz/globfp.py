"""3D-GloBFP (building footprints with heights, 2020) -> the region, as (polygon in world metres, tags).

The dataset is one shapefile per 1.25 x 1.25 degree tile. This reads the tile that covers the region and
keeps the footprints that reach into it. Each keeps its estimated height in metres.

Usage: python -m hz.globfp
"""
import glob
import pickle
import time

import numpy
import shapefile
import shapely
from shapely.geometry import shape

from . import region

SOURCE = region.RAW / "globfp"


def load(path=None, log=print):
    t0 = time.time()
    path = path or glob.glob(str(SOURCE / "*.shp"))[0]
    reader = shapefile.Reader(path, encoding="latin-1")
    pad = region.MARGIN_M / 100000.0  # about 3 km in degrees
    west, south, east, north = region.WEST - pad, region.SOUTH - pad, region.EAST + pad, region.NORTH + pad
    items, broken = [], 0
    for sr in reader.iterShapeRecords():
        x0, y0, x1, y1 = sr.shape.bbox
        if x1 < west - pad or x0 > east + pad or y1 < south - pad or y0 > north + pad:
            continue
        geom = shapely.transform(shape(sr.shape.__geo_interface__), lambda xy: numpy.column_stack(region.project(xy[:, 0], xy[:, 1])), include_z=False)
        if not geom.is_valid:
            geom = geom.make_valid()
        if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
            broken += 1
            continue
        rec = sr.record.as_dict()
        items.append((geom, {"height": rec.get("Height") or None, "type": rec.get("type")}))
    log(f"3D-GloBFP: {len(items)} footprints in the region (+{broken} unusable) in {time.time() - t0:.0f} s")
    return items


if __name__ == "__main__":
    region.WORK.mkdir(parents=True, exist_ok=True)
    items = load()
    out = region.WORK / "globfp.pkl"
    with open(out, "wb") as f:
        pickle.dump(items, f, protocol=pickle.HIGHEST_PROTOCOL)
    heights = numpy.array([t["height"] for _, t in items if t["height"] is not None])
    print(f"heights (m): min {heights.min():.1f}  10% {numpy.percentile(heights, 10):.1f}  median {numpy.median(heights):.1f}  90% {numpy.percentile(heights, 90):.1f}  99% {numpy.percentile(heights, 99):.1f}  max {heights.max():.1f}")
    types = {}
    for _, t in items:
        types[str(t["type"])] = types.get(str(t["type"]), 0) + 1
    print(f"types: {types}")
    print("->", out, f"{out.stat().st_size / 1048576:.0f} MB")
