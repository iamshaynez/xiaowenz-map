"""Checks on what the bake produces, done on the geometry itself rather than by looking at pictures.

Run from the repository root:  .venv/bin/python -I -m unittest discover -s pipeline/tests -t .
"""
import pickle
import struct
import sys
import unittest
from pathlib import Path

import numpy
import shapely

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from hz import bake, region


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


class PitchedRoofTest(unittest.TestCase):
    """Roofs of two slopes over rectangle-like outlines, and the boxes put on flat roofs."""

    HOUSE = shapely.box(0, 0, 12, 6).exterior.coords[:-1]
    RISE = min((3 + bake.EAVE_M) * bake.ROOF_SLOPE, bake.ROOF_RISE_MAX_M)

    def ridge_points(self, hip):
        verts, _ = bake.pitched_roof(self.HOUSE, 3.0, hip, 0, 0.0, 0.0)
        return verts[verts[:, 2] > 3.0 + self.RISE - 1e-3][:, :2]

    def test_the_eave_is_where_the_walls_end_and_the_ridge_is_one_rise_above_it(self):
        for hip in (False, True):
            verts, index = bake.pitched_roof(self.HOUSE, 3.0, hip, 0, 0.0, 0.0)
            self.assertEqual(len(index) % 3, 0)
            self.assertAlmostEqual(float(verts[:, 2].min()), 3.0, places=5)
            self.assertAlmostEqual(float(verts[:, 2].max()), 3.0 + self.RISE, places=4)

    def test_a_gable_ends_in_upright_walls_and_a_hip_in_slopes(self):
        tilt = lambda hip: numpy.linalg.norm(bake.pitched_roof(self.HOUSE, 3.0, hip, 0, 0.0, 0.0)[0][:, 3:5], axis=1)
        self.assertEqual(int((tilt(False) > 0.999).sum()), 6)                 # two triangular end walls
        self.assertEqual(int((tilt(True) > 0.999).sum()), 0)                  # none: the ends slope
        self.assertLess(numpy.ptp(self.ridge_points(True)[:, 0]), numpy.ptp(self.ridge_points(False)[:, 0]))   # so a hip's ridge is shorter

    def test_only_rectangle_like_outlines_get_slopes(self):
        geoms = numpy.asarray([shapely.box(0, 0, 12, 6), shapely.geometry.Polygon([(0, 0), (10, 0), (10, 4), (5, 4), (5, 9), (0, 9)])], dtype=object)
        props = numpy.array([[0, 3, 1, 1, bake.ROOF_GABLE, 0, 0, 0, 0], [0, 3, 1, 1, bake.ROOF_GABLE, 0, 0, 0, 0]], dtype=float)
        verts, _ = bake.coarse_mesh(*bake.coarse_outlines(geoms), props[:, 0], props[:, 0] + props[:, 1], 0, 0, roofs=props[:, 4])
        tilt = numpy.linalg.norm(verts[:, 3:5], axis=1)
        self.assertTrue(((tilt > 0.01) & (tilt < 0.99) & (verts[:, 5] == 0)).any())     # the rectangle is pitched
        self.assertFalse(((tilt > 0.01) & (tilt < 0.99) & (verts[:, 5] == 1)).any())    # the L is not...
        self.assertTrue(((tilt == 0) & (verts[:, 5] == 1)).any())                       # ...and keeps its flat cap

    def test_the_walls_are_the_same_whatever_the_roof(self):
        geoms = numpy.asarray([shapely.box(0, 0, 12, 6)], dtype=object)
        for roof in (bake.ROOF_FLAT, bake.ROOF_GABLE, bake.ROOF_HIP):
            props = numpy.array([[2.0, 3.0, 1, 1, roof, 0, 0, 0, 0]], dtype=float)
            verts, _ = bake.coarse_mesh(*bake.coarse_outlines(geoms), props[:, 0], props[:, 0] + props[:, 1], 0, 0, roofs=props[:, 4])
            top = 5.0 if roof == bake.ROOF_FLAT else 5.0 + min(3.45 * bake.ROOF_SLOPE, bake.ROOF_RISE_MAX_M)
            self.assertAlmostEqual(float(verts[:, 2].max()), top, places=4)
            # every point of the roof lies over the outline, allowing for the overhang of the eaves
            self.assertGreaterEqual(float(verts[:, 0].min()), -bake.EAVE_M - 1e-4)
            self.assertLessEqual(float(verts[:, 0].max()), 12 + bake.EAVE_M + 1e-4)

    def test_rooftop_boxes_stand_on_flat_roofs_only_and_inside_them(self):
        geoms = numpy.asarray([shapely.box(0, 0, 30, 12), shapely.box(0, 0, 1, 1), shapely.box(50, 0, 70, 10)], dtype=object)
        colour = {"tile_red": 8, "roof_flat_dark": 29, "metal_pale": 17, "roof_silver": 30, "metal_dark": 18, "roof_flat_grey": 28, "concrete_grey": 5}
        # a walk-up with a flat roof, a shed too small for anything, and a walk-up with a gable roof
        props = numpy.array([[3.0, 12.0, 4, 2, bake.ROOF_FLAT, 0, 28, 0, 0, 15, 6], [3.0, 2.5, 1, 10, bake.ROOF_FLAT, 0, 28, 0, 0, 0.5, 0.5],
                             [3.0, 12.0, 4, 2, bake.ROOF_GABLE, 0, 23, 0, 0, 60, 5]], dtype=float)
        boxes, rows = bake.rooftop_props(geoms, props, colour)
        self.assertGreater(len(rows), 0)
        for box, row in zip(boxes, rows, strict=True):
            self.assertTrue(geoms[0].buffer(-bake.ROOFTOP_INSET_M).contains(box))
            self.assertEqual(row[0], 15.0)                                           # on the roof of the first building
            self.assertEqual(row[8], bake.FLAG_ROOFTOP)
            self.assertEqual(row[4], bake.ROOF_FLAT)
        section = bake.roof_boxes_section(boxes, rows, 0.0, 0.0)
        self.assertEqual(struct.unpack_from("<I", section)[0], len(rows))
        self.assertEqual(len(section), 4 + 32 * len(rows))

    def test_a_halls_roof_climbs_higher_and_takes_a_hall_with_wings(self):
        # an outline that fills two thirds of its rectangle is no house, but a hall with wings will do for a great roof
        wings = numpy.asarray([shapely.geometry.Polygon([(0, 18), (24, 18), (24, 12), (18, 12), (18, 0), (6, 0), (6, 12), (0, 12)])], dtype=object)   # a T: two thirds of its rectangle
        hall = numpy.asarray([shapely.box(0, 0, 24, 18)], dtype=object)
        rise = min((9 + bake.EAVE_M) * bake.ROOF_SLOPE, numpy.inf)
        cases = [(wings, bake.ROOF_HIP, False, None), (wings, bake.ROOF_GREAT, True, None), (hall, bake.ROOF_HIP, True, min(rise, bake.ROOF_RISE_MAX_M)),
                 (hall, bake.ROOF_GREAT, True, min(rise, bake.GREAT_ROOF_RISE_MAX_M))]
        for geoms, roof, pitched, top in cases:
            props = numpy.array([[0, 9, 1, 8, roof, 0, 0, 0, 0]], dtype=float)
            verts, _ = bake.coarse_mesh(*bake.coarse_outlines(geoms), props[:, 0], props[:, 0] + props[:, 1], 0, 0, roofs=props[:, 4])
            tilt = numpy.linalg.norm(verts[:, 3:5], axis=1)
            self.assertEqual(bool(((tilt > 0.01) & (tilt < 0.99)).any()), pitched, (roof, geoms[0].bounds))
            if top is not None:
                self.assertAlmostEqual(float(verts[:, 2].max()), 9.0 + top, places=4)
        self.assertGreater(bake.GREAT_ROOF_RISE_MAX_M, bake.ROOF_RISE_MAX_M)


class SurfaceTest(unittest.TestCase):
    """The ground as the app draws it: what is laid on the ground must follow the mesh, not the DEM."""

    def grid(self):
        # rising to the north and to the east, 1 m per 30 m each way, from 10 m at the origin
        tnx = tny = 60
        rows = (tny - 1 - numpy.arange(tny))[:, None]
        return (10 + rows + numpy.arange(tnx)[None, :]), (0.0, 0.0, 30.0, tnx, tny)

    @staticmethod
    def cell(za, zb, zc, zd, u, v):
        """The height in a cell from its corners as the app's gridMesh names them (a south-west, b south-east,
        c north-west, d north-east): two triangles, a-c-b and b-c-d."""
        return za + (zb - za) * u + (zc - za) * v if u + v <= 1 else zd + (zc - zd) * (1 - u) + (zb - zd) * (1 - v)

    def test_a_flat_plateau_is_flat_everywhere(self):
        read = bake.surface(numpy.full((30, 30), 72.0), (7920.0, -8070.0, 30.0, 30, 30), 1000 / bake.TERRAIN_CELLS)
        for x, y in [(25159.0, 11421.0), (25003.1, 11496.7), (25999.9, 11999.9)]:
            self.assertAlmostEqual(float(read([x], [y])[0]), 72.0, places=6)

    def test_it_is_the_tile_grid_the_bake_writes_read_the_way_the_app_splits_a_cell(self):
        terrain, info = self.grid()
        step = 1000 / bake.TERRAIN_CELLS
        read = bake.surface(terrain, info, step)
        raw = bake.terrain_section(2000.0, 3000.0, terrain, info)
        nx, ny = struct.unpack_from("<HH", raw, 0)
        h = numpy.frombuffer(raw, dtype="<i2", count=nx * ny, offset=28).reshape(ny, nx).astype(float)   # row 0 is the north edge
        self.assertEqual((nx, ny), (bake.TERRAIN_CELLS + 1,) * 2)
        for a, b, u, v in [(5, 13, 0.09, 0.47), (5, 13, 0.6, 0.7), (0, 0, 0.5, 0.5), (31, 20, 0.2, 0.95)]:
            za, zb, zc, zd = h[ny - 1 - b, a], h[ny - 1 - b, a + 1], h[ny - 1 - b - 1, a], h[ny - 1 - b - 1, a + 1]
            self.assertAlmostEqual(float(read([2000 + (a + u) * step], [3000 + (b + v) * step])[0]), self.cell(za, zb, zc, zd, u, v), places=6, msg=(a, b, u, v))

    def test_the_two_triangles_meet_along_the_diagonal(self):
        terrain, info = self.grid()
        step = 1000 / bake.TERRAIN_CELLS
        read = bake.surface(terrain, info, step)
        for u in (0.0, 0.3, 0.7, 1.0):
            x, y = 2000 + (5 + u) * step, 3000 + (13 + 1 - u) * step
            self.assertAlmostEqual(float(read([x], [y - 1e-6])[0]), float(read([x], [y + 1e-6])[0]), places=6)

    def test_the_overview_reads_its_own_mesh(self):
        terrain, info = self.grid()
        extent = (1000.0, 1000.0, 9)                      # a 125 m mesh of 9 corners a side over the middle of the grid
        read = bake.surface(terrain, info, 125.0, extent)
        gx0, gy0, cell, tnx, tny = info

        def corner(a, b):                                 # the nearest cell of the DEM to a corner of the mesh
            col = int(numpy.clip(numpy.rint((1000 + a * 125.0 - gx0) / cell - 0.5), 0, tnx - 1))
            row = int(numpy.clip(numpy.rint((gy0 + tny * cell - (1000 + b * 125.0)) / cell - 0.5), 0, tny - 1))
            return terrain[row, col]

        for a, b, u, v in [(2, 3, 0.2, 0.3), (4, 1, 0.8, 0.6), (6, 6, 0.5, 0.5)]:
            expected = self.cell(corner(a, b), corner(a + 1, b), corner(a, b + 1), corner(a + 1, b + 1), u, v)
            self.assertAlmostEqual(float(read([1000 + (a + u) * 125.0], [1000 + (b + v) * 125.0])[0]), float(expected), places=6, msg=(a, b, u, v))
        west, south, across, up = bake.coarse_grid_extent()
        self.assertEqual((west % 125.0, south % 125.0), (0.0, 0.0))
        self.assertGreater(across * up, 100)


if __name__ == "__main__":
    unittest.main()
