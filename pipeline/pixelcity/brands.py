"""The chain brands the map knows: 麦当劳, 星巴克 and their kind, as OpenStreetMap gives them to us.

Which brands count is said here, in one table for every city: the display name, how the map may call it
(the map writes 麦当劳, McDonald's, 麦当劳(南京西路店) and, once in a while, only the branch's own name), what
the shop is (the label the search shows), and the colour of its sign (a name in app/palette.json; the bake
writes its index into the tile's BRND section and the page paints a small board with it).

OpenStreetMap's China coverage of these is real but partial — about a third to a half of the shops there
are (counted on the Zhejiang extract, 2026-11): enough to show where a brand is, not enough to find every
one. The licence-clean way to more of them is to add them to the map, not to take them from a commercial
POI service.

A match is by substring on the brand or the name tag (品牌:wikidata is welcome but the map rarely has it),
so the table's aliases must not be strings that appear in other names: "星巴克" rather than "Star", and
nothing that is a plain word of the language.
"""
import re

# id: (display, aliases, category, colour). The category is the search's label (what names.py shows), the
# colour the palette name of the signboard.
TABLE = {
    "mcd":        ("麦当劳", ("麦当劳", "McDonald's", "麦咖啡", "McCafé"), "快餐店", "brand_red"),
    "kfc":        ("肯德基", ("肯德基", "KFC", "K Pro", "柏赛奥"), "快餐店", "brand_red"),
    "pizza_hut":  ("必胜客", ("必胜客", "Pizza Hut"), "快餐店", "brand_red"),
    "burger_king": ("汉堡王", ("汉堡王", "Burger King"), "快餐店", "brand_orange"),
    "tastien":    ("塔斯汀", ("塔斯汀", "塔斯汀中国汉堡"), "快餐店", "brand_gold"),
    "starbucks":  ("星巴克", ("星巴克", "Starbucks", "星巴克甄选"), "咖啡馆", "brand_green"),
    "luckin":     ("瑞幸咖啡", ("瑞幸", "瑞幸咖啡", "Luckin", "luckin"), "咖啡馆", "brand_navy"),
    "cotti":      ("库迪咖啡", ("库迪", "库迪咖啡", "COTTI", "Cotti"), "咖啡馆", "brand_red"),
    "heytea":     ("喜茶", ("喜茶", "喜茶·茶坊", "HEYTEA"), "茶饮店", "panel_white"),
    "nayuki":     ("奈雪的茶", ("奈雪", "奈雪的茶", "NAIXUE"), "茶饮店", "panel_white"),
    "mixue":      ("蜜雪冰城", ("蜜雪冰城", "蜜雪", "MIXUE"), "茶饮店", "brand_red"),
    "chabaidao":  ("茶百道", ("茶百道", "ChaPanda", "ChaBaiDao"), "茶饮店", "brand_orange"),
    "chagee":     ("霸王茶姬", ("霸王茶姬", "CHAGEE"), "茶饮店", "glass_teal"),
    "haidilao":   ("海底捞", ("海底捞", "Hi 捞", "Haidilao"), "餐馆", "brand_red"),
    "familymart": ("全家", ("全家", "FamilyMart", "全家便利", "FamiMart"), "便利店", "brand_blue"),
    "seven_eleven": ("7-11", ("7-11", "711", "7-Eleven", "柒拾壹", "七一一"), "便利店", "brand_orange"),
    "lawson":     ("罗森", ("罗森", "Lawson", "LAWSON"), "便利店", "brand_blue"),
    "hema":       ("盒马", ("盒马", "盒马鲜生", "盒马邻里", "Freshippo"), "超市", "brand_blue"),
    "sam":        ("山姆会员店", ("山姆", "山姆会员店", "Sam's Club", "沃尔玛山姆"), "超市", "glass_teal"),
    "walmart":    ("沃尔玛", ("沃尔玛", "Walmart", "WAL-MART"), "超市", "brand_gold"),
    "rtmart":     ("大润发", ("大润发", "RT-MART", "rt-mart"), "超市", "brand_orange"),
    "uniqlo":     ("优衣库", ("优衣库", "UNIQLO", "优衣库(UNIQLO)"), "服装店", "brand_red"),
    "miniso":     ("名创优品", ("名创优品", "MINISO"), "杂货店", "brand_red"),
}

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


def of(tags):
    """-> (id, matched name) when the tags name a shop of one of the table's brands."""
    if not any(tags.get(key) in SHOP_VALUES for key in SHOP_KEYS):
        return None
    for what in (tags.get("brand"), tags.get("name")):
        if not what:
            continue
        for brand_id, (_, aliases, _, _) in TABLE.items():
            for alias in aliases:
                if alias in what:
                    return brand_id, what
    return None
