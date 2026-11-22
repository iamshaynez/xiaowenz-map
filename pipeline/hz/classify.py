"""What kind of building each one is, how tall it really is, and what it is made of.

The form of a building decides most of this: how many levels, how big the footprint, what shape.
Tags decide the rest where they exist (a school, a factory, a station). A few places in Hangzhou have
a look of their own and override the form for low buildings: the white walls and dark tiles of the
historic districts around West Lake and the canal.
"""
import numpy
import shapely


# archetypes; the app uses the same numbers
JIANGNAN, WALKUP, FARMHOUSE, TOWER, OFFICE, INDUSTRIAL, PUBLIC, TEMPLE, STATION, SHED = range(1, 11)
ARCHETYPE_NAMES = {JIANGNAN: "江南民居", WALKUP: "老式多层", FARMHOUSE: "城中村农居", TOWER: "高层住宅", OFFICE: "写字楼商业",
                   INDUSTRIAL: "厂房", PUBLIC: "公共建筑", TEMPLE: "寺庙园林", STATION: "交通设施", SHED: "附属小房"}
ROOF_FLAT, ROOF_GABLE, ROOF_HIP, ROOF_SAW = range(4)

# storey heights in metres by archetype; a level count and a height describe the same building through these
FLOOR_M = {JIANGNAN: 3.2, WALKUP: 2.9, FARMHOUSE: 3.1, TOWER: 2.95, OFFICE: 3.9, INDUSTRIAL: 5.5, PUBLIC: 3.8, TEMPLE: 4.2, STATION: 8.0, SHED: 2.6}

TEMPLE_BUILDINGS = {"temple", "pagoda", "shrine", "monastery", "religious", "church", "cathedral", "mosque", "religious_building", "stupa", "pavilion"}
STATION_BUILDINGS = {"train_station", "transportation", "station", "terminal", "airport", "hangar", "aerodrome"}
SHED_BUILDINGS = {"garage", "garages", "shed", "hut", "carport", "roof", "service", "toilets", "parking", "storage", "outbuilding", "cabin", "container", "tent"}
INDUSTRIAL_BUILDINGS = {"industrial", "warehouse", "factory", "manufacture", "storage_tank", "hangar", "depot", "cold_storage", "processing_plant", "water_tower"}
PUBLIC_AMENITIES = {"school", "university", "college", "kindergarten", "hospital", "clinic", "theatre", "library", "townhall", "courthouse", "police", "fire_station",
                    "events_venue", "exhibition_centre", "conference_centre", "arts_centre", "community_centre", "social_facility", "research_institute", "prison",
                    "public_building", "ranger_station", "monastery", "marketplace"}
PUBLIC_BUILDINGS = {"civic", "public", "government", "hospital", "school", "university", "kindergarten", "college", "church", "cathedral", "mosque", "temple", "stadium"}
COMMERCIAL_BUILDINGS = {"commercial", "retail", "office", "hotel", "supermarket", "mall", "department_store"}
COMMERCIAL_USES = {"shop", "office", "hotel"}

# places with a look of their own: (centre lon, centre lat, radius km). JIANGNAN applies to low buildings inside.
HISTORIC_PLACES = [
    (120.1465, 30.2460, 1.10),  # north shore of West Lake: Gushan, Beishan Street
    (120.1480, 30.2340, 0.95),  # Leifeng, Nanping, the south shore
    (120.1600, 30.2410, 0.70),  # He Fang Street, Southern Song imperial street, Wushan
    (120.1100, 30.2410, 0.80),  # Lingyin, Tianzhu
    (120.1220, 30.2170, 1.30),  # Longjing, Meijiawu, Manjuelong
    (120.1490, 30.3160, 0.55),  # Gongchen Bridge and Qiaoxi
    (120.1440, 30.3080, 0.35),  # Xiaohe Zhijie
    (120.1400, 30.3250, 0.35),  # Dadou Road
    (120.1850, 30.3220, 0.80),  # Tangqi is just outside; Xixi villages
    (120.0740, 30.2720, 1.40),  # Xixi wetland
]
# glass and steel clusters: OFFICE is preferred for tall buildings inside
MODERN_CENTRES = [
    (120.2120, 30.2490, 1.70),  # Qianjiang New City
    (120.2200, 30.2280, 2.20),  # Olympic Sports Centre, Binjiang
    (120.1670, 30.2760, 1.10),  # Wulin
    (120.0300, 30.2820, 2.40),  # Future Sci-Tech City
]


def _zone_masks(cx, cy):
    """(is historic, is modern) for building centroids in world metres."""
    from . import region
    lon, lat = region.unproject(cx, cy)
    historic = numpy.zeros(len(cx), dtype=bool)
    modern = numpy.zeros(len(cx), dtype=bool)
    for places, mask in ((HISTORIC_PLACES, historic), (MODERN_CENTRES, modern)):
        for lo, la, radius in places:
            xs, ys = region.project(lo, la)
            mask |= numpy.hypot(cx - float(xs), cy - float(ys)) <= radius * 1000
    return historic, modern


def classify(buildings, terrain, terrain_info, landmarks=None, log=print):
    """Fill in archetype, levels, height, floor height, roof, colours and base elevation for every building."""
    geoms = numpy.asarray([b["geom"] for b in buildings], dtype=object)
    centres = shapely.centroid(geoms)
    cx, cy = shapely.get_x(centres), shapely.get_y(centres)
    area = shapely.area(geoms)
    historic, modern = _zone_masks(cx, cy)
    x0, y0, cell, tnx, tny = terrain_info
    col = numpy.clip(((cx - x0) / cell).astype(int), 0, tnx - 1)
    row = numpy.clip(((y0 + tny * cell - cy) / cell).astype(int), 0, tny - 1)
    ground = terrain[row, col].astype(float)
    hull_share = shapely.area(shapely.convex_hull(geoms)) / numpy.maximum(area, 1)

    counts = {}
    for n, b in enumerate(buildings):
        tags, seed = b["tags"], n % 251
        kind = tags.get("building", "yes")
        amenity, use = tags.get("amenity"), tags.get("shop") or tags.get("office")
        levels = b.get("levels")
        metres = b.get("height")
        if kind in TEMPLE_BUILDINGS or amenity == "place_of_worship" or tags.get("religion") or tags.get("historic") in TEMPLE_BUILDINGS:
            archetype = TEMPLE
        elif kind in STATION_BUILDINGS or amenity in ("bus_station", "ferry_terminal"):
            archetype = STATION
        elif kind in SHED_BUILDINGS and not (levels and levels >= 2):
            archetype = SHED
        elif kind in INDUSTRIAL_BUILDINGS:
            archetype = INDUSTRIAL
        elif amenity in PUBLIC_AMENITIES or kind in PUBLIC_BUILDINGS or tags.get("tourism") in ("museum", "attraction", "gallery"):
            archetype = PUBLIC
        elif use in COMMERCIAL_USES or kind in COMMERCIAL_BUILDINGS:
            archetype = OFFICE
        else:
            archetype = _by_form(levels, metres, area[n], hull_share[n], historic[n], modern[n], ground[n])
        floor = FLOOR_M[archetype]

        # levels and height describe one building: settle them together
        if levels is None and metres is not None:
            levels = max(1, round(metres / floor))
        if levels is None:
            levels = _guess_levels(archetype, area[n], tags)
            b["height_source"] = "inferred"
        levels = _plausible(archetype, levels)
        metres = levels * floor
        if archetype == SHED:
            metres = min(metres, 6.0)

        roof, wall, roof_colour, colours = _materials(archetype, levels, area[n], historic[n], modern[n], seed, tags)
        b.update(archetype=archetype, levels=int(levels), height=float(metres), floor=floor, roof=roof, wall=wall,
                 roof_colour=roof_colour, colours=colours, seed=seed, base=float(ground[n]), historic=bool(historic[n]))
        counts[archetype] = counts.get(archetype, 0) + 1
    log("archetypes: " + ", ".join(f"{ARCHETYPE_NAMES[k]} {v}" for k, v in sorted(counts.items())))
    return buildings


def _by_form(levels, metres, area, hull_share, historic, modern, ground):
    height = metres if metres is not None else (levels or 1) * 3.0
    levels = levels or max(1, round(height / 3.0))
    if levels <= 1:
        if area < 40:
            return SHED
        return JIANGNAN if historic else (INDUSTRIAL if area > 1200 else SHED)
    if levels <= 3:
        if area > 2500:
            return INDUSTRIAL
        if historic:
            return JIANGNAN
        return FARMHOUSE if area < 220 or ground > 25 else WALKUP
    if levels <= 7:
        if area > 4000:
            return INDUSTRIAL
        return JIANGNAN if historic and levels <= 2 else WALKUP
    # tall: dwellings are slim and come in clusters, offices are fat and glassy
    if area > 2600 or levels > 34 or (modern and area > 1200):
        return OFFICE
    if hull_share < 0.62:
        return OFFICE  # wings around a courtyard: a hotel, a hospital, an office compound
    return TOWER


def _guess_levels(archetype, area, tags):
    """Levels for a building with neither a measured height nor a level count."""
    default = {JIANGNAN: 2, WALKUP: 5, FARMHOUSE: 3, TOWER: 18, OFFICE: 10, INDUSTRIAL: 1, PUBLIC: 4, TEMPLE: 1, STATION: 2, SHED: 1}
    if archetype in default:
        return default[archetype]
    return 2 if area < 120 else 4 if area < 900 else 6


def _plausible(archetype, levels):
    """Keep level counts inside the range a building of that kind can have."""
    low, high = {JIANGNAN: (1, 3), WALKUP: (2, 8), FARMHOUSE: (1, 6), TOWER: (8, 45), OFFICE: (3, 80), INDUSTRIAL: (1, 6),
                 PUBLIC: (1, 25), TEMPLE: (1, 9), STATION: (1, 6), SHED: (1, 2)}[archetype]
    return int(min(high, max(low, levels)))


# Colours are names into the central palette (data/curated/palette.json); the app turns them into ramp indices.
PLASTERS = ["plaster_white", "plaster_grey", "plaster_beige", "plaster_rose", "plaster_cream"]
VILLAGE_WALLS = ["concrete_grey", "tile_white", "brick_red", "plaster_white", "concrete_pale"]
TOWER_WALLS = ["plaster_white", "plaster_cream", "tile_white", "plaster_grey", "plaster_beige"]
OFFICE_WALLS = ["glass_blue", "glass_grey", "stone_pale", "glass_teal", "panel_white"]
INDUSTRIAL_WALLS = ["plaster_white", "concrete_grey", "metal_pale", "brick_red"]
PUBLIC_WALLS = ["stone_pale", "plaster_white", "plaster_cream", "glass_grey", "brick_red"]
JIANGNAN_WALLS = ["whitewash", "whitewash", "whitewash_aged", "plaster_grey"]
ROOFS_GREY = ["tile_grey", "tile_slate", "tile_dark"]
TANK_RED = ["tile_red", "tile_brown"]


def _materials(archetype, levels, area, historic, modern, seed, tags):
    """-> (roof type, wall colour, roof colour, accent colours)."""
    pick = lambda options: options[seed % len(options)]
    if archetype == JIANGNAN:
        return ROOF_HIP if seed % 3 == 0 else ROOF_GABLE, pick(JIANGNAN_WALLS), pick(ROOFS_GREY), {"trim": "wood_dark", "door": "wood_dark"}
    if archetype == FARMHOUSE:
        return (ROOF_GABLE if seed % 5 == 0 else ROOF_FLAT), pick(VILLAGE_WALLS), pick(ROOFS_GREY + ["concrete_grey"]), {"trim": "concrete_grey", "door": "wood_dark"}
    if archetype == WALKUP:
        return ROOF_FLAT, pick(PLASTERS), "roof_flat_grey", {"trim": "concrete_grey", "door": "wood_dark", "tank": TANK_RED[seed % 2]}
    if archetype == TOWER:
        return ROOF_FLAT, pick(TOWER_WALLS), "roof_flat_grey", {"trim": "plaster_cream", "glass": "window_dark"}
    if archetype == OFFICE:
        return ROOF_FLAT, pick(OFFICE_WALLS), "roof_flat_dark", {"trim": "metal_dark", "glass": "window_dark"}
    if archetype == INDUSTRIAL:
        roof = ROOF_SAW if seed % 4 == 0 else ROOF_GABLE if seed % 3 == 0 else ROOF_FLAT
        return roof, pick(INDUSTRIAL_WALLS), pick(["metal_blue", "metal_pale", "tile_red", "roof_flat_grey"]), {"trim": "concrete_grey"}
    if archetype == PUBLIC:
        return (ROOF_HIP if seed % 3 else ROOF_FLAT), pick(PUBLIC_WALLS), pick(ROOFS_GREY + ["roof_flat_grey"]), {"trim": "stone_pale", "glass": "window_dark"}
    if archetype == TEMPLE:
        return ROOF_HIP, "temple_wall", "tile_dark", {"trim": "temple_red", "door": "temple_red"}
    if archetype == STATION:
        return ROOF_FLAT, "stone_pale", "roof_silver", {"trim": "metal_dark", "glass": "window_dark"}
    return ROOF_FLAT, pick(["concrete_grey", "metal_pale", "brick_red"]), pick(["roof_flat_grey", "tile_red", "metal_pale"]), {"trim": "concrete_grey"}
