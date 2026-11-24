"""A city as its city.json tells of it: what the pipeline asks of one before it will work on it, and the projection
every step is given by it. The projection is checked against numbers the baked data of Hangzhou already holds.

Run from the repository root:  .venv/bin/python -I -m unittest discover -s pipeline/tests -t .
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from pixelcity import brands, city, sources

CITY = city.load("hz")          # these tests are written against Hangzhou: its places, its names
SAID = {"id": "x", "name": "X", "bounds": [0, 0, 1, 1], "epsg": 32651, "origin": [0, 0], "sources": {}}


def a_city(tmp, definition):
    """A folder under `tmp` holding a city.json that says `definition`."""
    folder = Path(tmp) / "x"
    folder.mkdir(exist_ok=True)
    (folder / "city.json").write_text(json.dumps(definition), encoding="utf-8")
    return folder


class TheCitiesThereAre(unittest.TestCase):
    def test_a_city_is_a_folder_under_cities_holding_a_definition_that_names_itself(self):
        self.assertEqual(city.ids(), sorted(city.ids()))
        self.assertIn("hz", city.ids())
        self.assertEqual(city.load("hz").folder, city.CITIES / "hz")
        self.assertEqual((CITY.id, CITY.name, CITY.subtitle), ("hz", "杭州", "主城区"))

    def test_saying_nothing_or_a_city_there_is_not_stops_with_the_cities_there_are(self):
        for asked in ("", None, "nothere"):
            with self.assertRaises(SystemExit) as stopped:
                city.load(asked)
            self.assertIn("hz", stopped.exception.code)

    def test_a_definition_must_say_what_the_pipeline_asks_of_it(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(city, "CITIES", Path(tmp)):
            for definition in ({**SAID, "id": "y"}, {key: value for key, value in SAID.items() if key != "sources"}, {**SAID, "bounds": [0, 0, 1]}):
                with self.assertRaises(SystemExit):
                    city.City(a_city(tmp, definition))
            made = city.City(a_city(tmp, SAID))
            self.assertEqual((made.id, made.west, made.east, made.epsg, made.origin_e, made.origin_n), ("x", 0.0, 1.0, 32651, 0.0, 0.0))
            self.assertEqual(city.ids(), ["x"])
            (Path(tmp) / "notes").mkdir()
            self.assertEqual(city.ids(), ["x"])


class TheProjection(unittest.TestCase):
    """The numbers every step had before the city was a file: those of the bake of Hangzhou."""

    @classmethod
    def setUpClass(cls):
        cls.index = json.loads((ROOT / "data" / "baked" / "hz" / "index.json").read_text(encoding="utf-8"))

    def test_the_bounds_and_the_origin_are_those_of_the_bake(self):
        for ours, theirs in zip(CITY.bounds(), self.index["bounds"], strict=True):
            self.assertAlmostEqual(ours, theirs, places=6)
        self.assertEqual([CITY.origin_e, CITY.origin_n], self.index["origin"])
        self.assertEqual(CITY.epsg, self.index["epsg"])

    def test_the_broken_bridge_is_projected_to_where_the_bake_stood_it(self):
        # (120.14703, 30.260901) is what the map gives for it; where the bake stood it is in its list of landmarks
        x, y = (float(v) for v in CITY.project(120.14703, 30.260901))
        self.assertAlmostEqual(x, 25504.038556383806, places=6)
        self.assertAlmostEqual(y, 11141.623219518457, places=6)

    def test_projecting_and_back_is_the_place(self):
        lon, lat = (float(v) for v in CITY.unproject(*CITY.project(120.2, 30.3)))
        self.assertAlmostEqual(lon, 120.2, places=9)
        self.assertAlmostEqual(lat, 30.3, places=9)

    def test_the_world_origin_is_the_origin_of_the_grid(self):
        x, y = (float(v) for v in CITY.project(*[float(v) for v in CITY.unproject(0.0, 0.0)]))
        self.assertAlmostEqual(x, 0.0, places=6)
        self.assertAlmostEqual(y, 0.0, places=6)

    def test_the_shape_is_that_of_the_bake(self):
        shape = CITY.shape()
        for key in ("cx", "cy", "cos", "sin", "halfWidth", "halfHeight"):
            self.assertAlmostEqual(shape[key], self.index["island"][key], places=6)

    def test_the_margin_and_the_tiles_are_the_same_whatever_the_city(self):
        west, south, east, north = CITY.bounds()
        self.assertEqual(CITY.world_bounds(), (west - city.MARGIN_M, south - city.MARGIN_M, east + city.MARGIN_M, north + city.MARGIN_M))
        self.assertEqual(city.tile_index(-1.0, 1000.0), (-1, 1))
        self.assertEqual(len(CITY.corners()), 4)            # the corners of a quadrilateral, not of its box: the grid is turned from the graticule

    def test_arrays_are_projected_as_arrays(self):
        x, y = CITY.project(numpy.array([120.0, 120.4]), numpy.array([30.12, 30.44]))
        self.assertEqual((x.shape, y.shape), ((2,), (2,)))


class WhatTheCityCarries(unittest.TestCase):
    def test_its_curated_files_are_those_of_its_folder(self):
        self.assertEqual(CITY.curated("landmarks.json"), CITY.folder / "landmarks.json")
        self.assertIsNone(CITY.curated("nothing.json"))

    def test_its_look_says_what_is_its_own(self):
        self.assertEqual(CITY.look["rivers"], ["钱塘", "之江"])
        for kind, count in (("historic", 11), ("tea", 1), ("modern", 4), ("templeGrounds", 1)):
            self.assertEqual(len(CITY.look[kind]), count, kind)
            for circle in CITY.look[kind]:
                self.assertEqual(len(circle["at"]), 2)
                self.assertGreater(circle["radius"], 0)
                if kind == "historic":
                    self.assertIsInstance(circle["village"], bool)

    def test_its_work_and_its_bake_are_in_folders_of_its_id(self):
        self.assertEqual((CITY.work, CITY.baked), (city.WORK / "hz", city.BAKED / "hz"))

    def test_the_circles_are_where_projecting_their_centres_puts_them(self):
        from pixelcity.classify import circles
        first = circles(CITY, "historic")[0]
        x, y = (float(v) for v in CITY.project(120.1465, 30.246))
        self.assertEqual((first["x"], first["y"]), (x, y))
        self.assertEqual(first["radius"], 1100.0)


class WhereTheRawDataLies(unittest.TestCase):
    def test_each_source_has_its_place_under_data_raw(self):
        self.assertEqual(sources.osm_file(CITY), sources.RAW / "osm" / "zhejiang-latest.osm.pbf")
        self.assertEqual(sources.dem_files(CITY), [sources.RAW / "dem" / "N30_00_E120_00.tif"])
        self.assertEqual(sources.landcover_files(CITY), [sources.RAW / "landcover" / "N30E120.tif"])
        self.assertEqual(sources.building_folders(CITY), [("2434", sources.RAW / "buildings" / "2434")])

    def test_one_tile_or_several_are_said_alike(self):
        for kind, tile, other in (("dem", "N30_00_E120_00", "N30_00_E121_00"), ("landcover", "N30E120", "N30E121")):
            said = {**CITY.definition, "sources": {**CITY.sources, kind: [tile, other]}}
            with mock.patch.object(CITY, "definition", said):
                files = sources.dem_files(CITY) if kind == "dem" else sources.landcover_files(CITY)
            self.assertEqual(files, [sources.RAW / f"{'dem' if kind == 'dem' else 'landcover'}" / f"{name}.tif" for name in (tile, other)])

    def test_the_tiles_named_must_reach_as_far_as_the_region(self):
        # Hangzhou's own tiles cover it; a region pushed east across the 121st meridian needs the tile next door
        self.assertEqual(sources.covering(CITY, "terrain", sources.dem_tiles(CITY), sources.dem_cell), ["N30_00_E120_00"])
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "hz"
            folder.mkdir()
            (folder / "city.json").write_text(json.dumps({**CITY.definition, "bounds": [120.0, 30.12, 121.4, 30.44]}), encoding="utf-8")
            wider = city.City(folder)
            with self.assertRaises(SystemExit) as stopped:
                sources.covering(wider, "terrain", sources.dem_tiles(wider), sources.dem_cell)
        self.assertIn("N30_00_E121_00", stopped.exception.code)
        self.assertIn("N30_00_E120_00", stopped.exception.code)

    def test_the_land_cover_is_covered_by_its_tiles_too(self):
        # the satellite map is cut three degrees a side: a region reaching south past the 30th parallel
        # asks for the tile that starts there, not for one per degree
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "hz"
            folder.mkdir()
            (folder / "city.json").write_text(json.dumps({**CITY.definition, "bounds": [120.0, 29.8, 121.4, 30.44]}), encoding="utf-8")
            wider = city.City(folder)
            with self.assertRaises(SystemExit) as stopped:
                sources.covering(wider, "land cover", sources.landcover_tiles(wider), sources.cover_cell)
        self.assertIn("N27E120", stopped.exception.code)


class BrandsTest(unittest.TestCase):
    """品牌编号必须全表唯一连续——BRND 段的字节就是它；曾有一个旧版 mark（按形状字典）定义
    排在后面把新定义覆盖，麦当劳挂上名创的红白格（D082 三补）。"""

    def test_marks_are_unique_and_in_order(self):
        marks = [brands.mark(brand) for brand in brands.TABLE]
        self.assertEqual(sorted(marks), list(range(len(marks))))


if __name__ == "__main__":
    unittest.main()
