"""Checks on the pieces of the bake that decide what is on the map: the outline of the region, and which
buildings are left out for standing in water.

Run from the repository root:  .venv/bin/python -I -m unittest discover -s pipeline/tests -t .
"""
import sys
import unittest
from pathlib import Path

import numpy
import shapely

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from hz import region  # noqa: E402
from hz.scene import in_water  # noqa: E402


class RegionShapeTest(unittest.TestCase):
    def test_the_corners_are_the_corners_of_the_shape(self):
        """In the shape's own frame the region must be the rectangle it is on the globe."""
        shape = region.region_shape()
        half_w, half_h = shape["halfWidth"], shape["halfHeight"]
        for x, y in region.region_corners():
            dx, dy = x - shape["cx"], y - shape["cy"]
            local_x = dx * shape["cos"] + dy * shape["sin"]
            local_y = -dx * shape["sin"] + dy * shape["cos"]
            # the meridians converge over 40 km, so the far edge is some 60 m shorter than the near one
            self.assertAlmostEqual(abs(local_x), half_w, delta=100)
            self.assertAlmostEqual(abs(local_y), half_h, delta=100)

    def test_the_shape_is_turned_from_the_grid(self):
        """The bounding box is wider than the region by what the turn adds; the app used to take the box for the outline."""
        shape = region.region_shape()
        west, south, east, north = region.region_bounds()
        self.assertLess(abs(shape["cos"] - 1.0), 0.001)           # the east axis points east, to within a degree or so
        self.assertGreater((east - west) / 2 - shape["halfWidth"], 200)
        self.assertGreater((north - south) / 2 - shape["halfHeight"], 200)

    def test_the_axes_are_unit_vectors_and_orthogonal(self):
        shape = region.region_shape()
        self.assertAlmostEqual(shape["cos"] ** 2 + shape["sin"] ** 2, 1.0, places=12)
        self.assertGreater(shape["halfWidth"], 38000 / 2 - 100)
        self.assertGreater(shape["halfHeight"], 35000 / 2 - 100)


class InWaterTest(unittest.TestCase):
    def setUp(self):
        # a lake 200 m across, and a puddle too small to matter
        self.lake = shapely.box(1000, 1000, 1200, 1200)
        self.puddle = shapely.box(500, 500, 505, 505)
        self.water = shapely.union_all([self.lake, self.puddle])

    def test_buildings_in_the_lake_are_left_out_and_those_on_land_are_kept(self):
        geoms = numpy.asarray([shapely.box(1050, 1050, 1060, 1060), shapely.box(2000, 2000, 2020, 2020)], dtype=object)
        self.assertEqual(list(in_water(geoms, self.water)), [True, False])

    def test_a_building_mostly_over_water_counts_and_one_mostly_on_land_does_not(self):
        # 10 m wide boxes straddling the lake's edge: one with 8 m over the water, one with 3 m
        mostly_over = shapely.box(1192, 1050, 1202, 1060)
        mostly_on = shapely.box(1197, 1050, 1207, 1060)
        geoms = numpy.asarray([mostly_over, mostly_on], dtype=object)
        self.assertEqual(list(in_water(geoms, self.water)), [True, False])

    def test_a_puddle_does_not_sink_anything(self):
        geoms = numpy.asarray([shapely.box(490, 490, 515, 515)], dtype=object)
        self.assertEqual(list(in_water(geoms, self.water)), [False])

    def test_an_island_in_the_lake_keeps_its_building(self):
        ring = shapely.box(1000, 1000, 1200, 1200).exterior.coords[::-1]
        hole = shapely.box(1090, 1090, 1110, 1110).exterior.coords
        lake_with_island = shapely.Polygon(ring, [hole])
        geoms = numpy.asarray([shapely.box(1092, 1092, 1108, 1108)], dtype=object)
        self.assertEqual(list(in_water(geoms, lake_with_island)), [False])

    def test_water_in_several_parts(self):
        water = shapely.MultiPolygon([shapely.box(0, 0, 20, 20), shapely.box(20, 0, 40, 20)])   # two parts, touching
        geoms = numpy.asarray([shapely.box(5, 5, 35, 15)], dtype=object)                           # lies in both
        self.assertEqual(list(in_water(geoms, water)), [True])


if __name__ == "__main__":
    unittest.main()
