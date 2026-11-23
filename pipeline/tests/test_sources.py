"""Where the raw downloads lie, the note beside each, and fetching one that is not there: against a small server of
this test's own, so that nothing is asked of the sources themselves.

Run from the repository root:  .venv/bin/python -I -m unittest discover -s pipeline/tests -t .
"""
import hashlib
import json
import sys
import tempfile
import threading
import unittest
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from pixelcity import city, sources

QUIET = lambda *words: None
FILES = {"zhejiang-latest.osm.pbf": b"osm" * 400000, "N30_00_E120_00.tif": b"dem" * 400000, "N30E120.tif": b"cover" * 400000}   # above 1 MB each: more than one block


class Server:
    """A folder served over HTTP on a port of its own, keeping what it is asked for."""

    def __init__(self, folder):
        asked = []

        class Handler(SimpleHTTPRequestHandler):
            def do_GET(self):
                asked.append(self.path)
                super().do_GET()

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), lambda *args, **keywords: Handler(*args, directory=str(folder), **keywords))
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.asked = asked
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class Fetching(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.served = Path(self.tmp.name) / "served"
        self.served.mkdir()
        (self.served / "tile.tif").write_bytes(FILES["N30_00_E120_00.tif"])
        (self.served / "page.html").write_text("<html>wait</html>", encoding="utf-8")
        self.server = Server(self.served)
        self.sleep = mock.patch.object(sources.time, "sleep", QUIET)      # the waiting between tries is not what is tested
        self.sleep.start()

    def tearDown(self):
        self.sleep.stop()
        self.server.close()
        self.tmp.cleanup()

    def test_a_file_comes_whole_and_nothing_half_is_left(self):
        target = Path(self.tmp.name) / "raw" / "dem" / "tile.tif"
        self.assertEqual(sources.fetch(f"{self.server.url}/tile.tif", target, log=QUIET), date.today().isoformat())
        self.assertEqual(target.read_bytes(), FILES["N30_00_E120_00.tif"])
        self.assertEqual([p.name for p in target.parent.iterdir()], ["tile.tif"])

    def test_what_does_not_answer_a_file_is_not_kept_and_nothing_is_left(self):
        for name in ("nothere.tif", "page.html"):
            target = Path(self.tmp.name) / "raw" / name
            with self.assertRaises(SystemExit) as stopped:
                sources.fetch(f"{self.server.url}/{name}", target, log=QUIET, tries=2)
            self.assertFalse(target.exists())
            self.assertEqual(list(target.parent.iterdir()), [])
            self.assertIn(name, stopped.exception.code)


class Notes(unittest.TestCase):
    """The note beside a file: made when there is none, left alone while the file is the one it told of, made again when it is not."""

    def test_a_file_put_here_by_hand_is_noted_with_its_hash_and_the_day_it_was_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, lines = Path(tmp) / "a.pbf", []
            path.write_bytes(b"open data")
            said = sources.noted(path, "https://example.org/a.pbf", log=lines.append)
            self.assertEqual(said, {"url": "https://example.org/a.pbf", "fetched": date.fromtimestamp(path.stat().st_mtime).isoformat(), "file": "a.pbf", "bytes": 9,
                                    "sha256": hashlib.sha256(b"open data").hexdigest()})
            self.assertEqual(json.loads((Path(tmp) / "a.pbf.json").read_text(encoding="utf-8")), said)
            self.assertEqual(sources.noted(path, "https://example.org/a.pbf", log=lines.append), said)
            self.assertEqual(len(lines), 1)                                  # said once: the second time the note was already right
            path.write_bytes(b"other data, longer")
            again = sources.noted(path, "https://example.org/a.pbf", log=lines.append)
            self.assertEqual(again["sha256"], hashlib.sha256(b"other data, longer").hexdigest())
            self.assertEqual(again["bytes"], len(b"other data, longer"))
            self.assertEqual(len(lines), 2)

    def test_the_day_a_file_was_fetched_is_kept_over_the_day_it_was_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.pbf"
            path.write_bytes(b"open data")
            said = sources.noted(path, "https://example.org/a.pbf", fetched="2026-11-22", log=QUIET)
            self.assertEqual(said["fetched"], "2026-11-22")
            self.assertEqual(sources.noted(path, "https://example.org/a.pbf", log=QUIET), said)

    def test_a_folder_of_files_that_belong_together_has_one_note(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "2434"
            folder.mkdir()
            for name in ("t.shp", "t.dbf", "t.shx", "t.prj", "t.cpg", "notes.txt", "t.shp.json"):
                (folder / name).write_bytes(name.encode())
            said = sources.noted_folder(folder, "https://example.org/2434", fetched="2026-11-22", log=QUIET)
            self.assertEqual([f["file"] for f in said["files"]], ["t.cpg", "t.dbf", "t.prj", "t.shp", "t.shx"])
            self.assertEqual(said["url"], "https://example.org/2434")
            self.assertEqual(json.loads((folder / "source.json").read_text(encoding="utf-8")), said)


class Ensuring(unittest.TestCase):
    """ensure(): every source of a city noted, a missing one fetched first, and one that is there asked for no more."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        served = tmp / "served"
        served.mkdir()
        for name, body in FILES.items():
            (served / name).write_bytes(body)
        self.server = Server(served)
        self.raw = tmp / "raw"
        self.sleep = mock.patch.object(sources.time, "sleep", QUIET)
        self.sleep.start()
        (tmp / "cities" / "x").mkdir(parents=True)
        self.url = self.server.url

    def tearDown(self):
        self.sleep.stop()
        self.server.close()
        self.tmp.cleanup()

    def city(self, with_buildings=True, sources_said=None):
        """A city whose three single-file sources are this test's server and whose building tile is (or is not) in place."""
        tmp = Path(self.tmp.name)
        buildings = self.raw / "buildings" / "2434"
        buildings.mkdir(parents=True, exist_ok=True)
        for name in () if not with_buildings else ("t.shp", "t.dbf"):
            (buildings / name).write_bytes(b"shapefile part")
        said = {"id": "x", "name": "X", "bounds": [120.1, 30.2, 120.5, 30.6], "epsg": 32651, "origin": [0, 0],
                "sources": sources_said or {"osm": f"{self.url}/zhejiang-latest.osm.pbf", "buildings": {"tile": "2434", "url": "https://example.org/2434"},
                                            "dem": "N30_00_E120_00", "landcover": "N30E120"}}
        (tmp / "cities" / "x" / "city.json").write_text(json.dumps(said), encoding="utf-8")
        with mock.patch.object(city, "CITIES", tmp / "cities"), mock.patch.object(sources, "RAW", self.raw):
            return city.load("x")

    def test_what_is_there_is_noted_and_what_is_not_is_fetched(self):
        c = self.city()
        with mock.patch.object(sources, "RAW", self.raw), mock.patch.object(sources, "DEM_URL", self.url + "/{tile}.tif"), \
                mock.patch.object(sources, "COVER_URL", self.url + "/{tile}.tif"):
            lines = []
            out = sources.ensure(c, log=lines.append)
            self.assertEqual(sorted(out), ["buildings", "dem", "landcover", "osm"])
            for kind, name in (("osm", "zhejiang-latest.osm.pbf"), ("dem", "N30_00_E120_00.tif"), ("landcover", "N30E120.tif")):
                self.assertEqual(out[kind]["sha256"], hashlib.sha256(FILES[name]).hexdigest(), kind)
                self.assertEqual(out[kind]["fetched"], date.today().isoformat())
                self.assertTrue((self.raw / kind / name).is_file(), kind)
            self.assertEqual([f["file"] for f in out["buildings"]["files"]], ["t.dbf", "t.shp"])
            self.assertEqual(out["buildings"]["url"], "https://example.org/2434")
            asked = list(self.server.asked)
            self.assertEqual(sorted(asked), ["/N30E120.tif", "/N30_00_E120_00.tif", "/zhejiang-latest.osm.pbf"])
            # again: nothing is fetched, nothing is noted anew
            out_again = sources.ensure(c, log=lines.append)
            self.assertEqual(self.server.asked, asked)
            self.assertEqual(out_again, out)
            self.assertEqual(sources.notes(c), out)
            self.assertEqual(sorted(p.name for p in self.raw.rglob("*.part")), [])

    def test_without_the_building_footprints_it_says_how_to_put_them_there(self):
        c = self.city(with_buildings=False)
        with mock.patch.object(sources, "RAW", self.raw), self.assertRaises(SystemExit) as stopped:
            sources.ensure(c, log=QUIET)
        self.assertIn(str(self.raw / "buildings" / "2434"), stopped.exception.code)
        self.assertIn("figshare", stopped.exception.code)
        self.assertEqual(self.server.asked, [])                                # nothing else is fetched first

    def test_asked_not_to_fetch_it_stops_at_what_is_missing(self):
        c = self.city()
        with mock.patch.object(sources, "RAW", self.raw), self.assertRaises(SystemExit) as stopped:
            sources.ensure(c, fetch_missing=False)
        self.assertIn("zhejiang-latest.osm.pbf", stopped.exception.code)
        self.assertEqual(self.server.asked, [])


if __name__ == "__main__":
    unittest.main()
