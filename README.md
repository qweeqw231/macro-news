# 宏观资讯台 · Macro News

全球宏观资讯自动采集与归档：**利率 · 汇率 · 政策 · 大宗商品**。

## 核心设计：采集不占用任何 AI 上下文

**推荐：GitHub Actions 定时采集（5 分钟）**

```
GitHub Actions（每 5 分钟，cron）
   └─ node src/collect.mjs          ← 纯脚本，0 context，跑在 GitHub 服务器上
        └─ 写 data/*.json（内容未变则跳过写盘）
             └─ git commit & push（仅数据有变化时）
                  └─ GitHub Pages 自动更新（约 1-2 分钟）
```

为什么用 Actions 而不是本地跑：

| | 本地 Windows 计划任务 | GitHub Actions |
|---|---|---|
| 间隔 | 30 分钟（最低约 5） | **5 分钟** |
| 电脑关机 | ❌ 停止采集 | ✅ 照常运行 |
| 国内可达性 | ✅ | ✅（github.com / github.io 均可直连） |
| 成本 | 0 | 0（公开仓库每月 2000 分钟免费额度，这里约 144 分钟/天） |

> 备用：仍可保留本地计划任务作为补充（两套并行不冲突，采集器按 id 幂等去重）。
> ```powershell
> powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
> ```

采集是确定性的 IO 任务，**不消耗对话窗口**。
AI 只在你主动要求时介入（例如"把这周新闻和我的 6 大类资产对齐"）。

## 第二条采集链：组合行情 + 宏观（交易日 16:30）

高频链路负责**新闻 + 17 个指数**；低频链路负责**组合分析需要的额外数据**，两者共用同一个
`data/quotes.json`，因此**必须按 key 合并写**（见下方「两个任务共用同一个文件」）。

```
minimax 定时任务（交易日 16:30 Asia/Shanghai，固定对话）
   └─ scripts\portfolio-collect-and-push.ps1     ← 一条命令，全程无 AI 判断
        ├─ node src\portfolio-collect.mjs        ← 5 个组合行情 key + 5 个宏观指标
        │    ├─ data\quotes.json       按 key 合并（保留原 17 个 key）
        │    ├─ data\macro\daily.json  按日期追加
        │    └─ data\_last-run.json    读改写（保留高频链路写的字段）
        └─ git commit（仅 data/ 有变化时）→ git push origin main
             └─ GitHub Pages 自动更新
```

配套的 **16:35 重试任务**（规格 §1「失败重试 1 次，间隔 5 分钟」）：
读 `logs\last-portfolio-status.json` 判断 16:30 那轮是否成功，失败才补跑一次。

| 项 | 值 |
|---|---|
| 频率 | 周一至周五 16:30（Asia/Shanghai） |
| 超时 | 脚本内 55 秒预算（规格要求 60 秒，留 5 秒写盘） |
| 重试 | 16:35 检查并补跑一次 |
| 节假日 | cron 不认中国节假日；脚本取不到当日数据时按 `carried` 沿用上一交易日，**内容未变就不写盘**（规格 §1 允许的简化） |

### 5 个新增行情 key

| key | 名称 | 数据源 | 备注 |
|---|---|---|---|
| `ndx` | 纳指100 | 腾讯行情 `qt.gtimg.cn/q=usNDX` | |
| `xau` | 伦敦金 | 腾讯行情 `qt.gtimg.cn/q=hf_XAU` | 现货黄金，24 小时连续交易 |
| `sge_au9999` | 上海金 Au99.99 | 上金所官网日行情表 | 精确匹配 `Au99.99`，避免误匹配 `iAu99.99` |
| `usdcny` | 人民币中间价 | 中国货币网 `ccpr.json` | 备用源为东财 `133.USDCNH`（离岸价，note 标 `estimated`） |
| `cgb_1y` | 1Y 国债收益率 | 中债收益率曲线 | 取不到当日值时沿用上一交易日（note 标 `carried`） |

### 5 个宏观指标（`data/macro/daily.json`）

| key | 名称 | 数据源 |
|---|---|---|
| `margin` | 两融余额 | 上交所 + 深交所（合计，亿元） |
| `us10y` | 10Y 美债 | FRED `DGS10` |
| `social_financing` | 社融增量 | 人民银行统计报表附件 |
| `cpi` | CPI 同比 | 国家统计局（东财接口） |
| `pmi` | 制造业 PMI | 国家统计局（东财接口） |

### 两个任务共用同一个文件

高频链路（5 分钟）与低频链路（16:30）都会写 `data/quotes.json` 和 `data/_last-run.json`。
**整份覆盖会互相抹掉**，所以两边都改成：

- `quotes.json` —— 按 `key` 合并写（各自只更新自己那批 key）
- `_last-run.json` —— 读改写（各自只更新自己的字段）

否则 16:30 写进去的 5 个 key 会在 5 分钟内被高频链路整份覆盖掉。

### 数据校验（规格 §5）

写入前逐条校验：价格 > 0、涨跌幅 ∈ −20%~+20%、上海金 ∈ 500~1500 元/克、
中间价 ∈ 5.0~9.0、`updatedAt` 距今 ≥3 天则标 `stale`。任一条不过就丢弃该条并记进运行日志。

## 实时行情与 K 线：浏览器直连，无需服务器

**新闻**的延迟 = 采集间隔（GitHub Actions 最短 5 分钟）；但**行情与 K 线**
不受采集间隔限制——浏览器直接请求东方财富公开接口，秒级刷新：

```
浏览器 ──直连──> push2.eastmoney.com     （实时行情）
       └─直连──> push2his.eastmoney.com  （K线，1/5/15/30/60 分钟 + 日/周/月）
```

> 订正一个此前写错的结论：早先认为「浏览器直连东财/腾讯会被 CORS 拦截」，
> 实测**不成立**——这两个接口都返回 `Access-Control-Allow-Origin: *`，
> 且国内可达。因此不再需要任何代理服务器。

接口不可达时（如离线）自动回退到 `data/quotes.json` 与 `data/kline/*.json` 快照。

原先准备的 Cloudflare Worker 方案**在国内不可用**——实测 `workers.dev`
域名被 DNS 污染（解析到 75.126.150.210 等非 Cloudflare IP，TCP 443 不通）。
`worker/` 目录保留，仅供海外访问或未来绑定自定义域名时选用；站点默认不依赖它。


## 数据源（全部经本机实测可用）

| 源 | 覆盖 | 方式 |
|---|---|---|
| 华尔街见闻 | 全球 / 外汇 / 大宗 / 美股 / A股 快讯 | 公开 API，5 频道 |
| 东方财富 | 国内财经新闻（`np-listapi`） | 公开 API |
| 新浪财经 | 国内财经滚动（`feed.mix.sina.com.cn`） | 公开 API |
| 中新网 | 国内财经 | RSS |
| 中国人民银行 | 政策 / 监管（新闻发布，站点无 RSS，解析列表页） | HTML |
| 美联储 | 货币政策、利率决议 | 官方 RSS |
| 欧洲央行 | 欧央行政策 | 官方 RSS |
| 国家统计局 | 中国宏观数据（CPI / PPI / PMI） | 官方 RSS |
| 东方财富 | 指数 / 汇率 / 商品实时行情 | 公开行情 API |

> 采集脚本对每个源独立容错：单个源失败不影响其他源，失败原因记录在 `data/_last-run.json`，
> 并在站点的「运行状态」页展示。
> 官方源（央行 / 统计局 / 美联储 / 欧洲央行）发布频率低，**不套用 24h 时间窗**，
> 靠条目 id 去重，避免「最新一条在窗口外被永久丢弃」。

## 目录结构

```
macro-news/
├── index.html            站点首页
├── assets/               style.css / app.js / market.js / kline.js / fuse.min.js
├── data/                 采集产物（已入库，Pages 直接读取）
│   ├── quotes.json       宏观行情快照（直连失败时的回退）
│   ├── latest.json       最近 200 条（首屏）
│   ├── search.json       全库检索索引
│   ├── index.json        按天归档索引
│   ├── kline/            预生成日K（直连失败时的回退）
│   ├── _last-run.json    上次运行状态
│   ├── macro/daily.json  宏观指标日频序列（16:30 链路写）
│   └── archive/YYYY-MM-DD.json
├── src/
│   ├── collect.mjs       采集主程序（零依赖）
│   ├── sources.mjs       各源适配器
│   ├── portfolio.mjs     5 个组合行情 key + 5 个宏观指标适配器
│   └── portfolio-collect.mjs  组合采集主程序（按 key 合并写）
├── worker/               Cloudflare Worker（可选，国内不可用，见上）
├── scripts/
│   ├── collect-and-push.ps1   采集 → 提交 → 推送
│   ├── portfolio-collect-and-push.ps1  组合采集 → 提交 → 推送（16:30 定时任务调用）
│   └── register-task.ps1      注册/取消计划任务
└── logs/                 运行日志（保留 14 天，不入库）
```

## 使用

```powershell
# 手动采集一次（新闻 + 17 指数）
node src\collect.mjs

# 首次使用建议回补 30 天
node src\collect.mjs --since 720

# 手动采集一次（组合行情 + 宏观，16:30 定时任务跑的就是它）
node src\portfolio-collect.mjs

# 只采集不写盘（看结果用）
node src\portfolio-collect.mjs --dry-run

# 组合采集全流程（采集 → 提交 → 推送），定时任务调用的是这条
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portfolio-collect-and-push.ps1

# 注册计划任务（默认 30 分钟）
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1

# 自定义频率
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Minutes 15

# 取消
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Unregister
```

## 采集脚本特性

- **幂等**：按条目 id 去重，重复运行不会产生重复条目
- **增量**：只抓时间窗内的新内容（默认 24h），已入库的自动丢弃
- **容错**：每个源独立 try/catch，全失败才返回非 0
- **零依赖**：只用 Node 内置 `fetch`，不装任何 npm 包
- **有界**：单日归档最多保留 800 条，日志保留 14 天

### 一个踩过的坑

`<![CDATA[...]]>` 包裹的 RSS 内容会被常规的 `<[^>]+>` 标签清理正则**整段吞掉**，
导致国家统计局这类源的标题变空、被静默丢弃（表现为"源成功但 0 条"）。
`src/sources.mjs` 的 `stripTags()` 已先提取 CDATA 内容再清标签。

## 部署

1. 在 GitHub 上新建仓库（建议 `macro-news`，选 **Public** 以获得 Actions 免费额度）
2. 推送代码：
   ```powershell
   git remote add origin https://github.com/<你的账号>/macro-news.git
   git push -u origin main
   ```
   > 若 `git push` 报 `Recv failure: Connection was reset`（HTTPS 被重置），
   > 改用 SSH-443：`~/.ssh/config` 里配 `Host github.com → HostName ssh.github.com / Port 443`，
   > 再在仓库里设 `git config url."ssh://git@ssh.github.com:443/".insteadOf "https://github.com/"`，
   > remote URL 不用改。
3. 仓库 **Settings → Pages** → Source 选 `main` 分支、根目录 → Save
4. 仓库 **Actions** 页应能看到 `宏观资讯采集` 工作流；
   首次可能需要在 Actions 页点一下 **Enable workflow**
5. 想立刻验证采集是否工作，点该工作流右侧的 **Run workflow** 手动触发一次
6. 等待 1-2 分钟，站点生效

> ⚠️ **2026-10-29 实测：这个仓库的 Pages 还没启用**（GitHub API `has_pages=false`，
> `https://qweeqw231.github.io/macro-news/` 返回 GitHub Pages 的 "Site not found"）。
> 数据与代码都在仓库里，但站点没上线 —— 需要你在仓库 **Settings → Pages** 里
> 把 Source 选成 `main` 分支 / 根目录并 Save，等 1-2 分钟后才会生效。
> 启用后站点地址为 `https://qweeqw231.github.io/macro-news/`。
>
> 另：**本机到 `github.com` / `github.io` 的 HTTPS 会被重置**（2026-10-29 实测，
> `api.github.com` 正常）。所以 `git push` 走 SSH-443，
> 而站点是否可达取决于你当时用的网络。

## 站内阅读新闻

条目**不再跳转源站**，点击即在站内打开阅读器：

- 展示来源 / 时间 / 频道 / 标题 / 完整正文（保留段落）
- 底部「阅读原文 ↗」保留跳转源站
- 支持 `←` / `→` 上一条 / 下一条，`Esc` 关闭；移动端底部全屏
- 正文来自采集时存储的 `content` 字段（快讯类基本为全文；纯官方公告若无正文，
  会提示改用「阅读原文」）

## 待办 / 可扩展

- [ ] 接入 FRED API（美债收益率等时间序列，需申请免费 key）
- [ ] 增加更多官方源（IMF / 世界银行 / 证监会 / 交易所）
- [ ] 条目按 6 大类资产打标，关联到 micro-control-finance 的章节
- [ ] 周报自动生成（可选，会引入 AI 调用成本）

---

## K线图

点击任意指数卡片即打开 K 线图（Canvas 手绘，零依赖，参照主流行情软件规范）：

- **红涨绿跌**，阳线空心 / 阴线实心（A 股习惯）
- MA5 / MA10 / MA20 / MA60 均线 + 图例数值
- 成交量副图，右侧价格轴，底部日期轴
- 十字光标 + 浮窗（开高低收 / 涨跌 / 成交量）
- **平移**：按住鼠标拖动回看历史（canvas 上按下、document 上移动/松开，鼠标移出画布也不中断；
  触屏同样支持），**双击回到最新**；也可用 **← / →** 键
- **缩放**：滚轮上下 / **Ctrl + 滚轮**（档次更细） / **Ctrl + `+` / `-`**（也支持不带修饰键）；
  缩放以**光标位置为锚点**（键盘以视图中心为锚点），锚点下的 K 线保持不动；
  160ms easeOut 平滑过渡；限幅 **20 根 ~ 全部**
- 可拖动时光标为「抓手」，图上提示「共 N 根 · 拖动/←→ 平移 · 滚轮或 Ctrl+± 缩放」；
  回看中提示「← 已回看 N 根 · 双击回到最新」；若根数不足则不显示拖动提示
- **关闭**：右上角 `×` 或 `Esc`。**点击阴影不会关闭** —— 拖动时鼠标常会移到画布外松手，
  若把松手当作点击蒙层会频繁误退出
- 周期切换 **1分 / 5分 / 15分 / 30分 / 60分 / 日K / 周K / 月K**，单次最多取 **1000 根**
  （东财 `lmt` 上限 1000；本地兜底文件为 250 根日K）
- **横轴带年份**：月K 显示 `YYYY-MM`、周K/日K 显示 `YY-MM-DD`，并在跨年处画淡色竖线，
  解决「只看 K 线认不出年份」的问题
- 弹窗打开且该市场处于交易时段时，每 20 秒自动刷新最新一根（保留当前回看位置）；休市不轮询
- 静态资源带版本号（`assets/*.js?v=...`），避免浏览器/GitHub Pages 缓存旧脚本

### K线数据源

**取数链（逐级回退，任何一级成功即止）：**

1. **东方财富** `push2his`（多镜像主机，缓存优先 + 并发兜底）—— 唯一覆盖全部 17 个指数、
   且含 1/5/15/30/60 分钟与日/周/月的源
2. **腾讯** `web.ifzq.gtimg.cn` —— 日/周/月，覆盖 CN/HK/US；东财不可达时兜底
3. **腾讯分时** `minute/query` —— 分钟周期兜底，用当日分时聚合出分钟K（**仅当天**）
4. **本地** `data/kline/<key>.json` —— 采集器预生成的日K；**周/月由日K在浏览器端聚合**
   （零网络）；离线也能用，仅分钟周期没有本地兜底

> 第 4 级是关键保底：只要 `data/kline/*.json` 在，「日/周/月」在任何网络下都能画出来。

| 指数 | 东财 | 腾讯 |
|---|---|---|
| 上证 / 深证 / 创业板 / 科创50 / 北证50 / 沪深300 / 中证500 / 中证1000 | ✓ | ✓(日周月) |
| 恒生指数 / 恒生科技 | ✓ | ✓(日周月) |
| 道琼斯 / 纳斯达克 / 标普500 | ✓ | ✓(日周月) |
| 日经225 / 德国DAX / 英国富时100 / 韩国KOSPI | ✓ | — |

> **实测注意**：东财这些镜像主机**会间歇性不可达**（同一时刻有的通、有的断，
> 表现为 `net::ERR_EMPTY_RESPONSE`），因此代码按主机缓存 + 失败并发赛其余。
> 东财整体不可达时，日/周/月由腾讯兜底，分钟由腾讯分时兜底（仅当天）；再不可达则
> 落到本地日K（周/月聚合）。仅「分钟周期 + 东财/腾讯都不可达」这一种组合会显示暂无数据。


## Cloudflare Worker 行情代理（已弃用，保留备查）

> **站点已不再依赖 Worker**：浏览器可直连东财，见上文。
> 本节仅当你有托管在 Cloudflare 的自定义域名、且希望海外访问时参考。

```powershell
cd worker
npx wrangler deploy    # 或 Cloudflare 控制台粘贴 worker/worker.js
```

**若你有托管在 Cloudflare 的域名**，用自定义域名即可绕开被污染的 `workers.dev`：
Worker → Settings → Triggers → Custom Domains → 填 `api.你的域名.com`。

### 接口

```
GET /health
GET /quote?secids=1.000001,100.DJIA&keys=sh_comp,dji
GET /kline?key=sh_comp&period=1d&limit=250
```

免费额度每天 10 万次请求，个人自用绰绰有余
（前端 15 秒轮询一次 ≈ 5760 次/天）。

## 踩过的坑

1. **CDATA 被吞**：`<![CDATA[...]]>` 会被 `<[^>]+>` 正则整段删除，导致统计局等源「成功但 0 条」
2. **PowerShell `| Out-Null`**：会让原生命令不执行，表现为 `git add` 没生效
3. **.ps1 必须带 BOM**：无 BOM 的 UTF-8 脚本被 PowerShell 5.1 按 GBK 解析，中文乱码导致语法错误
4. **腾讯美股端点**：`fqkline` 只给当天 1 根，必须用 `usfqkline`
5. **Windows 最小窗口宽度**：`--window-size=390` 会被钳到约 500px，测移动端要用 iframe
6. **CORS 是想当然**：曾断定「浏览器直连东财会被拦截」，实测东财两个接口都带
   `Access-Control-Allow-Origin: *`，无需代理（该项目一半的复杂度本可省掉）
7. **华尔街见闻 `uri` 已是完整 URL**：再拼一次域名会产生
   `https://wallstreetcn.comhttps://...` 的坏链接，链接全部失效
8. **「内容未变不写盘」误判**：剥离易变字段时把 `count / total / added` 也剥掉，
   导致同一天新增条目时 `index.json` 被判为未变化而跳过写盘，归档计数长期停留在旧值
9. **两个采集任务整份覆盖同一个文件**：5 分钟链路与 16:30 链路都写 `quotes.json` /
   `_last-run.json`，任何一边整份覆盖都会把另一边的结果抹掉。解法是两边都按 key 合并 / 读改写
10. **规格书的字段索引不可信**：`hf_XAU` 的 `[2]` 不是开盘价（与现价同值），真正的开盘在 `[8]`；
    照抄会让 `prevClose` 恒等于 `price`、涨跌幅恒为 0。`secid=133.USDCNY` 实测 `data:null`，
    可用的是 `133.USDCNH`（离岸价）。**所有字段索引都必须本机实测**
11. **`git over HTTPS 到 github.com 被重置**：`api.github.com` 通、`github.com:443` TCP 通，
    但 TLS 握手被 RST（`Recv failure: Connection was reset`）。SSH 走 `ssh.github.com:443` 正常，
    用仓库级 `url.<ssh>.insteadOf` 让 git 自动改走 SSH，remote URL 保持不变
12. **写盘前要建目录**：`data/macro/` 首次不存在时直接 `writeFile` 会 ENOENT；
    `writeJSON` 里有 `mkdir` 而 `writeJSONIfChanged` 里没有 —— 两个函数要一起改