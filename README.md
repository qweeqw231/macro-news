# 宏观资讯台 · Macro News

全球宏观资讯自动采集与归档：**利率 · 汇率 · 政策 · 大宗 · A股/港美股**。

| | |
|---|---|
| 站点 | **https://qweeqw231.github.io/macro-news/** |
| 形态 | 纯静态站（GitHub Pages）+ 定时采集写 JSON，**不需要服务器 / 数据库** |
| 数据规模 | **57 个行情标的**（18 指数 + 32 场内 ETF + 7 组合）、5 个宏观指标、8 个新闻源 |
| 前端 | 原生 JS + Canvas 手绘 K 线，零依赖 |

**读法**：第 1 节是全局地图；第 2~3 节是**规格（事实）**；第 4 节是数据契约；第 5~7 节是使用/部署/排障；**设计原因集中在第 8 节**，不和操作步骤混在一起。历史与被弃用的方案放最后。

---

## 1. 它是什么

站点四个页签（桌面/平板在顶部，手机在底部）：

| 页签 | 内容 |
|---|---|
| 要闻流 | 搜索 + 频道筛选 + 最新快讯（默认视图） |
| 行情 | 57 个标的的行情卡；点卡片打开 K 线抽屉 |
| 归档 | 按天列出条目数，点某天看当天全部 |
| 来源 | 8 个新闻源的状态 / 条数 / 耗时 / 错误 |

采集概况（最近一次采集时间 / 新增条数 / 行情项数 / 库内总计）渲染在**页脚**，任何视图下都可见。

### 多端与响应式

| 宽度 | 导航 | 布局 |
|---|---|---|
| ≤640px（手机） | 顶部只留 logo，**底部常驻四栏** | 行情卡 2 列；K 线/阅读器底部抽屉；周期与均线各一行横向滑动 |
| 641~900px（平板） | 顶部四页签 | 行情卡 3~4 列 |
| >900px（桌面） | 顶部四页签 | 行情卡 4~5 列 |

- 已用真实页面在 **320 / 390 / 430 / 768 / 1024** 五个宽度验证：无横向溢出。
- 刘海屏 / 底部手势条：`viewport-fit=cover` + `env(safe-area-inset-top/bottom)`。
- 手机底部导航常驻，不依赖汉堡抽屉；K 线画布高度为 `min(340px, 42vh)`，小屏也不会被按钮挤没。
- 横屏 / 矮窗口（高度 ≤560px）：K 线画布压到 200px，弹窗可滚动；手机横屏宽度 >640 时使用顶部页签。
- 搜索框提示按宽度切换：≤640px 用短文案（避免 placeholder 被截断），桌面用完整文案。

---

## 2. 数据链路（先看这一节）

采集分五条链路。**它们写不同的文件、互不覆盖**；`quotes.json` 只由链路 ① 写。

| # | 链路 | 谁在跑 | 频率 | 写什么 |
|---|---|---|---|---|
| ① | **新闻 + 行情** | GitHub Actions `collect.yml`（Cloudflare Worker 外部触发） | 15 分钟 | `data/archive/`、`latest.json`、`search.json`、`quotes.json` |
| ② | **K 线** | Actions `kline-full.yml` / `kline-minute.yml` | 全量每天 12:23；最后一根每小时 | `data/kline/` |
| ③ | **时点快照** | Actions `snapshot.yml` 兜底 + 本机 minimax 12:05 / 16:30 | 30 分钟 / 交易日两档 | `data/snapshots/` |
| ④ | **宏观指标** | 本机 minimax 16:30 | 每个交易日 | `data/macro/daily.json`、`kline/cgb_1y*` |
| ⑤ | **本机回退 / 同步** | Windows 计划任务 + minimax 每 4 小时 | 120 分钟 / 4 小时 | 本地 `data/`（回退采集、拉回远端） |

```
                      ┌──────────────── 链路 ① 每 15 分钟 ───────────────┐
Cloudflare Worker ──> │ collect.yml → collect.mjs                        │
（外部 cron）        │   新闻 + 51 个标的行情 + 6 个组合行情             │──> commit/push
                      └──────────────────────────────────────────────────┘
                      ┌──────────────── 链路 ② K 线 ─────────────────────┐
                      │ kline-full.yml   每天 12:23 全量日/周/月K          │
                      │ kline-minute.yml 每小时分钟K + 当前时段最后一根日K │──> commit/push
                      └──────────────────────────────────────────────────┘
                      ┌──────────────── 链路 ③ 快照 ─────────────────────┐
GitHub Actions ──────>│ snapshot.yml（兜底 + 回补 5 天）                  │
本机 minimax 12:05 ──>│ snapshot.mjs --auto（上午盘 / 收盘）              │──> commit/push
                      └──────────────────────────────────────────────────┘
                      ┌──────────────── 链路 ④ 宏观 ─────────────────────┐
本机 minimax 16:30 ──>│ portfolio-collect.mjs（5 指标 + 1Y国债日K）       │──> commit/push
                      └──────────────────────────────────────────────────┘
```

### 2.1 链路 ①：新闻 + 行情（15 分钟）

- **触发**：Cloudflare Worker Cron → GitHub `workflow_dispatch`（仓库内 `schedule` 只作冗余）。
- **动作**：`node src/collect.mjs --no-kline`
- **行情**：东财 `ulist.np` 批量一次拿完 **51 个**（18 指数 + 32 ETF + 纳指100）；
  组合行情由 `fetchPortfolioQuotesFast` 补充：`xau/xag/brent` 每轮刷新，
  `sge_au9999/usdcny/cgb_1y` 只在发布时刻（15:30 / 09:15 / 17:00）且存量不是今天时刷新。
- **新闻**：8 个源独立容错，条目按 `id` 幂等去重，按天写 `archive/`；
  `latest.json` 存最近 200 条（首屏），`search.json` 存全库检索索引（只有标题+摘要）。
- **推送**：`scripts/push-data.sh`（fetch + rebase 重试，只有 `data/` 变化才提交）。

### 2.2 链路 ②：K 线（每天全量 + 每小时最后一根）

- **全量**（`kline-full.yml`，UTC 04:23 = 北京 12:23）：
  - `scripts/update-kline-full.mjs`：8 个 CN 指数的全量日 K（`_full.json`）
  - `node src/collect.mjs --kline-only`：25 个标的 × 日/周/月（`<key>.json` / `_1w` / `_1M`）
- **分钟 + 最后一根**（`kline-minute.yml`，每小时 :17）：
  - `scripts/update-kline-minute.mjs`：7 个标的 × 5 个分钟周期（`min/`）
  - `scripts/update-kline-last.mjs`：只 upsert **当前处于交易时段**品种的最后一根日 K
    （上海金夜盘这类「未来蜡烛」要随采集动态更新，每天一次不够）

### 2.3 链路 ③：时点快照（12:05 / 16:30）

- **本机**：12:05 上午盘、16:30 收盘（`scripts/snapshot-collect-and-push.ps1`）。
- **云端兜底**：`snapshot.yml` 每 30 分钟，缺哪天的 am/pm 就补哪天，并回补最近 5 天。
- **不可覆盖**：`data/snapshots/YYYY-MM-DD_am|pm.json` 一个时点一个文件，只写一次。
- **取价**：一律走 K 线（历史数据可回溯），规则见 §3.2。

### 2.4 链路 ④：宏观（16:30）

`node src/portfolio-collect.mjs` → 5 个宏观指标 + 1Y 国债日 K。
**不再读写 `quotes.json`**（行情已全部并入链路 ①，避免每天 16:30 用旧值覆盖高频结果）。

### 2.5 链路 ⑤：本机回退与同步

| 任务 | 频率 | 作用 |
|---|---|---|
| Windows `MacroNews-Collect` | 120 分钟 | 云端正常时基本不产出；云端挂掉时接管（静默无窗口） |
| minimax `pull-remote.ps1` | 4 小时 | `git merge --ff-only` 把远端产物拉回本机，**绝不覆盖工作区** |

---

## 3. 采集规格（口径）

### 3.1 各市场「日 K 标为 D 的那一根」何时收完（北京时间）

这是**快照口径的根**，也解释了为什么 12:05 不能取日/韩当天的日 K。

| 市场 | 收完时间 | am 12:05 取 | pm 16:02 取 |
|---|---|---|---|
| CN / ETF | D 15:00 | 5 分钟 11:30 bar | D |
| HK | D 16:00 | 5 分钟 12:00 bar | D |
| JP | D 14:00 | **D−1** | D |
| KR | D 14:30 | **D−1** | D |
| EU / UK | D+1 00:30 | **D−1** | **D−1** |
| US | D+1 05:00 | **D−1** | **D−1** |

- 12:05 时，日/韩（UTC+9）已进入下午盘，当天日 K 是**没收盘的半截 bar**；
- 16:02 时，DAX/富时刚开盘，同样不能取当天；
- 欧美取冬令时较晚的收盘时刻（保守），采集时点离边界很远，不受夏令时影响。

### 3.2 时点快照怎么取价

| 档 | 目标时点 | 取价 |
|---|---|---|
| `am` | A股 11:30、港股 12:00 | 5 分钟 K 对应 bar 的收盘价 |
| `pm` | A股 15:00、港股 16:00 | 日 K 的官方收盘价（按 §3.1 选「已收完」的那根） |

每条记录带 `price / prevClose / changePct / asOf / priceSource / note`。
- `asOf` 是价格对应的**真实时刻**，不是采集时刻；
- `priceSource` = `kline5m` 或 `dailyK`；
- 采集时点未到 → 跳过；非交易日 → **一个文件都不写**（宁缺不假）；
- **昨收**：A股/ETF 用前一交易日 15:00 bar；港股用日 K 前一交易日收盘（5 分钟 K 没有 16:00 bar）。

### 3.3 日 K 取数规则

| 项 | 规则 |
|---|---|
| 主源 | 东财 `kline/get`，`klt=101/102/103`，`fqt=1` |
| 备源 | 腾讯（CN 8 + 港 2 + 美 3 指数）→ 新浪（CN 8 个）→ 新浪外盘（伦敦金/银、布伦特）→ 本地文件 |
| 根数 | 前端日/周/月请求 **20000**；服务端预生成 **1000 / 1821 / 500** 根 |
| 盘中 bar | 交易日会返回**当天未收盘**的 bar，K 线图显示为「活蜡烛」——绘图行为，不影响快照 |
| 日期 | bar 的 `t` 是**交易所当地日期**；周/月优先直接取源，源没有时用日 K 聚合 |

**分钟 K 与年 K**

- 分钟源上限（2026-10-31 实测）：
  - 东财：5m 最多 **1536** 根，1m 只有**当天 240** 根；
  - 新浪：**1023 根**，且**指数和场内 ETF 都有**（东财对 ETF 常常只给最近一天）；
  - 腾讯：320 根。
  ⇒ 客户端三源并发，规则是「最后一根最新优先；同一时刻取根数最多」。
  1m 最多约 4 个交易日；5m ≈ 21~32 天；15m ≈ 64~96 天；30m ≈ 128~192 天；60m ≈ 256~384 天。
- 年 K：没有可靠的年线接口，统一由**月 K 聚合**（中债等只有日频的标的由日 K 聚合），
  `t` 取 `YYYY-01-01`；ETF 按上市以来有多少年就多少根。
- 均线：日/周/月/分钟用 MA5 / 10 / 20 / 30 / 60 / 120 / 250，可在 K 线弹窗里逐条开关（状态存 localStorage）；
  年 K 只用 MA5 / 10 / 20 / 30（单位是年）。
  **所有周期都按数据根数判断可用性**：不足 n 根时该条不绘制、按钮置灰；数据增长到 n 根后自动启用。

### 3.4 行情刷新策略

| 标的 | 刷新 |
|---|---|
| 18 指数 + 32 ETF + `ndx` | 每 15 分钟（东财批量，纳指100 与 K 线同源 `100.NDX100`） |
| `xau` / `xag` / `brent` | 每 15 分钟（腾讯 `hf_*`） |
| `sge_au9999` | 15:30 后、存量不是今天才取（上金所日行情表） |
| `usdcny` | 09:15 后、存量不是今天才取（中国货币网） |
| `cgb_1y` | 17:00 后、存量不是今天才取（中债曲线） |

### 3.5 夜盘与「未来蜡烛」

上海金等有夜盘的品种，周五夜盘（20:00–次日 02:30）**归属下一交易日**，东财会把它标成
`2026-11-02`。在周六看就是一根「未来蜡烛」——这是交易所口径，行情软件同样如此，**保留显示**。

要保证的是它**随采集更新**：
- 图表层：`isTrading` 含 SGE 时段（日盘 + 夜盘，周六凌晨仍算周五夜盘），
  打开 K 线时每 20 秒重绘最后一根；
- 采集层：`update-kline-last.mjs` 每小时 upsert 当前交易时段品种的最后一根日 K。

### 3.6 幂等与推送

- 新闻按 `id` 去重；JSON 内容未变则跳过写盘（避免 git 反复存同样的 blob）。
- 多 workflow 各自独立 `concurrency group`，推送由 `push-data.sh` 做 fetch + rebase 重试。
- **禁止** `git reset --hard`；不要手工编辑 `data/`（下次采集会覆盖）。

---

## 4. 数据契约（前端 / AI 读什么）

| 文件 | 内容 | 谁写 |
|---|---|---|
| `data/quotes.json` | 57 个标的快照（18 指数 + 32 ETF + 7 组合） | 链路 ① |
| `data/snapshots/YYYY-MM-DD_am.json` | 上午盘时点价（57 项） | 链路 ③ |
| `data/snapshots/YYYY-MM-DD_pm.json` | 收盘时点价（57 项） | 链路 ③ |
| `data/archive/YYYY-MM-DD.json` | 按天归档新闻，**含正文** | 链路 ① |
| `data/latest.json` | 最近 200 条（首屏） | 链路 ① |
| `data/search.json` | 全库检索索引（**只有标题+摘要**，约 10 MB） | 链路 ① |
| `data/index.json` | 按天归档索引 | 链路 ① |
| `data/kline/<key>.json` / `_1w` / `_1M` | 25 个标的 × 日/周/月 | 链路 ② |
| `data/kline/<key>_full.json` | 8 个 CN 指数的全量日 K（紧凑数组 `[t,o,c,h,l,v]`） | 链路 ② |
| `data/kline/min/<key>_<period>.json` | 7 个标的 × 5 个分钟周期 | 链路 ② |
| `data/macro/daily.json` | 5 个宏观指标日频序列 | 链路 ④ |
| `data/_last-run.json` | 各链路运行状态（字段并存，读改写） | 所有链路 |

**给 AI / 脚本的读取规则**

- 要**行情 / 宏观** → 读 `quotes.json` + `macro/daily.json`，不要自己抓接口。
- 要**某天收盘价** → 读 `snapshots/`；`quotes.json` 里的 A股是实时价，不等于收盘价。
- 要**新闻全文** → 读 `archive/` 的 `items[].content`；`search.json` 没有正文。
- 不要顺手触发采集，也不要手工编辑 `data/`。

前端行为：行情与 K 线**浏览器直连东财**（CORS `*`），失败才回退到上述本地文件；
K 线采用**三源并发赛马**（本地快照 / 东财 / 腾讯+新浪），根数不减少才覆盖。

---

## 5. 使用

日常不需要手动跑任何东西。下面命令只在「想立刻刷新 / 排查」时用。

```powershell
# 本地预览（或直接双击 start.cmd）
node scripts/serve.mjs

# 从远端拉最新数据（= 每 4 小时任务）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pull-remote.ps1

# 手动采集一次（新闻 + 行情，通常由 Actions 跑）
node src/collect.mjs

# 补最近 5 天缺失的时点快照
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\snapshot-collect-and-push.ps1 -Backfill 5

# 收盘快照 + 宏观 + 1Y国债日K
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portfolio-collect-and-push.ps1

# 只刷新当前交易时段的最后一根日K（看结果不写盘加 --dry-run）
node scripts/update-kline-last.mjs --dry-run
```

页签是 `href="#view-xxx"` 真链接：可收藏、可分享、没 JS 也能跳转。
搜索计数有两个母集：未输入关键词是「最新快照 200 条」，输入后是「全库 N 条中命中 M 条」，
页面上会明确写出，避免出现「带关键词的条数 > 不带关键词的条数」的错觉。

---

## 6. 部署与运维

### 6.1 GitHub Pages（一次性）

1. 新建 **Public** 仓库（Actions 免费额度）；推送 `main`。
2. Settings → Pages → Source = `main` / `/ (root)`。
3. 仓库根必须有 **`.nojekyll`**：Jekyll 会忽略 `_` 开头的文件，而 `data/_last-run.json` 正好是。
4. Actions 页启用 `宏观资讯采集`，可手动 `Run workflow` 验证。

> 本机到 `github.com` 的 HTTPS 会被重置，git 走 SSH-443（仓库已配 `insteadOf`）；
> `github.io` 是否可达取决于当时网络。

### 6.2 Cloudflare Worker（外部 cron，一次性）

GitHub 自带 `schedule` 实测只兑现约 3%，所以触发搬到仓库外：

| cron | 驱动 |
|---|---|
| `7,22,37,52 * * * *` | `collect.yml` |
| `13,43 * * * *` | `snapshot.yml` |
| `17,47 * * * *` | `kline-minute.yml`（UTC 04:17 那轮附带 `kline-full.yml`） |

```bash
# 1) GitHub → Developer settings → Fine-grained tokens
#    Repository access: 只选 macro-news；Permissions: Actions → Read and write
# 2) 部署
cd worker/gh-cron && npx wrangler deploy
# 3) 写 secret（国内打不开 dash.cloudflare.com，用 API 版脚本）
powershell -ExecutionPolicy Bypass -File scripts\set-worker-secret.ps1
```

观测点：KV 键 `STATE.last_dispatch`（最近一次 `{at, cron, results}`），
`GET /accounts/<acc>/storage/kv/namespaces/<ns>/values/last_dispatch`。

三个会伪装成「token 坏了」的坑：

| 现象 | 真因 | 修法 |
|---|---|---|
| GitHub 返回 400 且响应体为空 | `workflow_id` 写了完整路径 | 只写文件名（`collect.yml`） |
| 返回 400 而非 401 | PAT 行尾有空白 | 写入前 `.Trim()` |
| workflow 解析失败、没有 job | `run:` 里有 `MSG_PREFIX="data: ..."` 的 `: ` | 整行加引号 |

### 6.3 本机定时任务

| 任务 | 计划 | 脚本 | cron_id |
|---|---|---|---|
| 上午盘快照 | `5 12 * * 1-5` | `scripts\snapshot-collect-and-push.ps1` | `8333a316-198e-4ca6-9a66-2e65a3c76643` |
| 收盘快照 + 宏观 | `30 16 * * 1-5` | `scripts\portfolio-collect-and-push.ps1` | `9b31e4b6-fa07-44ce-83f4-67c8d1eb5aa2` |
| 失败重试 | `35 16 * * 1-5` | 读 `logs\last-portfolio-status.json`，失败才补跑 | `95efe173-0c21-4250-8240-695641e49677` |
| 远端同步 | `0 */4 * * *` | `scripts\pull-remote.ps1` | `6f7816d3-da5f-4eda-9030-476a55684b6a` |

Windows 回退任务 `MacroNews-Collect` 默认每 120 分钟，`wscript + run-hidden.vbs` 零窗口启动。

---

## 7. 排障（现象 → 真因 → 修法）

| 现象 | 真因 | 修法 |
|---|---|---|
| 定时任务「少跑」/ 长时间不动 | GitHub schedule 只兑现约 3% | Worker 外部触发；本机 120 分钟兜底 |
| 云端所有 workflow 都不建 job | `run:` 里的 `: ` 让 YAML 解析失败 | 整行加单引号 |
| 数据提交了但内容没变 / 丢数据 | `push-data.sh` 把 `MSG_PREFIX=...` 当路径；或多 workflow 同组被取消 | 解析 `KEY=VALUE`；各自独立 concurrency group |
| 行情卡片停在上一交易日 | 美股/贵金属在 16:30 组合采集时还没收盘 | 组合行情并入 15 分钟链路（2026-10-31） |
| 快照收盘价不对（例如 csi300 差 0.4%） | 采集早于收盘，把盘中日 K 当收盘价 | `readyAt` 守卫 + §3.1「已收完」表 |
| 港股 am 昨收差十几点 | 5 分钟 K 只到 15:35，没有 16:00 bar | 港股昨收改走日 K |
| 上海金多出一根「未来」日 K | 夜盘归属下一交易日 | **保留**，靠每小时 `update-kline-last` 动态更新 |
| 点东财 K 线要等好几秒 | 串行 fallback 先等东财超时 | 三源并发赛马，谁先回谁出图 |
| 腾讯兜底 K 线静默失效 | DNS 解析不了 `web.ifzq.gtimg.cn` | 改用 `ifzq.gtimg.cn` |
| 一个源挂了，备用源也跟着挂 | 熔断是全局计数 | 熔断按主机组隔离 |
| 批量行情里 ETF 全是 `-` | 用错了 `stock/get` 字段 | 改用 `ulist.np` 的 `f2/f12/f13/f14/f18` |
| 源时间戳看着在收盘后还在跳 | `f124/f86` 是推送时间，不是成交时间 | 快照一律走 K 线，不用实时价自证 |
| 改了 HTML 十分钟不生效 | Pages 对 HTML 发 `max-age=600` | URL 加查询串或强刷 |
| `workers.dev` 打不开 | 域名被 DNS 污染 | 站点不依赖它；需要时绑自定义域名 |

---

## 8. 设计决策（为什么这么做）

> 这一节只讲**原因**；具体怎么做见 §2/§3。

1. **纯静态 + 浏览器直连**：没有服务器成本；东财/腾讯接口带 CORS，国内可直连。
   采集器只写 JSON，Pages 只负责分发。
2. **触发放在 Cloudflare Worker**：GitHub 排程长期只兑现约 3%（26 天实测 144 次 / 声明 288 次/天），
   仓库内改 cron 只能改变「哪几次被吞」。外部 cron 不依赖 GitHub 排程器，也不依赖本机开机。
3. **快照用 K 线，不用实时价**：K 线是历史数据，事后任意时刻重跑都能补出真值；
   实时价的源时间戳在收盘后仍会跳（15:32 → 16:26），无法证明价格冻结在目标时点。
4. **组合行情并入高频链路**：原先 16:30 每天采一次，而美股/伦敦金在 16:30 还没开盘，
   「最新价」永远停在上一交易日。现在 ndx/xau/xag/brent 每 15 分钟，日频品种到发布时刻才取。
5. **采集不占用 AI 上下文**：采集是确定性 IO，归定时任务；AI 只在被要求时读数据。
6. **K 线三源赛马**：串行 fallback 会让用户先白等东财超时；并发后首屏从数秒降到百毫秒级。
7. **快照文件只写一次**：按交易日归档、不可覆盖，避免「上午盘被下午盘覆盖、无法回溯」。

---

## 9. 已知限制 / 待办

- 新闻正文覆盖率不是 100%：人民银行、欧洲央行只有标题（原文在 PDF 里）。
- `search.json` 约 10 MB，首次全文检索要下载索引（Pages 带宽实测 5~30 KB/s）。
- cron 不认法定节假日：行情沿用上一交易日，快照直接不写文件（属正常行为）。
- `data/archive/` 持续增长，一年后值得重新评估归档策略。
- 上海金 17:00 前、中债曲线傍晚才发布，当天看准确收盘价用 `etf_518880`（黄金 ETF）。
- **现货金/银的报价源（腾讯/新浪 `hf_*`）在 04:55 冻结**，官方 05:00 收盘。2026-10-30 实测：
  伦敦金 3876.69（04:55）vs Wind 3875.19 / 同花顺 3875.06 / 支付宝 3875.02，差约 1.67（0.04%）；
  东财现货 `122.XAU` 更新到 04:59（3875.55），但没有对应的 K 线接口。
- **布伦特是连续合约**（新浪外盘 OIL）：与新闻里的「12 月合约」存在基差，
  2026-10-30 连续 113.4 vs 12 月合约 117.64（约 4 美元），但涨跌幅一致（+2.4%）。

---

## 附录 A：数据源

| 类别 | 源 | 取什么 | 备源 |
|---|---|---|---|
| 行情 | 东财 `ulist.np` | 18 指数 + 32 ETF 最新价（1 个请求） | 腾讯 `qt.gtimg.cn` |
| K 线 | 东财 `push2his` | 日/周/月 + 分钟 | 腾讯 `ifzq.gtimg.cn`；新浪（仅 CN 8 指数） |
| 组合 | 腾讯 `hf_XAU` / `hf_XAG` / `hf_OIL` / `usNDX` | 伦敦金/银、布伦特、纳指100 | 东财 `100.NDX100` |
| 组合 | 上金所官网 | 上海金 Au99.99 | 估算回退（note=estimated） |
| 组合 | 中国货币网 `ccpr.json` | 人民币中间价 | 东财 `133.USDCNH`（离岸） |
| 组合 | 中债 `queryGjqxInfo` | 1Y 国债收益率 | 无 |
| 宏观 | 上交所+深交所 / FRED / 央行 / 统计局 | 两融、10Y 美债、社融、CPI、PMI | 无 |
| 新闻 | 华尔街见闻 / 东财 / 新浪 / 中新网 / 央行 / 美联储 / 欧洲央行 / 统计局 | 快讯与政策发布 | 无 |

取数基础设施 `src/em.mjs`：主机镜像、90ms 全局限速、指数退避、**按主机组隔离的熔断**、磁盘缓存。

## 附录 B：目录结构

```
macro-news/
├── index.html / .nojekyll / start.cmd
├── assets/            style.css · app.js · market.js · kline.js · fuse.min.js · icon.svg
├── data/              采集产物（入库，Pages 直接读）
│   ├── quotes.json · latest.json · search.json · index.json · _last-run.json
│   ├── snapshots/     时点快照（权威收盘价）
│   ├── archive/       按天新闻（含正文）
│   ├── kline/         日/周/月 + _full + min/
│   └── macro/daily.json
├── src/
│   ├── collect.mjs    新闻 + 行情主程序（--no-kline / --kline-only）
│   ├── sources.mjs    新闻源 + 18 指数适配器 + fetchKline
│   ├── quotes.mjs     批量行情（东财 → 腾讯）
│   ├── kline.mjs      日 K / 5 分钟 K（东财 → 腾讯）
│   ├── em.mjs         镜像 / 限速 / 退避 / 熔断 / 缓存
│   ├── snapshot.mjs   时点快照（am/pm，含 §3.1 收盘时刻表）
│   ├── portfolio.mjs  7 个组合行情 + 5 个宏观指标
│   └── portfolio-collect.mjs  宏观 + 1Y国债日K（每日 16:30）
├── scripts/           serve · push-data.sh · update-kline-{full,minute,last} · 各 PowerShell 任务
└── worker/gh-cron/    Cloudflare 外部触发器（窄职责，仅 dispatch）
```

## 附录 C：历史与被弃用

- **GitHub schedule 时代**：曾用 `*/5` 声明 5 分钟，实测 3~6 小时一次；已由 Worker 外部触发取代。
- **Cloudflare Worker 行情代理（已弃用）**：早期想用 Worker 代理行情绕过 CORS，
  实测 `workers.dev` 被 DNS 污染、国内不可达；且东财接口本身带 CORS，代理不再需要。
  `worker/` 目录仅保留用于海外或绑定自定义域名。
- **串行 K 线 fallback**：已被三源并发赛马取代。
- **16:30 组合行情链路**：已被并入 15 分钟链路；16:30 任务只剩宏观 + 1Y 国债日 K。
