"""The whole pipeline of one city, from the raw downloads in data/raw to the baked files the page loads in
data/baked/<city>.

Each step writes what the later ones read into data/work/<city>, so that any of them can be run again on its own:

    python -m pixelcity.build_all --city hz                 everything
    python -m pixelcity.build_all --city hz --from ground   everything from the ground layers on
    python -m pixelcity.build_all --city hz --only trees    one step
    python -m pixelcity.build_all --list                    the steps and the cities

Nothing in data/work is kept in git: this script is how it comes back. After a run that writes into the baked
files, the stamp of the bake is written beside them (data/baked/<city>/bake.json): when, from which commit of
this repository and which city definition, by which steps, and from which raw files.
"""
import json
import pickle
import subprocess
import sys
import time
from datetime import datetime, timezone

import numpy

from . import classify, globfp, ground, landcover, landmarks, names, scene, sources, terrain
from . import trees as tree_data
from .buildings import unify
from .city import ROOT, TILE_M, ids, load
from .osm_extract import Layers


def step_sources(city, log):
    sources.ensure(city, log=log)


def step_osm(city, log):
    from .osm_extract import extract
    layers = extract(city, sources.osm_file(city), log=log)
    layers.save(city.work / "osm.pkl")


def step_globfp(city, log):
    items = globfp.load(city, log=log)
    with open(city.work / "globfp.pkl", "wb") as f:
        pickle.dump(items, f, protocol=pickle.HIGHEST_PROTOCOL)


def step_buildings(city, log):
    osm = Layers.load(city.work / "osm.pkl")
    with open(city.work / "globfp.pkl", "rb") as f:
        footprints = pickle.load(f)
    buildings = unify(osm, footprints, city.bounds())
    with open(city.work / "buildings.pkl", "wb") as f:
        pickle.dump(buildings, f, protocol=pickle.HIGHEST_PROTOCOL)
    log(f"{len(buildings)} buildings")


def step_terrain(city, log):
    grid = terrain.build(city, log=log)
    terrain.save(city, grid, city.work / "terrain.bin")


def step_landcover(city, log):
    west, south, east, north = city.bounds()
    landcover.save(landcover.world_grid(city, (west - 2000, south - 2000, east + 2000, north + 2000), log=log), city.work / "landcover.npz")


def step_ground(city, log):
    osm = Layers.load(city.work / "osm.pkl")
    data = ground.prepare(osm, city.bounds(), city.look.get("rivers", ()), log=log)
    cover = landcover.load(city.work / "landcover.npz")
    with open(city.work / "buildings.pkl", "rb") as f:
        footprints = [b["geom"] for b in pickle.load(f)]
    log(f"water the map lacks, from the satellite map: {ground.water_from_cover(data, cover, footprints)} patches")
    data.save(city.work / "ground.pkl")


def step_trees(city, log):
    # trees are only kept where the map is: the region and a fringe of 60 m, so no more than that is made
    with open(city.work / "buildings.pkl", "rb") as f:
        buildings = pickle.load(f)
    ground_data = ground.Ground.load(city.work / "ground.pkl")
    grid, info = terrain.load(city.work / "terrain.bin")
    west, south, east, north = city.bounds()
    records = tree_data.generate(ground_data, numpy.asarray([b["geom"] for b in buildings], dtype=object), scene.surface(grid, info, TILE_M / scene.TERRAIN_CELLS),
                                 landcover.load(city.work / "landcover.npz"), (west - 100, south - 100, east + 100, north + 100), numpy.random.default_rng(20261122), log=log,
                                 tea=lambda x, y: classify.in_tea_zones(city, x, y))
    numpy.save(city.work / "trees.npy", records)


def step_landmarks(city, log):
    # looked up in the map, then stood on the ground; the bake clears what is mapped around them
    landmarks.build(city, log=log)
    grid, info = terrain.load(city.work / "terrain.bin")
    landmarks.place(city, grid, info, log=log)


def step_names(city, log):
    # looked up in the map and placed on the ground: the page searches by it and flies to what it finds
    names.build(city, log=log)


def step_bake(city, log):
    scene.bake(city, log=log)


STEPS = {"sources": step_sources, "osm": step_osm, "globfp": step_globfp, "buildings": step_buildings, "terrain": step_terrain, "landcover": step_landcover,
         "ground": step_ground, "trees": step_trees, "landmarks": step_landmarks, "names": step_names, "bake": step_bake}
TO_THE_BAKED_FILES = ("landmarks", "names", "bake")     # the steps that write into data/baked


def commit():
    """(the short hash of HEAD, whether anything in the working tree is not committed), or (None, None) outside git."""
    try:
        head = subprocess.run(["git", "rev-parse", "--short=12", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
        state = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None, None
    return head, bool(state.strip())


def stamp(city, ran):
    """data/baked/<city>/bake.json (the module's docstring says what is in it)."""
    head, uncommitted = commit()
    said = {"city": city.id, "built": datetime.now(timezone.utc).isoformat(timespec="seconds"), "steps": ran,
            "commit": head, "uncommitted": uncommitted, "sources": sources.notes(city), "definition": sources.digests(city.folder)}
    path = city.baked / "bake.json"
    path.write_text(json.dumps(said, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def run(city, first="sources", last="bake", log=print):
    order = list(STEPS)
    ran = []
    total = time.time()
    city.work.mkdir(parents=True, exist_ok=True)
    for name in order[order.index(first):order.index(last) + 1]:
        start = time.time()
        log(f"---- {name}")
        STEPS[name](city, log)
        ran.append(name)
        log(f"---- {name}: {time.time() - start:.0f} s")
    if any(name in TO_THE_BAKED_FILES for name in ran):
        stamp(city, ran)
    log(f"done in {(time.time() - total) / 60:.1f} min")


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--list" in args:
        print("steps:", " ".join(STEPS))
        print("cities:", " ".join(ids()))
    else:

        def value(flag):
            at = args.index(flag) + 1 if flag in args else 0
            return args[at] if at else None

        city = load(value("--city"))
        if "--only" in args:
            only = value("--only")
            run(city, only, only)
        else:
            run(city, value("--from") or "sources", value("--to") or "bake")
