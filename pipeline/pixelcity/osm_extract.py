"""OpenStreetMap extract -> layers, as lists of (shapely geometry in world metres, tags).

Everything the map needs is pulled out once and pickled, so the later steps never touch the PBF again.
Buildings, water and land cover arrive as finished polygons: osmium's area manager assembles closed
ways and multipolygon relations before they reach `area()`.

Usage: python -m pixelcity.osm_extract <city> [file.osm.pbf]
"""
import pickle
import sys
import time

import numpy
import osmium
import shapely
from shapely.geometry import Point

from .city import of
from .sources import ensure, osm_file

# --- what is kept, by layer -----------------------------------------------------------------------
# Tags worth carrying along for every kind of object.
NAME_TAGS = ("name", "name:en", "name:zh", "alt_name", "old_name", "official_name", "wikidata", "wikipedia")
BUILDING_TAGS = ("building", "building:part", "height", "building:levels", "min_height", "layer", "amenity", "shop", "tourism", "historic", "religion",
                 "office", "start_date", "architect", "building:colour", "building:material", "roof:shape", "roof:colour", "addr:street", "addr:housenumber")
ROAD_TAGS = ("highway", "bridge", "tunnel", "layer", "lanes", "oneway", "width", "maxspeed", "motorroad", "service", "toll", "sidewalk", "cycleway", "surface")
RAIL_TAGS = ("railway", "bridge", "tunnel", "layer", "usage", "service", "gauge", "electrified")
WATER_TAGS = ("natural", "water", "waterway", "landuse", "layer", "tunnel", "intermittent", "salt")
WATERLINE_TAGS = ("waterway", "width", "tunnel", "layer", "intermittent")
LAND_TAGS = ("landuse", "natural", "leisure", "amenity", "place", "boundary", "power", "man_made", "tourism", "highway", "layer", "leaf_type", "protect_class")

ROAD_KINDS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "pedestrian", "service",
              "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link", "track", "footway", "path", "cycleway", "steps", "road"}
RAIL_KINDS = {"rail", "light_rail", "subway", "tram", "monorail", "funicular", "narrow_gauge"}
WATERLINE_KINDS = {"river", "stream", "canal", "ditch", "drain"}
# land use values that are water rather than land
WATER_LANDUSE = {"reservoir", "basin"}
NATURAL_WATER = {"water", "bay", "strait"}
NATURAL_LAND = {"wood", "scrub", "heath", "moor", "grassland", "sand", "bare_rock", "scree", "shingle", "wetland", "beach", "glacier"}
LEISURE_LAND = {"park", "garden", "nature_reserve", "golf_course", "pitch", "playground", "track", "recreation_ground", "dog_park", "sports_centre", "stadium",
                "marina", "water_park", "hiking_area", "picnic_site", "summer_camp", "resort"}
AMENITY_LAND = {"grave_yard", "school", "university", "college", "hospital", "kindergarten", "prison", "place_of_worship", "events_venue", "exhibition_centre",
                "conference_centre", "research_institute", "public_building", "bus_station", "ferry_terminal", "police", "fire_station", "townhall", "courthouse",
                "theatre", "library", "marketplace", "arts_centre", "parking", "bicycle_parking", "motorcycle_parking", "taxi", "social_facility", "monastery"}
POWER_LAND = {"plant", "substation", "generator", "switchgear", "transformer"}
MADE_LAND = {"works", "wastewater_plant", "water_works", "pier", "wharf", "drydock", "mineshaft"}
TOURISM_LAND = {"zoo", "theme_park", "aquarium"}

# named things worth a label or a lookup by name, on points and on areas
PLACE_VALUES = {
    "place": {"city", "town", "suburb", "quarter", "neighbourhood", "village", "island", "islet", "square"},
    "tourism": {"attraction", "viewpoint", "museum", "artwork", "zoo", "theme_park", "aquarium"},
    "historic": None,
    "natural": {"peak", "hill", "saddle", "cape", "volcano", "spring", "cave_entrance"},
    "man_made": {"tower", "lighthouse", "water_tower", "communications_tower", "chimney", "mast", "windmill", "bridge", "observatory", "cross", "works", "pier", "wharf"},
    "leisure": {"park", "garden", "stadium", "marina", "nature_reserve", "sports_centre", "track", "slipway", "golf_course", "resort"},
    "amenity": {"theatre", "arts_centre", "library", "marketplace", "fountain", "townhall", "courthouse", "hospital", "university", "college", "school",
                "kindergarten", "place_of_worship", "bus_station", "ferry_terminal", "events_venue", "exhibition_centre", "conference_centre", "prison",
                "ranger_station", "research_institute", "public_building", "monastery", "boat_rental"},
    "railway": {"station", "halt", "subway_entrance", "tram_stop"},
    "public_transport": {"station", "stop_area"},
    "shop": {"mall", "department_store"},
    "office": {"government", "association"},
    "boundary": {"marker", "national_park", "protected_area"},
}
PLACE_KEYS = tuple(PLACE_VALUES)


class Layers:
    def __init__(self):
        self.buildings = []     # polygons: every building
        self.roads = []         # lines: every highway way
        self.road_areas = []    # polygons: pedestrian streets, squares and platforms
        self.rail = []          # lines: railways
        self.water = []         # polygons: lakes, rivers, canals, ponds, reservoirs
        self.water_lines = []   # lines: streams and narrow canals mapped as centrelines
        self.land = []          # polygons: land use and cover, parks, woods, campuses, squares
        self.places = []        # points and polygons with a name worth showing
        self.meta = {}

    def save(self, path):
        with open(path, "wb") as f:
            pickle.dump(self, f, protocol=pickle.HIGHEST_PROTOCOL)

    @staticmethod
    def load(path):
        with open(path, "rb") as f:
            return pickle.load(f)


def pick(tags, keys):
    return {t.k: t.v for t in tags if t.k in NAME_TAGS or t.k in keys}


def place_kind(tags):
    """(key, value) of the first place-worthy tag, or None."""
    for key, values in PLACE_VALUES.items():
        if key in tags and (values is None or tags[key] in values):
            return key, tags[key]
    return None


def is_water(tags):
    return (tags.get("natural") in NATURAL_WATER or "water" in tags or tags.get("waterway") == "riverbank"
            or tags.get("landuse") in WATER_LANDUSE)


def is_land(tags):
    return bool("landuse" in tags or tags.get("natural") in NATURAL_LAND or tags.get("leisure") in LEISURE_LAND
                or tags.get("amenity") in AMENITY_LAND or tags.get("power") in POWER_LAND or tags.get("man_made") in MADE_LAND
                or tags.get("tourism") in TOURISM_LAND or tags.get("place") in ("island", "islet")
                or tags.get("boundary") in ("protected_area", "national_park") or tags.get("highway") in ("services", "rest_area"))


class Extractor(osmium.SimpleHandler):
    def __init__(self, city):
        super().__init__()
        self.city = city
        self.layers = Layers()
        self.wkb = osmium.geom.WKBFactory()
        self.west, self.south, self.east, self.north = city.world_bounds()
        self.seen = {"node": 0, "way": 0, "area": 0}
        self.dropped = {"broken_geometry": 0}

    def _to_world(self, geom):
        return shapely.transform(geom, lambda xy: numpy.column_stack(self.city.project(xy[:, 0], xy[:, 1])), include_z=False)

    def _in_region(self, geom):
        minx, miny, maxx, maxy = geom.bounds
        return not (maxx < self.west or minx > self.east or maxy < self.south or miny > self.north)

    def _polygon(self, area):
        geom = self._to_world(shapely.from_wkb(self.wkb.create_multipolygon(area)))
        if geom.is_empty:
            raise ValueError("empty multipolygon")
        return geom.make_valid() if not geom.is_valid else geom

    def node(self, n):
        self.seen["node"] += 1
        tags = n.tags
        if not len(tags):
            return
        x, y = (float(v) for v in self.city.project(n.location.lon, n.location.lat))
        if not (self.west <= x <= self.east and self.south <= y <= self.north):
            return
        found = place_kind(tags)
        if not found:
            return
        t = pick(tags, PLACE_KEYS)
        t["kind_key"], t["kind"] = found
        self.layers.places.append((Point(x, y), t))

    def way(self, w):
        self.seen["way"] += 1
        tags = w.tags
        if not len(tags) or not any(k in tags for k in ("highway", "railway", "waterway")):
            return
        try:
            geom = self._to_world(shapely.from_wkb(self.wkb.create_linestring(w)))
        except Exception:
            self.dropped["broken_geometry"] += 1
            return
        if not self._in_region(geom):
            return
        L = self.layers
        if tags.get("highway") in ROAD_KINDS and tags.get("area") != "yes":
            L.roads.append((geom, pick(tags, ROAD_TAGS)))
        elif tags.get("railway") in RAIL_KINDS:
            L.rail.append((geom, pick(tags, RAIL_TAGS)))
        elif tags.get("waterway") in WATERLINE_KINDS:
            L.water_lines.append((geom, pick(tags, WATERLINE_TAGS)))

    def area(self, a):
        self.seen["area"] += 1
        tags = a.tags
        if not len(tags):
            return
        building = "building" in tags and tags["building"] != "no"
        road = tags.get("area") == "yes" and (tags.get("highway") in ROAD_KINDS or tags.get("place") == "square")
        water = is_water(tags)
        land = is_land(tags)
        found = place_kind(tags)
        if not (building or road or water or land or found):
            return
        try:
            geom = self._polygon(a)
        except Exception:
            self.dropped["broken_geometry"] += 1
            return
        if geom.is_empty or not self._in_region(geom):
            return
        L = self.layers
        if building:
            L.buildings.append((geom, pick(tags, BUILDING_TAGS)))
        elif road:
            L.road_areas.append((geom, pick(tags, ("highway", "place", "bridge", "tunnel", "layer", "surface", "ref"))))
        elif water:
            L.water.append((geom, pick(tags, WATER_TAGS)))
        elif land:
            L.land.append((geom, pick(tags, LAND_TAGS)))
        if found and "name" in tags:
            L.places.append((geom, {**pick(tags, PLACE_KEYS), "kind_key": found[0], "kind": found[1]}))


def extract(city, path, log=print):
    """-> Layers: everything the city needs from the extract at `path`, in the city's world metres."""
    t0 = time.time()
    ex = Extractor(city)
    # the area manager needs every node location; flex_mem keeps them in memory
    ex.apply_file(str(path), idx="flex_mem")
    ex.layers.meta = {"source": str(path), "seconds": round(time.time() - t0, 1), "seen": ex.seen, "dropped": ex.dropped}
    log(f"read in {ex.layers.meta['seconds']} s: {ex.seen}, dropped {ex.dropped}")
    return ex.layers


if __name__ == "__main__":
    c = of(sys.argv)
    ensure(c)
    src = sys.argv[2] if len(sys.argv) > 2 else osm_file(c)
    c.work.mkdir(parents=True, exist_ok=True)
    layers = extract(c, src)
    out = c.work / "osm.pkl"
    layers.save(out)
    for name in ("buildings", "roads", "road_areas", "rail", "water", "water_lines", "land", "places"):
        print(f"{name:<12} {len(getattr(layers, name)):>8}")
    print("->", out, f"{out.stat().st_size / 1048576:.0f} MB")
