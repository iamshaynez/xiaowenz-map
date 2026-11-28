# 像素城市：杭州与上海

可以转、可以放大、可以走进去的像素城市。一座城的整片主城区是一个悬浮在白底上的立体模型，边缘化成散点溶进白色。画风来自 [pixel-plays](https://github.com/amirmushichge/pixel-plays)（MIT）：五级色阶、左上来的光、紫灰的影子、深度的描边、抖动。每一栋建筑、每一片水、每一条路都来自开放数据。街道上有双黄线、边线、斑马线、停止线与盲道，路口立着信号灯与路名牌，路边有候车亭、隔离栏、长椅、共享单车和电杆，人行道抬起了路缘，墙上有阳台、空调外机与晾衣，底商一间一间开着（关了店的拉下卷帘，夜里招牌亮成灯箱）；行人迈腿走路，路灯到点就亮。晨昏昼夜各有各的光色（夜里的窗会亮、天上有星），下雨天云影压城、路面反光。路名、地名和地标都能搜，搜到就飞过去，并在图上画出来。

- **像素杭州**：主城区东经 120.00–120.40、北纬 30.12–30.44，约 1,430 平方公里，44 万栋建筑，26 处地标，西湖四季。
- **像素上海**：主城区东经 121.22–121.84、北纬 30.98–31.45，外接框约 3,000 平方公里（主城区约 1,161 平方公里），26 处地标，外滩到陆家嘴的黄浦江两岸。

![西湖与主城区](docs/REVIEW/over-and-above.png)

工程按"一座城一个目录"组织：一座城的范围、数据源、地标和它自己的规矩都在 `cities/<id>/` 里，管线和页面不认得任何一座具体的城。杭州是 `cities/hz/`，上海是 `cities/sh/`。页面在 Cloudflare Workers 上，数据在 Cloudflare R2 上，都不用自己的服务器；怎么上线见 [`deploy/README.md`](deploy/README.md)。

## 运行

需要 Node 18 以上。页面读的烘焙数据（`data/baked/<城市>/`，杭州约 340 MB、上海还在这一轮的产出里）不在仓库里：新克隆的仓库要先按下面"从头构建数据"把它做出来。

```
node serve.mjs
```

然后打开 <http://127.0.0.1:5300/>（首页）或 <http://127.0.0.1:5300/hz>、<http://127.0.0.1:5300/sh>。首次打开约 2 秒出现全景（要加载几 MB 的全景包）。

`serve.mjs` 开两个端口，和线上一样是两个来源：5300 是页面，5400 是数据（读 `data/baked/<城市>/`，清单现场合成）。地址就是城市：`/hz` 是杭州、`/sh` 是上海；`/` 是首页——一颗会转的像素地球，已上线的城是球上的红点（本地名加英文名），点它经过一段潜入动画落进那座城（D072）。

没有构建步骤，没有依赖；页面是原生 ES 模块和 WebGL2。只保证 Chrome；手机上可用（单指平移、双指转动与缩放）。

地址后面加 `?ui=off` 只留地图（截图用）；`?time=dawn/noon/dusk/night`、`?weather=clear/rain`、`?sky=1`（岛后面画天与星）照进了测试与分享的链接。

## 操作

| 动作 | 鼠标键盘 | 触屏 |
|---|---|---|
| （首页）转动地球 | 按住拖动：横着自转，竖着倾 | 同左 |
| （首页）进一座城 | 点球上的红点或左上角名录 | 同左 |
| 平移 | 左键拖动，或 W A S D / 方向键 | 单指拖动 |
| 旋转、俯仰 | 右键拖动 | 双指一起拖动 |
| 缩放 | 滚轮（以鼠标下面的东西为锚点） | 双指张开（以两指中间的东西为锚点） |
| 回到全景 | R 或"全景"按钮 | "全景"按钮 |
| 正俯视 | M 或"俯视"按钮 | "俯视"按钮 |
| 季节 | 1 2 3 4 或右上角的按钮 | 按钮 |
| 时刻 | 5 或右上角的按钮（晨/昼/暮/夜一档档循环） | 按钮 |
| 天气 | 6 或右上角的"天气"按钮（晴/雨） | 按钮 |
| 去一处地标 | 点左上角名录里的名字（窄屏先点"地名"）；之后右键拖动是绕着它转 | 同左 |
| 找一个地方 | 左上角的搜索框里写路名、地名；`/` 或 Ctrl+K 把键盘交给它。写一个字出一批候选，上下键选，回车去，Esc 清除。地址后面加 `?find=文三路` 打开就落在那里 | 点搜索框，再点一条候选 |
| 导览 | T 或导览按钮（这座城有导览的话） | 按钮 |
| 换一座城 | 右上角"城市"一栏 | 同左 |
| 像素大小 | 右上角"像素"按钮，三档 | — |
| 走进城市（步行） | G 或"走进城市"按钮落地。WASD/方向键 走 · Shift 跑 · 点画面锁鼠标看四周（Esc 解锁） · 滚轮 镜头远近 · `+`/`-` 快慢 · `[` `]` 镜头档 · 空格 放激光 · G 或 Esc 回地图 | 左半边按住出摇杆（浮动的，推多少走多快，推到底是跑） · 右半边拖动看四周 · 上缘按钮管快慢、镜头、退出 |
| 走进城市（驾驶） | 走到路边按 E 上车。W/S 油门刹车（倒车） · A/D 转向 · 空格 手刹漂移 · 滚轮 镜头远近 · E 下车 | 右下圆钮上/下车；摇杆推上是油门、推下刹车倒车、左右转向；圆钮上面一颗手刹 |

## 目录

```
app/                  页面。线上就是站点根目录，原样发布
app/src/home/         首页：地球（globe.js）和它的标注、拖动、潜入（main.js）；app/globe-land.json 是球的陆地骨架
tools/bake/           一次性的烘焙：globe-land.mjs 把 Natural Earth 烘成陆地点阵
cities/hz/            杭州：city.json（范围、投影、数据源、这座城自己的规矩）、landmarks.json、aliases.json、routes.json
cities/sh/            上海：同上
pipeline/pixelcity/   数据管线。每一步都接收"一座城"
tools/deploy/         发布：压缩、算指纹、上传 R2、写清单；发页面；对着线上检查
deploy/               上线要做的事、桶的跨域策略
wrangler.jsonc        页面怎么发
data/                 不入库：raw/（按来源分，多城共用） work/<城市>/ baked/<城市>/
docs/                 计划、决定、进度、数据报告、验收图
tools/tests/          测试
```

## 从头构建数据

需要 Python 3.12 以上和约 4 GB 磁盘一座城。原始数据不在仓库里，管线的第一步会下载缺的：OpenStreetMap 的提取包、Copernicus GLO-30 的一两块、ESA WorldCover 的一块（三度一格，两座城共用 N30E120）。楼高数据集 3D-GloBFP 按 1.25 度分块：city.json 里写了 `files` 表的瓦片管线自己下载；万一它只应答浏览器，就手工下载解压到 `data/raw/buildings/<瓦片号>/`。地址见 `docs/DATA-SOURCES.md`。

```
uv venv .venv && uv pip install --python .venv/bin/python -e pipeline     # 或者 python3 -m venv .venv && .venv/bin/pip install -e pipeline
.venv/bin/python -I -m pixelcity.build_all --city hz                      # 杭州：下载之后的一切，约 12 分钟
.venv/bin/python -I -m pixelcity.build_all --city sh                      # 上海：范围大一圈，更久
```

依赖 osmium、shapely、numpy、pyproj、pyshp、tifffile、imagecodecs。

`--list` 列出每一步和有哪些城市，`--from ground` 从某一步起重跑，`--only trees` 只跑一步。跑完在 `data/baked/<城市>/bake.json` 留一张烘焙戳：什么时候、从哪个提交、用了哪些原始数据。

- `cities/<id>/city.json` 是一座城的定义。`look` 一节是它自己的规矩：哪几片是老街区、哪几片是商务区、哪几处是寺庙用地、名字带什么的水道算江（杭州另有茶山，上海没有）。
- `cities/<id>/landmarks.json` 是地标的表：对应 OSM 里的哪个要素、用哪个模型、多大、取景多近。坐标由管线从 OSM 查，表里不写。
- `cities/<id>/aliases.json` 是俗名和简称。要加一条就在那里添一行，重跑 `--only names`。
- `cities/<id>/routes.json` 是开阔水面上的游船航线（杭州西湖、上海黄浦江）。
- `python -m pixelcity.report <id>` 把数据报告现算一遍，写 `cities/<id>/DATA-REPORT.md`。

### 再加一座城

1. 建 `cities/<id>/city.json`：名字、英文名（`en`，首页的标注用）、经纬度范围、投影、原点、四样原始数据。
2. `python -I -m pixelcity.build_all --city <id>`。能下载的它会自己下载，下载不了的会告诉你放到哪里。
3. `node serve.mjs`，打开 `http://127.0.0.1:5300/<id>` 看。
4. 想要手工搭的地标、俗名、导览，再添 `landmarks.json`、`aliases.json`、`routes.json` 和 `city.json` 里的 `tour`。没有也能成一座城。
5. 发布：`npm run publish -- <id>`，见 `deploy/README.md`。

现在的限制：地形、土地覆盖、楼高各按自己的网格分块（GLO-30 一度一块、WorldCover 三度一块、3D-GloBFP 一点二五度一块），范围跨过哪条分界线，就在 `city.json` 里把那几块都写上（`dem`、`landcover`、`buildings.tile` 都收一列）；建筑原型和树种（`pipeline/pixelcity/classify.py`）是江南一带的样子，出了江南要注意。数据报告的数字跟着城市走，说明文字在加上海时已改成不说杭州的事，但新的一座城还是要把整份报告重读一遍。

## 发布

烘焙数据不进 git，发到 Cloudflare R2。页面是 Workers 上的一组静态文件。上线前一次性要做的事、以后每次发布的命令、预发布和回退，都在 [`deploy/README.md`](deploy/README.md)。

```
npm run publish -- hz --dry-run     会传什么
npm run publish -- hz               压缩、算指纹、只上传新的、写清单
npm run deploy                      页面
npm run verify -- hz                对着线上检查
```

## 测试

```
npm test                                                             # 数据读取器、请求签名、发布（对着一个假桶）、管线的单元测试
npm run test:browser                                                 # 下面的浏览器测试逐个跑（fidelity 除外），汇总在 out/test-runs/
node tools/tests/bake-compare.cjs <上一版烘焙的目录> [上一版的读取器]      # 改数据格式时用：新一版烘焙逐栋、逐棵、逐块对着上一版
node tools/tests/frames.cjs <目录> && node tools/tests/frames-diff.cjs <改前目录> <改后目录>   # 54 张定死的静帧，逐像素比
.venv/bin/python -I -m unittest discover -s pipeline/tests -t pipeline/tests          # 数据管线的单元测试
NODE_PATH="$(npm root -g)" node tools/tests/cities.cjs                               # 多城市：地址、选城、换城、预发布通道
NODE_PATH="$(npm root -g)" node tools/tests/published.cjs                             # 整条链路在本机走一遍：发布到一个假桶，页面从它那里取压缩过的文件，画面和读本地原文件一样
NODE_PATH="$(npm root -g)" node tools/tests/search.cjs                               # 按名字找地方：搜索框、候选、飞达、高亮落在路上、手机
NODE_PATH="$(npm root -g)" node tools/tests/shadows.cjs                              # 阴影贴图对着解析答案逐像素比对
NODE_PATH="$(npm root -g)" node tools/tests/smoke.cjs                                # 真实城市的十四个视角
NODE_PATH="$(npm root -g)" node tools/tests/tour.cjs                                 # 24 处地标、四季、缩放阶梯，顺带出验收图
NODE_PATH="$(npm root -g)" node tools/tests/landmark-views.cjs                       # 每处地标的取景：露出来多少像素、在不在中央、是不是自己的颜色
NODE_PATH="$(npm root -g)" node tools/tests/zoom-anchor.cjs                          # 滚轮缩放的锚点：鼠标下面的东西不动
NODE_PATH="$(npm root -g)" node tools/tests/mouse.cjs                                # 左键拖动平移、右键拖动转视角
NODE_PATH="$(npm root -g)" node tools/tests/mobile.cjs                               # 两种手机的模拟
NODE_PATH="$(npm root -g)" node tools/tests/throughput.cjs --ss 2,4 --out 名字        # 吞吐
NODE_PATH="$(npm root -g)" node tools/tests/roam.cjs --minutes 10                    # 随机漫游十分钟
NODE_PATH="$(npm root -g)" node tools/tests/fidelity.cjs                             # 与原版参照逐像素比（闸门 G1）
```

浏览器测试各自起一个本地服务器（页面端口 5388–5399，数据端口各加 100），一个跑完再跑下一个。`fidelity.cjs` 的退出码是 1：它停下来报的就是下面那项已知的例外，其余指标全过。

浏览器测试需要全局安装的 Playwright 和 `/Applications/Google Chrome.app`。

## 文档

- `deploy/README.md` 上线：一次性准备、每次发布、预发布和回退。
- `docs/PLAN.md` 批准的计划；`docs/PROGRESS.md` 进度；`docs/DECISIONS.md` 执行期间的全部取舍。
- `docs/GATES.md` 三道闸门的结果（其中 G1 带着一项未达标，见下）。
- `cities/hz/DATA-REPORT.md` 杭州的数据底座：数量、来源、推断清单。`docs/DATA-SOURCES.md` 原始数据与许可。
- `docs/STYLE-GUIDE.md` 这座城是怎么画的。
- `docs/REVIEW/` 验收图：24 处地标各三个侧面（`1-01.png` … `4-05.png`，左边是页面原大的主视角，右边两个是另两个侧面的中间部分；`focus-1.png` … `focus-6.png` 是主视角中间放大两倍的近景）、西湖核心的四季、从全景到断桥的六档缩放、绕雷峰塔一圈、俯视与全景。全尺寸的帧在 `out/review/`。
- `docs/REVIEW-QUEUE.md` 等你定夺的品味问题。

## 数据与许可

- 地图数据 © [OpenStreetMap](https://www.openstreetmap.org/copyright) 贡献者，ODbL：建筑轮廓、道路、铁路、水面、土地利用、地名。
- 楼高和 OSM 没画的建筑轮廓来自 [3D-GloBFP](https://doi.org/10.5281/zenodo.11397014)（Che & Ban 2024，CC BY 4.0），2020 年数据，论文报告在中国的楼高误差约 13 米。
- 地形：Copernicus GLO-30（欧盟哥白尼计划）。土地覆盖：ESA WorldCover 2021（CC BY 4.0）。
- 代码 MIT，保留 pixel-plays 的署名（`LICENSE`）。没有使用 pixel-plays 的音乐。
- 本项目不是 OpenStreetMap 官方产品。

## 已知的限制

- **已经上线（2026-11-23）**：页面 <https://city.xiaowenz.com/hz>，数据在 <https://data-city.xiaowenz.com>（R2 桶 `city`）。全部 1558 块瓦片从线上取回逐一核对过，真浏览器打开无报错。大陆的访问速度还没有实测。上海还没有发布。
- **两座城：杭州（验收过的）、上海（2026-11-24 新烘的，第一版）。** 多城市的机制（地址、选城、清单）用杭州的数据挂成两座城测过（D066）；上海是第一座真的第二城，画面和地标取景都是第一版，等你看过验收图再定去留（`REVIEW-QUEUE.md` 33–36）。
- **我没有看过这些画面。** 这个环境里截图只能交给视觉模型转述。画质靠客观比对、自动测试和视觉模型的目检保证；最终的样子需要你看验收图。
- **建筑的颜色直到验收阶段才真正生效**：着色器里读错了一个纹理，之前全城的墙都是同一种灰白。修正之后只复核了 8 张地标图（断桥、保俶塔、雷峰塔、净慈寺、城隍阁、灵隐寺、六和塔、拱宸桥），其余的验收图没有经过看图复核，只过了数字检查。请重点看颜色。经过见 `docs/DECISIONS.md` D048、`docs/PROGRESS.md`。
- **闸门 G1 带着一项未达标**：与原版逐像素比对，背面机位的明暗分布差 2.08%（门槛 2%）。原因在参照版一方（它从这个角度漏出桥拱的下表面）；其余四项指标五个机位全过。见 `docs/GATES.md` 和 `docs/DECISIONS.md` D013、D014。
- **搜索只认 OpenStreetMap 里的名字**：主路搜得到，小区里的小路和人行道大多没有名字；由楼高数据集补出来的楼（87%）没有名字。俗名靠别名表。钱塘江高亮画的是江面的岸，因为 OSM 里沿江的线画得很粗，有十几公里是从陆地上穿过去的。见 `cities/hz/DATA-REPORT.md`"名字"一节、`docs/DECISIONS.md` D062。
- **飞行途中的画面由全景包顶着。** 飞行只取落点需要的瓦片（跨城飞行 15 块，原来取 92 块、41 MB），途中掠过的地方不再临时加载——快速掠过时本来也看不清。见 `docs/DECISIONS.md` D071。
- 楼高 3.3% 是推断的；屋顶上的小件、树的位置、车船行人全是按规矩生成的；地标的坐标来自 OSM，模型尺寸一半是公开数字、一半按形制估。清单在 `cities/hz/DATA-REPORT.md`。
- **位置存成了 4 厘米一格的整数**（数据从 1.1 GB 降到 320 MB 的代价）。几何在 2 厘米以内和原来一样，但着色器的颗粒噪声是按位置铺的，所以约 1.5% 的像素会比原来高或低一级明暗，远景多一些、近景少一些；肉眼分不出，逐像素比会看到。见 `docs/DECISIONS.md` D058。
- 3D-GloBFP 给三分之一的轮廓记了两条高度不同的记录，烘焙时每组只留较高的一条（`cities/hz/DATA-REPORT.md`"重复的轮廓"）。
- 全景和城区两档之间没有过渡。桥面不投影。Safari、Firefox 和真机手机没有测过。
- 只在这台 Mac Studio（M3 Ultra）的 Chrome 上测过性能：所有图层都开，最差一行 95 分位 7.7 毫秒（4 倍超采样，960 × 540）。其他机器没有数据。
- 源码在公开仓库 <https://github.com/iamshaynez/xiaowenz-map>；烘焙数据和原始数据不进仓库，发布到 R2（`deploy/README.md`）。
- **R2 API 令牌出现过一次在对话里**（配置当天）。轮换的方法：控制台 → R2 → 管理 R2 API 令牌 → 滚转或重建，换 `.env` 里两行。
