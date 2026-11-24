# 上线

页面和数据分开，各用自己的域名，都不经过自己的服务器：

```
浏览器  打开 https://city.xiaowenz.com/hz
   ├─ 页面  ─▶ Workers 静态资源    app/ 原样发布，没有构建，没有脚本
   └─ 数据  ─▶ https://data-city.xiaowenz.com  R2 的一个桶（city），前面是 Cloudflare 的边缘缓存
```

仓库管代码、城市定义和配置。烘焙数据不进 git，发到桶里。

## 桶里有什么

| 对象 | 会不会变 | 浏览器和边缘缓存 |
|---|---|---|
| `cities.json`：有哪些城 | 会，发布城市时 | 每次都问有没有变 |
| `<城市>/manifest.json`：这座城现在由哪些文件组成 | 会，发布时 | 每次都问 |
| `<城市>/next.json`：预发布 | 会 | 每次都问 |
| `<城市>/releases/<编号>.json`：每次发布的清单，留底 | 不变 | 一年 |
| `<城市>/objects/<指纹>.<类型>`：文件本身，brotli 压过 | 不变 | 一年 |

文件的地址是它压缩后内容的 SHA-256。所以同一个文件永远在同一个地址，重发一座城只上传变过的文件，回访的人也只重新下载变过的。杭州全城在桶里约 157 MB。

## 一次性准备

按顺序做。每一步之后括号里是你要告诉我的东西，或者不用告诉我、只要做完。

1. **买一个域名。** 在哪家买都行。
   （告诉我：域名。）

2. **把域名接入 Cloudflare。** 控制台“添加站点”选免费版，按提示到注册商那里把域名的名称服务器换成 Cloudflare 给的两个。等状态变成“活动”，通常几分钟到几小时。

3. **开通 R2。** 控制台进 R2 Object Storage，按提示开通。要绑一张支付方式（卡或 PayPal）：免费额度内不扣费，超出按量扣，没有硬上限。顺手在通知里给 R2 的用量设一个提醒。

4. **建一个桶。** 名字 `city`（已经建好：位置亚太，命令和 `.env.example` 都按它写；再加桶时连 `.env.example` 里的 `R2_BUCKET` 一起换）。设置里如果有“删除保护”，打开。

5. **给桶连上数据域名。** 桶的“设置 → 自定义域”里连 `data-city.xiaowenz.com`（已连）。DNS 记录和证书会自动建好，记录保持“已代理”（橙云）：关了就不走缓存和证书了。

6. **让桶允许页面来读（跨域）。** 本机执行一次：
   ```
   npx wrangler login
   npx wrangler r2 bucket cors set city --file deploy/cors.json
   ```
   第一条会打开浏览器让你授权。改过跨域策略后，到“缓存 → 配置”里清一次缓存。

7. **拿一把只管这个桶的钥匙，写进 `.env`。** R2 的“管理 R2 API 令牌 → 创建 API 令牌”：权限选“对象读和写”，范围只指定 `city` 这一个桶。创建时显示一次的两把钥匙照抄进 `.env`（账户编号和桶名已经填好）。`.env` 在哪一步建：上面第 6 步做完后由协助你的人在仓库根目录建好。
   ```
   cp .env.example .env
   ```
   填四项：账户编号（R2 概览页右侧的 Account ID）、桶名、Access Key ID、Secret Access Key。
   （钥匙不用发给我：`.env` 在这台机器上，脚本自己读。告诉我“填好了”就行。）

8. **仓库里改两处域名。**
   - `wrangler.jsonc` 里 `"pattern"`：页面的域名。
   - `app/src/config.js` 里 `DATA_ORIGIN`：数据的域名。
   两处都已按 `city.xiaowenz.com` 和 `data-city.xiaowenz.com` 改好；`npm run verify` 不带参数时从这两处读。换域名就改这两处。

9. **发页面。** 本机执行 `npx wrangler login` 授权一次之后：
   ```
   npm run deploy
   ```
   第一次会在 Cloudflare 上建好 Worker、`city.xiaowenz.com` 和它的 DNS 记录。如果这台机器上 `wrangler login` 打不开浏览器，改为在 `.env` 里填 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`（令牌权限：账户的“Workers 脚本：编辑”，这个域名的“Workers 路由：编辑”和“DNS：编辑”）。

10. **发数据，然后检查。**
    ```
    npm run publish -- hz --dry-run     # 先看会传什么，什么都不传
    npm run publish -- hz               # 传数据、写清单
    npm run verify -- hz                # 抽查 24 块瓦片；加 --all 查全部
    ```
    都通过后，用手机流量和宽带各打开一次 `https://city.xiaowenz.com/hz`。

## 以后每次发布

```
npm run build -- --city hz          # 烘焙，11 步，约 8 分钟
npm run publish -- hz               # 压缩、算指纹、只上传新的，写清单
npm run verify -- hz                # 对着线上检查
npm run deploy                      # 只有页面代码变了才要
```

顺序是先发数据、后发页面。数据格式升了版本的时候更是如此：新页面不读旧数据，旧页面也不读新数据。

## 先看再换、回退

```
npm run publish -- hz --channel next          # 发到预发布，不动线上的
```
然后打开 `https://city.xiaowenz.com/hz?channel=next` 看。没问题就 `npm run publish -- hz --promote` 换上去。

回退：`npm run publish -- hz --release <编号>`。编号是发布时打印的十二位十六进制数，也在 `hz/releases/` 下面。旧版本的文件没有被删过，所以随时回得去。

## 本地开发

```
node serve.mjs
```
打开 <http://127.0.0.1:5300/hz>。这是两个端口：5300 是页面，5400 是数据（读 `data/baked/<城市>/`，两份清单现场合成）。和线上一样是跨域的，所以跨域的问题在本地就会暴露。刚烘焙完的数据不用发布就能在页面上看到。

## 要知道的几件事

- **大陆访问。** `*.workers.dev` 在大陆打不开，所以 `wrangler.jsonc` 里把它关了，只用你自己的域名。免费版的大陆访客走境外节点，速度要用真实的网络试。同一份文件可以原样搬到别处。
- **别在浏览器里直接打开数据的地址。** 页面取数据时带着自己的来源，桶才回跨域头；在地址栏里直接打开不带来源，回包没有跨域头，可能被边缘缓存记住。要看数据，看两份清单，它们不缓存。万一页面突然报跨域错误，到桶的“设置”里清一次自定义域名的缓存。
- **数据是公开的。** 桶连了自定义域名就是公开的，谁都能下载。地图数据本来就是公开的（OpenStreetMap 等，许可见 `docs/DATA-SOURCES.md`）。流量不收费。
- **费用。** 页面（Workers 静态资源）的请求免费且不限量。R2 免费额度每月 10 GB 存储、100 万次写入、1000 万次读取，流量免费。一座城约 0.16 GB，所以几十座城之内是零成本。
- **还没有做的一件事。** 公开发布前的地图合规审查（`docs/PLAN.md` 里列在范围之外）。跨方格的城市（上海跨北纬 31 度）已经能烘：地形、土地覆盖、楼高各按自己的瓦片列表来（D073）。

## 各文件管什么

| 文件 | 管什么 |
|---|---|
| `wrangler.jsonc` | 页面怎么发：Worker、域名、`app/` 就是站点根目录 |
| `app/_headers` | 页面文件的缓存和安全头 |
| `deploy/cors.json` | 桶的跨域策略 |
| `.env.example` → `.env` | 发布和部署要的凭据，`.env` 不进 git |
| `app/src/config.js` | 页面从哪个域名取数据 |
| `tools/deploy/publish.mjs` | 发布一座城的数据 |
| `tools/deploy/deploy.mjs` | 发页面 |
| `tools/deploy/verify.mjs` | 对着线上检查 |
| `tools/deploy/manifest.mjs` | 桶里的布局，本地服务器和发布脚本共用 |
| `tools/deploy/r2.mjs` | 给 R2 的请求签名（`tools/tests/r2-signing.cjs` 拿 AWS 公开的例子核对过） |
