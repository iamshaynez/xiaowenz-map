"""The whole pipeline, from the raw downloads in data/raw to the baked files the app loads in data/baked.

Each step writes what the later ones read into data/work, so that any of them can be run again on its own:

    python -m hz.build_all                 everything
    python -m hz.build_all --from ground   everything from the ground layers on
    python -m hz.build_all --only trees    one step
    python -m hz.build_all --list          the steps

Nothing in data/work is kept in git: this script is how it comes back.
"""
import pickle
import sys
import time

import numpy

from . import classify, globfp, ground, landcover, landmarks, region, scene, terrain
from . import trees as tree_data
from .buildings import unify
from .osm_extract import Layers

WORK = region.WORK


def step_osm(log):
    from .osm_extract import extract
    layers = extract(region.RAW / "zhejiang-latest.osm.pbf", log=log)
    layers.save(WORK / "osm.pkl")


def step_globfp(log):
    items = globfp.load(log=log)
    with open(WORK / "globfp.pkl", "wb") as f:
        pickle.dump(items, f, protocol=pickle.HIGHEST_PROTOCOL)


def step_buildings(log):
    osm = Layers.load(WORK / "osm.pkl")
    with open(WORK / "globfp.pkl", "rb") as f:
        footprints = pickle.load(f)
    buildings = unify(osm, footprints, region.region_bounds())
    with open(WORK / "buildings.pkl", "wb") as f:
        pickle.dump(buildings, f, protocol=pickle.HIGHEST_PROTOCOL)
    log(f"{len(buildings)} buildings")


def step_terrain(log):
    grid = terrain.build(log=log)
    terrain.save(grid, WORK / "terrain.bin")


def step_landcover(log):
    west, south, east, north = region.region_bounds()
    landcover.save(landcover.world_grid((west - 2000, south - 2000, east + 2000, north + 2000), log=log), WORK / "landcover.npz")


def step_ground(log):
    osm = Layers.load(WORK / "osm.pkl")
    data = ground.prepare(osm, region.region_bounds(), log=log)
    cover = landcover.load(WORK / "landcover.npz")
    with open(WORK / "buildings.pkl", "rb") as f:
        footprints = [b["geom"] for b in pickle.load(f)]
    log(f"water the map lacks, from the satellite map: {ground.water_from_cover(data, cover, footprints)} patches")
    data.save(WORK / "ground.pkl")


def step_trees(log):
    # trees are only kept where the map is: the region and a fringe of 60 m, so no more than that is made
    with open(WORK / "buildings.pkl", "rb") as f:
        buildings = pickle.load(f)
    ground_data = ground.Ground.load(WORK / "ground.pkl")
    grid, info = terrain.load(WORK / "terrain.bin")
    west, south, east, north = region.region_bounds()
    records = tree_data.generate(ground_data, numpy.asarray([b["geom"] for b in buildings], dtype=object), scene.surface(grid, info, region.TILE_M / scene.TERRAIN_CELLS),
                                 landcover.load(WORK / "landcover.npz"), (west - 100, south - 100, east + 100, north + 100), numpy.random.default_rng(20261122), log=log,
                                 tea=classify.in_tea_zones)
    numpy.save(WORK / "trees.npy", records)


def step_landmarks(log):
    # looked up in the map, then stood on the ground; the bake clears what is mapped around them
    landmarks.build(log=log)
    grid, info = terrain.load(WORK / "terrain.bin")
    landmarks.place(grid, info, log=log)


def step_bake(log):
    scene.bake(log=log)


STEPS = {"osm": step_osm, "globfp": step_globfp, "buildings": step_buildings, "terrain": step_terrain, "landcover": step_landcover,
         "ground": step_ground, "trees": step_trees, "landmarks": step_landmarks, "bake": step_bake}


def run(first="osm", last="bake", log=print):
    names = list(STEPS)
    total = time.time()
    for name in names[names.index(first):names.index(last) + 1]:
        start = time.time()
        log(f"---- {name}")
        STEPS[name](log)
        log(f"---- {name}: {time.time() - start:.0f} s")
    log(f"done in {(time.time() - total) / 60:.1f} min")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--list" in args:
        print(" ".join(STEPS))
    elif "--only" in args:
        run(args[args.index("--only") + 1], args[args.index("--only") + 1])
    else:
        run(args[args.index("--from") + 1] if "--from" in args else "osm", args[args.index("--to") + 1] if "--to" in args else "bake")
