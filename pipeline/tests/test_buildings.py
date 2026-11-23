"""Checks on the building list: which records repeat another one's footprint.

Run from the repository root:  .venv/bin/python -I -m unittest discover -s pipeline/tests -t .
"""
import sys
import unittest
from pathlib import Path

import shapely
from shapely.geometry import box

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from pixelcity.buildings import doubles


def record(geom, height, origin="globfp"):
    return {"geom": geom, "tags": {}, "match": None, "origin": origin, "height": height, "levels": None, "height_source": "globfp"}


def quiet(*args):
    pass


class DoublesTest(unittest.TestCase):
    def test_the_shorter_of_two_records_of_one_footprint_is_left_out(self):
        outline = box(0, 0, 12, 9)
        twice = doubles([record(outline, 9.3), record(box(0, 0, 12, 9), 6.2)], log=quiet)
        self.assertEqual(twice.tolist(), [False, True])

    def test_whichever_comes_first_is_kept_when_the_heights_are_equal(self):
        twice = doubles([record(box(0, 0, 12, 9), 9.0), record(box(0, 0, 12, 9), 9.0)], log=quiet)
        self.assertEqual(twice.tolist(), [False, True])

    def test_an_osm_outline_is_never_left_out(self):
        outline = box(0, 0, 12, 9)
        twice = doubles([record(outline, 20.0, origin="osm"), record(box(0, 0, 12, 9), 6.2)], log=quiet)
        self.assertEqual(twice.tolist(), [False, False])

    def test_outlines_that_only_share_a_bounding_box_are_different_buildings(self):
        ring = box(0, 0, 20, 20).difference(box(5, 5, 15, 15))
        courtyard = box(5, 5, 15, 15)
        twice = doubles([record(ring, 3.0), record(courtyard, 12.0)], log=quiet)
        self.assertEqual(twice.tolist(), [False, False])

    def test_buildings_that_merely_touch_are_not_the_same_building(self):
        twice = doubles([record(box(0, 0, 10, 10), 9.0), record(box(10, 0, 20, 10), 6.0)], log=quiet)
        self.assertEqual(twice.tolist(), [False, False])

    def test_of_three_records_the_tallest_is_kept(self):
        outline = shapely.geometry.polygon.orient(box(0, 0, 30, 8), sign=1)
        twice = doubles([record(outline, 12.0), record(shapely.geometry.polygon.orient(box(0, 0, 30, 8), sign=-1), 45.0), record(outline, 7.5)], log=quiet)
        self.assertEqual(twice.tolist(), [True, False, True])

    def test_outlines_that_differ_less_than_the_drawing_tolerance_are_one_footprint(self):
        # a corner moved by a metre, and an extra vertex on an edge: the same building as far as the map goes
        with_a_kink = shapely.Polygon([(0, 0), (6, 0.6), (12, 0), (12, 9), (0, 9)])
        twice = doubles([record(box(0, 0, 12, 9), 9.0), record(with_a_kink, 6.0)], log=quiet)
        self.assertEqual(twice.tolist(), [False, True])


if __name__ == "__main__":
    unittest.main()
