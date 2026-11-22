# 数据来源

> 每个来源记下：用途、地址、许可、从本机是否可用、下载日期、文件大小。
> 界面里必须出现的署名见文末。

| 来源 | 用途 | 地址 | 许可 | 本机可用 | 下载日期 | 大小 | 备注 |
|---|---|---|---|---|---|---|---|
| OpenStreetMap（Geofabrik 浙江提取包） | 建筑轮廓、道路、铁路、水面、土地利用、地名 | https://download.geofabrik.de/asia/china/zhejiang/zhejiang-latest.osm.pbf | ODbL，© OpenStreetMap 贡献者 | 可达，约 300 KB/s | 2026-11-22 | 91.5 MB | |
| 3D-GloBFP（亚洲） | 楼高；OSM 缺失处的建筑轮廓 | Figshare 文件 54116888（由 Zenodo 记录 10.5281/zenodo.11397014 的链接表找到） | CC BY 4.0 | 可达，约 180 KB/s | 下载中 | 201.6 MB | 2020 年数据；论文报告在中国的楼高误差约 13 m |
| CNBH-10m | 楼高（备用） | https://data.casearth.cn/dataset/68f3561c9418b437b22b4741 | 待核实 | 待验证 | | 待定 | 页面需要脚本渲染，获取条件未知 |
| Copernicus GLO-30 | 地形高程 | https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N30_00_E120_00_DEM/Copernicus_DSM_COG_10_N30_00_E120_00_DEM.tif | Copernicus 许可，需署名 | 可达，约 350 KB/s | 2026-11-22 | 45.6 MB | 一块覆盖东经 120–121、北纬 30–31 |
| Terrarium 高程瓦片 | 地形（备用） | https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png | 待核实 | 待验证 | | | 该处有 z12 至 z15 |
| ESA WorldCover 2021 | 土地覆盖（林地、耕地） | https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N30E120_Map.tif | CC BY 4.0 | 可达，约 330 KB/s | 下载中 | 89.1 MB | 可选 |
| pixel-plays | 上色规则的移植来源 | https://github.com/amirmushichge/pixel-plays | 代码 MIT；音乐不在 MIT 内 | 已克隆到 `reference/pixel-plays` | 2026-11-22 | | 只读参照，不参与构建 |

## 必须的引用

- 地图数据 © OpenStreetMap 贡献者，依 Open Database License (ODbL) 提供：https://www.openstreetmap.org/copyright
- 3D-GloBFP：Che Y., Ban Y., 2024. 3D-GloBFP: the first global three-dimensional building footprint dataset. Earth System Science Data 16, 5357–5374. 依 CC BY 4.0 提供。
- 地形：Copernicus DEM，欧盟哥白尼计划。
- 风格参照：pixel-plays by AmirMushich（MIT），concept by abhi。
