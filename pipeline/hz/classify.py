"""What kind of building each one is, how tall it really is, and what it is made of.

The form of a building decides most of this: how many levels, how big the footprint, what shape.
Tags decide the rest where they exist (a school, a factory, a station). A few places in Hangzhou have
a look of their own and override the form for low buildings: the white walls and dark tiles of the
historic districts around West Lake and the canal.
"""
import numpy
import shapely

from . import region
from .bake import TERRAIN_CELLS, surface

# archetypes; the app uses the same numbers
JIANGNAN, WALKUP, FARMHOUSE, TOWER, OFFICE, INDUSTRIAL, PUBLIC, TEMPLE, STATION, SHED = range(1, 11)
ARCHETYPE_NAMES = {JIANGNAN: "江南民居", WALKUP: "老式多层", FARMHOUSE: "城中村农居", TOWER: "高层住宅", OFFICE: "写字楼商业",
                   INDUSTRIAL: "厂房", PUBLIC: "公共建筑", TEMPLE: "寺庙园林", STATION: "交通设施", SHED: "附属小房"}
ROOF_FLAT, ROOF_GABLE, ROOF_HIP, ROOF_SAW, ROOF_GREAT = range(5)      # a great hip roof: a temple hall's, higher and needing less of a rectangle

# storey heights in metres by archetype; a level count and a height describe the same building through these
FLOOR_M = {JIANGNAN: 3.2, WALKUP: 2.9, FARMHOUSE: 3.1, TOWER: 2.95, OFFICE: 3.9, INDUSTRIAL: 5.5, PUBLIC: 3.8, TEMPLE: 9.0, STATION: 8.0, SHED: 2.6}

TEMPLE_BUILDINGS = {"temple", "pagoda", "shrine", "monastery", "religious", "church", "cathedral", "mosque", "religious_building", "stupa", "pavilion"}
# a hall of a temple by its name: most of Lingyin's halls are mapped as plain buildings called 济公殿, 华严殿...
HALL_NAMES = ("殿", "禅堂", "经堂", "戒堂", "念佛堂", "钟楼", "鼓楼")
# temple grounds where OSM names only the place and leaves the halls unnamed: there a building with nothing
# said about it is a hall. (centre lon, centre lat, radius km)
TEMPLE_GROUNDS = [
    (120.14434, 30.23132, 0.10),  # Jingci Temple
]
# what a building is said to be, when it is said to be something other than a hall
NOT_HALLS = {"apartments", "residential", "house", "detached", "terrace", "dormitory", "hotel", "commercial", "retail", "office", "school", "kindergarten",
             "university", "college", "hospital", "civic", "public", "government", "industrial", "warehouse", "garage", "garages", "shed", "hut", "parking"}
# roof shapes someone walked past and wrote down (OSM roof:shape), and the roof they give; and roof:colour
PITCHED_ROOFS = {"gabled": ROOF_GABLE, "hipped": ROOF_HIP, "pyramidal": ROOF_HIP, "half-hipped": ROOF_HIP, "half_hipped": ROOF_HIP, "hip_and_gable": ROOF_HIP}
ROOF_COLOURS = {"black": "tile_dark", "dark": "tile_dark", "grey": "tile_grey", "gray": "tile_grey", "slate": "tile_slate", "orange": "tile_red",
                "red": "tile_red", "brown": "tile_brown", "white": "tile_white"}
STATION_BUILDINGS = {"train_station", "transportation", "station", "terminal", "airport", "hangar", "aerodrome"}
SHED_BUILDINGS = {"garage", "garages", "shed", "hut", "carport", "roof", "service", "toilets", "parking", "storage", "outbuilding", "cabin", "container", "tent"}
INDUSTRIAL_BUILDINGS = {"industrial", "warehouse", "factory", "manufacture", "storage_tank", "hangar", "depot", "cold_storage", "processing_plant", "water_tower"}
PUBLIC_AMENITIES = {"school", "university", "college", "kindergarten", "hospital", "clinic", "theatre", "library", "townhall", "courthouse", "police", "fire_station",
                    "events_venue", "exhibition_centre", "conference_centre", "arts_centre", "community_centre", "social_facility", "research_institute", "prison",
                    "public_building", "ranger_station", "monastery", "marketplace"}
PUBLIC_BUILDINGS = {"civic", "public", "government", "hospital", "school", "university", "kindergarten", "college", "church", "cathedral", "mosque", "temple", "stadium"}
COMMERCIAL_BUILDINGS = {"commercial", "retail", "office", "hotel", "supermarket", "mall", "department_store"}
COMMERCIAL_USES = {"shop", "office", "hotel"}

# places with a look of their own: (centre lon, centre lat, radius km, village). JIANGNAN applies to low
# buildings inside. In a village (the last four... see True) the houses are low whatever the height data
# says: the heights there come from the satellite data set, whose error is a few storeys.
HISTORIC_PLACES = [
    (120.1465, 30.2460, 1.10, False),  # north shore of West Lake: Gushan, Beishan Street
    (120.1480, 30.2340, 0.95, False),  # Leifeng, Nanping, the south shore
    (120.1443, 30.2313, 0.20, True),   # Jingci Temple and its neighbours, between the lake road and the hill: no towers
    (120.1600, 30.2410, 0.70, False),  # He Fang Street, Southern Song imperial street, Wushan
    (120.1000, 30.2420, 1.10, True),   # Lingyin, Yongfu, Tianzhu: the temples and the villages among them
    (120.1220, 30.2170, 1.30, True),   # Longjing, Meijiawu, Manjuelong: the tea villages
    (120.1490, 30.3160, 0.55, False),  # Gongchen Bridge and Qiaoxi
    (120.1440, 30.3080, 0.35, False),  # Xiaohe Zhijie
    (120.1400, 30.3250, 0.35, False),  # Dadou Road
    (120.1850, 30.3220, 0.80, True),   # the villages of Xixi, by Tangqi
    (120.0740, 30.2720, 1.40, True),   # Xixi wetland
]
VILLAGE_LEVELS = 3          # no house in a village has more storeys, unless OSM itself says so
# the tea hills: the satellite land-cover map reads the terraces of tea bushes as trees. (centre lon, centre
# lat, radius km). There the "trees" are drawn as tea, and few real trees are put among them.
TEA_PLACES = [
    (120.1156, 30.2266, 1.60),  # the circle with the area of OSM's scenic area "虎跑龙井景区" (8.4 km2): Longjing, Meijiawu, Manjuelong
]
TRUSTED_SOURCES = ("osm:height", "osm:levels")
# glass and steel clusters: OFFICE is preferred for tall buildings inside
MODERN_CENTRES = [
    (120.2120, 30.2490, 1.70),  # Qianjiang New City
    (120.2200, 30.2280, 2.20),  # Olympic Sports Centre, Binjiang
    (120.1670, 30.2760, 1.10),  # Wulin
    (120.0300, 30.2820, 2.40),  # Future Sci-Tech City
]


def _zone_masks(cx, cy):
    """(is historic, is modern, is in a village of the historic kind) for building centroids in world metres."""
    historic = numpy.zeros(len(cx), dtype=bool)
    modern = numpy.zeros(len(cx), dtype=bool)
    village = numpy.zeros(len(cx), dtype=bool)
    for lo, la, radius in MODERN_CENTRES:
        xs, ys = region.project(lo, la)
        modern |= numpy.hypot(cx - float(xs), cy - float(ys)) <= radius * 1000
    for lo, la, radius, houses in HISTORIC_PLACES:
        xs, ys = region.project(lo, la)
        inside = numpy.hypot(cx - float(xs), cy - float(ys)) <= radius * 1000
        historic |= inside
        village |= inside & houses
    return historic, modern, village


def in_tea_zones(cx, cy):
    """-> which of these points (world metres) lie in the tea hills."""
    tea = numpy.zeros(len(cx), dtype=bool)
    for lo, la, radius in TEA_PLACES:
        xs, ys = region.project(lo, la)
        tea |= numpy.hypot(cx - float(xs), cy - float(ys)) <= radius * 1000
    return tea


def in_temple_grounds(cx, cy):
    """-> which of these points (world metres) lie in a temple's grounds (see TEMPLE_GROUNDS)."""
    inside = numpy.zeros(len(cx), dtype=bool)
    for lo, la, radius in TEMPLE_GROUNDS:
        xs, ys = region.project(lo, la)
        inside |= numpy.hypot(cx - float(xs), cy - float(ys)) <= radius * 1000
    return inside


def in_historic_villages(cx, cy):
    """-> which of these points (world metres) lie in a village of the historic kind (see HISTORIC_PLACES)."""
    village = numpy.zeros(len(cx), dtype=bool)
    for lo, la, radius, houses in HISTORIC_PLACES:
        if houses:
            xs, ys = region.project(lo, la)
            village |= numpy.hypot(cx - float(xs), cy - float(ys)) <= radius * 1000
    return village


def classify(buildings, terrain, terrain_info, landmarks=None, log=print):
    """Fill in archetype, levels, height, floor height, roof, colours and base elevation for every building."""
    geoms = numpy.asarray([b["geom"] for b in buildings], dtype=object)
    centres = shapely.centroid(geoms)
    cx, cy = shapely.get_x(centres), shapely.get_y(centres)
    area = shapely.area(geoms)
    historic, modern, village = _zone_masks(cx, cy)
    grounds = in_temple_grounds(cx, cy)
    # the ground as the app draws it: a building stands on the mesh, and on a slope its base is the lowest
    # ground around its outline, half a metre lower, so that no gap shows under its walls
    on_ground = surface(terrain, terrain_info, region.TILE_M / TERRAIN_CELLS)
    bounds = shapely.bounds(geoms)
    around = on_ground(numpy.column_stack([bounds[:, 0], bounds[:, 2], bounds[:, 0], bounds[:, 2], cx]),
                       numpy.column_stack([bounds[:, 1], bounds[:, 1], bounds[:, 3], bounds[:, 3], cy]))
    ground = around[:, 4]
    base = around.min(axis=1) - 0.5
    hull_share = shapely.area(shapely.convex_hull(geoms)) / numpy.maximum(area, 1)

    counts = {}
    capped = 0
    halls = 0
    pitched = 0
    for n, b in enumerate(buildings):
        tags, seed = b["tags"], n % 251
        kind = tags.get("building", "yes")
        name = str(tags.get("name", ""))
        amenity, use = tags.get("amenity"), tags.get("shop") or tags.get("office")
        levels = b.get("levels")
        metres = b.get("height")
        if kind in TEMPLE_BUILDINGS or amenity == "place_of_worship" or tags.get("religion") or tags.get("historic") in TEMPLE_BUILDINGS or name.endswith(HALL_NAMES) \
                or (grounds[n] and kind not in NOT_HALLS and not (amenity or use) and not name):
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
        given = metres                                  # the height as mapped or measured, before the storeys take over
        if levels is None and metres is not None:
            levels = max(1, round(metres / floor))
        if levels is None:
            levels = _guess_levels(archetype, area[n], tags)
            b["height_source"] = "inferred"
        levels = _plausible(archetype, levels)
        metres = levels * floor
        if archetype == SHED:
            metres = min(metres, 6.0)
        if archetype == TEMPLE:
            if kind == "pagoda" or b["height_source"] in TRUSTED_SOURCES:
                if given is not None:
                    levels, metres = max(1, round(given / floor)), given     # the height stands as mapped; the storeys follow it
            else:
                # a hall is one tall storey under a great roof, two for a bell tower or a loft. The height data
                # set reads the roof and the steps up to it and calls it five storeys of flats.
                levels = 2 if name.endswith(("楼", "阁")) else 1
                metres = 2 * floor if levels == 2 else (14.0 if "大雄宝殿" in name else floor)
                b["height_source"], b["temple_hall"] = "inferred", True
                halls += 1
        # a pitched roof written down on the spot makes the building a house under that roof; the height data
        # set, reading the slope of it, calls the same house fourteen storeys
        osm_roof = PITCHED_ROOFS.get(str(tags.get("roof:shape", "")).lower())
        if osm_roof is not None and b["height_source"] not in TRUSTED_SOURCES and archetype != TEMPLE:
            levels = 1 if area[n] < 120 else 2
            metres = levels * FLOOR_M[JIANGNAN]
            archetype = JIANGNAN
            b["height_source"], b["osm_roof"] = "inferred", True
            pitched += 1
        if village[n] and levels > VILLAGE_LEVELS and b["height_source"] not in TRUSTED_SOURCES and not (archetype == TEMPLE and kind == "pagoda"):
            # a tea farmer's house is two or three storeys; the data set's height for it is not to be trusted
            levels = VILLAGE_LEVELS
            b["height_source"], b["village_cap"] = "inferred", True
            capped += 1
            if archetype in (WALKUP, TOWER, FARMHOUSE, OFFICE) and historic[n]:
                archetype = JIANGNAN          # and so it is a house of the village kind, white walls and dark tiles
            floor = FLOOR_M[archetype]
            metres = levels * floor

        roof, wall, roof_colour, colours = _materials(archetype, levels, area[n], historic[n], modern[n], seed, tags)
        if osm_roof is not None:
            roof = osm_roof
            roof_colour = ROOF_COLOURS.get(str(tags.get("roof:colour", "")).lower(), roof_colour)
        b.update(archetype=archetype, levels=int(levels), height=float(metres), floor=floor, roof=roof, wall=wall,
                 roof_colour=roof_colour, colours=colours, seed=seed, base=float(base[n]), historic=bool(historic[n]))
        counts[archetype] = counts.get(archetype, 0) + 1
    log("archetypes: " + ", ".join(f"{ARCHETYPE_NAMES[k]} {v}" for k, v in sorted(counts.items())) + f"; {capped} houses in villages brought down to {VILLAGE_LEVELS} storeys; {halls} halls of temples given a hall's height; {pitched} houses under a roof written down on the spot")
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
        return ROOF_GREAT, "temple_wall", "tile_dark", {"trim": "temple_red", "door": "temple_red"}
    if archetype == STATION:
        return ROOF_FLAT, "stone_pale", "roof_silver", {"trim": "metal_dark", "glass": "window_dark"}
    return ROOF_FLAT, pick(["concrete_grey", "metal_pale", "brick_red"]), pick(["roof_flat_grey", "tile_red", "metal_pale"]), {"trim": "concrete_grey"}
