"""Region-wide sample of OpenStreetMap building coverage over Hangzhou's main urban area.

The Overpass API is not reachable from this machine, so this uses the main map API
(``/api/0.6/map?bbox=``), one 2 km x 2 km box per cell of an 8 x 7 grid. At most one request per
second. Standard library only; nothing is written except the JSON-lines file given as argv[1].

Usage: python3 -I tools/probes/osm_grid_sample.py out/probes/osm-grid.jsonl [--summary-only]
"""
import json
import math
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = "xiaowenz-map-hangzhou/0.1 (local evaluation; open data for a pixel-art map)"
API = "https://api.openstreetmap.org/api/0.6/map?bbox="
POI_KEYS = ("amenity", "shop", "tourism", "leisure", "historic")
BIG_ROADS = ("motorway", "trunk", "primary", "motorway_link", "trunk_link", "primary_link")
COLUMNS, ROWS = 8, 7
LON0, DLON = 120.025, 0.05
LAT0, DLAT = 30.1425, 0.045
CELL_KM2 = (0.05 * 111.32 * math.cos(math.radians(30.28))) * (0.045 * 111.195)


def fetch(bbox):
    req = urllib.request.Request(API + ",".join("%.6f" % v for v in bbox), headers={"User-Agent": UA})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read(), None
        except urllib.error.HTTPError as e:
            if e.code in (400, 509):
                return None, e.code
            if attempt == 2:
                return None, "HTTP %d" % e.code
        except Exception as e:  # network hiccup: retry
            if attempt == 2:
                return None, repr(e)
        time.sleep(2)


def analyze(xml_bytes, lat0, lon0, box_km):
    root = ET.fromstring(xml_bytes)
    nodes, node_tags, ways, rels = {}, {}, [], []
    for el in root:
        if el.tag == "node":
            nodes[el.get("id")] = (float(el.get("lat")), float(el.get("lon")))
            tg = {t.get("k"): t.get("v") for t in el.findall("tag")}
            if tg:
                node_tags[el.get("id")] = tg
        elif el.tag == "way":
            ways.append(([nd.get("ref") for nd in el.findall("nd")], {t.get("k"): t.get("v") for t in el.findall("tag")}))
        elif el.tag == "relation":
            rels.append({t.get("k"): t.get("v") for t in el.findall("tag")})
    kx = 111320.0 * math.cos(math.radians(lat0))
    ky = 6371008.8 * math.pi / 180.0

    def proj(nid):
        la, lo = nodes[nid]
        return ((lo - lon0) * kx, (la - lat0) * ky)

    def closed(refs):
        return len(refs) >= 4 and refs[0] == refs[-1] and all(x in nodes for x in refs)

    def area_of(refs):
        pts = [proj(r) for r in refs]
        return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1]))) / 2

    def length_of(refs):
        pts = [proj(r) for r in refs]
        return sum(math.dist(a, b) for a, b in zip(pts, pts[1:]))

    bld = [(r, t) for r, t in ways if t.get("building") not in (None, "no")]
    fps = [area_of(r) for r, t in bld if closed(r)]
    kinds = {}
    for r, t in bld:
        kinds[t.get("building")] = kinds.get(t.get("building"), 0) + 1

    def share(key):
        c = 0
        for r, t in bld:
            try:
                float(t.get(key, "x"))
                c += 1
            except ValueError:
                pass
        return round(100.0 * c / len(bld), 1) if bld else 0.0

    big = []
    for r, t in ways:
        if t.get("highway") in BIG_ROADS and t.get("name") and t["name"] not in big:
            big.append(t["name"])
    return {
        "elements": len(nodes) + len(ways) + len(rels), "buildings": len(bld),
        "bld_per_km2": round(len(bld) / (box_km * box_km), 1),
        "coverage_pct": round(100.0 * sum(fps) / (box_km * box_km * 1e6), 2),
        "median_fp_m2": round(statistics.median(fps)) if fps else None,
        "h_pct": share("height"), "lv_pct": share("building:levels"),
        "named_pct": round(100.0 * sum(1 for r, t in bld if "name" in t) / len(bld), 1) if bld else 0.0,
        "roads_km": round(sum(length_of(r) for r, t in ways if "highway" in t and len(r) >= 2 and all(x in nodes for x in r)) / 1000.0, 2),
        "water_ha": round(sum(area_of(r) for r, t in ways if closed(r) and t.get("natural") == "water") / 1e4, 2),
        "pois": sum(1 for t in list(node_tags.values()) + [t for r, t in ways] + rels if any(k in t for k in POI_KEYS)),
        "top2": sorted(kinds.items(), key=lambda kv: (-kv[1], kv[0]))[:2], "big_roads": big[:8],
    }


def run(path):
    t_start = time.time()
    with open(path, "w", encoding="utf-8") as out:
        for j in range(ROWS):
            for i in range(COLUMNS):
                lat0, lon0 = LAT0 + DLAT * j, LON0 + DLON * i
                hlat = 1.0 / 111.195
                hlon = 1.0 / (111.32 * math.cos(math.radians(lat0)))
                if i or j:
                    time.sleep(1.1)
                data, err = fetch((lon0 - hlon, lat0 - hlat, lon0 + hlon, lat0 + hlat))
                row, box_km, fallback = {"i": i, "j": j, "lon": lon0, "lat": lat0}, 2.0, False
                if err in (400, 509):
                    time.sleep(1.1)
                    fallback, box_km = True, 1.0
                    data, err = fetch((lon0 - hlon / 2, lat0 - hlat / 2, lon0 + hlon / 2, lat0 + hlat / 2))
                if err is not None:
                    row["error"] = str(err)
                else:
                    scale = 4.0 if fallback else 1.0
                    stats = analyze(data, lat0, lon0, box_km)
                    row.update(stats)
                    row["cell_buildings_est"] = round(stats["buildings"] * scale * CELL_KM2 / 4.0)
                    row["fallback1km"] = fallback
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                out.flush()
                print("cell", i, j, row.get("buildings", "ERR:" + row.get("error", "?")), flush=True)
    print("elapsed_s", round(time.time() - t_start, 1))


def summary(path):
    rows = [json.loads(l) for l in open(path, encoding="utf-8")]
    ok = [r for r in rows if "error" not in r]
    failed = [r for r in rows if "error" in r]

    def grid(key, fmt):
        lines = []
        for j in reversed(range(ROWS)):
            lines.append(" ".join(fmt(r) for r in rows if r["j"] == j))
        return "\n".join(lines)

    print(f"cells ok={len(ok)} failed={len(failed)} cell_area_km2={CELL_KM2:.1f}")
    print("\nbuildings per km2 (north at top, west at left):")
    print(grid("bld_per_km2", lambda r: ("%5s" % r.get("bld_per_km2", "x")) if "error" not in r else "    x"))
    print("\nfootprint coverage %:")
    print(grid("coverage_pct", lambda r: ("%5s" % r.get("coverage_pct", "x")) if "error" not in r else "    x"))
    total = sum(r["cell_buildings_est"] for r in ok)
    per = [r["bld_per_km2"] for r in ok]
    cov = [r["coverage_pct"] for r in ok]
    def band(values, cuts):
        return (sum(1 for x in values if x >= cuts[0]), sum(1 for x in values if cuts[1] <= x < cuts[0]),
                sum(1 for x in values if cuts[2] <= x < cuts[1]), sum(1 for x in values if x < cuts[2]))
    print(f"\nestimated buildings in region (sum of per-cell estimates): {total:,}")
    print("cells by buildings/km2  dense>=100 / medium 30-99 / sparse 5-29 / empty<5:", band(per, (100, 30, 5)))
    print("cells by coverage %      dense>=15 / medium 5-14 / sparse 1-4 / empty<1:", band(cov, (15, 5, 1)))
    print(f"height tagged %: mean {statistics.mean(r['h_pct'] for r in ok):.1f} max {max(r['h_pct'] for r in ok):.1f} | "
          f"levels tagged %: mean {statistics.mean(r['lv_pct'] for r in ok):.1f} max {max(r['lv_pct'] for r in ok):.1f}")
    print("mean roads km per sample: %.1f | samples with water: %d" % (
        statistics.mean(r["roads_km"] for r in ok), sum(1 for r in ok if r["water_ha"] > 1)))
    print("fallback to 1 km boxes:", sum(1 for r in ok if r["fallback1km"]))
    if failed:
        print("failed cells:", [(r["i"], r["j"], r["error"]) for r in failed])


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    if "--summary-only" not in sys.argv:
        run(sys.argv[1])
    summary(sys.argv[1])
