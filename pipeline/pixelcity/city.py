"""A city: the piece of the world the map covers, the projection used everywhere in the pipeline, the raw data
it is built from, and the rules that are its own.

One city is one folder under cities/, and cities/<id>/city.json says all of this about it. What the pipeline
makes or keeps for a city lies under data/, in a folder of the city's id: data/work/<id>/ for what the steps keep
for one another, data/baked/<id>/ for what the page loads. The raw downloads are shared by every city that needs
them; sources.py says where each lies.

Usage: python -m pixelcity.city [id]      the cities there are, or one city's definition
"""
import json
import sys
from pathlib import Path

import numpy
import pyproj

ROOT = Path(__file__).resolve().parents[2]
CITIES = ROOT / "cities"
RAW = ROOT / "data" / "raw"
WORK = ROOT / "data" / "work"
BAKED = ROOT / "data" / "baked"
PALETTE = ROOT / "app" / "palette.json"   # the colours by name and in their order: the bake refers to them by it, and the page reads the same file
TILE_M = 1000                             # baked tiles are squares of this many metres
MARGIN_M = 3000                           # features may reach this far outside before they are dropped
REQUIRED = ("id", "name", "bounds", "epsg", "origin", "sources")


class City:
    """One city, as cities/<id>/city.json tells of it."""

    def __init__(self, folder):
        self.folder = Path(folder)
        path = self.folder / "city.json"
        if not path.exists():
            raise SystemExit(f"{path} is not there: a city is a folder under cities/ holding a city.json")
        self.definition = json.loads(path.read_text(encoding="utf-8"))
        missing = [key for key in REQUIRED if key not in self.definition]
        if missing:
            raise SystemExit(f"{path} does not say {', '.join(missing)}")
        if self.definition["id"] != self.folder.name:
            raise SystemExit(f"{path} says its id is {self.definition['id']!r}, but it lies in {self.folder.name}/")
        self.id = self.folder.name
        self.name, self.subtitle = self.definition["name"], self.definition.get("subtitle", "")
        # main urban area, west/south/east/north, degrees
        self.west, self.south, self.east, self.north = _numbers(self.definition, "bounds", 4, path)
        # metres, north up. The app's world is these metres minus the origin.
        self.epsg = int(self.definition["epsg"])
        self.origin_e, self.origin_n = _numbers(self.definition, "origin", 2, path)
        self._to_world = pyproj.Transformer.from_crs("EPSG:4326", f"EPSG:{self.epsg}", always_xy=True)
        self._to_lonlat = pyproj.Transformer.from_crs(f"EPSG:{self.epsg}", "EPSG:4326", always_xy=True)
        self.work, self.baked = WORK / self.id, BAKED / self.id

    @property
    def sources(self):
        """The raw data the city is built from, as city.json tells of it (sources.py reads it)."""
        return self.definition["sources"]

    @property
    def look(self):
        """The rules that are the city's own: which quarters are historic, where the tea hills are, and so on."""
        return self.definition.get("look", {})

    def curated(self, name):
        """A file of the city's folder (its landmarks, its aliases, its routes across open water), or None when it has none of that kind."""
        path = self.folder / name
        return path if path.exists() else None

    def project(self, lon, lat):
        """lon/lat (numbers or arrays) -> world metres from the origin, as numpy arrays (x east, y north)."""
        east, north = self._to_world.transform(numpy.asarray(lon, dtype=float), numpy.asarray(lat, dtype=float))
        return numpy.asarray(east) - self.origin_e, numpy.asarray(north) - self.origin_n

    def unproject(self, x, y):
        """world metres -> lon/lat."""
        return self._to_lonlat.transform(numpy.asarray(x, dtype=float) + self.origin_e, numpy.asarray(y, dtype=float) + self.origin_n)

    def bounds(self):
        """(west, south, east, north) of the region itself, in world metres."""
        xs, ys = self.project([self.west, self.east, self.east, self.west], [self.south, self.south, self.north, self.north])
        return float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())

    def corners(self):
        """The corners of the region in world metres: south-west, south-east, north-east, north-west."""
        xs, ys = self.project([self.west, self.east, self.east, self.west], [self.south, self.south, self.north, self.north])
        return [(float(x), float(y)) for x, y in zip(xs, ys, strict=True)]

    def shape(self):
        """The region as it stands on the ground: a rectangle turned by the convergence of the grid.

        In a transverse Mercator grid the region (a rectangle of longitude and latitude) is a quadrilateral whose
        edges run a degree or so off the grid axes, so its bounding box is not its outline. This is that outline, as
        the app needs it to shape the island: the centre, the direction of its east axis, and its half sizes.
        """
        sw, se, ne, nw = self.corners()
        dx, dy = se[0] - sw[0], se[1] - sw[1]
        length = (dx * dx + dy * dy) ** 0.5
        return {
            "cx": (sw[0] + ne[0]) / 2, "cy": (sw[1] + ne[1]) / 2, "cos": dx / length, "sin": dy / length,
            "halfWidth": length / 2,
            "halfHeight": ((nw[0] - sw[0]) ** 2 + (nw[1] - sw[1]) ** 2) ** 0.5 / 2,
        }

    def world_bounds(self):
        """(west, south, east, north) of the region plus its margin, in world metres."""
        west, south, east, north = self.bounds()
        return west - MARGIN_M, south - MARGIN_M, east + MARGIN_M, north + MARGIN_M


def _numbers(definition, key, count, path):
    """`count` numbers from a list in a definition, or a message saying what was wanted."""
    try:
        values = [float(v) for v in definition[key]]
        if len(values) != count:
            raise ValueError
    except (TypeError, ValueError):
        raise SystemExit(f"{path}: {key} must be {count} numbers ({'west, south, east, north' if key == 'bounds' else 'east, north'})")
    return values


def ids():
    """The cities there are, by id: the folders under cities/ that hold a city.json."""
    return sorted(path.parent.name for path in CITIES.glob("*/city.json"))


def load(city_id):
    """The city of that id; the message names the cities there are when there is no such one."""
    if not city_id:
        raise SystemExit(f"say which city: --city <id>   (cities: {', '.join(ids()) or 'none'})")
    if city_id not in ids():
        raise SystemExit(f"there is no city called {city_id!r} under cities/ (there are: {', '.join(ids()) or 'none'})")
    return City(CITIES / city_id)


def of(argv):
    """The city a step was asked for: `python -m pixelcity.<step> <id> [file]`."""
    if len(argv) < 2:
        raise SystemExit(f"usage: python -m {argv[0]} <city> [file]   (cities: {', '.join(ids()) or 'none'})")
    return load(argv[1])


def tile_index(x, y):
    """world metres -> 1 km tile indices (ix, iy)."""
    return int(x // TILE_M), int(y // TILE_M)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        print(json.dumps(load(sys.argv[1]).definition, ensure_ascii=False, indent=1))
    else:
        print(" ".join(ids()))
