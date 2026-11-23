"""The raw downloads a city is built from: where each lies under data/raw, where it came from, and fetching it
when it is not there. Raw files are shared: two cities of one province read the same extract, two cities of one
degree tile the same terrain.

  data/raw/osm/<file>.pbf          the OpenStreetMap extract
  data/raw/buildings/<tile>/       3D-GloBFP: a shapefile with its companions
  data/raw/dem/<tile>.tif          Copernicus GLO-30
  data/raw/landcover/<tile>.tif    ESA WorldCover 2021

Beside each lies a note (<file>.json) saying where it came from, when it was fetched, and its size and SHA-256;
the stamp of a bake (build_all.py) carries them on. A file that is there is left alone.

The terrain and the land cover are read one degree tile at a time (terrain.py, landcover.py): a city is built from
one tile of each, and city.json naming more is an error until those readers take several.

Usage: python -m pixelcity.sources <city>      says what is there, and fetches what is not
"""
import hashlib
import json
import sys
import time
import urllib.request
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

from . import city
from .city import RAW

DEM_URL = "https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{tile}_DEM/Copernicus_DSM_COG_10_{tile}_DEM.tif"
COVER_URL = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
USER_AGENT = "pixelcity/0.1 (a pixel map built from open data)"
CHUNK = 1 << 20
SIDECARS = (".shp", ".shx", ".dbf", ".prj", ".cpg")


def one(tiles, what):
    """The one tile a city is built from, of a source that is read a tile at a time."""
    if isinstance(tiles, (list, tuple)):
        raise SystemExit(f"{what} is read one degree tile at a time so far, and city.json names {len(tiles)}: {', '.join(map(str, tiles))}")
    return str(tiles)


def osm_file(c):
    return RAW / "osm" / Path(urlsplit(c.sources["osm"]).path).name


def building_folder(c):
    return RAW / "buildings" / str(c.sources["buildings"]["tile"])


def footprints_file(c):
    """The one shapefile holding the building footprints of the city's tile, or None when the tile is not here."""
    found = sorted(building_folder(c).glob("*.shp"))
    return found[0] if found else None


def dem_file(c):
    return RAW / "dem" / f"{one(c.sources['dem'], 'the terrain')}.tif"


def landcover_file(c):
    return RAW / "landcover" / f"{one(c.sources['landcover'], 'the land cover')}.tif"


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
    """{osm, buildings, dem, landcover}: the note beside each of the city's sources, as it is."""
    return {"osm": read(osm_file(c).with_name(osm_file(c).name + ".json")), "buildings": read(building_folder(c) / "source.json"),
            "dem": read(dem_file(c).with_name(dem_file(c).name + ".json")), "landcover": read(landcover_file(c).with_name(landcover_file(c).name + ".json"))}


def digests(folder):
    """{file: SHA-256} of the JSON files directly in a folder: for the stamp of a bake, which says what definition made it."""
    return {p.name: sha256(p) for p in sorted(folder.glob("*.json"))}


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


KINDS = ("osm", "buildings", "dem", "landcover")


def ensure(c, log=print, fetch_missing=True):
    """-> {osm, buildings, dem, landcover}: what the note beside each of the city's sources says, a missing single
    file fetched first. What is missing and cannot be fetched is said at once, before anything is downloaded."""
    path = c.folder / "city.json"
    missing = [kind for kind in KINDS if kind not in c.sources]
    if missing:
        raise SystemExit(f"{path} does not say where {', '.join(missing)} come from")
    folder = building_folder(c)
    if footprints_file(c) is None:
        raise SystemExit(f"the building footprints are not in {folder}: 3D-GloBFP is served by figshare, which answers a script with a page to wait for "
                         f"and not the file, so this one is fetched by hand. Open {c.sources['buildings'].get('url') or 'the dataset record (docs/DATA-SOURCES.md)'} "
                         "in a browser, put the zip in that folder and unpack it there: the shapefile and its companions beside it.")
    out = {}
    for kind, file, template, what in (("osm", osm_file(c), None, "the OpenStreetMap extract"), ("dem", dem_file(c), DEM_URL, "the terrain"),
                                       ("landcover", landcover_file(c), COVER_URL, "the land cover")):
        url = template.format(tile=file.stem) if template else c.sources["osm"]
        fetched = None
        if not file.exists():
            if not fetch_missing:
                raise SystemExit(f"{file} is not here: run the sources step to fetch it")
            log(f"fetching {what}, {url}")
            fetched = fetch(url, file, log=log)
        out[kind] = noted(file, url, fetched, log=log)
    out["buildings"] = noted_folder(folder, c.sources["buildings"].get("url"), log=log)
    return out


if __name__ == "__main__":
    c = city.of(sys.argv)
    for kind, said in ensure(c).items():
        files = said.get("files") or [said]
        print(f"{kind:<10} {sum(f['bytes'] for f in files):>13,} bytes in {len(files)} file{'s' if len(files) > 1 else ''}, fetched {said.get('fetched') or 'by hand'}")
