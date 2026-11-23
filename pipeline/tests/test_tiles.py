"""A city that reaches across degree boundaries: several tiles of terrain put side by side, squares of land cover
read from every tile that covers them, footprints taken from every tile that reaches in, and the checks that stop
when the tiles named do not reach as far as the region.

The tiles here are small synthetic ones, written as the real ones are written (a GeoTIFF with its pixel scale and
tiepoint), laid on one pixel lattice but not on whole degrees, so that the merge is proven where the tiles meet
away from a corner.

Run from the repository root:  .venv/bin/python -I -m unittest discover -s pipeline/tests -t pipeline/tests
"""
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import numpy
import shapefile
import tifffile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from pixelcity import city, globfp, landcover, sources, terrain

QUIET = lambda *words: None
SCALE = 0.01          # degrees a pixel, one for both kinds of tile
SIDE = 40             # pixels a side: a tile is 0.4 degrees across


def dem_tile(path, west, north, height_of):
    """A GLO-30 tile as the real ones are made: lat/lon, one value a pixel, the tiepoint at the north-west corner."""
    lat = north - (numpy.arange(SIDE) + 0.5) * SCALE
    grid = numpy.tile(height_of(lat)[:, None], (1, SIDE)).astype(numpy.float32)
    tifffile.imwrite(path, grid, extratags=[(33550, "d", 3, (SCALE, SCALE, 0.0), True),
                                            (33922, "d", 6, (0.0, 0.0, 0.0, west, north, 0.0), True)])


def cover_tile(path, west, north, classes):
    """A WorldCover tile: one class a pixel, as many rows as the classes say."""
    tifffile.imwrite(path, classes, extratags=[(33550, "d", 3, (SCALE, SCALE, 0.0), True),
                                               (33922, "d", 6, (0.0, 0.0, 0.0, west, north, 0.0), True)])


class ARegionOfTwoTiles(unittest.TestCase):
    """A region that straddles a boundary: the terrain of two tiles is one ground without a tear, the land cover
    takes each square from the tile that covers it, the footprints come from every tile that reaches in."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        raw = Path(cls.tmp.name) / "raw"
        (raw / "dem").mkdir(parents=True)
        (raw / "landcover").mkdir(parents=True)
        # two terrain tiles on one lattice: 30.6-31.0 north and 31.0-31.4 north, and the ground rising ten metres
        # a kilometre without a tear where they meet
        dem_tile(raw / "dem" / "N30_00_E120_00.tif", 120.0, 31.0, lambda lat: lat * 1000)
        dem_tile(raw / "dem" / "N31_00_E120_00.tif", 120.0, 31.4, lambda lat: lat * 1000)
        # two land-cover tiles over the same ground, both of them the full height of the region: woods west of
        # 120.2, crops east of it
        cover_tile(raw / "landcover" / "N30E120.tif", 120.0, 31.4, numpy.full((2 * SIDE, SIDE), landcover.TREE, dtype=numpy.uint8))
        cover_tile(raw / "landcover" / "N31E120.tif", 120.2, 31.4, numpy.full((2 * SIDE, SIDE), landcover.CROPLAND, dtype=numpy.uint8))
        cities = Path(cls.tmp.name) / "cities" / "x"
        cities.mkdir(parents=True)
        said = {"id": "x", "name": "X", "bounds": [120.05, 30.85, 120.35, 31.15], "epsg": 32651, "origin": [0, 0],
                "sources": {"osm": "https://example.org/x.pbf",
                            "buildings": {"tile": ["2434", "2435"], "url": "https://example.org/parts"},
                            "dem": ["N30_00_E120_00", "N31_00_E120_00"], "landcover": ["N30E120", "N31E120"]}}
        (cities / "city.json").write_text(json.dumps(said), encoding="utf-8")
        for patch in (mock.patch.object(city, "CITIES", Path(cls.tmp.name) / "cities"), mock.patch.object(sources, "RAW", raw)):
            patch.start()
            cls.addClassCleanup(patch.stop)
        cls.raw = raw
        cls.city = city.load("x")
        cls.city.work.mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_the_terrain_of_two_tiles_is_one_ground_without_a_tear(self):
        metres = terrain.build(self.city, log=QUIET)[::-1]      # back to rows from the south, where latitude grows
        x0, y0, nx, ny, cell = terrain.grid_bounds(self.city)
        lon, lat = self.city.unproject(numpy.tile(x0 + (numpy.arange(nx) + 0.5) * cell, ny), numpy.repeat(y0 + (numpy.arange(ny) + 0.5) * cell, nx))
        lon, lat = lon.reshape(ny, nx), lat.reshape(ny, nx)
        self.assertLessEqual(float(numpy.abs(metres - lat * 1000).max()), 1.5)

    def test_the_land_cover_is_read_from_the_tile_that_covers_each_square(self):
        classes, x0, y0, step = landcover.world_grid(self.city, self.city.bounds(), log=QUIET)
        grid = (classes, x0, y0, step)
        west, south, east, north = self.city.bounds()           # world metres
        middle = (north + south) / 2
        for x, wanted in ((west + (east - west) * 0.25, landcover.TREE), (west + (east - west) * 0.75, landcover.CROPLAND)):
            self.assertEqual(int(landcover.class_at(grid, numpy.array([x]), numpy.array([middle]))[0]), wanted)

    def test_a_region_across_a_boundary_is_covered_by_the_tiles_it_names(self):
        self.assertEqual(sources.covering(self.city, "terrain", sources.dem_tiles(self.city), sources.dem_cell),
                         ["N30_00_E120_00", "N31_00_E120_00"])
        self.assertEqual(sources.covering(self.city, "land cover", sources.landcover_tiles(self.city), sources.cover_cell),
                         ["N30E120", "N31E120"])

    def test_terrain_beyond_the_tiles_stops_and_names_the_tile_wanted(self):
        self.addCleanup(setattr, self.city, "east", self.city.definition["bounds"][2])
        self.city.east = 120.5                                  # the region reaches past the tiles, which end at 120.4
        with self.assertRaises(SystemExit) as stopped:
            terrain.build(self.city, log=QUIET)
        self.assertIn("do not cover the region", stopped.exception.code)
        self.assertIn("N30_00_E120_00", stopped.exception.code)

    def test_land_cover_beyond_the_tiles_stops_and_names_the_tile_wanted(self):
        self.addCleanup(setattr, self.city, "east", self.city.definition["bounds"][2])
        self.city.east = 120.7                                  # past the tile east of 120.2, which ends at 120.6
        with self.assertRaises(SystemExit) as stopped:
            landcover.world_grid(self.city, self.city.bounds(), log=QUIET)
        self.assertIn("do not cover the region", stopped.exception.code)
        self.assertIn("N30E120", stopped.exception.code)

    def test_footprints_come_from_every_tile_that_reaches_in(self):
        for tile, lon in (("2434", 120.1), ("2435", 120.3)):
            folder = self.raw / "buildings" / tile
            folder.mkdir(parents=True, exist_ok=True)
            writer = shapefile.Writer(str(folder / f"{tile}_tile"), shapeType=shapefile.POLYGON)
            writer.field("Height", "N", decimal=2)
            writer.field("type", "C", size=20)
            writer.poly([[(lon, 30.9), (lon + 0.01, 30.9), (lon + 0.01, 30.95), (lon, 30.95), (lon, 30.9)]])
            writer.record(25.0, "residential")
            writer.close()
        paths = sources.footprints_files(self.city)
        self.assertEqual([path.parent.name for path in paths], ["2434", "2435"])
        items = globfp.load(self.city, paths, log=QUIET)
        self.assertEqual([tags["height"] for _, tags in items], [25.0, 25.0])
        for (geom, _), lon in zip(items, (120.1, 120.3), strict=True):
            wx, wy = self.city.project(lon + 0.005, 30.925)
            self.assertAlmostEqual(geom.centroid.x, wx, delta=0.5)   # a tall square of lat/lon shears a little in the projection
            self.assertAlmostEqual(geom.centroid.y, wy, delta=0.5)


class TheArchives(unittest.TestCase):
    """A tile of footprints that comes as a zip is unpacked the way a tile put here by hand would lie."""

    def test_what_the_archive_holds_under_one_folder_comes_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "2433.zip"
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("2433_121.25_31.25_122.5_32.5_jiangsuCN_shanghaiCN/2433_x.shp", b"shape")
                z.writestr("2433_121.25_31.25_122.5_32.5_jiangsuCN_shanghaiCN/2433_x.dbf", b"data")
            folder = Path(tmp) / "2433"
            folder.mkdir()
            sources.unpack(archive, folder)
            self.assertEqual(sorted(p.name for p in folder.iterdir()), ["2433_x.dbf", "2433_x.shp"])

    def test_what_the_archive_holds_loose_stays_loose_and_nothing_leaves_the_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "t.zip"
            with zipfile.ZipFile(archive, "w") as z:
                z.writestr("t.shp", b"shape")
                z.writestr("sub/t.dbf", b"data")
                z.writestr("../escape.shp", b"no")
            folder = Path(tmp) / "t"
            folder.mkdir()
            with self.assertRaises(ValueError):
                sources.unpack(archive, folder)
            self.assertEqual(list(folder.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
