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

from hz import region
from hz.bake import FLAG_CLEARED, FLAG_ROOFTOP, rooftop_props
from hz.classify import FLOOR_M, JIANGNAN, ROOF_GABLE, ROOF_GREAT, ROOF_HIP, TEMPLE
from hz.ground import WATER_CANAL, WATER_LAKE, WATER_POND, WATER_RIVER, water_class
from hz.landmarks import cleared_around, cleared_mask
from hz.scene import FLAG_DATASET_OUTLINE, flag_cleared, in_water


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


class FlagClearedTest(unittest.TestCase):
    """The buildings a landmark built by hand replaces must be flagged in the properties the app reads.

    The bake used to count them and add the flag to an array of its own, after the properties had been
    written: nothing was flagged, and the data set's very tall "buildings" stood on top of the pagodas.
    """

    def setUp(self):
        # nine property floats, then the centre: base, height, levels, archetype, roof, wall, roofColour, seed, flags
        def row(x, y, flags=0, base=10.0, height=12.0):
            return [base, height, 4, 2, 0, 3, 4, 7, flags, x, y]
        # what the data set makes of a pagoda: three tall parts on its spot, with the flag of a data set outline
        self.props = numpy.array([row(0, 0, FLAG_DATASET_OUTLINE, height=70.8), row(-8, 0, FLAG_DATASET_OUTLINE, height=91.5), row(10, 0, FLAG_DATASET_OUTLINE, height=37.8),
                                  row(120, 0), row(0, 130)], dtype=numpy.float64)
        self.geoms = numpy.asarray([shapely.box(x - 10, y - 10, x + 10, y + 10) for x, y in [(0, 0), (-8, 0), (10, 0), (120, 0), (0, 130)]], dtype=object)
        self.clears = [(0.0, 0.0, 80.0)]

    def test_what_stands_in_the_disc_is_flagged_where_the_app_reads_it_and_nothing_else(self):
        cleared = flag_cleared(self.props, self.clears)
        self.assertEqual(cleared.tolist(), [True, True, True, False, False])
        flags = self.props[:, 8].astype(int)
        self.assertEqual([bool(f & FLAG_CLEARED) for f in flags], [True, True, True, False, False])

    def test_the_other_flags_are_kept(self):
        flag_cleared(self.props, self.clears)
        flags = self.props[:, 8].astype(int)
        self.assertTrue(all(f & FLAG_DATASET_OUTLINE for f in flags[:3]))
        self.assertEqual(flags[3], 0)

    def test_nothing_is_put_on_the_roofs_of_cleared_buildings(self):
        colours = {"roof_flat_grey": 9, "tile_red": 10, "roof_flat_dark": 11, "metal_pale": 12, "roof_silver": 13, "metal_dark": 14, "concrete_grey": 15}
        _, before = rooftop_props(self.geoms, self.props, colours)
        self.assertTrue((numpy.hypot(before[:, 9], before[:, 10]) <= 80).any(), "the unflagged buildings would have had props over the landmark")
        flag_cleared(self.props, self.clears)
        _, after = rooftop_props(self.geoms, self.props, colours)
        self.assertFalse((numpy.hypot(after[:, 9], after[:, 10]) <= 80).any(), "a rooftop prop stands over the landmark")
        self.assertEqual(after[:, 8].astype(int).tolist(), [FLAG_ROOFTOP] * len(after))


class TempleHallTest(unittest.TestCase):
    """The halls of a temple: known by their names and tags, and one tall storey high whatever the height data set says."""

    def classify(self, tags, height_source="globfp", levels=6, height=25.0, at=(120.09667, 30.24308)):
        """A building with these tags at Lingyin's Great Hall (inside the villages of the historic kind), or elsewhere."""
        from hz import classify as module
        x, y = region.project(*at)
        building = {"geom": shapely.box(x - 15, y - 10, x + 15, y + 10), "tags": tags, "height_source": height_source, "levels": levels, "height": height}
        terrain = numpy.zeros((10, 10))
        info = (x - 200.0, y - 200.0, 40.0, 10, 10)
        return module.classify([building], terrain, info, log=lambda *a: None)[0]

    def test_a_hall_called_by_its_name_is_a_temple_one_tall_storey_high(self):
        b = self.classify({"building": "yes", "name": "济公殿"})
        self.assertEqual(b["archetype"], TEMPLE)
        self.assertEqual((b["levels"], b["height"]), (1, FLOOR_M[TEMPLE]))
        self.assertEqual(b["height_source"], "inferred")
        self.assertEqual(b["roof"], ROOF_GREAT)

    def test_the_great_hall_is_taller_and_a_loft_has_two_storeys(self):
        self.assertEqual(self.classify({"building": "yes", "name": "大雄宝殿"})["height"], 14.0)
        self.assertEqual(self.classify({"building": "temple", "name": "大悲楼"})["levels"], 2)

    def test_a_pagoda_and_a_mapped_height_are_left_alone(self):
        pagoda = self.classify({"building": "pagoda", "name": "闸口白塔"})   # a pagoda keeps its measured height, even in a village
        self.assertEqual((pagoda["archetype"], pagoda["levels"], pagoda["height"]), (TEMPLE, 3, 25.0))   # the storeys follow the height at 9 m each
        self.assertEqual(pagoda["height_source"], "globfp")
        mapped = self.classify({"building": "temple", "name": "五百罗汉堂"}, height_source="osm:levels", levels=1, height=None)
        self.assertEqual(mapped["height_source"], "osm:levels")

    def test_inside_a_temple_grounds_an_unnamed_outline_is_a_hall(self):
        # Jingci Temple: OSM names the place and tags a few halls; the rest of its halls are plain outlines the
        # height data set calls fourteen-storey towers
        hall = self.classify({"building": "yes"}, height_source="globfp", levels=8, height=32.5, at=(120.14455, 30.23142))
        self.assertEqual((hall["archetype"], hall["height"]), (TEMPLE, FLOOR_M[TEMPLE]))
        shop = self.classify({"building": "retail", "name": "素斋"}, height_source="globfp", levels=8, height=32.5, at=(120.14455, 30.23142))
        self.assertNotEqual(shop["archetype"], TEMPLE)
        # and two hundred metres away, on the south shore road, the blocks are what they are
        block = self.classify({"building": "yes"}, height_source="globfp", levels=7, height=20.3, at=(120.1485, 30.2355))
        self.assertEqual((block["levels"], block["height_source"]), (7, "globfp"))

    def test_an_ordinary_block_of_flats_is_not_touched(self):
        flats = self.classify({"building": "yes", "name": "某某公寓"}, at=(120.1650, 30.2750))
        self.assertNotEqual(flats["archetype"], TEMPLE)
        self.assertEqual((flats["levels"], flats["height_source"]), (6, "globfp"))


class MappedRoofTest(unittest.TestCase):
    """A roof shape written down on the spot beats the height data set: a gabled house is not fourteen storeys."""

    def classify(self, tags, height_source="globfp", levels=15, height=44.2, width=25):
        from hz import classify as module
        x, y = region.project(120.1520, 30.2400)          # on the lake's south shore road, among old houses
        building = {"geom": shapely.box(x - width / 2, y - width / 2, x + width / 2, y + width / 2), "tags": tags, "height_source": height_source,
                    "levels": levels, "height": height}
        return module.classify([building], numpy.zeros((10, 10)), (x - 200.0, y - 200.0, 40.0, 10, 10), log=lambda *a: None)[0]

    def test_a_gabled_house_keeps_its_roof_and_loses_the_storeys(self):
        house = self.classify({"building": "yes", "roof:shape": "gabled", "roof:colour": "black"})
        self.assertEqual((house["archetype"], house["levels"], house["roof"], house["roof_colour"]), (JIANGNAN, 2, ROOF_GABLE, "tile_dark"))
        self.assertEqual(house["height_source"], "inferred")

    def test_a_mapped_height_still_stands_and_the_roof_is_drawn(self):
        block = self.classify({"building": "apartments", "roof:shape": "hipped"}, height_source="osm:levels", levels=6, height=None)
        self.assertEqual((block["levels"], block["height_source"], block["roof"]), (6, "osm:levels", ROOF_HIP))

    def test_without_a_roof_tag_nothing_changes(self):
        block = self.classify({"building": "yes"})
        self.assertEqual((block["levels"], block["height_source"]), (15, "globfp"))


class CorridorTest(unittest.TestCase):
    """A bridge built by hand clears the ground along its own length, and only there."""

    def setUp(self):
        import json
        import tempfile
        # a bridge 100 m long running east from the middle of the world, 9 m clear to each side; and a pagoda
        lon, lat = region.unproject(500.0, 0.0)
        rows = {"landmarks": [
            {"title": "the bridge", "group": "g", "lon": lon, "lat": lat, "angle": 0.0, "clear": 9, "clearSpan": 52.0, "kit": {"model": "archBridge"}},
            {"title": "the pagoda", "group": "g", "lon": lon, "lat": lat, "clear": 40.0, "kit": {"model": "pagoda"}},
        ]}
        self.folder = tempfile.TemporaryDirectory()
        file = Path(self.folder.name) / "landmarks.json"
        file.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        self.addCleanup(self.folder.cleanup)
        self.areas = cleared_around(file)

    def test_a_bridge_is_a_corridor_and_a_tower_a_disc(self):
        self.assertEqual([len(a) for a in self.areas], [5, 3])
        self.assertAlmostEqual(self.areas[0][0], 500.0, delta=0.5)
        # the corridor runs from 448 to 552 (half the 100 m, and two metres more), 9 m to each side; the pagoda's
        # disc, 40 m around the same middle, reaches the first two of the three points off the corridor
        xs = numpy.array([500.0, 540.0, 460.0, 554.0, 446.0, 530.0, 500.0, 470.0, 553.0, 600.0])
        ys = numpy.array([0.0, 6.0, -8.9, 0.0, 0.0, 9.5, 0.0, 20.0, 9.5, 0.0])
        self.assertEqual(cleared_mask(xs, ys, self.areas).tolist(), [True, True, True, False, False, True, True, True, False, False])

    def test_what_the_bake_flags_follows_the_corridor(self):
        def row(x, y):
            return [10.0, 12.0, 4, 2, 0, 3, 4, 7, 0, x, y]
        props = numpy.array([row(540, 5), row(460, -8), row(560, 0), row(540, 14), row(500, 30)], dtype=float)
        self.assertEqual(flag_cleared(props, self.areas).tolist(), [True, True, False, False, True])   # the last is the pagoda's disc


class WaterClassTest(unittest.TestCase):
    """What colour of water a mapped body gets."""

    def test_only_the_great_river_is_brown(self):
        self.assertEqual(water_class({"water": "river", "name": "钱塘江"}, 5e6), WATER_RIVER)
        self.assertEqual(water_class({"natural": "water", "water": "river", "name": "京杭大运河"}, 2e6), WATER_CANAL)
        self.assertEqual(water_class({"water": "river"}, 9e5), WATER_CANAL)             # a stream with no name is no great river

    def test_lakes_canals_and_ponds(self):
        self.assertEqual(water_class({"natural": "water", "water": "lake", "name": "西湖"}, 6e6), WATER_LAKE)
        self.assertEqual(water_class({"waterway": "canal"}, 0), WATER_CANAL)
        self.assertEqual(water_class({"natural": "water", "water": "pond"}, 3000), WATER_POND)
