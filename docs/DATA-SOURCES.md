# 数据来源

> 每个来源记下：用途、地址、许可、从本机是否可用、下载日期、文件大小。
> 界面里必须出现的署名见文末。

| 来源 | 用途 | 地址 | 许可 | 本机可用 | 下载日期 | 大小 | 备注 |
|---|---|---|---|---|---|---|---|
| OpenStreetMap（Geofabrik 浙江提取包） | 杭州：建筑轮廓、道路、铁路、水面、土地利用、地名 | https://download.geofabrik.de/asia/china/zhejiang/zhejiang-latest.osm.pbf | ODbL，© OpenStreetMap 贡献者 | 可达，约 300 KB/s | 2026-11-22 | 91.5 MB | 提取后 45,338 个建筑轮廓（含 3 公里边距） |
| OpenStreetMap（Geofabrik 上海提取包） | 上海：同上 | https://download.geofabrik.de/asia/china/shanghai/shanghai-latest.osm.pbf | ODbL，© OpenStreetMap 贡献者 | 可达 | 2026-11-23 | 25.0 MB | 上海的 OSM 比浙江的少得多 |
| 3D-GloBFP（亚洲） | 楼高；OSM 缺失处的建筑轮廓 | 按 1.25 度分块的瓦片，在 figshare 的十个部分里（全部链接在 Zenodo 记录 10.5281/zenodo.15487006 的 `data_links.txt`）；杭州用 2434 一块，上海用 2432、2433、2434、2435 四块 | CC BY 4.0 | 可达，约 180 KB/s–3 MB/s | 2026-11-22（2434）、2026-11-23（上海三块） | 211.4 / 218.0 / 70.6 / 68.2 MB | 每块解压后一个 shapefile。city.json 的 `files` 表给出每块的 ndownloader 地址，管线自己取（2026-11-23 实测脚本能下载到文件，不再只应答浏览器；拿不到时照旧提示手工放） | 2020 年数据；论文报告在中国的楼高误差约 13 m |
| CNBH-10m | 楼高（备用） | https://data.casearth.cn/dataset/68f3561c9418b437b22b4741 | 待核实 | 待验证 | | 待定 | 页面需要脚本渲染，获取条件未知 |
| Copernicus GLO-30 | 地形高程 | https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{tile}_DEM/Copernicus_DSM_COG_10_{tile}_DEM.tif（`{tile}` 如 `N30_00_E120_00`） | Copernicus 许可，需署名 | 可达，约 350 KB/s | 2026-11-22（杭州）、2026-11-23（上海） | 每块约 48 MB | 3600×3600，浮点预测编码，读它需要 imagecodecs | 杭州一块（东经 120–121、北纬 30–31）；上海两块（N31、N30 各 E121，主城区跨北纬 31 度整线） |
| Terrarium 高程瓦片 | 地形（备用） | https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png | 待核实 | 待验证 | | | 该处有 z12 至 z15 |
| ESA WorldCover 2021 | 土地覆盖（林地、耕地） | https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_{tile}_Map.tif（`{tile}` 如 `N30E120`） | CC BY 4.0 | 可达，约 330 KB/s | 2026-11-22 | 93.4 MB | **三度一块**（N30E120 = 北纬 30–33、东经 120–123）：杭州和上海用同一块 |
| Natural Earth 1:110m 陆地 | 首页地球的陆地骨架（点阵） | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson | 公有领域 | 可达，约 1 MB | 2026-11-23 | 642 KB | 烘成 180 行陆地点阵（11,925 点，12.9 KB）进 `app/globe-land.json`，页面自己的文件，不进桶 |
| pixel-plays | 上色规则的移植来源 | https://github.com/amirmushichge/pixel-plays | 代码 MIT；音乐不在 MIT 内 | 已克隆到 `reference/pixel-plays` | 2026-11-22 | | 只读参照，不参与构建 |

## 放在哪、怎么来

原始数据按来源放在 `data/raw/` 下，多座城共用：

| 数据 | 放在 | 怎么来 |
|---|---|---|
| OpenStreetMap 提取包 | `data/raw/osm/<城市>-latest.osm.pbf` | 管线自己下载，地址写在各城的 `city.json` |
| 3D-GloBFP | `data/raw/buildings/<瓦片号>/` | `city.json` 里有 `files` 表的瓦片管线自己下载解压；没有的**手工**：下载压缩包，解压到这个目录（压缩包留着也行） |
| Copernicus GLO-30 | `data/raw/dem/<瓦片>.tif` | 管线自己下载 |
| ESA WorldCover | `data/raw/landcover/<瓦片>.tif` | 管线自己下载 |
| Natural Earth 陆地多边形 | `data/raw/globe/ne_110m_land.geojson` | `node tools/bake/globe-land.mjs` 自己下载（有缓存）并烘出 `app/globe-land.json` |

管线的第一步（`sources`）检查这些在不在，缺的下载，并在每个文件旁边留一份记录（`<文件>.json`：地址、取到的那天、字节数、SHA-256；一个瓦片的 shapefile 和它的同伴合用一份）。烘焙戳 `data/baked/<城市>/bake.json` 把这些记录带上，发布时写进清单。`-latest` 的提取包每天都会变，所以记录里的校验值是"这一次用的是哪一份"的唯一凭据。

## 必须的引用

- 地图数据 © OpenStreetMap 贡献者，依 Open Database License (ODbL) 提供：https://www.openstreetmap.org/copyright
- 3D-GloBFP：Che Y., Ban Y., 2024. 3D-GloBFP: the first global three-dimensional building footprint dataset. Earth System Science Data 16, 5357–5374. 依 CC BY 4.0 提供。
- 地形：Copernicus DEM，欧盟哥白尼计划。
- 首页地球的陆地骨架：Natural Earth（公有领域），naturalearthdata.com。已出现在首页读数栏。
- 风格参照：pixel-plays by AmirMushich（MIT），concept by abhi。
