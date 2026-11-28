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

from pixelcity import bake, city, compact, scene

CITY = city.load("hz")          # these tests are written against Hangzhou: its places, its names


def triangle_area(points):
    a, b, c = points[:, 0], points[:, 1], points[:, 2]
    return numpy.abs((b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (c[:, 0] - a[:, 0]) * (b[:, 1] - a[:, 1])) / 2


class CoarseMeshTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(CITY.work / "buildings.pkl", "rb") as f:
            buildings = pickle.load(f)
        # a spread of ordinary buildings, plus the largest outlines and those with several parts
        order = sorted(range(len(buildings)), key=lambda k: -buildings[k]["geom"].area)
        multi = [k for k, b in enumerate(buildings) if b["geom"].geom_type == "MultiPolygon"][:300]
        chosen = list(range(0, len(buildings), 997))[:400] + order[:60] + multi
        cls.geoms = numpy.asarray([buildings[k]["geom"] for k in chosen], dtype=object)
        cls.props = numpy.array([[2.0, 15.0, 5, 2, 0, 1, 2, k % 250, 0] for k in range(len(chosen))], dtype=float)
        west, south, east, north = shapely.bounds(cls.geoms).T
        cls.ox, cls.oy = float(numpy.median((west + east) / 2)), float(numpy.median((south + north) / 2))

    def setUp(self):
        geoms, props = self.geoms, self.props
        # the mesh as the bake builds it, with the middle of these buildings as the origin the bake would
        # take from a tile's corner. (The compact form the section packs it in is CompactFormsTest's subject:
        # the buildings here come from all over the region, too far apart for one tile's corner to serve them.)
        polys, owner = bake.coarse_outlines(geoms)
        self.vertices, self.indices = bake.coarse_mesh(polys, owner, props[:, 0], props[:, 0] + props[:, 1], self.ox, self.oy, roofs=props[:, 4])
        self.indices = self.indices.astype(numpy.int64)
        self.count = len(props)

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
        self.assertTrue(numpy.isclose(height, numpy.where(numpy.isclose(height, low, atol=0.02), low, high), atol=0.02).all())
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
            corner = shapely.Point(quad[0, :2] + [self.ox, self.oy])
            candidates = polys[owner == int(quad[0, 5])]
            polygon = next(p for p in candidates if p.exterior.distance(corner) < 0.001 or any(r.distance(corner) < 0.001 for r in p.interiors))
            middle = (quad[0, :2] + quad[1, :2]) / 2 + [self.ox, self.oy]
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
        rings = compact.TERRAIN_RINGS
        self.assertEqual((nx, ny), (33 + 2 * rings,) * 2)                    # the tile's grid and two rings beyond it
        self.assertEqual(heights[0, 0], 100, "the first row stored must be the northern edge")
        self.assertEqual(heights[-1, 0], 0)
        self.assertAlmostEqual(step, 1000 / 32)
        self.assertAlmostEqual(x0, -rings * step)                            # the rings lie west and south of the tile's corner
        self.assertAlmostEqual(y0, -rings * step)


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
        self.assertEqual(len(section), 4 + 11 * len(rows))
        back = compact.read_roof_boxes(section)
        self.assertTrue(numpy.isclose(back[:, 0], rows[:, 9], atol=0.021).all())
        self.assertTrue(numpy.isclose(back[:, 2], rows[:, 0], atol=0.013).all())            # the box stands on the roof it was put on

    def test_each_rooftop_box_says_which_building_it_stands_on(self):
        geoms = numpy.asarray([shapely.box(0, 0, 30, 12), shapely.box(50, 0, 80, 12)], dtype=object)
        colour = {"tile_red": 8, "roof_flat_dark": 29, "metal_pale": 17, "roof_silver": 30, "metal_dark": 18, "roof_flat_grey": 28, "concrete_grey": 5}
        props = numpy.array([[3.0, 12.0, 4, 2, bake.ROOF_FLAT, 0, 28, 0, 0, 15, 6], [3.0, 12.0, 4, 2, bake.ROOF_FLAT, 0, 28, 0, 0, 65, 6]], dtype=float)
        _, rows = bake.rooftop_props(geoms, props, colour)
        self.assertEqual(rows.shape[1], props.shape[1] + 1)
        self.assertEqual(set(rows[:, 11].astype(int)), {0, 1})
        for row in rows:
            self.assertTrue(geoms[int(row[11])].contains(shapely.Point(row[9], row[10])))

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
        rings = compact.TERRAIN_RINGS
        self.assertEqual((nx, ny), (bake.TERRAIN_CELLS + 1 + 2 * rings,) * 2)
        self.assertAlmostEqual(struct.unpack_from("<d", raw, 4)[0], 2000.0 - rings * step)
        # (a, b) count the tile's own lattice from its corner; the rings lie outside them
        for a, b, u, v in [(5, 13, 0.09, 0.47), (5, 13, 0.6, 0.7), (0, 0, 0.5, 0.5), (31, 20, 0.2, 0.95), (-1, 7, 0.3, 0.6), (32, -2, 0.5, 0.5)]:
            a, b = a + rings, b + rings
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
        west, south, across, up = bake.coarse_grid_extent(CITY)
        self.assertEqual((west % 125.0, south % 125.0), (0.0, 0.0))
        self.assertGreater(across * up, 100)


if __name__ == "__main__":
    unittest.main()


class CompactFormsTest(unittest.TestCase):
    """The forms the baked files are made of (compact.py): read back, they give what went in to within half a
    unit, and a number its integer cannot hold is an error rather than something clipped."""

    def test_buildings(self):
        props = numpy.array([[2.0, 15.3, 5, 2, 0, 1, 2, 7, 16], [40.13, 310.0, 45, 4, 2, 20, 21, 250, 0], [-1.0, 2.6, 1, 10, 0, 3, 4, 0, 2]])
        corners = numpy.array([[12.345, -67.89, 2.0, 0.0, -1.0, 0], [12.345, -67.89, 17.3, 0.0, -1.0, 0], [0.0, 0.0, 17.3, 0.0, 0.0, 1],
                               [5.0, 5.0, 350.13, 0.6, 0.8, 1], [-60.0, 1060.0, 819.0, 1.0, 0.0, 2]], dtype="<f4")
        indices = numpy.array([0, 1, 2, 0, 2, 3, 4, 3, 2], dtype=numpy.uint32)
        payload = struct.pack("<IIIB", 3, 5, 9, 2) + compact.building_properties(props) + compact.building_vertices(corners) + compact.indices(indices, 5)[0]
        self.assertEqual(len(payload), 13 + 42 + 60 + 18)            # against 12 + 108 + 120 + 36 in floats
        back, vertices, backIndices = compact.read_buildings(payload)
        self.assertTrue(numpy.isclose(back[:, 0], props[:, 0], atol=0.0126).all())
        self.assertTrue(numpy.isclose(back[:, 1], props[:, 1], atol=0.0051).all())
        self.assertEqual(back[:, 2:9].tolist(), props[:, 2:].tolist())   # nine old properties as they went in
        self.assertTrue((back[:, 9:] == 0).all())                        # the three street columns ride zero
        self.assertTrue(numpy.isclose(vertices[:, :2], corners[:, :2], atol=0.021).all())
        self.assertTrue(numpy.isclose(vertices[:, 2], corners[:, 2], atol=0.0126).all())
        self.assertTrue(numpy.isclose(vertices[:, 3:5], corners[:, 3:5], atol=0.0001).all())
        self.assertEqual(vertices[:, 5].tolist(), corners[:, 5].tolist())
        self.assertEqual(vertices[0, 3:5].tolist(), [0.0, -1.0])      # a wall's normal stays exactly a unit vector
        self.assertEqual(backIndices.tolist(), indices.tolist())

    def test_street_columns_land_at_bytes_11_to_13(self):
        props = numpy.array([[2.0, 15.3, 5, 2, 0, 1, 2, 7, 16, 5, 1, 99]])
        raw = compact.building_properties(props)
        self.assertEqual(len(raw), 14)
        self.assertEqual(raw[11], 5)                 # frontage bits
        self.assertEqual(raw[12], 1)                 # ground-floor use
        self.assertEqual(raw[13], 99)                # the variant byte

    def test_a_walls_foot_and_its_buildings_base_are_one_number(self):
        # the mesh is built in single precision: a base a hair under a rounding boundary of the integer comes
        # out on the far side of it once rounded to single, and the wall's foot has to follow its building
        base = 11.53749999                # 461.4999996 units of 2.5 cm in double, 461.5000153 in single
        props = numpy.array([[base, 26.55, 9, 4, 0, 1, 28, 98, 16]])
        corners = numpy.array([[0.0, 0.0, base, 0.0, -1.0, 0]], dtype="<f4")
        back, vertices, _ = compact.read_buildings(struct.pack("<IIIB", 1, 1, 0, 2) + compact.building_properties(props) + compact.building_vertices(corners))
        self.assertEqual(back[0, 0], vertices[0, 2])
        self.assertEqual(back[0, 0], 11.55)

    def test_indices_widen_when_a_tile_has_more_corners_than_two_bytes_hold(self):
        indices = numpy.array([0, 70000], dtype=numpy.uint32)
        self.assertEqual(compact.indices(indices, 70001), (indices.astype("<u4").tobytes(), 4))
        self.assertEqual(compact.indices(numpy.array([0, 65535], dtype=numpy.uint32), 65536)[1], 4)
        self.assertEqual(compact.indices(numpy.array([0, 65534], dtype=numpy.uint32), 65535)[1], 2)

    def test_ground_corners_are_shared(self):
        # two triangles of one road share an edge (four corners for the rectangle); a pavement of the same
        # shape is another class, so its corners are its own
        road = numpy.array([[0, 0, 5.072, 6, 0], [10, 0, 5.072, 6, 0], [10, 10, 5.072, 6, 0], [0, 0, 5.072, 6, 0], [10, 10, 5.072, 6, 0], [0, 10, 5.072, 6, 0]], dtype="<f4")
        paving = numpy.array([[0, 0, 5.066, 13, 0], [10, 0, 5.066, 13, 0], [10, 10, 5.066, 13, 0]], dtype="<f4")
        mesh = numpy.concatenate([road, paving])
        indices = numpy.arange(len(mesh), dtype=numpy.uint32)
        payload = scene.mesh_section(mesh, indices, False)
        self.assertEqual(len(payload), 9 + 7 * 5 + 18)                # seven corners and nine indices: against 8 + 180 + 36 in floats
        corners, back = compact.read_ground(payload, False)
        self.assertEqual(len(corners), 7)                           # the road's six corners are the four of a rectangle, once each
        self.assertEqual([int((corners[:, 3] == c).sum()) for c in (6, 13)], [4, 3])
        for k, v in enumerate(indices):
            self.assertAlmostEqual(corners[back[k], 0], mesh[v, 0], delta=0.021)
            self.assertAlmostEqual(corners[back[k], 1], mesh[v, 1], delta=0.021)
            self.assertEqual(corners[back[k], 3], mesh[v, 3])
        self.assertEqual(corners[:, 2].tolist(), [0.0] * 7)            # the height is not carried: the page reads it off the ground

    def test_a_deck_keeps_its_height(self):
        # a deck's top is triangles, its walls quads of four corners each, so the mesh has more corners than a
        # shared one and other numbers of corners and indices: the header must say how many of each
        deck = numpy.array([[0, 0, 11.25, 5, 0], [10, 0, 11.25, 5, 0], [10, 10, 11.3, 12, 1], [0, 10, 11.25, 5, 0],
                           [0, 0, 11.25, 12, 1], [0, 0, 2.25, 12, 1], [10, 0, 2.25, 12, 1], [10, 0, 11.25, 12, 1]], dtype="<f4")
        indices = numpy.array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7], dtype=numpy.uint32)
        payload = scene.mesh_section(deck, indices, True)
        self.assertEqual(struct.unpack_from("<IIB", payload, 0), (8, 12, 2))      # eight corners, 12 indices: none is shared (a top and its wall differ in class)
        self.assertEqual(len(payload), 9 + 8 * 8 + 12 * 2)
        corners, back = compact.read_ground(payload, True)
        self.assertEqual(back.tolist(), indices.tolist())
        self.assertTrue(numpy.isclose(corners[:, 2], deck[:, 2], atol=0.063).all())
        self.assertEqual(corners[:, 3].tolist(), deck[:, 3].tolist())

    def test_a_deck_corner_s_spare_byte_is_nought(self):
        # a deck's record is eight bytes for seven. The spare one was once left as whatever was in the memory, so
        # that the same bake was not the same bytes every time it was run (D069). The page never reads it, but a
        # file is named by its bytes when it is published.
        deck = numpy.array([[0, 0, 11.25, 5, 0], [10, 0, 11.25, 5, 0], [10, 10, 11.3, 12, 1], [0, 10, 11.25, 5, 0]], dtype="<f4")
        mesh = scene.mesh_section(deck, numpy.arange(4, dtype=numpy.uint32), True)
        records = numpy.frombuffer(mesh, dtype="u1", offset=9, count=4 * 8).reshape(4, 8)
        self.assertEqual(records[:, 6].tolist(), [0, 0, 0, 0])
        self.assertEqual(records[:, 7].tolist(), [5, 5, 12, 5])                # and the class is where the page reads it
        self.assertEqual(mesh, scene.mesh_section(deck, numpy.arange(4, dtype=numpy.uint32), True))

    def test_trees(self):
        records = numpy.zeros(3, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("species", "u1"), ("size", "u1"), ("seed", "u1"), ("kind", "u1")])
        records["x"], records["y"], records["z"] = [12.34, -0.5, 999.87], [45.67, 60.0, 0.01], [5, 6, 7]
        records["species"], records["size"], records["seed"], records["kind"] = [5, 0, 3], [9, 4, 12], [250, 1, 0], [3, 0, 1]
        out = compact.tree_records(records)
        self.assertEqual(len(out), 21)                                    # against 48
        payload = struct.pack("<II", 4, 3) + numpy.zeros(17, dtype="<u4").tobytes() + out
        back = compact.read_trees(payload)
        self.assertTrue(numpy.isclose(back["x"], records["x"], atol=0.021).all())
        self.assertTrue(numpy.isclose(back["y"], records["y"], atol=0.021).all())
        self.assertEqual(back["species"].tolist(), records["species"].tolist())
        self.assertEqual(back["kind"].tolist(), records["kind"].tolist())
        self.assertEqual(back["size"].tolist(), records["size"].tolist())
        self.assertEqual(back["seed"].tolist(), records["seed"].tolist())

    def test_a_number_its_integer_cannot_hold_is_an_error(self):
        with self.assertRaises(compact.OutOfRange):
            compact.i16([2000.0], compact.XY_PER_M, "x")
        with self.assertRaises(compact.OutOfRange):
            compact.u8([30.0], compact.ROOF_UNIT, "a half width")
        self.assertEqual(compact.i16([-60.0, 1060.0], compact.XY_PER_M, "x").tolist(), [-1440, 25440])

    def test_ribbons(self):
        from shapely.geometry import LineString
        line = LineString([(1200.4, 300.6), (1200.4, 900.6), (1700.4, 900.6)])
        payload = scene.ribbon_section([(line, 6, 11.0)])
        parts = compact.read_ribbons(payload)
        self.assertEqual(len(parts), 1)
        cls, half, points, directions = parts[0]
        self.assertEqual((cls, half), (6, 11.0))
        self.assertTrue(numpy.isclose(points, [(1200, 301), (1200, 901), (1700, 901)], atol=0.51).all())
        self.assertTrue(numpy.isclose(directions, [(0.0, 1.0), (1.0, 0.0)], atol=0.0001).all())
        self.assertEqual(len(payload), 4 + 4 + 3 * 8 + 2 * 2)          # against 8 + 192 bytes of vertices and 24 of indices before

    def test_massing_cells(self):
        props = numpy.array([[2.0, 15.3, 5, 2, 0, 1, 2, 7, 16, 25.0, 25.0], [40.13, 310.0, 45, 4, 2, 20, 21, 254, 0, 75.0, 125.0]])
        payload = bake.massing_section(props, 0.0, 0.0)
        self.assertEqual(len(payload), 4 + 24)                          # against 4 + 40
        back = compact.read_massing(payload)
        self.assertEqual(back[:, :2].tolist(), [[25.0, 25.0], [75.0, 125.0]])
        self.assertTrue(numpy.isclose(back[:, 2], props[:, 0], atol=0.0126).all())
        self.assertTrue(numpy.isclose(back[:, 3], props[:, 1], atol=0.0051).all())
        self.assertEqual(back[:, 4:].tolist(), props[:, [3, 5, 6, 7]].tolist())


class TileAnchorTest(unittest.TestCase):
    """A building is kept whole in one tile, corners relative to its corner in 16-bit integers: the giants
    and the margin buildings piled against the grid's edge are kept from a neighbour whose corner holds
    them, and what no tile of the grid holds is left out."""

    def test_the_case_the_shanghai_bake_hit(self):
        # a plant hall 473 x 1334 m, its centre in the tile below the one whose corner holds it best
        self.assertEqual(scene.tile_anchor(55121.0, 18313.0, 55595.0, 19647.0, 55, 18, 0, 59, 0, 52), (55, 19))

    def test_a_margin_building_piled_against_the_grid_edge_leaves_the_grid(self):
        # a building of the margin clamped into the northernmost tile: its far corner is past that tile's
        # window, and the tile one row down cannot hold it either -- it stands 1.4 km out in the dissolving
        # margin, where nothing is drawn
        self.assertEqual(scene.tile_anchor(18970.5, 52840.0, 19479.2, 53397.8, 19, 52, 0, 59, 0, 52), None)

    def test_an_ordinary_building_stays_in_the_tile_of_its_centre(self):
        self.assertEqual(scene.tile_anchor(10.0, 10.0, 990.0, 990.0, 0, 0, 0, 59, 0, 52), (0, 0))

    def test_nothing_so_vast_as_to_reach_past_every_neighbour_can_be_kept(self):
        self.assertIsNone(scene.tile_anchor(0.0, 0.0, 3000.0, 3000.0, 0, 0, 0, 59, 0, 52))
