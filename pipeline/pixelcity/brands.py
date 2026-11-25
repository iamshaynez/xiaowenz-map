"""The chain brands the map knows: 麦当劳, 星巴克 and their kind, as OpenStreetMap gives them to us.

Which brands count is said here, in one table for every city: the display name, how the map may call it
(the map writes 麦当劳, McDonald's, 麦当劳(南京西路店) and, once in a while, only the branch's own name), what
the shop is (the label the search shows), and how its signboard is painted — a board colour, an accent
colour and the brand's own number (the bake writes all three into the tile's BRND section; the page
paints the brand's pixel logo, from its atlas, over the board with them).

OpenStreetMap's China coverage of these is real but partial — about a third to a half of the shops there
are (counted on the Zhejiang extract, 2026-11): enough to show where a brand is, not enough to find every
one. The licence-clean way to more of them is to add them to the map, not to take them from a commercial
POI service.

A match is by substring on the brand or the name tag (品牌:wikidata is welcome but the map rarely has it),
so the table's aliases must not be strings that appear in other names: "星巴克" rather than "Star", and
nothing that is a plain word of the language.
"""
import re

# id: (display, aliases, category, colour, accent, mark). The category is the search's label (what names.py
# shows); colour and accent are palette names (the board and the mark on it); mark is the brand's number.
TABLE = {
    "mcd":        ("麦当劳", ("麦当劳", "McDonald's", "麦咖啡", "McCafé"), "快餐店", "brand_red", "brand_gold", "arches"),
    "kfc":        ("肯德基", ("肯德基", "KFC", "K Pro", "柏赛奥"), "快餐店", "brand_red", "panel_white", "diag"),
    "pizza_hut":  ("必胜客", ("必胜客", "Pizza Hut"), "快餐店", "brand_red", "panel_white", "disc"),
    "burger_king": ("汉堡王", ("汉堡王", "Burger King"), "快餐店", "brand_orange", "brand_red", "band"),
    "tastien":    ("塔斯汀", ("塔斯汀", "塔斯汀中国汉堡"), "快餐店", "brand_gold", "brand_red", "band"),
    "starbucks":  ("星巴克", ("星巴克", "Starbucks", "星巴克甄选"), "咖啡馆", "brand_green", "panel_white", "disc"),
    "luckin":     ("瑞幸咖啡", ("瑞幸", "瑞幸咖啡", "Luckin", "luckin"), "咖啡馆", "brand_navy", "panel_white", "disc"),
    "cotti":      ("库迪咖啡", ("库迪", "库迪咖啡", "COTTI", "Cotti"), "咖啡馆", "brand_red", "panel_white", "disc"),
    "heytea":     ("喜茶", ("喜茶", "喜茶·茶坊", "HEYTEA"), "茶饮店", "panel_white", "window_dark", "disc"),
    "nayuki":     ("奈雪的茶", ("奈雪", "奈雪的茶", "NAIXUE"), "茶饮店", "panel_white", "brand_red", "disc"),
    "mixue":      ("蜜雪冰城", ("蜜雪冰城", "蜜雪", "MIXUE"), "茶饮店", "brand_red", "panel_white", "ring"),
    "chabaidao":  ("茶百道", ("茶百道", "ChaPanda", "ChaBaiDao"), "茶饮店", "brand_orange", "panel_white", "band"),
    "chagee":     ("霸王茶姬", ("霸王茶姬", "CHAGEE"), "茶饮店", "glass_teal", "panel_white", "disc"),
    "haidilao":   ("海底捞", ("海底捞", "Hi 捞", "Haidilao"), "餐馆", "brand_red", "brand_gold", "band"),
    "familymart": ("全家", ("全家", "FamilyMart", "全家便利", "FamiMart"), "便利店", "brand_blue", "panel_white", "band"),
    "seven_eleven": ("7-11", ("7-11", "711", "7-Eleven", "柒拾壹", "七一一"), "便利店", "brand_orange", "brand_green", "stripes"),
    "lawson":     ("罗森", ("罗森", "Lawson", "LAWSON"), "便利店", "brand_blue", "panel_white", "ring"),
    "hema":       ("盒马", ("盒马", "盒马鲜生", "盒马邻里", "Freshippo"), "超市", "brand_blue", "panel_white", "disc"),
    "sam":        ("山姆会员店", ("山姆", "山姆会员店", "Sam's Club", "沃尔玛山姆"), "超市", "glass_teal", "panel_white", "band"),
    "walmart":    ("沃尔玛", ("沃尔玛", "Walmart", "WAL-MART"), "超市", "brand_blue", "brand_gold", "disc"),
    "rtmart":     ("大润发", ("大润发", "RT-MART", "rt-mart"), "超市", "brand_orange", "panel_white", "band"),
    "uniqlo":     ("优衣库", ("优衣库", "UNIQLO", "优衣库(UNIQLO)"), "服装店", "brand_red", "panel_white", "band"),
    "miniso":     ("名创优品", ("名创优品", "MINISO"), "杂货店", "brand_red", "panel_white", "disc"),
    # 不是连锁，是汀岸芷兰轩 11# 楼顶那块大牌（scene.bake 往 osm.brands 里注入一个点）：借同一套招牌机制
    # 画。按在表末，tile 里已存的品牌序号才不会位移。
    "ultraman":   ("奥特曼", ("奥特曼", "Ultraman"), "景点", "window_dark", "metal_pale", "figure"),
}

def mark(brand_id):
    """The brand's own number, its place in the table's order: what the tile's BRND section stores, and
    what the page's atlas of pictures (app/src/landmarks/brandmarks.js, same order) is laid out by."""
    return list(TABLE).index(brand_id)

# the shop tags a brand may be written on: a brand named on another tag (a school canteen's operator) is
# not a shop of ours
SHOP_KEYS = ("shop", "amenity")
SHOP_VALUES = {"fast_food", "restaurant", "cafe", "ice_cream", "coffee", "tea", "bakery", "convenience",
               "supermarket", "department_store", "clothes", "shoes", "variety_store", "wholesale",
               "mobile_phone", "electronics", "furniture", "mall", "deli", "bread", "pastry", "chocolate"}

# a store name that says nothing by itself: a bare number or code, or a part's label ("A座", "3层")
JUNK_NAME = re.compile(r"^[\dA-Za-z#\-–—]+$|^[一二三四五六七八九十零百\d]+(号|号楼|幢|栋|座|层|期|区)$")


def meaningful(name):
    """Whether a store's own name is worth keeping instead of the brand's: not a bare number or a part's label."""
    return bool(name) and not JUNK_NAME.match(name)


def display(brand_id):
    return TABLE[brand_id][0]


def category(brand_id):
    return TABLE[brand_id][2]


def colour(brand_id):
    return TABLE[brand_id][3]


def accent(brand_id):
    return TABLE[brand_id][4]



def of(tags):
    """-> (id, matched name) when the tags name a shop of one of the table's brands."""
    if not any(tags.get(key) in SHOP_VALUES for key in SHOP_KEYS):
        return None
    for what in (tags.get("brand"), tags.get("name")):
        if not what:
            continue
        for brand_id in TABLE:
            for alias in TABLE[brand_id][1]:
                if alias in what:
                    return brand_id, what
    return None
