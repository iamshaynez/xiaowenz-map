"""Checks on what the bake produces, done on the geometry itself rather than by looking at pictures.

Run from the repository root:  .venv/bin/python -I -m unittest discover -s pipeline/tests -t .
"""
import pickle
import sys
import unittest
from pathlib import Path

import numpy
import shapely

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from hz import bake, region  # noqa: E402


def triangle_area(points):
    a, b, c = points[:, 0], points[:, 1], points[:, 2]
    return numpy.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])) / 2


class CoarseMeshTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(region.WORK / "buildings.pkl", "rb") as f:
            buildings = pickle.load(f)
        # a spread of ordinary buildings, plus the largest outlines and those with several parts
        order = sorted(range(len(buildings)), key=lambda k: -buildings[k]["geom"].area)
        multi = [k for k, b in enumerate(buildings) if b["geom"].geom_type == "MultiPolygon"][:300]
        chosen = list(range(0, len(buildings), 997))[:400] + order[:60] + multi
        cls.geoms = numpy.asarray([buildings[k]["geom"] for k in chosen], dtype=object)
        cls.props = numpy.array([[2.0, 15.0, 5, 2, 0, 1, 2, k % 250, 0] for k in range(len(chosen))], dtype=float)

    def setUp(self):
        geoms, props = self.geoms, self.props
        section = bake.buildings_section(geoms, props, 30000.0, 10000.0)
        count, vertices, indices = numpy.frombuffer(section[:12], dtype="<u4")
        self.vertices = numpy.frombuffer(section, dtype="<f4", count=vertices * 6, offset=12 + count * 36).reshape(-1, 6)
        self.indices = numpy.frombuffer(section, dtype="<u4", count=indices, offset=12 + count * 36 + vertices * 24)
        self.count = int(count)

    def test_indices_address_real_vertices_in_whole_triangles(self):
        self.assertEqual(len(self.indices) % 3, 0)
        self.assertGreater(len(self.indices), 0)
        self.assertLess(int(self.indices.max()), len(self.vertices))
        self.assertTrue(numpy.isfinite(self.vertices).all())

    def test_roofs_cover_the_outlines(self):
        tops = self.vertices[self.vertices[:, 3] == 0]
        self.assertGreater(len(tops), 0)
        self.assertEqual(len(tops) % 3, 0, "roof vertices must come in triangles")
        roof_area = triangle_area(tops[:, :2].reshape(-1, 3, 2)).sum()
        outline_area = shapely.area(self.geoms).sum()
        # small courtyards are roofed over and outlines are simplified to 1.5 m, so allow a few percent
        self.assertGreater(roof_area, outline_area * 0.97)
        self.assertLess(roof_area, outline_area * 1.05)

    def test_walls_stand_on_the_ground_and_reach_the_roof(self):
        walls = self.vertices[self.vertices[:, 3] != 0]
        building = walls[:, 5].astype(int)
        low, high = self.props[building, 0], self.props[building, 0] + self.props[building, 1]
        height = walls[:, 2]
        self.assertTrue(numpy.isclose(height, numpy.where(numpy.isclose(height, low), low, high)).all())
        self.assertGreater(len(walls), 0)

    def test_wall_normals_point_outwards(self):
        # A step outwards from the middle of a wall leaves the outline; a step inwards stays inside.
        # The outlines tested against are the simplified ones the mesh was built from.
        polys, owner = bake.coarse_outlines(self.geoms)
        walls = self.vertices[self.vertices[:, 3] != 0]
        tested = 0
        # wall quads are four consecutive vertices; picking the wall vertices first keeps each quad together.
        # Very short walls are skipped: inside a shed a metre wide there is no "inside".
        for quad in walls.reshape(-1, 4, 6)[::13]:
            if numpy.hypot(*(quad[1, :2] - quad[0, :2])) < 2.0:
                continue
            corner = shapely.Point(quad[0, :2] + [30000, 10000])
            candidates = polys[owner == int(quad[0, 5])]
            polygon = next(p for p in candidates if p.exterior.distance(corner) < 0.001 or any(r.distance(corner) < 0.001 for r in p.interiors))
            middle = (quad[0, :2] + quad[1, :2]) / 2 + [30000, 10000]
            normal = quad[0, 3:5]
            step = 0.15
            inside = shapely.contains_xy(polygon, middle[0] - normal[0] * step, middle[1] - normal[1] * step)
            outside = shapely.contains_xy(polygon, middle[0] + normal[0] * step, middle[1] + normal[1] * step)
            self.assertTrue(inside and not outside, f"wall at {middle} with normal {normal} does not face out")
            tested += 1
        self.assertGreater(tested, 200)

    def test_every_building_with_area_is_drawn(self):
        drawn = numpy.unique(self.vertices[:, 5]).astype(int)
        self.assertEqual(drawn.tolist(), list(range(self.count)))


class TerrainSectionTest(unittest.TestCase):
    def test_grid_runs_north_to_south(self):
        grid = numpy.zeros((10, 10), dtype=numpy.int16)
        grid[0, :] = 100  # the northern row of the source grid
        info = (0.0, 0.0, 30.0, 10, 10)
        section = bake.terrain_section(0.0, 0.0, grid, info)
        nx, ny, x0, y0, step = numpy.frombuffer(section[:28], dtype=[("nx", "<u2"), ("ny", "<u2"), ("x0", "<f8"), ("y0", "<f8"), ("step", "<f8")])[0]
        heights = numpy.frombuffer(section, dtype="<i2", offset=28).reshape(ny, nx)
        self.assertEqual((nx, ny), (33, 33))
        self.assertEqual(heights[0, 0], 100, "the first row stored must be the northern edge")
        self.assertEqual(heights[-1, 0], 0)
        self.assertAlmostEqual(step, 1000 / 32)


if __name__ == "__main__":
    unittest.main()
