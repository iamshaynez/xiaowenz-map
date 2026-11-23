# 数据来源

> 每个来源记下：用途、地址、许可、从本机是否可用、下载日期、文件大小。
> 界面里必须出现的署名见文末。

| 来源 | 用途 | 地址 | 许可 | 本机可用 | 下载日期 | 大小 | 备注 |
|---|---|---|---|---|---|---|---|
| OpenStreetMap（Geofabrik 浙江提取包） | 建筑轮廓、道路、铁路、水面、土地利用、地名 | https://download.geofabrik.de/asia/china/zhejiang/zhejiang-latest.osm.pbf | ODbL，© OpenStreetMap 贡献者 | 可达，约 300 KB/s | 2026-11-22 | 91.5 MB | 提取后 45,338 个建筑轮廓（含 3 公里边距） |
| 3D-GloBFP（亚洲） | 楼高；OSM 缺失处的建筑轮廓 | Figshare 文件 54116888（由 Zenodo 记录 10.5281/zenodo.11397014 的链接表找到） | CC BY 4.0 | 可达，约 180 KB/s | 2026-11-22 | 211.4 MB | 解压后一个 shapefile，272 万条；范围内（含边距）752,590 条 | 2020 年数据；论文报告在中国的楼高误差约 13 m |
| CNBH-10m | 楼高（备用） | https://data.casearth.cn/dataset/68f3561c9418b437b22b4741 | 待核实 | 待验证 | | 待定 | 页面需要脚本渲染，获取条件未知 |
| Copernicus GLO-30 | 地形高程 | https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N30_00_E120_00_DEM/Copernicus_DSM_COG_10_N30_00_E120_00_DEM.tif | Copernicus 许可，需署名 | 可达，约 350 KB/s | 2026-11-22 | 47.9 MB | 3600×3600，浮点预测编码，读它需要 imagecodecs | 一块覆盖东经 120–121、北纬 30–31 |
| Terrarium 高程瓦片 | 地形（备用） | https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png | 待核实 | 待验证 | | | 该处有 z12 至 z15 |
| ESA WorldCover 2021 | 土地覆盖（林地、耕地） | https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N30E120_Map.tif | CC BY 4.0 | 可达，约 330 KB/s | 2026-11-22 | 93.4 MB | 可选，尚未使用 |
| pixel-plays | 上色规则的移植来源 | https://github.com/amirmushichge/pixel-plays | 代码 MIT；音乐不在 MIT 内 | 已克隆到 `reference/pixel-plays` | 2026-11-22 | | 只读参照，不参与构建 |

## 放在哪、怎么来

原始数据按来源放在 `data/raw/` 下，多座城共用：

| 数据 | 放在 | 怎么来 |
|---|---|---|
| OpenStreetMap 提取包 | `data/raw/osm/zhejiang-latest.osm.pbf` | 管线自己下载，地址写在 `cities/hz/city.json` |
| 3D-GloBFP | `data/raw/buildings/2434/` | **手工**：figshare 只应答浏览器，脚本拿不到。下载压缩包，解压到这个目录（压缩包留着也行） |
| Copernicus GLO-30 | `data/raw/dem/N30_00_E120_00.tif` | 管线自己下载 |
| ESA WorldCover | `data/raw/landcover/N30E120.tif` | 管线自己下载 |

管线的第一步（`sources`）检查这四样在不在，缺的下载，并在每个文件旁边留一份记录（`<文件>.json`：地址、取到的那天、字节数、SHA-256）。烘焙戳 `data/baked/<城市>/bake.json` 把这些记录带上，发布时写进清单。`-latest` 的提取包每天都会变，所以记录里的校验值是"这一次用的是哪一份"的唯一凭据。

## 必须的引用

- 地图数据 © OpenStreetMap 贡献者，依 Open Database License (ODbL) 提供：https://www.openstreetmap.org/copyright
- 3D-GloBFP：Che Y., Ban Y., 2024. 3D-GloBFP: the first global three-dimensional building footprint dataset. Earth System Science Data 16, 5357–5374. 依 CC BY 4.0 提供。
- 地形：Copernicus DEM，欧盟哥白尼计划。
- 风格参照：pixel-plays by AmirMushich（MIT），concept by abhi。
