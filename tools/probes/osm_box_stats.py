# Read-only stats over OSM map-API extracts (XML). Usage: python3 -I osmstats.py <label> <half-lat> <half-lon> <file.xml> ...
import sys, math, collections, xml.etree.ElementTree as ET

def tags_of(el):
    return {t.get('k'): t.get('v') for t in el if t.tag == 'tag'}

def parse_h(v):
    if v is None: return None
    s = ''.join(c if c.isdigit() or c == '.' else ' ' for c in v).split()
    try: return float(s[0]) if s and s[0] not in ('', '.') else None
    except Exception: return None

def run(label, hlat, hlon, path):
    root = ET.parse(path).getroot()
    nodes, ways, nrel = {}, {}, 0
    for el in root:
        if el.tag == 'node':
            nodes[el.get('id')] = (float(el.get('lon')), float(el.get('lat')), tags_of(el))
        elif el.tag == 'way':
            ways[el.get('id')] = ([nd.get('ref') for nd in el if nd.tag == 'nd'], tags_of(el))
        elif el.tag == 'relation':
            nrel += 1
    lat0, lon0 = 0, 0
    if nodes:
        lat0 = sum(n[1] for n in nodes.values()) / len(nodes)
        lon0 = sum(n[0] for n in nodes.values()) / len(nodes)
    kx = math.radians(1.0) * 6371008.8 * math.cos(math.radians(lat0))   # metres per degree
    ky = math.radians(1.0) * 6371008.8
    def xy(nid):
        x, y, _ = nodes[nid]
        return ((x - lon0) * kx, (y - lat0) * ky)
    def area(nds):
        if len(nds) < 4 or nds[0] != nds[-1] or any(n not in nodes for n in nds): return None
        pts = [xy(n) for n in nds]
        s = 0.0
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            s += ax * by - bx * ay
        return abs(s) / 2
    def length(nds):
        if any(n not in nodes for n in nds): return None
        return sum(math.dist(p, q) for p, q in zip([xy(n) for n in nds], [xy(n) for n in nds[1:]]))

    box_km2 = (2 * hlat * ky / 1000) * (2 * hlon * kx / 1000)
    b = [(w, t) for w, (nds, t) in ways.items() if t.get('building', 'no') != 'no' and 'building' in t]
    areas = [area(ways[w][0]) for w, t in b]
    closed = [a for a in areas if a is not None]
    tot = sum(closed)
    h = [parse_h(t.get('height')) for w, t in b if t.get('height')]
    h = [v for v in h if v]
    lv = [parse_h(t.get('building:levels')) for w, t in b if t.get('building:levels')]
    lv = [v for v in lv if v]
    hw = [(nds, t) for w, (nds, t) in ways.items() if 'highway' in t]
    hw_len = [l for l in (length(n) for n, t in hw) if l is not None]
    poi_nodes = sum(1 for _, _, t in nodes.values() if any(k in t for k in ('amenity', 'shop', 'tourism', 'leisure', 'historic', 'office')))
    poi_ways = sum(1 for _, t in ways.values() if any(k in t for k in ('amenity', 'shop', 'tourism', 'leisure', 'historic', 'office')))
    water = sum((area(n) or 0) for n, t in ways.values() if t.get('natural') == 'water')
    landuse = sum(1 for _, t in ways.values() if 'landuse' in t)
    kinds = collections.Counter(t.get('building') for _, t in b)
    named = sum(1 for _, t in b if 'name' in t)
    big = sorted([(area(w) or 0, t.get('name', '-'), t.get('height', '-'), t.get('building')) for w, t in b], reverse=True)[:3]
    med = sorted(closed)[len(closed) // 2] if closed else 0
    print(f"{label:<22} box={box_km2:4.1f}km2 nodes={len(nodes):6d} ways={len(ways):6d} rel={nrel:3d} | buildings={len(b):5d} "
          f"({len(b)/box_km2:6.0f}/km2) closed={len(closed):5d} footprint={tot/1e4:7.1f}ha cover={100*tot/(box_km2*1e6):5.1f}% "
          f"median={med:5.0f}m2 named={100*named/max(1,len(b)):3.0f}% | height={100*len(h)/max(1,len(b)):3.0f}% levels={100*len(lv)/max(1,len(b)):3.0f}% "
          f"| roads={len(hw):4d} ({sum(hw_len)/1000:5.1f}km) pois={poi_nodes+poi_ways:4d} landuse={landuse:3d} water={water/1e4:6.1f}ha")
    print(f"{'':<22} building kinds: " + ', '.join(f'{k}={v}' for k, v in kinds.most_common(6)))
    print(f"{'':<22} largest: " + ' ; '.join(f'{a:.0f}m2 {n[:16]} h={hh} {k}' for a, n, hh, k in big))

args = sys.argv[1:]
while args:
    label, hlat, hlon, path = args[0], float(args[1]), float(args[2]), args[3]
    args = args[4:]
    try:
        run(label, hlat, hlon, path)
    except Exception as e:
        print(f'{label:<22} FAILED: {type(e).__name__}: {e}')
