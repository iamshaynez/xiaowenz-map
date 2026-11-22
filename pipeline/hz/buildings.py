"""One building list out of OpenStreetMap and 3D-GloBFP.

OpenStreetMap has the better outlines where it has any: precise, with names and uses. 3D-GloBFP has an
outline and an estimated height for nearly everything, but its outlines are coarser and carry no use.
So the two are matched footprint against footprint:

* An OSM outline that mostly coincides with one GloBFP footprint is kept, and takes the footprint's height.
* An OSM outline that covers several GloBFP footprints (a whole compound drawn as one block) is dropped
  and the footprints stand in for it, so the block becomes individual buildings again.
* Every GloBFP footprint that no OSM outline claims becomes a building of its own.
* An OSM outline with no counterpart at all is kept as it is; its height is inferred later.

Heights are assigned in a fixed order (see HEIGHT_SOURCES) and each building records where its height
came from, so the data report can say how much of the city is measured and how much is guessed.
"""
import re
import time

import numpy
import shapely
from shapely.strtree import STRtree

HEIGHT_SOURCES = ("landmark", "osm:height", "osm:levels", "globfp", "inferred")
MIN_FOOTPRINT_M2 = 6.0      # smaller GloBFP polygons are noise at this scale
FLOOR_M = 3.0               # default storey height when a level count has to become metres
COINCIDE = 0.5              # an outline "mostly coincides" with a footprint when at least this share of it overlaps


def parse_metres(value):
    """'24', '24 m', '~20', '12.5' -> metres, or None."""
    if value is None:
        return None
    m = re.search(r"-?\d+(\.\d+)?", str(value))
    return float(m.group()) if m else None


def parse_levels(value):
    m = re.search(r"\d+", str(value or ""))
    return int(m.group()) if m else None


def _within(geom, bounds):
    minx, miny, maxx, maxy = geom.bounds
    return not (maxx < bounds[0] or minx > bounds[2] or maxy < bounds[1] or miny > bounds[3])


def unify(osm_layers, globfp, bounds, log=print):
    """-> list of dicts: geom, tags, height (m or None), levels (int or None), height_source, origin."""
    t0 = time.time()
    west, south, east, north = bounds
    osm = [(g, t) for g, t in osm_layers.buildings if _within(g, bounds)]
    glo = [(g, t["height"]) for g, t in globfp if g.area >= MIN_FOOTPRINT_M2 and _within(g, bounds)]
    log(f"matching {len(osm)} OSM outlines against {len(glo)} GloBFP footprints")
    osm_geoms = numpy.asarray([g for g, _ in osm], dtype=object)
    glo_geoms = numpy.asarray([g for g, _ in glo], dtype=object)
    osm_area = shapely.area(osm_geoms)
    glo_area = shapely.area(glo_geoms)

    # every (outline, footprint) pair whose shapes touch, with the share of each that overlaps
    i, j = STRtree(glo_geoms).query(osm_geoms, predicate="intersects")
    overlap = shapely.area(shapely.intersection(osm_geoms[i], glo_geoms[j]))
    share_osm, share_glo = overlap / osm_area[i], overlap / glo_area[j]
    order = numpy.lexsort((-share_osm, i))
    i, j, share_osm, share_glo, overlap = i[order], j[order], share_osm[order], share_glo[order], overlap[order]
    starts = numpy.searchsorted(i, numpy.arange(len(osm)))
    ends = numpy.searchsorted(i, numpy.arange(len(osm)), side="right")
    # the first pair of every outline is its best match: the footprint covering the largest share of it
    claimed = numpy.zeros(len(glo), dtype=bool)      # footprints that stand for an OSM outline
    parts_of = {}                                     # outline index -> footprint indices it is cut into
    keep_osm = []
    for k in range(len(osm)):
        lo, hi = starts[k], ends[k]
        if lo == hi:
            keep_osm.append((k, None))  # nothing touches this outline: it stands on its own
            continue
        js, s_osm, s_glo = j[lo:hi], share_osm[lo:hi], share_glo[lo:hi]
        inside = js[s_glo >= COINCIDE]  # footprints that lie mostly within the outline
        if s_osm[0] >= COINCIDE:
            # the outline is one building: keep it, and claim every footprint that is part of it
            keep_osm.append((k, int(js[0])))
            claimed[inside] = True
        elif len(inside):
            # the outline is a block of several buildings: the footprints inside it stand in for it
            parts_of[k] = [int(x) for x in inside]
            claimed[inside] = True
        else:
            # the two only clip each other: they are not the same building
            keep_osm.append((k, None))

    out = []
    for k, match in keep_osm:
        geom, tags = osm[k]
        out.append({"geom": geom, "tags": tags, "match": match, "origin": "osm"})
    for k, members in parts_of.items():
        tags = osm[k][1]
        biggest = max(members, key=lambda m: glo_area[m])
        for m in members:
            out.append({"geom": glo_geoms[m], "tags": {} if m != biggest else {t: v for t, v in tags.items() if t in ("name", "building", "amenity", "shop", "tourism", "historic")},
                        "match": m, "origin": "osm-block"})
    for m in numpy.nonzero(~claimed)[0]:
        out.append({"geom": glo_geoms[int(m)], "tags": {}, "match": int(m), "origin": "globfp"})

    # heights, in a fixed order of trust
    source_count = dict.fromkeys(HEIGHT_SOURCES, 0)
    for b in out:
        tags, m = b["tags"], b["match"]
        metres = levels = None
        if parse_metres(tags.get("height")) is not None:
            metres, source = parse_metres(tags.get("height")), "osm:height"
            levels = max(1, round(metres / FLOOR_M))
        elif parse_levels(tags.get("building:levels")) is not None:
            levels = max(1, parse_levels(tags.get("building:levels")))
            metres, source = levels * FLOOR_M, "osm:levels"
        elif m is not None and glo[m][1]:
            metres, source = float(glo[m][1]), "globfp"
            levels = max(1, round(metres / FLOOR_M))
        else:
            source = "inferred"  # filled in by classify.infer_heights
        b.update(height=metres, levels=levels, height_source=source)
        source_count[source] += 1

    counts = {origin: sum(1 for b in out if b["origin"] == origin) for origin in ("osm", "osm-block", "globfp")}
    log(f"buildings: {len(out)}  ({counts['osm']} OSM outlines kept, {counts['osm-block']} footprints standing in for {len(parts_of)} OSM blocks, {counts['globfp']} from GloBFP alone) in {time.time() - t0:.0f} s")
    log(f"heights: {source_count}")
    return out
