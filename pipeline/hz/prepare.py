"""Run the matching of OSM outlines against GloBFP footprints over the region and save the building list.

Usage: python -m hz.prepare
"""
import pickle

import numpy

from . import region
from .buildings import HEIGHT_SOURCES, unify
from .globfp import load as load_globfp
from .osm_extract import Layers


def main():
    osm = Layers.load(region.WORK / "osm.pkl")
    with open(region.WORK / "globfp.pkl", "rb") as f:
        globfp = pickle.load(f)
    buildings = unify(osm, globfp, region.region_bounds())
    heights = numpy.array([b["height"] for b in buildings if b["height"] is not None])
    print("heights (m): median %.0f, 90%% %.0f, 99%% %.0f, max %.0f" % (numpy.median(heights), numpy.percentile(heights, 90), numpy.percentile(heights, 99), heights.max()))
    with open(region.WORK / "buildings.pkl", "wb") as f:
        pickle.dump(buildings, f, protocol=pickle.HIGHEST_PROTOCOL)
    print("->", region.WORK / "buildings.pkl")


if __name__ == "__main__":
    main()
