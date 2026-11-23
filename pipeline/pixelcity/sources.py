"""The raw downloads a city is built from: where each lies under data/raw, where it came from, and fetching it
when it is not there. Raw files are shared: two cities of one province read the same extract, two cities of one
degree tile the same terrain.

  data/raw/osm/<file>.pbf          the OpenStreetMap extract
  data/raw/buildings/<tile>/       3D-GloBFP: a shapefile with its companions, one folder per 1.25 degree tile
  data/raw/dem/<tile>.tif          Copernicus GLO-30, one file per degree tile
  data/raw/landcover/<tile>.tif    ESA WorldCover 2021, one file per degree tile

city.json may name one tile of a source or several (a list where one name stood): a city that reaches across
a degree boundary names every tile it and its margin touch, and `covering` stops when the named tiles do not
reach as far as the region. A file that is there is left alone.

Beside each file lies a note (<file>.json) saying where it came from, when it was fetched, and its size and
SHA-256; a folder of files that belong together has one note (source.json). The stamp of a bake (build_all.py)
carries the notes on: one note as it is, several as a list in the order of the tiles. A file that is there is
left alone.

Usage: python -m pixelcity.sources <city>      says what is there, and fetches what is not
"""
import hashlib
import json
import math
import sys
import time
import urllib.request
import zipfile
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

import numpy

from . import city
from .city import RAW

DEM_URL = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{tile}_DEM/Copernicus_DSM_COG_10_{tile}_DEM.tif"
COVER_URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
USER_AGENT = "pixelcity/0.1 (a pixel map built from open data)"
CHUNK = 1 << 20
SIDECARS = (".shp", ".shx", ".dbf", ".prj", ".cpg")


def tiles(said, what):
    """The tiles a city is built from: city.json holds one name there, or a list of names."""
    if isinstance(said, (list, tuple)):
        if not said or not all(isinstance(tile, (str, int)) for tile in said):
            raise SystemExit(f"{what} in city.json must be one tile or a list of tiles")
        return [str(tile) for tile in said]
    return [str(said)]


def osm_file(c):
    return RAW / "osm" / Path(urlsplit(c.sources["osm"]).path).name


def building_tiles(c):
    return tiles(c.sources["buildings"]["tile"], "buildings")


def building_folders(c):
    return [(tile, RAW / "buildings" / tile) for tile in building_tiles(c)]


def footprints_files(c):
    """The shapefile of each tile the city is built from, in the order of the tiles; None when any is not here."""
    found = []
    for _, folder in building_folders(c):
        in_folder = sorted(folder.glob("*.shp"))
        if not in_folder:
            return None
        found.append(in_folder[0])
    return found


def footprints_urls(c):
    """Where each tile of footprints can be fetched from, as city.json tells of it: the "files" map by tile.
    A city without it is fetched by hand, as before; "url" is only said to the reader as where to look."""
    return dict(c.sources["buildings"].get("files") or {})


def dem_tiles(c):
    return tiles(c.sources["dem"], "the terrain")


def landcover_tiles(c):
    return tiles(c.sources["landcover"], "the land cover")


def dem_files(c):
    return [RAW / "dem" / f"{tile}.tif" for tile in dem_tiles(c)]


def landcover_files(c):
    return [RAW / "landcover" / f"{tile}.tif" for tile in landcover_tiles(c)]


def dem_cell(lon, lat):
    """The GLO-30 tile covering a point: 'N30_00_E120_00' is the degree cell of 30-31 north, 120-121 east."""
    return f"N{math.floor(lat):02d}_00_E{math.floor(lon):02d}_00"


def cover_cell(lon, lat):
    """The WorldCover tile covering a point: 'N30E120'."""
    return f"N{math.floor(lat):02d}E{math.floor(lon):02d}"


def cells(west, south, east, north, cell):
    """Every degree tile a window in lon/lat reaches into, named as `cell` names them, in order. A tenth of a
    degree-arcsecond of slop is allowed on every side, so that a region that only just touches a boundary from
    the inside does not ask for the tile next door."""
    cols = range(math.floor(west + 1e-9), math.floor(east - 1e-9) + 1)
    rows = range(math.floor(south + 1e-9), math.floor(north - 1e-9) + 1)
    return sorted(cell(x, y) for x in cols for y in rows)


def reached(c):
    """The lon/lat window the region itself reaches into: west, south, east, north. The region's four edges are
    sampled rather than its bounding box taken, for the region stands turned to the grid: its lon/lat box is
    wider than the region, by some hundreds of metres a side, enough to reach over a degree boundary."""
    corners = c.corners()
    points = []
    for one, other in zip(corners, corners[1:] + corners[:1], strict=True):
        steps = max(2, int((abs(other[0] - one[0]) + abs(other[1] - one[1])) / 100) + 1)   # a sample every 100 m or so
        t = numpy.linspace(0.0, 1.0, steps)
        points.append(numpy.column_stack([one[0] + (other[0] - one[0]) * t, one[1] + (other[1] - one[1]) * t]))
    lon, lat = c.unproject(numpy.concatenate(points)[:, 0], numpy.concatenate(points)[:, 1])
    return float(min(lon)), float(min(lat)), float(max(lon)), float(max(lat))


def covering(c, what, named, cell):
    """The tiles the region itself reaches into must all be named; stops and says which are missing. The margin
    outside the region is not asked for: it is the dissolving edge of the island, and the readers sample it from
    the tile edge where the tiles named do not reach."""
    needed = cells(*reached(c), cell)
    missing = [tile for tile in needed if tile not in named]
    if missing:
        raise SystemExit(f"the {what} tiles the region reaches into are {', '.join(needed)}; city.json names "
                         f"{', '.join(named) or 'none'}, so {', '.join(missing)} must be added")
    return needed


def described(path):
    """{file, bytes, sha256} of one file."""
    return {"file": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)}


def sha256(path):
    """The SHA-256 of a file, read in chunks."""
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def write(note, said):
    note.write_text(json.dumps(said, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def read(note):
    """What a note says, or None when there is none: for the stamp of a bake, which carries the notes on but fetches nothing."""
    try:
        return json.loads(note.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def notes(c):
    """{osm, buildings, dem, landcover}: the note beside each of the city's sources, as it is. A source of several
    tiles gives the notes of its files as a list, in the order of the tiles."""
    out = {"osm": read(osm_file(c).with_name(osm_file(c).name + ".json")),
           "buildings": _notes_of_folders(c), "dem": _notes_of_files(dem_files(c)), "landcover": _notes_of_files(landcover_files(c))}
    return out


def digests(folder):
    """{file: SHA-256} of the JSON files directly in a folder: for the stamp of a bake, which says what definition made it."""
    return {p.name: sha256(p) for p in sorted(folder.glob("*.json"))}


def _notes_of_files(files):
    said = [read(file.with_name(file.name + ".json")) for file in files]
    return said[0] if len(said) == 1 else said


def _notes_of_folders(c):
    said = [read(folder / "source.json") for _, folder in building_folders(c)]
    return said[0] if len(said) == 1 else said


def noted(path, url, fetched=None, log=print):
    """What the note beside a file says; the note is made first when there is none, or when the file is not the one it told of."""
    note = path.with_name(path.name + ".json")
    try:
        said = json.loads(note.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        said = {}
    if said.get("bytes") != path.stat().st_size or not said.get("sha256"):
        # a file that was put here by hand was fetched the day it was written
        said = {"url": url, "fetched": fetched or said.get("fetched") or date.fromtimestamp(path.stat().st_mtime).isoformat(), **described(path)}
        write(note, said)
        log(f"  noted {path.name}: {said['bytes']:,} bytes")
    return said


def noted_folder(folder, url, fetched=None, log=print):
    """The same for a folder of files that belong together (a shapefile and its companions)."""
    note = folder / "source.json"
    files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in SIDECARS)
    try:
        said = json.loads(note.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        said = {}
    if [f["file"] for f in said.get("files", [])] != [p.name for p in files] or any(f["bytes"] != p.stat().st_size for f, p in zip(said["files"], files, strict=False)):
        # unpacked files keep the dates they had in the archive, so the day of the download is read off the newest
        # file of the folder that is not a note: the archive itself, where it was kept
        stamps = [p.stat().st_mtime for p in folder.iterdir() if p.is_file() and p.suffix.lower() not in SIDECARS]
        said = {"url": url, "fetched": fetched or said.get("fetched") or date.fromtimestamp(max(stamps or [folder.stat().st_mtime])).isoformat(), "files": [described(p) for p in files]}
        write(note, said)
        log(f"  noted {folder.name}: {len(files)} files, {sum(f['bytes'] for f in said['files']):,} bytes")
    return said


def fetch(url, target, log=print, tries=3):
    """Stream `url` to `target` through a .part file, so that a download cut short leaves nothing that looks whole.
    -> the day it was fetched."""
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    for attempt in range(1, tries + 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=120) as response:
                if response.status != 200 or response.headers.get_content_type() == "text/html":
                    raise OSError(f"{url} answers {response.status} {response.headers.get('Content-Type')}, not a file")
                total = int(response.headers.get("Content-Length") or 0)
                done, start, said = 0, time.time(), 0
                with open(part, "wb") as f:
                    while block := response.read(CHUNK):
                        f.write(block)
                        done += len(block)
                        if done - said >= 50 << 20:
                            log(f"  {done / 1e6:.0f} MB of {total / 1e6:.0f}, {done / 1e6 / max(time.time() - start, 0.1):.0f} MB/s")
                            said = done
                if total and done != total:
                    raise OSError(f"{done:,} bytes came of {total:,}")
            part.replace(target)
            return date.today().isoformat()
        except OSError as error:
            part.unlink(missing_ok=True)
            if attempt == tries:
                raise SystemExit(f"could not fetch {url}: {error}")
            log(f"  {error}; trying again ({attempt} of {tries})")
            time.sleep(5 * attempt)


def unpack(archive, folder):
    """A zip of a shapefile and its companions, unpacked into `folder`: what the archive holds under one folder
    comes up, so the shapefile lies in the tile folder itself, as a tile put here by hand would lie. The names
    are all checked before anything is written, so a bad archive leaves nothing behind."""
    with zipfile.ZipFile(archive) as z:
        members = [name for name in z.namelist() if not name.endswith("/")]
        split = []
        for name in members:
            parts = [part for part in name.split("/") if part not in ("", ".")]
            if any(part == ".." for part in parts):
                raise ValueError(f"{archive} would unpack outside {folder}")
            split.append(parts)
        tops = {parts[0] for parts in split if len(parts) > 1}
        shared = tops.pop() if len(tops) == 1 and all(len(parts) > 1 for parts in split) else None
        for name, parts in zip(members, split, strict=True):
            if shared is not None:
                parts = parts[1:]
            target = folder / Path(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(z.read(name))


def _unpack_buildings(c, tile, url, log):
    """One tile of footprints, fetched and unpacked when city.json says where it comes from; -> whether it worked."""
    folder = RAW / "buildings" / tile
    archive = folder / f"{tile}.zip"
    log(f"fetching the building footprints of tile {tile}, {url}")
    try:
        fetched = fetch(url, archive, log=log)
    except SystemExit as error:
        log(f"  {error}")
        return False
    unpack(archive, folder)
    noted_folder(folder, url, fetched=fetched, log=log)
    return True


def _noted_footprints(c, log):
    """The notes of the folders of footprints, one per tile: made when they are not there or do not say what is
    there. The note says where the tile came from: its own address in "files", or the one "url" of a city built
    from a single tile."""
    said_map = c.sources["buildings"]
    files = said_map.get("files") or {}
    only = said_map.get("url") if len(building_tiles(c)) == 1 else None
    said = [noted_folder(folder, files.get(tile) or only, log=log) for tile, folder in building_folders(c)]
    return said[0] if len(said) == 1 else said


def _missing_footprints(c, log, fetch_missing):
    """The tiles of footprints that are not here, fetched first where city.json says where they come from."""
    said = footprints_urls(c)
    missing = [tile for tile, folder in building_folders(c) if not sorted(folder.glob("*.shp"))]
    if missing and fetch_missing:
        for tile in missing:
            if said.get(tile):
                _unpack_buildings(c, tile, said[tile], log=log)
    missing = [tile for tile, folder in building_folders(c) if not sorted(folder.glob("*.shp"))]
    if missing:
        folders = ", ".join(str(RAW / "buildings" / tile) for tile in missing)
        where = ", ".join(f"{tile}: {said[tile]}" for tile in missing if said.get(tile))
        raise SystemExit(f"the building footprints are not in {folders}: 3D-GloBFP comes by tile from figshare"
                         + (f" ({where})" if where else "")
                         + ", which has answered a script with a page to wait for and not the file before, so a tile "
                           "that will not come is fetched by hand. Open its address (see docs/DATA-SOURCES.md) in a "
                           "browser, put the zip in the tile's folder and unpack it there: the shapefile and its "
                           "companions beside it.")


KINDS = ("osm", "buildings", "dem", "landcover")


def ensure(c, log=print, fetch_missing=True):
    """-> {osm, buildings, dem, landcover}: what the note beside each of the city's sources says, a missing single
    file fetched first. What is missing and cannot be fetched is said at once, before anything is downloaded."""
    path = c.folder / "city.json"
    missing = [kind for kind in KINDS if kind not in c.sources]
    if missing:
        raise SystemExit(f"{path} does not say where {', '.join(missing)} come from")
    covering(c, "terrain", dem_tiles(c), dem_cell)
    covering(c, "land cover", landcover_tiles(c), cover_cell)
    _missing_footprints(c, log, fetch_missing)
    out = {"buildings": _noted_footprints(c, log)}
    for kind, files, template, what in (("osm", [osm_file(c)], None, "the OpenStreetMap extract"),
                                        ("dem", dem_files(c), DEM_URL, "the terrain"),
                                        ("landcover", landcover_files(c), COVER_URL, "the land cover")):
        said = []
        for file in files:
            url = template.format(tile=file.stem) if template else c.sources["osm"]
            fetched = None
            if not file.exists():
                if not fetch_missing:
                    raise SystemExit(f"{file} is not here: run the sources step to fetch it")
                log(f"fetching {what}, {url}")
                fetched = fetch(url, file, log=log)
            said.append(noted(file, url, fetched, log=log))
        out[kind] = said[0] if len(said) == 1 else said
    return out


if __name__ == "__main__":
    c = city.of(sys.argv)
    for kind, said in ensure(c).items():
        for one in said if isinstance(said, list) else [said]:
            files = one.get("files") or [one]
            print(f"{kind:<10} {sum(f['bytes'] for f in files):>13,} bytes in {len(files)} file{'s' if len(files) > 1 else ''}, fetched {one.get('fetched') or 'by hand'}")
