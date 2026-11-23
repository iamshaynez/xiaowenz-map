"""3D-GloBFP (building footprints with heights, 2020) -> the region, as (polygon in world metres, tags).

The dataset is one shapefile per 1.25 x 1.25 degree tile. This reads every tile named in city.json and
keeps the footprints that reach into the region from any of them. Each keeps its estimated height in metres.

Usage: python -m pixelcity.globfp <city>
"""
import pickle
import sys
import time

import numpy
import shapefile
import shapely
from shapely.geometry import shape

from .city import MARGIN_M, RAW, of
from .sources import ensure, footprints_files


def load(city, paths=None, log=print):
    """The footprints of the tiles the city is built from (its city.json, "sources": "buildings") that reach into the region."""
    t0 = time.time()
    paths = list(paths or footprints_files(city))
    if not paths:
        raise SystemExit(f"the building footprints are not complete under {RAW / 'buildings'}: see sources.py")
    pad = MARGIN_M / 100000.0  # about 3 km in degrees
    west, south, east, north = city.west - pad, city.south - pad, city.east + pad, city.north + pad
    items, broken, per_tile = [], 0, []
    for path in paths:
        reader = shapefile.Reader(path, encoding="latin-1")
        came = 0
        for sr in reader.iterShapeRecords():
            x0, y0, x1, y1 = sr.shape.bbox
            if x1 < west - pad or x0 > east + pad or y1 < south - pad or y0 > north + pad:
                continue
            came += 1
            geom = shapely.transform(shape(sr.shape.__geo_interface__), lambda xy: numpy.column_stack(city.project(xy[:, 0], xy[:, 1])), include_z=False)
            if not geom.is_valid:
                geom = geom.make_valid()
            if geom.is_empty or geom.geom_type not in ("Polygon", "MultiPolygon"):
                broken += 1
                continue
            rec = sr.record.as_dict()
            items.append((geom, {"height": rec.get("Height") or None, "type": rec.get("type")}))
        per_tile.append(f"{path.stem.split('_')[0]} {came:,}")
    log(f"3D-GloBFP: {len(items)} footprints in the region (+{broken} unusable) from {len(paths)} tile{'s' if len(paths) != 1 else ''} ({', '.join(per_tile)}) in {time.time() - t0:.0f} s")
    return items


if __name__ == "__main__":
    c = of(sys.argv)
    ensure(c)
    c.work.mkdir(parents=True, exist_ok=True)
    items = load(c)
    out = c.work / "globfp.pkl"
    with open(out, "wb") as f:
        pickle.dump(items, f, protocol=pickle.HIGHEST_PROTOCOL)
    heights = numpy.array([t["height"] for _, t in items if t["height"] is not None])
    print(f"heights (m): min {heights.min():.1f}  10% {numpy.percentile(heights, 10):.1f}  median {numpy.median(heights):.1f}  90% {numpy.percentile(heights, 90):.1f}  99% {numpy.percentile(heights, 99):.1f}  max {heights.max():.1f}")
    types = {}
    for _, t in items:
        types[str(t["type"])] = types.get(str(t["type"]), 0) + 1
    print(f"types: {types}")
    print("->", out, f"{out.stat().st_size / 1048576:.0f} MB")
