"""The index of names the page searches by: how ways under one name are made one road, how a node, an outline
and a piece of ground under one name are made one thing, what is left out, the landmarks, aliases, and the file.

Run from the repository root:  .venv/bin/python -I -m unittest discover -s pipeline/tests -t pipeline/tests
"""
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

import numpy
from shapely.geometry import LineString, Point, box

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from pixelcity import city, ground, names
from pixelcity.bake import container
from pixelcity.osm_extract import Layers

CITY = city.load("hz")          # these tests are written against Hangzhou: its places, its names

BUILDING, PLACE, WATER, ROAD, LANDMARK = names.BUILDING, names.PLACE, names.WATER, names.ROAD, names.LANDMARK
OX, OY = (float(v) for v in CITY.project(120.20, 30.30))          # a point well inside the region
FLAT = lambda x, y: 10.0 + numpy.zeros(numpy.shape(x))              # the ground at ten metres everywhere
SLOPE = lambda x, y: (numpy.asarray(x, dtype=float) - OX) / 100.0   # rising a metre every hundred metres eastwards
QUIET = {"log": lambda *a: None}


def way(x0, y0, x1, y1, name, **tags):
    return LineString([(OX + x0, OY + y0), (OX + x1, OY + y1)]), {"highway": "residential", "name": name, **tags}


def piece(x0, y0, x1, y1, name, **tags):
    return box(OX + x0, OY + y0, OX + x1, OY + y1), {"name": name, **tags}


def village(x, y, name):
    return Point(OX + x, OY + y), {"name": name, "kind_key": "place", "kind": "village"}


def at(columns, name):
    """The rows, by number, of the things called `name`."""
    return [k for k, other in enumerate(columns["names"]) if other == name]


def said(columns, k):
    """What the thing in row `k` is."""
    return columns["labels"][columns["label"][k]]


def drawn(columns, points, k):
    """The x and y of what is drawn for the thing in row `k`, breaks included."""
    first, count = columns["line"][k]
    return points["x"][first:first + count], points["y"][first:first + count]


class RoadTest(unittest.TestCase):
    def setUp(self):
        self.osm = Layers()
        self.osm.places += [village(100, 100, "甲村"), village(3000, 300, "乙村")]    # for saying where a name borne twice is

    def collect(self):
        return names.collect(CITY, self.osm, [], FLAT, **QUIET)

    def test_ways_that_meet_are_one_road_and_a_piece_far_away_is_another(self):
        self.osm.roads += [way(0, 0, 200, 0, "文三路"), way(200, 0, 450, 0, "文三路", highway="tertiary"), way(3000, 0, 3200, 0, "文三路")]
        rows, points = self.collect()
        near, far = at(rows, "文三路")
        self.assertEqual([rows["kinds"][near], rows["kinds"][far]], [ROAD, ROAD])
        self.assertAlmostEqual(rows["size"][near], 450, delta=1)
        self.assertAlmostEqual(rows["size"][far], 200, delta=1)
        self.assertEqual(said(rows, near), "支路")                                  # said by its longest way
        self.assertEqual([rows["near"][str(near)], rows["near"][str(far)]], ["甲村", "乙村"])
        self.assertEqual(rows["box"][near], [round(OX), round(OY), round(OX + 450), round(OY)])
        self.assertEqual([rows["line"][near], rows["line"][far]], [[0, 4], [4, 2]])  # two ways of two points, then one
        self.assertEqual([rows["z"][near], rows["z"][far]], [10.0, 10.0])
        self.assertEqual(set(points["z"][:6].tolist()), {80})                         # ten metres in eighths

    def test_pieces_that_do_not_join_are_drawn_apart(self):
        self.osm.roads += [way(0, 0, 200, 0, "灵山线"), way(1000, 0, 1200, 0, "灵山线")]
        rows, points = self.collect()
        first, count = rows["line"][at(rows, "灵山线")[0]]
        xs = points["x"][first:first + count]
        self.assertEqual(count, 5)                                               # two points, a break, two points
        self.assertTrue(numpy.isnan(xs[2]) and numpy.isclose(xs[1], OX + 200) and numpy.isclose(xs[3], OX + 1000))

    def test_a_name_left_unnamed_between_two_pieces_keeps_one_road(self):
        self.osm.roads += [way(0, 0, 200, 0, "灵山线"), way(1000, 0, 1200, 0, "灵山线")]
        self.osm.roads += [way(0, 5000, 200, 5000, "创业路"), way(1500, 5000, 1700, 5000, "创业路")]
        rows = self.collect()[0]
        self.assertEqual((len(at(rows, "灵山线")), len(at(rows, "创业路"))), (1, 2))

    def test_a_bridge_floats_above_the_ground_and_a_tunnel_is_drawn_on_the_ground_over_it(self):
        self.osm.roads += [way(0, 0, 200, 0, "钱塘江大桥", bridge="yes"), way(0, 1000, 200, 1000, "紫之隧道", tunnel="yes")]
        rows, points = names.collect(CITY, self.osm, [], SLOPE, **QUIET)
        bridge, tunnel = at(rows, "钱塘江大桥")[0], at(rows, "紫之隧道")[0]
        first, count = rows["line"][bridge]
        self.assertEqual(set(points["z"][first:first + count].tolist()), {round((2.0 + ground.CLEARANCE) * 8)}, "the deck: six metres over the highest ground under it")
        self.assertEqual(said(rows, bridge), "桥")
        first, count = rows["line"][tunnel]
        self.assertAlmostEqual(points["z"][first + count - 1] / 8, 2.0, delta=0.2)
        self.assertEqual(said(rows, tunnel), "隧道")

    def test_the_course_is_the_way_simplified_and_cut_at_the_edge(self):
        dense = LineString([(OX + k * 10, OY + math.sin(k / 20) * 0.05) for k in range(21)])
        self.osm.roads += [(dense, {"highway": "primary", "name": "直路"}), way(0, -2000, 200000, -2000, "长路")]
        rows, points = self.collect()
        self.assertEqual(rows["line"][at(rows, "直路")[0]][1], 2)                    # a line that wanders less than POINT_M is straight
        first, count = rows["line"][at(rows, "长路")[0]]
        east = CITY.bounds()[2] + names.EDGE_M
        self.assertLessEqual(points["x"][first + count - 1], east + 1)
        self.assertGreater(points["x"][first + count - 1], east - 100)

    def test_what_a_road_is_called(self):
        for kind, name, tags, label in [("motorway", "沪昆高速", {}, "高速公路"), ("motorway_link", "沪昆高速", {}, "匝道"), ("trunk", "秋石高架路", {"bridge": "yes"}, "高架"),
                                        ("trunk", "上德立交", {}, "立交"), ("primary", "复兴大桥", {"bridge": "yes"}, "桥"), ("primary", "复兴大桥", {}, "主干道"),
                                        ("pedestrian", "河坊街", {}, "步行街"), ("unclassified", "白堤", {}, "街巷"), ("trunk", "紫之隧道", {"tunnel": "yes"}, "隧道")]:
            with self.subTest(name=name, kind=kind, tags=tags):
                self.assertEqual(names.road_label({"highway": kind, **tags}, name), label)
        self.assertEqual((names.rail_label({}, "杭州地铁1号线"), names.rail_label({}, "杭海城际"), names.rail_label({}, "沪昆高速线"), names.rail_label({}, "宣杭线")),
                         ("地铁", "城际铁路", "高速铁路", "铁路"))


class LeftOutTest(unittest.TestCase):
    def test_a_name_that_is_only_a_letter_or_a_part_s_label_is_left_out(self):
        for name in ("A", "B2", "12", "1#", "3幢", "B座", "东8", "6号", "五幢", "六号楼", "二区", "-2往站厅", "垂梯"):
            with self.subTest(name=name):
                self.assertFalse(names.meaningful(name))
        for name in ("文三路", "10号大街", "A座大楼", "Apple Store", "三潭印月", "西湖区"):
            with self.subTest(name=name):
                self.assertTrue(names.meaningful(name))

    def test_letters_lifts_and_subway_entrances_are_not_in_the_index(self):
        osm = Layers()
        osm.buildings += [piece(0, 0, 20, 20, "A", building="transportation"), piece(0, 0, 20, 20, "垂梯", building="transportation")]
        osm.places += [(Point(OX, OY), {"name": "B", "kind_key": "railway", "kind": "subway_entrance"}),
                       (Point(OX, OY), {"name": "龙翔桥", "kind_key": "railway", "kind": "subway_entrance"})]
        self.assertEqual(names.collect(CITY, osm, [], FLAT, **QUIET)[0]["names"], [])

    def test_nothing_outside_the_region_and_its_edge_is_kept(self):
        osm = Layers()
        far = CITY.bounds()[2] + names.EDGE_M + 500
        osm.buildings += [piece(0, 0, 10, 10, "城里的楼", building="yes"), piece(far - OX, 0, far - OX + 10, 10, "城外的楼", building="yes")]
        self.assertEqual(names.collect(CITY, osm, [], FLAT, **QUIET)[0]["names"], ["城里的楼"])


class OneThingTest(unittest.TestCase):
    def setUp(self):
        self.osm = Layers()

    def collect(self):
        return names.collect(CITY, self.osm, [], FLAT, **QUIET)[0]

    def test_a_school_is_one_thing_and_its_outline_says_where(self):
        self.osm.places += [(Point(OX + 5, OY + 5), {"name": "小营小学", "kind_key": "amenity", "kind": "school"})]
        self.osm.buildings += [piece(0, 0, 40, 20, "小营小学", building="yes"), piece(1000, 0, 1020, 20, "小营小学", building="yes")]
        self.osm.land += [piece(-10, -10, 60, 60, "小营小学", amenity="school")]
        rows = self.collect()
        self.assertEqual(len(at(rows, "小营小学")), 2)                               # the school, and another of the same name a kilometre off
        school = max(at(rows, "小营小学"), key=lambda k: rows["size"][k])
        self.assertEqual((rows["kinds"][school], said(rows, school)), (BUILDING, "学校"))   # what it is: the point of interest knows
        self.assertEqual(rows["size"][school], 70 * 70)                             # counted once, not once for each of the three
        self.assertEqual(rows["box"][school], [round(OX - 10), round(OY - 10), round(OX + 60), round(OY + 60)])
        self.assertTrue(-10 <= rows["x"][school] - OX <= 60 and -10 <= rows["y"][school] - OY <= 60)
        self.assertIsNone(rows["line"][school])
        self.assertIsNone(rows["near"].get(str(school)))                            # no village is mapped near it

    def test_a_station_and_the_square_above_it_are_two_things(self):
        self.osm.buildings += [piece(0, 0, 30, 30, "武林广场", building="train_station")]
        self.osm.places += [(box(OX - 5, OY - 5, OX + 80, OY + 80), {"name": "武林广场", "kind_key": "place", "kind": "square"}),
                            (Point(OX + 10, OY + 10), {"name": "武林广场", "kind_key": "public_transport", "kind": "station"})]
        rows = self.collect()
        rows_of = at(rows, "武林广场")
        self.assertEqual(len(rows_of), 2)                                           # the station's own point joined its outline; the square did not
        self.assertEqual(sorted((rows["kinds"][k], said(rows, k)) for k in rows_of), [(BUILDING, "车站"), (PLACE, "广场")])
        self.osm.places.append(village(50, 50, "环北新村社区"))
        self.assertEqual(self.collect()["near"], {})                              # they lie together: one place, and no word to tell them apart

    def test_water_stays_water(self):
        self.osm.water += [(box(OX, OY, OX + 500, OY + 300), {"name": "西湖", "natural": "water", "water": "lake"})]
        self.osm.water_lines += [way(0, 1000, 3000, 1000, "钱塘江", waterway="river"), way(0, 2000, 3000, 2000, "上塘河", waterway="canal")]
        rows = self.collect()
        lake = at(rows, "西湖")[0]
        self.assertEqual((rows["kinds"][lake], said(rows, lake), rows["size"][lake]), (WATER, "湖", 150000))
        self.assertEqual([(rows["kinds"][k], said(rows, k)) for k in at(rows, "钱塘江")], [(WATER, "江")])
        self.assertEqual([said(rows, k) for k in at(rows, "上塘河")], ["运河"])

    def test_what_a_building_and_a_place_are(self):
        for tags, label in [({"building": "yes"}, ""), ({"building": "yes", "tourism": "hotel"}, "酒店"), ({"building": "yes", "amenity": "place_of_worship"}, "寺庙教堂"),
                            ({"building": "apartments"}, "住宅"), ({"building": "yes", "amenity": "school"}, "学校"), ({"building": "train_station", "name": "杭州东"}, "车站"),
                            ({"building": "train_station", "name": "停车列检库"}, "车辆段"), ({"building": "transportation", "name": "火车东站"}, "车站")]:
            with self.subTest(tags=tags):
                self.assertEqual(names.building_label(tags), label)
        self.assertEqual((names.place_label({"kind_key": "natural", "kind": "peak"}), names.place_label({"kind_key": "amenity", "kind": "school"}),
                          names.land_label({"landuse": "residential"}), names.land_label({"leisure": "park"}), names.land_label({"power": "plant"})),
                         ("山峰", "学校", "住宅区", "公园", ""))


class SheetTest(unittest.TestCase):
    """A river is a sheet of water with no name of its own, named by a line along it: the watercourse takes the water."""

    def setUp(self):
        self.osm = Layers()
        self.osm.water.append((box(OX, OY, OX + 3000, OY + 300), {"natural": "water", "water": "river"}))     # three kilometres long, three hundred metres wide

    def collect(self):
        return names.collect(CITY, self.osm, [], FLAT, **QUIET)

    def assertOnBank(self, rows, points, k):
        """Everything drawn for the thing in row `k` lies on the bank of the sheet, to the metre; and it comes in pieces."""
        xs, ys = drawn(rows, points, k)
        on = ~numpy.isnan(xs)
        self.assertGreater(int((~on).sum()), 0)                                    # a break after each piece
        self.assertTrue(on.any())
        self.assertTrue(((numpy.isclose(xs[on], OX, atol=1) | numpy.isclose(xs[on], OX + 3000, atol=1))
                         | (numpy.isclose(ys[on], OY, atol=1) | numpy.isclose(ys[on], OY + 300, atol=1))).all())

    def test_a_watercourse_in_a_nameless_sheet_is_the_water_of_it(self):
        self.osm.water_lines.append(way(0, 150, 3000, 150, "钱塘江", waterway="river"))
        rows, points = self.collect()
        k = at(rows, "钱塘江")[0]
        self.assertEqual((rows["sheets"], rows["kinds"][k], said(rows, k), rows["size"][k]), ([k], WATER, "江", 3000 * 300))
        self.assertEqual(rows["box"][k], [round(OX), round(OY), round(OX + 3000), round(OY + 300)])
        self.assertOnBank(rows, points, k)

    def test_a_sheet_shared_by_watercourses_of_several_names_is_split_between_them(self):
        self.osm.water_lines += [way(0, 150, 1500, 150, "甲江", waterway="river"), way(1500, 150, 3000, 150, "乙江", waterway="river")]
        rows, points = self.collect()
        west, east = at(rows, "甲江")[0], at(rows, "乙江")[0]
        self.assertEqual(sorted(rows["sheets"]), sorted([west, east]))
        # each the water nearest to its own course; the seam lies within a seed's spacing of where they meet
        for k in (west, east):
            self.assertAlmostEqual(rows["size"][k], 1500 * 300, delta=names.SEED_M * 300)
        self.assertGreaterEqual(rows["size"][west] + rows["size"][east], 0.99 * 3000 * 300)
        self.assertLessEqual(rows["size"][west] + rows["size"][east], 3000 * 300)
        self.assertOnBank(rows, points, west)                                     # the bank only: not the seam the split cut across the water
        self.assertOnBank(rows, points, east)

    def test_a_course_outside_any_sheet_and_a_lake_of_its_own_name_are_left_as_they_are(self):
        self.osm.water_lines.append(way(0, 1500, 3000, 1500, "钱塘江", waterway="river"))      # a kilometre and a quarter south of the sheet
        self.osm.water.append((box(OX + 5000, OY + 5000, OX + 5500, OY + 5400), {"name": "西湖", "natural": "water", "water": "lake"}))
        rows = self.collect()[0]
        river, lake = at(rows, "钱塘江")[0], at(rows, "西湖")[0]
        self.assertEqual((rows["sheets"], rows["size"][river], rows["line"][river][1]), ([], 3000, 2))   # the course it was mapped with
        self.assertEqual((rows["kinds"][lake], said(rows, lake), rows["size"][lake], rows["line"][lake]), (WATER, "湖", 500 * 400, None))


class LandmarkTest(unittest.TestCase):
    LANDMARKS = [{"id": "1-01", "title": "断桥残雪", "group": "西湖", "x": OX, "y": OY, "ground": 12.0, "parts": []},
                 {"id": "2-03", "title": "六和塔·钱塘江大桥", "group": "山水", "x": OX + 5000, "y": OY, "ground": 30.0, "parts": []}]

    def test_the_landmarks_are_there_under_their_titles_and_the_parts_of_them(self):
        rows = names.collect(CITY, Layers(), self.LANDMARKS, FLAT, **QUIET)[0]
        bridge, pagoda = at(rows, "断桥残雪")[0], at(rows, "六和塔·钱塘江大桥")[0]
        self.assertEqual([rows["kinds"][bridge], rows["landmark"][bridge], rows["z"][bridge]], [LANDMARK, "1-01", 12.0])
        self.assertEqual((rows["x"][pagoda], rows["landmark"][pagoda]), (round(OX + 5000, 1), "2-03"))
        self.assertEqual((rows["also"][str(pagoda)], said(rows, pagoda)), ("六和塔;钱塘江大桥", "山水"))
        self.assertNotIn(str(bridge), rows["also"])                                   # a title in one piece is not said twice

    def test_what_stands_under_a_landmark_called_as_it_is_is_the_landmark(self):
        osm = Layers()
        osm.buildings += [piece(-20, -20, 20, 20, "断桥残雪", building="yes"), piece(400, 0, 440, 40, "断桥残雪", building="yes")]
        osm.places += [(Point(OX + 20, OY + 20), {"name": "六和塔", "kind_key": "man_made", "kind": "tower"})]
        rows = names.collect(CITY, osm, self.LANDMARKS, FLAT, **QUIET)[0]
        self.assertEqual([rows["kinds"][k] for k in at(rows, "断桥残雪")], [LANDMARK, BUILDING])   # the one under it gives way; the other is kept
        self.assertEqual([rows["kinds"][k] for k in at(rows, "六和塔")], [PLACE])       # five kilometres from the pagoda, a tower of that name is not it

    def test_a_road_named_as_the_landmark_keeps_its_whole_course(self):
        osm = Layers()
        osm.roads += [way(0, -200, 0, 200, "断桥残雪", highway="steps", bridge="yes")]
        rows = names.collect(CITY, osm, self.LANDMARKS, FLAT, **QUIET)[0]
        self.assertEqual([rows["kinds"][k] for k in at(rows, "断桥残雪")], [LANDMARK, ROAD])   # the list's view of the bridge, and its course to draw

    def test_a_yard_s_track_is_left_out_and_a_line_is_kept(self):
        osm = Layers()
        for name, service in (("沪昆线", None), ("文三路站停车线", None), ("杭州东站25道", "siding"), ("出入场线", "yard")):
            tags = {"railway": "rail", "name": name, **({"service": service} if service else {})}
            osm.rail.append((LineString([(OX, OY + 3000), (OX + 400, OY + 3000)]), tags))
        osm.rail.append((LineString([(OX, OY + 4000), (OX + 400, OY + 4000)]), {"railway": "subway", "name": "杭州地铁1号线"}))
        rows = names.collect(CITY, osm, [], FLAT, **QUIET)[0]
        self.assertEqual(sorted(rows["names"]), sorted(["沪昆线", "杭州地铁1号线"]))
        self.assertEqual([said(rows, k) for k in at(rows, "沪昆线")], ["铁路"])

    def test_an_alias_is_found_by_and_has_to_point_at_something(self):
        rows = names.collect(CITY, Layers(), self.LANDMARKS, FLAT, {"断桥": "断桥残雪", "之江大桥": "六和塔·钱塘江大桥"}, **QUIET)[0]
        self.assertEqual(rows["also"][str(at(rows, "断桥残雪")[0])], "断桥")
        self.assertEqual(rows["also"][str(at(rows, "六和塔·钱塘江大桥")[0])], "六和塔;钱塘江大桥;之江大桥")
        with self.assertRaises(SystemExit):
            names.collect(CITY, Layers(), self.LANDMARKS, FLAT, {"小莲花": "网球中心"}, **QUIET)


class FileTest(unittest.TestCase):
    def test_the_file_reads_back_as_it_was_written(self):
        osm = Layers()
        osm.roads += [way(0, 0, 400, 0, "文三路", highway="secondary"), way(0, 0, 400, 0, "文三路", highway="secondary", **{"name:en": "Wensan Road", "alt_name": "文三街"})]
        osm.buildings += [piece(0, 1000, 60, 1040, "市民中心", building="yes")]
        columns, points = names.collect(CITY, osm, LandmarkTest.LANDMARKS, FLAT, **QUIET)
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / "names.bin"
            out.write_bytes(container([(b"NAME", json.dumps(columns, ensure_ascii=False, separators=(",", ":")).encode("utf-8")), (b"LINE", points.tobytes())]))
            read, course = names.read(out)
        self.assertEqual(read, json.loads(json.dumps(columns, ensure_ascii=False)))
        self.assertEqual(course.tobytes(), points.tobytes())
        for column in ("kinds", "x", "y", "z", "label", "size", "box", "line", "landmark"):
            self.assertEqual(len(read[column]), len(read["names"]), column)
        spans = [span for span in read["line"] if span]
        self.assertEqual([span[0] for span in spans], numpy.cumsum([0] + [span[1] for span in spans[:-1]]).tolist(), "one course after another")
        self.assertEqual(sum(span[1] for span in spans), len(course))
        self.assertEqual((course.itemsize, round(float(points["z"][0]) / 8, 1)), (10, 10.0))
        road = at(read, "文三路")[0]
        self.assertEqual((read["x"][road], read["also"][str(road)]), (round(OX + 200, 1), "Wensan Road;文三街"))
        self.assertEqual(read["x"][at(read, "市民中心")[0]], round(OX + 30, 1))


if __name__ == "__main__":
    unittest.main()
