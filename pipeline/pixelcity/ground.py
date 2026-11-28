"""The ground under the buildings: water, roads, railways and land cover.

prepare() turns the OSM layers into sets of polygons that do not overlap within a set:
  water     lake, river, canal and pond surfaces, plus narrow waterways widened to strips
  land      parks, woods, farmland, yards, urban ground, ... with the specific kinds cut out of the generic
  pavement  the walkways along the wider streets
  roads     carriageways by class, with the pavement cut away
  decks     roads and railways on bridges or viaducts: a surface that follows the ground on piers,
            its edge hung with a fascia and rimmed with a parapet

mesh() turns a set into triangles for one tile. Every polygon is cut into pieces no wider than 40 m
before it is triangulated, so that the pieces can be laid on the terrain: a triangle spanning a whole
hillside would cut through it or float over it.
"""
import numpy
import shapely
from shapely.geometry import box
from shapely.strtree import STRtree

# --- ground classes ---------------------------------------------------------------------------------------------
# The same numbers reach the app through index.json.
WATER_LAKE, WATER_RIVER, WATER_CANAL, WATER_POND = 1, 2, 3, 4
ROAD_MAJOR, ROAD_SECONDARY, ROAD_MINOR, ROAD_SERVICE, ROAD_PEDESTRIAN, PATH = 5, 6, 7, 8, 9, 10
RAIL, WALL, SIDEWALK = 11, 12, 13
GRASS, FOREST, FARMLAND, YARD, SAND, ROCK, WETLAND, PITCH, URBAN, CEMETERY = 14, 15, 16, 17, 18, 19, 20, 21, 22, 23
TEA = 24                    # only ever comes from the land-cover map in the tea hills; no polygon of OSM has it
WATER_CLASSES = (WATER_LAKE, WATER_RIVER, WATER_CANAL, WATER_POND)
ROAD_CLASSES = (ROAD_MAJOR, ROAD_SECONDARY, ROAD_MINOR, ROAD_SERVICE, ROAD_PEDESTRIAN, PATH, SIDEWALK)
LAND_CLASSES = (FOREST, TEA, FARMLAND, GRASS, CEMETERY, PITCH, WETLAND, SAND, ROCK, YARD, URBAN)   # specific first

# the base colour of each class, by name in the central palette
GROUND_COLOURS = {
    WATER_LAKE: "water_lake", WATER_RIVER: "water_river", WATER_CANAL: "water_canal", WATER_POND: "water_pond",
    ROAD_MAJOR: "asphalt", ROAD_SECONDARY: "asphalt", ROAD_MINOR: "asphalt_light", ROAD_SERVICE: "asphalt_light",
    ROAD_PEDESTRIAN: "paving", PATH: "gravel", RAIL: "rail", WALL: "concrete_grey", SIDEWALK: "sidewalk",
    GRASS: "grass", FOREST: "forest_floor", FARMLAND: "farmland", YARD: "yard", SAND: "sand", ROCK: "rock",
    WETLAND: "wetland", PITCH: "pitch", URBAN: "urban_ground", CEMETERY: "grass_dry", TEA: "tea",
}
# how far each class floats above the terrain, in metres; what floats higher is drawn over what is lower
LIFT = {URBAN: 0.02, GRASS: 0.03, FOREST: 0.03, FARMLAND: 0.03, YARD: 0.03, SAND: 0.03, ROCK: 0.03, WETLAND: 0.03, CEMETERY: 0.03, TEA: 0.03,
        PITCH: 0.04, SIDEWALK: 0.17, PATH: 0.066, ROAD_PEDESTRIAN: 0.068, ROAD_SERVICE: 0.070, ROAD_MINOR: 0.072,
        ROAD_SECONDARY: 0.076, ROAD_MAJOR: 0.080, RAIL: 0.09, WALL: 0.0,
        WATER_LAKE: 0.10, WATER_RIVER: 0.10, WATER_CANAL: 0.10, WATER_POND: 0.10}

# carriageway width in metres, and the class each kind of way belongs to
WIDTH = {"motorway": 25, "trunk": 22, "primary": 18, "secondary": 14, "tertiary": 11, "residential": 8, "unclassified": 7,
         "living_street": 6, "service": 5, "pedestrian": 6, "footway": 2.5, "path": 2, "cycleway": 2.5, "steps": 2, "track": 3,
         "motorway_link": 12, "trunk_link": 12, "primary_link": 11, "secondary_link": 9, "tertiary_link": 8}
GROUP = {"motorway": ROAD_MAJOR, "trunk": ROAD_MAJOR, "primary": ROAD_MAJOR, "secondary": ROAD_SECONDARY, "tertiary": ROAD_MINOR,
         "residential": ROAD_MINOR, "unclassified": ROAD_MINOR, "living_street": ROAD_MINOR, "service": ROAD_SERVICE,
         "pedestrian": ROAD_PEDESTRIAN, "footway": PATH, "path": PATH, "cycleway": PATH, "steps": PATH, "track": PATH,
         "motorway_link": ROAD_MAJOR, "trunk_link": ROAD_MAJOR, "primary_link": ROAD_MAJOR, "secondary_link": ROAD_SECONDARY,
         "tertiary_link": ROAD_MINOR}
PAVEMENT = {ROAD_MAJOR: 4.5, ROAD_SECONDARY: 3.5, ROAD_MINOR: 3.0}      # metres of walkway on each side
WATERWAY_WIDTH = {"river": 12, "stream": 4, "canal": 9, "ditch": 3, "drain": 3}
RAIL_WIDTH = 3.5
CLEARANCE = 6.0                                                        # a deck floats this far above the ground under it
DECK_STEP_M = 8.0       # the deck's level is sampled along its way at this pace
RAMP_M = 40.0           # a deck's free end tapers to the ground over this, as its approach does
TOUCHDOWN_LIFT = 0.12   # the taper ends this far above the ground: just over the road's own lift, so the two melt together
PIER_SPACING_M = 35.0   # piers stand this far apart along the way
PIER_HALF_M = 0.9       # a pier is a square column of twice this, from the ground to the deck
DECK_EDGE_M = 1.2       # the slab's edge hangs this far down under the deck
PARAPET_M = 1.1         # and a low wall of this height runs along each side of it
COVER_WATER_TOLERANCE_M = 7.0   # the satellite map's water comes in 10 m cells: their corners are taken off by this much
COVER_WATER_MIN_M2 = 120.0       # smaller patches of it are dropped
RIVER_SIDE_M = 150.0            # water the satellite shows this close to the mapped river is taken to be the river's own

PIECE_M = 40.0          # polygons are cut to this size before triangulation
SIMPLIFY_M = 0.4        # outlines are simplified to this before they are triangulated
TILE_MARGIN_M = 60.0    # ground within this far of a tile is drawn with the tile, so that neighbours meet
KEEP_M = 2000.0         # ground this far outside the region is kept, so that the edge of the island has some


def _layer(tags):
    try:
        return int(tags.get("layer", "0"))
    except ValueError:
        return 0


def _elevated(tags):
    """On a bridge or a viaduct: said so by its layer, or by its bridge tag (which means a layer of one
    even where OSM leaves the layer out, as it mostly does). Tunnels are not elevated whatever their layer."""
    if tags.get("tunnel"):
        return False
    return _layer(tags) >= 1 or tags.get("bridge") not in (None, "no")


def _union(shapes):
    shapes = numpy.asarray(shapes, dtype=object)
    return shapely.union_all(shapes) if len(shapes) else shapely.Polygon()


def _deck_ramps(flying):
    """Which ends of each elevated centreline carry on into another elevated way: their ways chain end to
    end, or a ramp merges into them, and such an end keeps the deck's height. A free end tapers to the
    ground, as the approach of a real bridge does."""
    if not flying:
        return []
    lines = [line for _, _, line in flying]
    tree = STRtree(numpy.asarray(lines, dtype=object))
    out = []
    for k, line in enumerate(lines):
        coords = shapely.get_coordinates(line)
        ends = [shapely.points(coords[0, 0], coords[0, 1]), shapely.points(coords[-1, 0], coords[-1, 1])]
        out.append(tuple(any(int(other) != k for other in tree.query(end, predicate="dwithin", distance=1.5)) for end in ends))
    return out


def deck_level(line, height, ramps=(False, False)):
    """-> f(x, y): the level of the deck that follows the centreline `line`, in world metres.

    The deck follows the ground along its way (sampled every DECK_STEP_M, CLEARANCE over it), and each
    free end tapers to the ground over RAMP_M, so that the mapped bridge melts into the road it lands
    on. The level of a point is the level of the deck at the nearest point of the way. Callers that do
    not know which ends are free (labels, traffic on a bridge built by hand) leave both ends kept."""
    far = line.length
    dists = numpy.arange(0.0, far, DECK_STEP_M)
    if far - (dists[-1] if len(dists) else 0.0) > 0.5:
        dists = numpy.append(dists, far)
    kx, ky = shapely.get_coordinates(shapely.line_interpolate_point(line, dists)).T
    ground_at = height(kx, ky)
    levels = ground_at + CLEARANCE
    if ramps[0]:
        t = numpy.clip(dists / RAMP_M, 0.0, 1.0)
        levels = (ground_at[0] + TOUCHDOWN_LIFT) + (levels - ground_at[0] - TOUCHDOWN_LIFT) * (t * t * (3.0 - 2.0 * t))
    if ramps[1]:
        t = numpy.clip((far - dists) / RAMP_M, 0.0, 1.0)
        levels = (ground_at[-1] + TOUCHDOWN_LIFT) + (levels - ground_at[-1] - TOUCHDOWN_LIFT) * (t * t * (3.0 - 2.0 * t))

    def level(x, y):
        at = shapely.line_locate_point(line, shapely.points(numpy.asarray(x, dtype=float), numpy.asarray(y, dtype=float)))
        return numpy.interp(at, dists, levels)

    return level


def water_class(tags, area, rivers=()):
    kind = tags.get("water") or tags.get("landuse") or tags.get("waterway") or "water"
    if kind in ("river", "riverbank"):
        # only the great river carries the loess-brown water; the canals and streams that the map also calls
        # rivers (the Grand Canal among them, in Hangzhou) are the green-grey of canals. Which rivers do is the
        # city's to say: "rivers" in its city.json
        name = tags.get("name", "")
        return WATER_RIVER if any(word in name for word in rivers) else WATER_CANAL
    if kind == "canal":
        return WATER_CANAL
    if kind in ("lake", "reservoir") or area > 80000:
        return WATER_LAKE
    return WATER_POND


def land_class(tags):
    """The ground class of a land polygon, or None where it should not be drawn (an island, for instance)."""
    use, natural, leisure, amenity = tags.get("landuse"), tags.get("natural"), tags.get("leisure"), tags.get("amenity")
    if natural == "wood" or use == "forest" or leisure == "nature_reserve" or tags.get("boundary") in ("protected_area", "national_park"):
        return FOREST
    if natural == "wetland":
        return WETLAND
    if natural in ("sand", "beach"):
        return SAND
    if natural in ("bare_rock", "scree", "shingle"):
        return ROCK
    if natural in ("grassland", "heath", "moor"):
        return GRASS
    if use == "cemetery" or amenity == "grave_yard":
        return CEMETERY
    if use in ("farmland", "orchard", "vineyard", "plantation", "greenhouse_horticulture"):
        return TEA if "茶园" in (tags.get("name") or "") else FARMLAND     # a tea plantation mapped and named as such

    if use in ("grass", "meadow", "village_green", "greenfield"):
        return GRASS
    if use in ("industrial", "railway", "construction", "brownfield", "landfill", "quarry", "port", "military", "garages"):
        return YARD
    if use in ("residential", "commercial", "retail", "harbour", "education", "religious", "institutions"):
        return URBAN
    if leisure in ("pitch", "track", "stadium", "sports_centre"):
        return PITCH
    if leisure in ("park", "garden", "dog_park", "recreation_ground", "golf_course", "playground", "picnic_site"):
        return GRASS
    if leisure in ("marina", "resort", "summer_camp"):
        return URBAN
    if amenity in ("school", "university", "college", "kindergarten", "hospital", "prison", "place_of_worship", "monastery",
                   "social_facility", "research_institute", "public_building", "ranger_station", "events_venue"):
        return GRASS
    if amenity in ("parking", "bicycle_parking", "motorcycle_parking", "taxi", "bus_station", "ferry_terminal",
                   "fire_station", "police", "townhall", "courthouse"):
        return YARD
    if tags.get("power") or tags.get("man_made") in ("works", "wastewater_plant", "water_works", "pier", "wharf", "drydock"):
        return YARD
    if tags.get("tourism") in ("zoo", "theme_park", "aquarium"):
        return GRASS
    if tags.get("highway") in ("services", "rest_area"):
        return YARD
    return None


class Ground:
    """Polygon sets by class, each one indexed for tile queries."""

    def __init__(self):
        self.layers = {}      # class -> MultiPolygon in world metres
        self.parts = {}       # class -> array of simple polygons
        self.trees = {}       # class -> STRtree over the parts
        self.water = shapely.Polygon()
        self.decks = []       # (strip, class, centreline, ramps) for bridges and viaducts
        self.deck_tree = None  # over the strips
        self.roads = []       # (centreline, class, width) for street trees

    def index(self, cls, shapes):
        if shapes.is_empty:
            return
        self.layers[cls] = shapes
        parts = numpy.asarray(shapely.get_parts(shapes), dtype=object)
        parts = parts[shapely.area(parts) > 0.2]
        self.parts[cls] = parts
        self.trees[cls] = STRtree(parts)

    def set_decks(self, decks):
        self.decks = decks
        self.deck_tree = STRtree(numpy.asarray([deck[0] for deck in decks], dtype=object)) if decks else None

    def in_box(self, cls, query_box):
        """The polygons of a class that reach into a box."""
        parts = self.parts.get(cls)
        if parts is None:
            return []
        return parts[self.trees[cls].query(query_box, predicate="intersects")]

    def decks_in_box(self, query_box):
        """The bridges and viaducts that reach into a box."""
        return [self.decks[k] for k in self.deck_tree.query(query_box, predicate="intersects")] if self.deck_tree else []

    def save(self, path):
        """The polygons and the lists. The spatial indices are rebuilt on loading, since they do not pickle."""
        import pickle
        with open(path, "wb") as f:
            pickle.dump({"layers": self.layers, "water": self.water, "decks": self.decks, "roads": self.roads}, f, protocol=pickle.HIGHEST_PROTOCOL)

    @staticmethod
    def load(path):
        import pickle
        g = Ground()
        with open(path, "rb") as f:
            saved = pickle.load(f)
        for cls, shapes in saved["layers"].items():
            g.index(cls, shapes)
        g.water, g.roads = saved["water"], saved["roads"]
        g.set_decks(saved["decks"])
        return g


def prepare(osm, bounds, rivers=(), log=print):
    """-> Ground: polygons in world metres for the region and a margin around it."""
    keep = box(*bounds).buffer(KEEP_M)
    g = Ground()

    # ---- water: polygons as mapped, and narrow waterways widened to strips ----
    polygons = [geom.intersection(keep) for geom, _ in osm.water if geom.area > 12]
    shapes = polygons + [geom.intersection(keep).buffer(WATERWAY_WIDTH.get(t.get("waterway"), 4) / 2, quad_segs=2)
                         for geom, t in osm.water_lines if not t.get("tunnel") and geom.length >= 1]
    classes = numpy.asarray([water_class(t, geom.area, rivers) for geom, t in osm.water if geom.area > 12]
                           + [WATER_CANAL] * (len(shapes) - len(polygons)))
    # 一整块没有名字的水面，认它里面那条有名字的水道：钱塘江、黄浦江的江面在 OSM 里无名，名字只在
    # 沿江的水道线上，"名字里带钱塘才是江"的规则对那块大水面一直不生效（REVIEW-QUEUE 32、37）
    if rivers:
        river_lines = shapely.union_all([geom for geom, t in osm.water_lines
                                         if not t.get("tunnel") and any(word in str(t.get("name", "")) for word in rivers)] or [])
        if not river_lines.is_empty:
            unnamed = numpy.asarray([not str(t.get("name", "")).strip() for geom, t in osm.water if geom.area > 12])
            crosses = numpy.asarray([geom.intersects(river_lines) for geom, t in osm.water if geom.area > 12])
            take = unnamed & crosses
            if take.any():
                classes[:len(take)] = numpy.where(take, WATER_RIVER, classes[:len(take)])
    shapes = numpy.asarray(shapes, dtype=object)
    alive = ~shapely.is_empty(shapes)
    shapes, classes = shapes[alive], classes[alive]
    g.water = _union(shapes)
    # where bodies overlap, the larger one's class wins: the classes are assigned in order of size
    by_size = shapes[numpy.argsort(-shapely.area(shapes), kind="stable")]
    by_size_class = classes[numpy.argsort(-shapely.area(shapes), kind="stable")]
    taken = []
    for cls in WATER_CLASSES:
        chosen = by_size[by_size_class == cls]
        if not len(chosen):
            continue
        union = _union(chosen)
        if taken:
            union = union.difference(_union(taken))
        if not union.is_empty:
            g.index(cls, union)
            taken.append(union)

    # ---- roads and railways ----
    roads, rails = [], []
    for geom, tags in osm.roads:
        kind = tags.get("highway")
        if kind not in WIDTH or tags.get("tunnel") or geom.length < 1:
            continue
        line = geom.intersection(keep)
        if line.is_empty:
            continue
        roads.append((line.buffer(WIDTH[kind] / 2, quad_segs=3), GROUP[kind], line, _elevated(tags), WIDTH[kind]))
    for geom, tags in osm.rail:
        if tags.get("railway") not in ("rail", "tram", "narrow_gauge") or tags.get("tunnel") or geom.length < 1:
            continue
        line = geom.intersection(keep)
        if line.is_empty:
            continue
        rails.append((line.buffer(RAIL_WIDTH, quad_segs=2), line, _elevated(tags)))

    # ---- carriageways on the ground ----
    carriageway = {}
    for strip, cls, _line, elevated, _width in roads:
        if not elevated:
            carriageway.setdefault(cls, []).append(strip)
    squares = [geom.intersection(keep) for geom, _ in osm.road_areas]
    carriageway.setdefault(ROAD_PEDESTRIAN, []).extend(s for s in squares if not s.is_empty)
    for cls in (ROAD_MAJOR, ROAD_SECONDARY, ROAD_MINOR, ROAD_SERVICE, ROAD_PEDESTRIAN, PATH):
        if carriageway.get(cls):
            g.index(cls, _union(carriageway[cls]).difference(g.water))
    every_road = _union(list(g.layers.get(cls, shapely.Polygon()) for cls in (ROAD_MAJOR, ROAD_SECONDARY, ROAD_MINOR, ROAD_SERVICE, ROAD_PEDESTRIAN, PATH)))

    # ---- walkways along the wider streets, with the carriageway taken out ----
    pavement = []
    for strip, cls, _line, elevated, _width in roads:
        if not elevated and cls in PAVEMENT:
            pavement.append(strip.buffer(PAVEMENT[cls], quad_segs=3))
    if pavement:
        g.index(SIDEWALK, _union(pavement).difference(every_road).difference(g.water))

    # ---- railways on the ground, and everything that flies ----
    on_ground = [strip for strip, _line, elevated in rails if not elevated]
    if on_ground:
        g.index(RAIL, _union(on_ground).difference(g.water))
    flying = [(strip, cls, line) for strip, cls, line, elevated, width in roads if elevated]
    flying += [(strip, RAIL, line) for strip, line, elevated in rails if elevated]
    ramps = _deck_ramps(flying)
    g.set_decks([(*deck, ramps[k]) for k, deck in enumerate(flying)])
    g.roads = [(line, cls, width) for strip, cls, line, elevated, width in roads]

    # ---- land cover: the specific kinds are cut out of the generic ones ----
    kinds = {}
    for geom, tags in osm.land:
        cls = land_class(tags)
        if cls is None or geom.area < 8:
            continue
        kinds.setdefault(cls, []).append(geom.intersection(keep))
    covered = []
    for cls in LAND_CLASSES:
        if not kinds.get(cls):
            continue
        union = _union(kinds[cls]).difference(g.water)
        if covered:
            union = union.difference(_union(covered))
        if not union.is_empty:
            g.index(cls, union)
            covered.append(union)

    log("ground: " + ", ".join(f"{GROUND_COLOURS[c]} {g.layers[c].area / 1e6:.1f} km2" for c in sorted(g.layers, key=lambda k: -g.layers[k].area)[:10])
        + f"; {len(g.decks)} decks")
    return g


# --- on the terrain ---------------------------------------------------------------------------------------------
def water_from_cover(g, cover, buildings=(), log=print):
    """Ponds and channels the map does not have but the satellite land cover shows: its water cells, joined
    row by row, with the corners taken off, laid over the land as ponds. Only what lies outside the mapped
    water is added, and a cell that holds a building is not water: in dense quarters the satellite map takes
    dark roofs for water. -> how many patches."""
    from .landcover import WATER
    classes, x0, y0, step = cover
    wet = classes == WATER
    footprints = numpy.asarray(list(buildings), dtype=object)
    if len(footprints):
        # every cell a building's box reaches is land, not only the one its middle falls in: a great roof
        # lies over many cells
        west_b, south_b, east_b, north_b = shapely.bounds(footprints).T
        rows_n, cols_n = classes.shape
        west_g, north_g = x0, y0 + rows_n * step
        inside = (west_b >= west_g) & (east_b < west_g + cols_n * step) & (south_b >= y0) & (north_b < north_g)
        c0 = numpy.floor((west_b[inside] - x0) / step).astype(int)
        r0 = numpy.floor((north_g - north_b[inside]) / step).astype(int)
        widths = numpy.floor((east_b[inside] - x0) / step).astype(int) - c0 + 1
        heights = numpy.floor((north_g - south_b[inside]) / step).astype(int) - r0 + 1
        counts = widths * heights
        within = numpy.arange(int(counts.sum())) - numpy.repeat(numpy.cumsum(counts) - counts, counts)
        widths = numpy.repeat(widths, counts)
        wet[numpy.repeat(r0, counts) + within // widths, numpy.repeat(c0, counts) + within % widths] = False
    rows, cols = numpy.nonzero(wet)
    if not len(rows):
        return 0
    north = y0 + classes.shape[0] * step
    order = numpy.lexsort((cols, rows))
    rows, cols = rows[order], cols[order]
    starts = numpy.ones(len(rows), dtype=bool)
    starts[1:] = (rows[1:] != rows[:-1]) | (cols[1:] != cols[:-1] + 1)        # a new run of cells in a row
    first = numpy.flatnonzero(starts)
    last = numpy.r_[first[1:], len(rows)] - 1
    south = north - (rows[first] + 1) * step
    west, east = x0 + cols[first] * step, x0 + (cols[last] + 1) * step
    shapely.prepare(g.water)
    outside = ~shapely.contains_xy(g.water, (west + east) / 2, south + step / 2)   # runs already inside mapped water are not wanted
    if not outside.any():
        return 0
    joined = shapely.simplify(shapely.union_all(shapely.box(west[outside], south[outside], east[outside], south[outside] + step)), COVER_WATER_TOLERANCE_M)
    patches = numpy.asarray([p for p in shapely.get_parts(joined.difference(g.water)) if p.area >= COVER_WATER_MIN_M2], dtype=object)
    if not len(patches):
        return 0
    # most of it is the great river's own channel, which the map draws wider than the water reaches: what
    # lies by the river takes the river's colour, the rest is a pond
    by_river = shapely.distance(patches, g.layers[WATER_RIVER]) < RIVER_SIDE_M if WATER_RIVER in g.layers else numpy.zeros(len(patches), dtype=bool)
    if by_river.any():
        g.index(WATER_RIVER, shapely.union_all([g.layers[WATER_RIVER], *patches[by_river]]))
    if (~by_river).any():
        g.index(WATER_POND, shapely.union_all([g.layers.get(WATER_POND, shapely.Polygon()), *patches[~by_river]]))
    g.water = shapely.union_all([g.water, *patches])
    return len(patches)


def sample_terrain(terrain, info):
    """-> f(x, y): the terrain height read bilinearly from the grid, for arrays of world metres.

    Positions outside the grid read the nearest edge. The arithmetic is done in double precision: with
    single-precision inputs a bound such as 1414.999999 rounds up to 1415 and the lookup runs off the grid.
    """
    x0, y0, cell, tnx, tny = info
    top = y0 + tny * cell

    def height(x, y):
        x, y = numpy.asarray(x, dtype=numpy.float64), numpy.asarray(y, dtype=numpy.float64)
        fx = numpy.clip((x - x0) / cell - 0.5, 0, tnx - 1.001)
        fy = numpy.clip((top - y) / cell - 0.5, 0, tny - 1.001)
        ix, iy = fx.astype(int), fy.astype(int)
        tx, ty = fx - ix, fy - iy
        near = terrain[iy, ix] * (1 - tx) + terrain[iy, ix + 1] * tx
        far = terrain[iy + 1, ix] * (1 - tx) + terrain[iy + 1, ix + 1] * tx
        return near * (1 - ty) + far * ty

    return height


# --- meshing -----------------------------------------------------------------------------------------------------
def pieces(polygon, piece=PIECE_M):
    """Cut a polygon into pieces no wider than `piece` by clipping it with a grid of squares."""
    minx, miny, maxx, maxy = polygon.bounds
    if maxx - minx <= piece and maxy - miny <= piece:
        return [polygon]
    xs = numpy.arange(numpy.floor(minx / piece) * piece, maxx + piece, piece)
    ys = numpy.arange(numpy.floor(miny / piece) * piece, maxy + piece, piece)
    cells = shapely.box(numpy.repeat(xs[:-1], len(ys) - 1), numpy.tile(ys[:-1], len(xs) - 1),
                        numpy.repeat(xs[1:], len(ys) - 1), numpy.tile(ys[1:], len(xs) - 1))
    parts = shapely.intersection(polygon, cells)
    parts = parts[~shapely.is_empty(parts)]
    return [p for p in shapely.get_parts(parts) if p.area > 0.2]


def triangulate(polygon):
    """-> (n, 3, 2) corners of the triangles that tile a polygon, holes included."""
    out = []
    for piece in pieces(polygon):
        faces = shapely.constrained_delaunay_triangles(piece)
        if not faces.is_empty:
            # each triangle comes back as a closed ring of four points, the first three of which are its corners
            out.append(numpy.asarray(shapely.get_coordinates(faces), dtype=numpy.float64).reshape(-1, 4, 2)[:, :3].reshape(-1, 2))
    return numpy.concatenate(out) if out else numpy.zeros((0, 2))


def mesh(ground, classes, x0, y0, height, size=1000.0, margin=TILE_MARGIN_M, reclassify=None):
    """Triangles for the ground of one tile.

    classes: the ground classes to include. reclassify: optional (x, y, class) -> class, applied to each
    polygon whole, for places where one class should have been another.
    -> (vertices float32[n, 5], indices uint32[m]); a vertex is x, y, z, class, seed, with x and y relative
    to the tile's south-west corner.
    """
    query = shapely.box(x0 - margin, y0 - margin, x0 + size + margin, y0 + size + margin)
    verts, index = [], []
    count = 0
    for cls in classes:
        for part in ground.in_box(cls, query):
            if reclassify is not None:
                # a polygon is one surface: it is reclassified whole, by a point inside it
                inside = part.representative_point()
                cls = reclassify(float(inside.x), float(inside.y), cls)
            # clip to the tile before anything else: a river or a forest may reach across half the region,
            # and cutting it to pieces first would redo the whole of it for every tile it touches
            clipped = shapely.simplify(part.intersection(query), SIMPLIFY_M)
            for polygon in shapely.get_parts(clipped):
                corners = triangulate(polygon)
                if not len(corners):
                    continue
                v = numpy.column_stack([corners[:, 0] - x0, corners[:, 1] - y0, height(corners[:, 0], corners[:, 1]) + LIFT[cls],
                                        numpy.full(len(corners), float(cls)), numpy.zeros(len(corners))]).astype("<f4")
                verts.append(v)
                index.append(numpy.arange(len(v), dtype="<u4") + count)
                count += len(v)
    if not verts:
        return numpy.zeros((0, 5), dtype="<f4"), numpy.zeros(0, dtype="<u4")
    return numpy.concatenate(verts), numpy.concatenate(index)


def kerb_mesh(ground, x0, y0, height, size=1000.0, margin=TILE_MARGIN_M):
    """The kerb: a vertical face along the edges of the carriageway that a pavement stands beside — from
    just under the road's own surface up to the pavement's lift, a hand's height of stone between the two.

    The band breaks wherever the pavement does: at a junction mouth the ground outside the road belongs to
    the crossing road, not to a kerb, and gets no band. -> (vertices, indices) as mesh() returns them.
    """
    query = shapely.box(x0 - margin, y0 - margin, x0 + size + margin, y0 + size + margin)
    ways = [part for cls in (ROAD_MAJOR, ROAD_SECONDARY, ROAD_MINOR, ROAD_SERVICE, ROAD_PEDESTRIAN) if cls in ground.layers
            for part in ground.in_box(cls, query)]
    walks = [part for part in ground.in_box(SIDEWALK, query)]
    if not ways or not walks:
        return numpy.zeros((0, 5), dtype="<f4"), numpy.zeros(0, dtype="<u4")
    roads = shapely.union_all(ways)
    shapely.prepare(roads)
    pavement = shapely.union_all(walks)
    shapely.prepare(pavement)
    quads, quads_base = [], []
    kerb_top = LIFT[SIDEWALK]
    for cls in (ROAD_MAJOR, ROAD_SECONDARY, ROAD_MINOR, ROAD_SERVICE, ROAD_PEDESTRIAN):
        if cls not in ground.layers:
            continue
        lift = LIFT[cls]
        for part in ground.in_box(cls, query):
            clipped = part.intersection(query)
            if clipped.is_empty:
                continue
            for polygon in shapely.get_parts(clipped):
                for ring in (polygon.exterior, *polygon.interiors):
                    pts = numpy.asarray(ring.coords)
                    a, b = pts[:-1], pts[1:]
                    mid = (a + b) / 2
                    dx, dy = b[:, 0] - a[:, 0], b[:, 1] - a[:, 1]
                    length = numpy.hypot(dx, dy)
                    keep = length > 0.4
                    if not keep.any():
                        continue
                    a, b, mid, dx, dy = a[keep], b[keep], mid[keep], dx[keep], dy[keep]
                    nx, ny = dy / length[keep], -dx / length[keep]      # one of the two sides; both are tried below
                    ground_top = height(mid[:, 0], mid[:, 1])
                    for sign in (1.0, -1.0):
                        px, py = mid[:, 0] + nx * sign * 0.6, mid[:, 1] + ny * sign * 0.6
                        ok = shapely.contains_xy(pavement, px, py) & ~shapely.contains_xy(roads, px, py)
                        if not ok.any():
                            continue
                        xa, ya = a[ok, 0], a[ok, 1]
                        xb, yb = b[ok, 0], b[ok, 1]
                        za = ground_top[ok] + kerb_top
                        zb = height(xb, yb) + kerb_top
                        ba = ground_top[ok] + lift - 0.04
                        bb = height(xb, yb) + lift - 0.04
                        quads.append(numpy.column_stack([
                            numpy.column_stack([xa, ya, za]), numpy.column_stack([xa, ya, ba]),
                            numpy.column_stack([xb, yb, zb]), numpy.column_stack([xb, yb, bb])]).reshape(-1, 3))
                        quads_base.append(numpy.tile(float(WALL), len(xa) * 4))
    if not quads:
        return numpy.zeros((0, 5), dtype="<f4"), numpy.zeros(0, dtype="<u4")
    corners = numpy.concatenate(quads)                     # four corners a segment: top-a, bottom-a, top-b, bottom-b
    base = numpy.concatenate(quads_base)
    n = len(corners)
    verts = numpy.column_stack([corners[:, 0] - x0, corners[:, 1] - y0, corners[:, 2], base, numpy.ones(n)]).astype("<f4")
    quad = numpy.arange(n, dtype="<u4").reshape(-1, 4)     # corners: 0 top-a, 1 bottom-a, 2 top-b, 3 bottom-b
    index = numpy.concatenate([quad[:, 0], quad[:, 1], quad[:, 2], quad[:, 0], quad[:, 2], quad[:, 3]])
    return verts, index


def deck_mesh(ground, x0, y0, height, size=1000.0, margin=TILE_MARGIN_M):
    """Bridges and viaducts in a tile: each deck as a surface that follows the ground below it, its edge
    hung with a fascia and rimmed with a parapet, and piers standing to the ground along its way."""
    query = shapely.box(x0 - margin, y0 - margin, x0 + size + margin, y0 + size + margin)
    verts, index = [], []
    count = 0

    def emit(v, tris):
        nonlocal count
        verts.append(v)
        index.append((numpy.asarray(tris, dtype=numpy.int64) + count).astype("<u4"))
        count += len(v)

    def band(pts, nxt, top_a, top_b, drop, cls):
        """A vertical strip along a ring: from each point's own `top` by `drop` (negative stands above it)."""
        quad = numpy.empty((len(pts), 4, 5), dtype=numpy.float32)
        quad[:, 0, :2], quad[:, 1, :2] = pts - [x0, y0], nxt - [x0, y0]
        quad[:, 2, :2], quad[:, 3, :2] = nxt - [x0, y0], pts - [x0, y0]
        quad[:, 0, 2], quad[:, 1, 2] = top_a, top_b
        quad[:, 2, 2], quad[:, 3, 2] = top_b - drop, top_a - drop
        quad[:, :, 3], quad[:, :, 4] = cls, 1.0
        t = numpy.arange(len(pts)) * 4
        emit(quad.reshape(-1, 5), numpy.column_stack([t, t + 1, t + 2, t, t + 2, t + 3]).reshape(-1))

    for strip, cls, line, ramps in ground.decks_in_box(query):
        part = strip.intersection(query)
        if part.is_empty:
            continue
        level = deck_level(line, height, ramps)
        for polygon in shapely.get_parts(part):
            corners = triangulate(polygon)
            if len(corners):
                v = numpy.column_stack([corners[:, 0] - x0, corners[:, 1] - y0, level(corners[:, 0], corners[:, 1]),
                                        numpy.full(len(corners), float(cls)), numpy.zeros(len(corners))]).astype("<f4")
                emit(v, numpy.arange(len(v)))
            for ring in (polygon.exterior, *polygon.interiors):
                pts = numpy.asarray(ring.coords)[:-1]
                if len(pts) < 3:
                    continue
                nxt = numpy.roll(pts, -1, axis=0)
                top, top_n = level(pts[:, 0], pts[:, 1]), level(nxt[:, 0], nxt[:, 1])
                band(pts, nxt, top, top_n, DECK_EDGE_M, WALL)          # the slab's edge, hanging under the deck
                band(pts, nxt, top, top_n, -PARAPET_M, SIDEWALK)       # the low wall along it
        # the piers along the way, each drawn whole by the one tile that owns it, so that neighbours do not double them
        far = line.length
        first = numpy.ceil(((RAMP_M if ramps[0] else 0.0) + PIER_SPACING_M / 2) / PIER_SPACING_M) * PIER_SPACING_M
        last = far - (RAMP_M if ramps[1] else 0.0) - PIER_SPACING_M / 2
        ds = numpy.arange(first, max(last, first), PIER_SPACING_M)
        if len(ds):
            px, py = shapely.get_coordinates(shapely.line_interpolate_point(line, ds)).T
            own = numpy.nonzero((px >= x0) & (px < x0 + size) & (py >= y0) & (py < y0 + size))[0]
            for k in own:
                top = float(level(px[k], py[k]))
                foot = float(height(px[k], py[k])) - 0.5
                ring = numpy.array([[px[k] - PIER_HALF_M - x0, py[k] - PIER_HALF_M - y0], [px[k] + PIER_HALF_M - x0, py[k] - PIER_HALF_M - y0],
                                    [px[k] + PIER_HALF_M - x0, py[k] + PIER_HALF_M - y0], [px[k] - PIER_HALF_M - x0, py[k] + PIER_HALF_M - y0]])
                nxt = numpy.roll(ring, -1, axis=0)
                quad = numpy.empty((4, 4, 5), dtype=numpy.float32)
                quad[:, 0, :2], quad[:, 1, :2] = ring, nxt
                quad[:, 2, :2], quad[:, 3, :2] = nxt, ring
                quad[:, 0, 2], quad[:, 1, 2] = top, top
                quad[:, 2, 2], quad[:, 3, 2] = foot, foot
                quad[:, :, 3], quad[:, :, 4] = WALL, 1.0
                t = numpy.arange(4) * 4
                emit(quad.reshape(-1, 5), numpy.column_stack([t, t + 1, t + 2, t, t + 2, t + 3]).reshape(-1))
    if not verts:
        return numpy.zeros((0, 5), dtype="<f4"), numpy.zeros(0, dtype="<u4")
    return numpy.concatenate(verts), numpy.concatenate(index)
