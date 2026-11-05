# 宏观资讯台 · Macro News

全球宏观资讯自动采集与归档：**利率 · 汇率 · 政策 · 大宗 · A股/港美股**。

| | |
|---|---|
| 站点 | **https://qweeqw231.github.io/macro-news/** |
| 形态 | 纯静态站（GitHub Pages）+ 定时采集写 JSON，**不需要服务器 / 数据库** |
| 数据规模 | **59 个行情标的**（20 指数 + 32 场内 ETF + 7 组合）、5 个宏观指标、8 个新闻源 |
| 前端 | 原生 JS + Canvas 手绘 K 线，零依赖 |

**读法**：第 1 节是全局地图；第 2~3 节是**规格（事实）**；第 4 节是数据契约；第 5~7 节是使用/部署/排障；**设计原因集中在第 8 节**，不和操作步骤混在一起。历史与被弃用的方案放最后。

---

## 1. 它是什么

站点四个页签（桌面/平板在顶部，手机在底部）：

| 页签 | 内容 |
|---|---|
| 要闻流 | 搜索 + 频道筛选 + 最新快讯（默认视图） |
| 行情 | 59 个标的的行情卡，支持按名称 / 代码 / 英文缩写搜索；点卡片打开 K 线抽屉 |
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
- 手机 K 线手势：**单指拖动平移 / 双指捏合缩放（锚点=双指中点）/ 双击回最新 / 单击看明细**；
  画布 `touch-action:none`，缩放不带动整页。桌面仍是拖动、←→、滚轮、Ctrl+±。
- 画布左下角手势提示按指针类型切换：触屏只说「单指拖动 · 双指缩放」，不出现「滚轮 / Ctrl」。
- 横屏 / 矮窗口（高度 ≤560px）：K 线画布压到 200px，弹窗可滚动；手机横屏宽度 >640 时使用顶部页签。
- 搜索框提示按宽度切换：≤640px 用短文案（避免 placeholder 被截断），桌面用完整文案。

---

## 2. 数据链路（先看这一节）

采集分五条链路。**它们写不同的文件、互不覆盖**；`quotes.json` 只由链路 ① 写。

| # | 链路 | 谁在跑 | 频率 | 写什么 |
|---|---|---|---|---|
| ① | **新闻 + 行情** | GitHub Actions `collect.yml`（Cloudflare Worker 外部触发） | 15 分钟 | `data/archive/`、`latest.json`、`search.json`、`quotes.json` |
| ② | **K 线** | Actions `kline-full.yml` / `kline-minute.yml` | 全量每天 12:23；最后一根每小时 | `data/kline/` |
| ③ | **时点快照** | Actions `snapshot.yml`（Worker 每 30 分钟触发，回补 5 天） | 30 分钟 | `data/snapshots/` |
| ④ | **宏观指标** | Actions `snapshot.yml`（17:00 后幂等补当天） | 每个交易日 | `data/macro/daily.json`、`kline/cgb_1y*` |
| ⑤ | **本机回退 / 同步** | Windows 计划任务 `MacroNews-Collect` / `MacroNews-Pull` | 120 分钟 / 4 小时 | 本地 `data/`（回退采集、拉回远端） |

```
                      ┌──────────────── 链路 ① 每 15 分钟 ───────────────┐
Cloudflare Worker ──> │ collect.yml → collect.mjs                        │
（外部 cron）        │   新闻 + 53 个标的行情 + 6 个组合行情             │──> commit/push
                      └──────────────────────────────────────────────────┘
                      ┌──────────────── 链路 ② K 线 ─────────────────────┐
                      │ kline-full.yml   每天 12:23 全量日/周/月K          │
                      │ kline-minute.yml 每小时分钟K + 当前时段最后一根日K │──> commit/push
                      └──────────────────────────────────────────────────┘
                      ┌──────────── 链路 ③ 快照 + ④ 宏观 ───────────────┐
GitHub Actions ──────>│ snapshot.yml（快照兜底 + 回补 5 天）              │
Cloudflare Worker ──> │ 17:00 后：collect-macro-if-due.mjs（幂等补当天）  │──> commit/push
                      └──────────────────────────────────────────────────┘
```

### 2.1 链路 ①：新闻 + 行情（15 分钟）

- **触发**：Cloudflare Worker Cron → GitHub `workflow_dispatch`（仓库内 `schedule` 只作冗余）。
- **动作**：`node src/collect.mjs --no-kline`
- **行情**：东财 `ulist.np` 批量一次拿完 **53 个**（20 指数 + 32 ETF + 纳指100）；
  组合行情由 `fetchPortfolioQuotesFast` 补充：`xau/xag/brent` 每轮刷新，
  `sge_au9999/usdcny/cgb_1y` 只在发布时刻（15:30 / 09:15 / 17:00）且存量不是今天时刷新。
- **新闻**：8 个源独立容错，条目先按 `id` 幂等去重，再按 2.4.5 的「同文合并」规则去重：
  同一 `url`、或同一来源＋同一时间＋同一正文/标题 ⇒ 只留一条；频道按具体度取舍
  `A股/中国 > 国内财经 > 外汇/大宗/美股 > 全球`，同频道保留正文更长的一条。
  写归档时对「本轮新增 + 已有条目」重新跑一遍合并，因此旧数据里的双频道重复会在
  下一次采集时自愈。按天写 `archive/`；`latest.json` 存最近 200 条（首屏），
  `search.json` 存全库检索索引（只有标题+摘要）。
- **标题（2.4.6）**：无独立标题的快讯取正文**第一整句**，完整入 `title`，不再硬截 40 字；
  需要短版时只在标点边界（`。！？；` → `，、`）断开并加 `…`，找不到标点就返回全文。
  前端 `.item-title` 用 `-webkit-line-clamp: 2` 多行省略，不做字符截断。
  历史数据可用 `node scripts/repair-archive.mjs` 从 `content` 回填（幂等）。
- **RSS 时间（2.4.8）**：带时区（`Z` / `±HH:MM` / `GMT`）的 `pubDate` 原样解析；
  不带时区的（如统计局 `2026-11-04 09:30:00`）按来源 `tz` 解释（中国源默认
  `Asia/Shanghai`），**不依赖 runner 的本地时区**。历史偏移可用
  `node scripts/repair-nbs-time.mjs --apply` 回填：只修与统计局原文页
  `<meta name="PubDate">` 恰好差 +480 分钟的条目，其它差异不动。
- **推送**：`scripts/push-data.sh`（fetch + rebase 重试，只有 `data/` 变化才提交）。

**指数名录（20 个）**

| 分组 | key | 名称 | 代码 | 东财 secid | 腾讯 |
|---|---|---|---|---|---|
| A股 | `sh_comp` | 上证指数 | 000001 | `1.000001` | `sh000001` |
| A股 | `sz_comp` | 深证成指 | 399001 | `0.399001` | `sz399001` |
| A股 | `chinext` | 创业板指 | 399006 | `0.399006` | `sz399006` |
| A股 | `star50` | 科创50 | 000688 | `1.000688` | `sh000688` |
| A股 | `bse50` | 北证50 | 899050 | `0.899050` | `bj899050` |
| A股 | `csi300` | 沪深300 | 000300 | `1.000300` | `sh000300` |
| A股 | `sse50` | 上证50 | 000016 | `1.000016` | `sh000016` |
| A股 | `a500` | 中证A500 | 000510 | `1.000510` | `sh000510` |
| A股 | `csi500` | 中证500 | 000905 | `1.000905` | `sh000905` |
| A股 | `csi1000` | 中证1000 | 000852 | `1.000852` | `sh000852` |
| 港股 | `hsi` | 恒生指数 | HSI | `100.HSI` | `hkHSI` |
| 港股 | `hs_tech` | 恒生科技 | HSTECH | `124.HSTECH` | `hkHSTECH` |
| 美股 | `dji` | 道琼斯 | DJI | `100.DJIA` | `usDJI` |
| 美股 | `ixic` | 纳斯达克 | IXIC | `100.NDX` | `usIXIC` |
| 美股 | `spx` | 标普500 | SPX | `100.SPX` | `usINX` |
| 日本 | `n225` | 日经225 | N225 | `100.N225` | — |
| 欧洲 | `dax` | 德国DAX | DAX | `100.GDAXI` | — |
| 欧洲 | `cac40` | 法国CAC40 | CAC40 | `100.FCHI` | — |
| 英国 | `ukx` | 英国富时100 | FTSE | `100.FTSE` | — |
| 韩国 | `kospi` | 韩国KOSPI | KOSPI | `100.KS11` | — |

`上证50` 的 `000016` 是**上交所指数代码**；东财 `QuoteID=1.000016`、腾讯 `sh000016`，
两源返回的名称均为「上证50」（2026-11-02 核对，见 CHANGELOG）。

### 2.2 链路 ②：K 线（每天全量 + 每小时最后一根）

- **全量**（`kline-full.yml`，UTC 04:23 = 北京 12:23）：
  - `scripts/update-kline-full.mjs`：10 个 CN 指数的全量日 K（`_full.json`）
  - `node src/collect.mjs --kline-only`：27 个标的 × 日/周/月（`<key>.json` / `_1w` / `_1M`）
- **分钟 + 最后一根**（`kline-minute.yml`，每小时 :17）：
  - `scripts/update-kline-minute.mjs`：8 个标的 × 5 个分钟周期（`min/`）
  - `scripts/update-kline-last.mjs`：只 upsert **当前处于交易时段**品种的最后一根日 K
  - **短覆盖守卫（2.4.10）**：所有写 `data/kline/` 的脚本统一走 `src/kline-guard.mjs`。
    新结果首根更晚且更短 → 拒绝并记录（`rejected: shorter`）；等长但末根更新 / 更长 → 接受；
    更长但中间有缺口 → 按时间键 union 合并。绝不静默用短序列覆盖长历史。
  - **成交量保护（2.4.11）**：同一时间键上，incoming 的 0 成交量不得覆盖现有非零值。
    上海金日线由东财（有量）与上金所（无量）交替写入，没有这条守卫会被反复抹掉。
    （上海金夜盘这类「未来蜡烛」要随采集动态更新，每天一次不够）

### 2.3 链路 ③：时点快照（云端 30 分钟兜底）

- **云端**：`snapshot.yml` 由 Worker 每 30 分钟触发，缺哪天的 am/pm 就补哪天，并回补最近 5 天。
- **不再有本机准点任务**：2026-10-31 起 minimax 的 12:05 / 16:30 快照任务已下线。
  时点价一律取 K 线，晚采不影响数值（`capturedAt` 会晚，`asOf` 与价格不变）。
- **不可覆盖**：`data/snapshots/YYYY-MM-DD_am|pm.json` 一个时点一个文件，只写一次。
- **历史定案**：新增行情标的后，只保证新增日之后的 am/pm 快照包含它；
  历史快照缺口**不回填、不重写**（时点价事后无法还原，宁可缺，不补造）。
- **取价**：一律走 K 线（历史数据可回溯），规则见 §3.2。

### 2.4 链路 ④：宏观（17:00 后，云端）

`node src/portfolio-collect.mjs` → 5 个宏观指标 + 1Y 国债日 K。
挂在 `snapshot.yml` 里：`scripts/collect-macro-if-due.mjs` 每 30 分钟检查一次，
只有**北京工作日 17:00 后、且当天还没有记录**时才真正采集（17:13 / 17:43 天然重试）。
17:00 是下限：中债 1Y 曲线要 17:00 后才发布，16:30 采会把昨天的值当今天。
每次门禁还会先跑 `scripts/backfill-macro.mjs --days 14`：补最近 14 天缺失的日记录
（两融/10Y 美债按目标日期取，1Y 国债补当日 K 线，社融/CPI/PMI 取最近一条月度值）；
没有缺口时只读一次文件，不发请求。
**日频源**：两融 / 10Y 美债优先走东方财富数据中心（GitHub Actions 可达）；
上交所+深交所 / FRED 仅作回退（Actions 实测不可达）。1Y 国债仍走中债。
**不再读写 `quotes.json`**（行情已全部并入链路 ①，避免用旧值覆盖高频结果）。

### 2.5 链路 ⑤：本机回退与同步

| 任务 | 频率 | 作用 |
|---|---|---|
| Windows `MacroNews-Collect` | 120 分钟 | 云端正常时基本不产出；云端挂掉时接管（静默无窗口） |
| Windows `MacroNews-Pull` | 4 小时 | `git merge --ff-only` 把远端产物拉回本机，**绝不覆盖工作区** |

### 2.6 链路 ⑥：每日早报（09:00，本机固定对话）

**2.3.0 起：管道归脚本，写作归 LLM**。中间产物在 `.local/runs/YYYY-MM-DD/`
（`input.json` → `outline.json` → `draft.json` → `final.json`，`.local/` 不进 git）；
`publish` 通过校验后才写 `data/briefings/YYYY-MM-DD.json`（与归档日期同键绑定，见 §2.7）。

> mcode 任务提示词是**手写成品**，优先级高于 `prepare` 生成的 `prompt.md`：
> [mcode 早报任务提示词](file:///c:/Work/Minimax_Work/macro-news/docs/superpowers/specs/2026-11-02-mcode-briefing-task-prompt.md)。
> 两者冲突时以任务提示词为准；`prompt.md` 只作当天数据入口与补充。

| 环节 | 实现 |
|---|---|
| 触发 | minimax 定时任务 `macro-news 宏观早报（每日 09:00）`，cron `0 9 * * *`（Asia/Shanghai），**固定对话**（同一个任务专用对话，历史累积可回溯）。2.3.0 的三段式调度由用户在 mcode 侧执行，仓库不自动改任务 |
| prepare | `node scripts/briefing/prepare.mjs --date <今天>`：同步/导入 archive → `brief-candidates` 去重打分 → 固化 `input.json`（不发布、不进仓库） |
| 写作 | **LLM 判断**：读 `.local/runs/<date>/prompt.md`，按 schema 写 `outline.json` → `draft.json` → `final.json`；≤10 条，同一事件多源合并 |
| publish | `node scripts/briefing/publish.mjs --date <今天> --push`：校验 schema / 条数 / 来源可追溯 / `inputSha`，通过才原子写站点与本地，并更新索引、状态；`--push` 只提交早报相关 4 个路径（见 §2.6.1） |
| 产物 | `.local/briefings/YYYY-MM-DD.json` + `.md`（本地）+ `data/briefings/YYYY-MM-DD.json`（站点） |

**新闻库** `.local/news.db`（SQLite + FTS5，中文 bigram 分词）：52 万条量级；
近 60 天有全文/摘要，5 年历史以标题+链接为主（中新网回填约 50 万条）。
**已接入静态站**：2.2.0 上线近一年历史切片，2.4.10 补齐 09-20~10-04；当前
**319 天 / 72,553 条 / 截止 2026-10-04**，09-20 之后走 `archive/` 全文。
历史切片只有标题/来源/时间/原文链接，**没有摘要与正文**。

⚠ 两个实测坑（早报任务会天天踩，所以写进指令里）：
1. **库里的 `published_at` 是「入库时刻」不是原始发布时间，且格式不统一** ——
   `+08:00` 结尾的是抓取源（东方财富/新浪财经/华尔街见闻），原样用；
   `Z` 结尾的是 UTC（中新网/国家统计局/美联储/欧洲央行），**要 +8 小时**再转北京时间。
   校验锚点：统计局 PMI 那条 `2026-10-31T01:30:01Z` → 北京时间 9:30，正是官方发布时刻。
2. **同一篇文章在库里可能有两行**：中新网回填行是 date 精度占位（`T12:00:00+08:00`、summary 为空），
   采集行才有全文 ⇒ 取时间与链接要用**有 summary 的那一行**。

**三段式（2.3.0）**

```
prepare --date（脚本，确定性）
  → input.json / prompt.md（.local/runs/<date>/，不发布）
LLM 写作（语义判断）
  → outline.json → draft.json → final.json（分段检查点，可续写）
publish --date（脚本，确定性）
  → 校验通过才写 data/briefings/，否则 missed 或 source:"draft" 事实清单
```

- **幂等**：`prepare` 发现 `input.json` 已存在就复用（不重抓、不产生第二套候选）；
  LLM 从最近有效检查点续写；`publish` 遇到站点已有完整 AI 早报**永不覆盖**。
- **降级不冒充**：LLM 不可用/定稿不合格 → 不写文件并标 `missed`；
  显式加 `--draft-on-fail` 才写 `source:"draft"` 的事实清单（只有标题/来源/时间/链接，无 AI 摘要）。
  `source` 取值：`ai`（LLM 定稿，无角标）、`draft`（事实清单）、`rule`（仅人工显式 `generate.mjs`）。
- `node scripts/briefing/ensure.mjs` **自动模式只补今天**：今天过 **09:30** 仍未完整时，
  只运行 `prepare` 固化输入并标 `awaiting`，**不再自动生成规则版**；本地已有完整 AI 产物则只发布。
  历史缺口不生成任何早报，只在状态文件里标 `missed`（宁缺不假）。
  需要人工补历史时显式给 `--backfill-from/--backfill-to`（默认关闭、不参与调度）。
- 状态写 `data/_briefing-status.json`（单文件、保留 14 天，非高频）：页脚显示
  `早报 09:02`（绿，AI）/ `早报 事实清单 09:35`（棕，draft）/ `早报 自动`（棕，rule）/
  `早报 待写作` / `早报 待发布` / `早报 补跑中` / `早报 失败` / `早报 未记录`。
- 防重入锁 `.local/briefing.lock`（ensure，pid + 启动时刻，20 分钟失效）与
  `.local/runs/<date>/run.lock`（prepare/publish 共用）；单日硬超时 15 分钟，
  超时以退出码 124 结束并记录原因。
- 判据**不看 `generatedAt`**（它是开始时刻，11-02 事故里写着 09:02、实际 12:15 才落盘）：
  文件存在、JSON 可解析、`items > 0`、`overview` 非空，新产物另有 `endedAt`。
- **状态不变式（2.2.3）**：存在早报文件的日子必须是 `done` 且 `source` 与文件一致；
  `missed` 只用于「无文件且未成功生成」。每次 `ensure` 会先校正再校验，违规时退出码 1。

**发布即入库（2.4.2）**

`publish --date <今天> --push` 在发布成功后自动：

1. 只 `git add --` 4 个路径：`data/briefings/<date>.json`、`data/index.json`、
   `data/history/index.json`、`data/_briefing-status.json`（**不整目录 add**）；
2. `git fetch origin main` → `git rebase origin/main` → `git push origin HEAD:main`；
3. push/rebase 失败**不回滚已发布文件**，状态写 `pushed:false / pushError / pushErrorKind`，
   页脚显示 `早报 已发布未入库`（悬停看原因）。
4. **rebase 冲突（2.4.8，2.4.18 修正语义）**：采集器与发布器同时改 `data/index.json` /
   `data/_briefing-status.json` 时自动语义合并后 `rebase --continue`：
   - ⚠️ **rebase 冲突时 `:2:` = 上游（origin/main），`:3:` = 正在重放的本地提交**
     （与 merge 的 ours/theirs 直觉相反；2026-11-05 真实 git 实测确认）。
   - 合并基准 = **以 `:2:`（远端）最新计数为底**，叠加 `:3:`（本地）这一天的
     `hasBriefing/briefLine/source`；状态文件同理 = 远端为底 + 本地当天的发布状态。
     绝不做整文件取一侧。
   - 冲突文件不在白名单（`data/index.json`、`data/history/index.json`、
     `data/_briefing-status.json`）时仍然中止，绝不 force push。

兜底：本机 `collect-and-push.ps1` 每 120 分钟只放行**今天/昨天已存在**的单个早报文件。
不变式：`hasBriefing=true` ⇔ 文件存在且已被 git 跟踪（`tests/briefing-index-invariant.test.mjs` 锁定）。

归档页早报（2.4.3）：折叠只显示索引里的 `briefLine`；展开时**才**拉取当天
`data/briefings/<date>.json`（历史 `default`、当日 `no-store`），渲染
`overview + items + watch`，并把 summary 换成 `当日早报 · N 条 · HH:MM 生成` 以避免同句重复。
首屏不预取（实测 0 个 `briefings` 请求）；单份 10 KB，Pages 带宽下线上展开约 40 秒属正常。

### 2.7 链路 ⑦：近一年历史切片（离线导出）

**不是定时任务**，需要时手动跑；读本地新闻库，只写静态文件。

| 环节 | 实现 |
|---|---|
| 数据源 | `.local/news.db`（SQLite，525,925 条，2021-11 起） |
| 导出 | `node scripts/export-history.mjs --days 365` → `data/history/YYYY-MM-DD.json` + `index.json` |
| 范围 | 到**昨天**为止 365 天；只导 `data/archive/` 未覆盖的日期（gap-only），已存在的切片不覆盖 |
| 现状（2.4.10） | **319 天 / 72,553 条 / 截止 2026-10-04**；09-20 起有 archive 占位文件的日期由 `--include-archived` 补切片，09-20 之后走归档全文 |
| 字段 | 仅 `标题/来源/时间/原文链接`，**无摘要、无正文** |
| 缺口 | 09-04~10-04 华尔街见闻/东财/新浪未采集（源站不留 30 天以上历史，无法回补），该时段以中新网/官方源为主 |
| 单日上限 | 400 条（同 hash 去重后按「官方 / 全文 / 来源权重」取）；**只有标题/来源/时间/链接，无摘要/正文** |
| 体积 | 实测 **319 个切片 / 72,553 条 / 15.8 MB**（单日最大 88.4 KB） |
| 读取 | 归档页切到「归档」时才取 `history/index.json`；点某天才取当天切片，LRU 3 天、`max-age=600` |

历史切片**只有标题/来源/时间，没有摘要与正文**（正文在 `archive/` 的日期里）；`search.json` 不覆盖历史，
全文检索仍只搜最近 62 天 —— 这是刻意的，365 天全量索引在浏览器里不可行（见 §9）。

**同一天用哪份（2.4.10）**：archive 条数 **≥ 20** 时用归档全文；`< 20` 且存在历史切片时，
改用历史切片并在列表上方显示原因（如「该日归档仅 3 条，已改用历史切片 243 条（仅标题/来源/时间，
正文请点原文）」）。规则在 `assets/day-source.js`，阈值显式可见、可测试，不藏在渲染里。
补齐占位日切片：`node scripts/export-history.mjs --from <起> --to <止> --include-archived --force`。

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
| 备源 | 腾讯（CN 10 + 港 2 + 美 3 指数）→ 新浪（CN 10 个）→ 新浪外盘（伦敦金/银、布伦特）→ 本地文件 |
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
| 20 指数 + 32 ETF + `ndx` | 每 15 分钟（东财批量，纳指100 与 K 线同源 `100.NDX100`） |
| `xau` / `xag` / `brent` | 每 15 分钟（腾讯 `hf_*`） |
| `sge_au9999` | 15:30 后、存量不是今天才取（上金所日行情表） |
| `usdcny` | 09:15 后、存量不是今天才取（中国货币网） |
| `cgb_1y` | 17:00 后、存量不是今天才取（中债曲线） |

**新鲜度状态（2.4.0 / 2.4.1）**：只有拿到**可证的源时间**（东财 `f124` / 腾讯时间字段）才允许标「实时」；
源时间 ≤ **5 分钟** = 实时；市场**不在交易时段**且源时间 ≥ 最近一次收盘 = `已收盘` / `休市`
（午休显示 `午间休市`）；**本应交易却拿不到新价** = 延迟；直连全失败回落 `data/quotes.json` = 本地快照。
报价链路总预算 **2 秒**（东财 1.2s → 腾讯 0.8s），超时立即回落，不再空转十几秒。
卡片、`#quoteTime`、页脚共用同一套文案（`assets/quote-status.js`，纯逻辑、Node 测试共用）。

交易时段用 IANA 时区（`Intl`）换算，不写死 +08:00：CN/ETF/HK/JP/KR/US/DE/FR/UK 各有时段与午休，
美/欧 DST 已覆盖测试。假日表 `assets/market-calendar.json`（2.4.4 补齐）：
JPX / NYSE / 上交所 / 港交所 / Xetra / Euronext Paris / LSE，2026 全年 + 2027（CN/FR 的 2027
官方表尚未发布，留空并写入 `gaps`）。德/法在页面上仍归 `EU` 分组，但每张卡片用
`calendarMarket`（DAX→DE、CAC40→FR）单独判假日，避免「Xetra 休市、巴黎开市」被合并。
KRX 官方页面为 JS 动态渲染、未能取得可核验的完整表，`markets.KR` 保持空表并写入 `gaps`。
缺表或超出 `coverageByMarket` 时只按交易时段显示 `已收盘`，**绝不猜休市**。
维护：每年 12 月更新一次（下一年的官方日历通常已发布），更新
`coverage` / `coverageByMarket` / `halfDays` / `markets` / `sources` / `verifiedAt` / `updatedAt`；
测试锁定每个市场 `coverageByMarket.to >= 2026-12-31`、每个市场至少一条假日用例，
并禁止把周末写进假日表。

**半日市（2.4.7）**：`halfDays` 按市场列出 `date` / `closeTime`（交易所本地时间）/
`sessionNote` / `source`。半日市当天只保留 `closeTime` 之前的交易窗口，收盘后显示
`已收盘（半日市） · 12-24 12:00`；即使价格源仍返回上一交易日的旧价，也归「已收盘」，
不会误标「延迟」。已覆盖：

| 市场 | 日期 | 收市 | 依据 |
|---|---|---|---|
| HK | 2026-02-16 / 12-24 / 12-31；2027-02-05 / 12-24 / 12-31 | 12:00 | HKEX 通告 CT/075/25、CT/077/26；交易所规则「前夕无午市」 |
| FR | 2026-12-24 / 12-31 | 14:00 CET | Euronext 2026 Holiday Calendar（Half Trading Day）；时点依据 2025 年末附录 |
| UK | 2026/2027 的 12-24 / 12-31 | 12:30 London | LSE Business days（收盘流程 12:30） |
| US | 2026-11-27 / 12-24；2027-11-26 | 13:00 ET | NYSE Holidays & Trading Hours |

Xetra 的 12-24/12-31 是**全天不交易**（已列在 `markets.DE`），没有半日市；12-30 缩短交易
未查到 2026 官方公告，未纳入，写在 `gaps`。

K 线抽屉头部 `#kmMeta` 显示 `来源 · 日期 时间 · 陈旧度 · 三态`：直连源写「东财/新浪/腾讯」，
本地预生成写「本地预生成」，并标「本地快照」；切换周期时跟随该周期最后一根的时间。

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
| `data/quotes.json` | 59 个标的快照（20 指数 + 32 ETF + 7 组合） | 链路 ① |
| `data/snapshots/YYYY-MM-DD_am.json` | 上午盘时点价（59 项；新增标的前的历史文件 57/58 项） | 链路 ③ |
| `data/snapshots/YYYY-MM-DD_pm.json` | 收盘时点价（59 项；新增标前的历史文件 57/58 项） | 链路 ③ |
| `data/archive/YYYY-MM-DD.json` | 按天归档新闻，**含正文** | 链路 ① |
| `data/history/YYYY-MM-DD.json` | 近一年历史切片（**只有标题/摘要**，单日 ≤400 条） | `scripts/export-history.mjs` |
| `data/history/index.json` | 历史切片索引（含 `hasBriefing` / `briefLine` / `source`） | 同上 |
| `data/briefings/YYYY-MM-DD.json` | 当日早报（`overview` + `watch` + `items` + `source`，与归档同键） | 链路 ⑥ / `scripts/briefing/*` |
| `data/latest.json` | 最近 200 条（首屏） | 链路 ① |
| `data/search.json` | 全库检索索引（**只有标题+摘要**，约 10 MB） | 链路 ① |
| `data/index.json` | 按天归档索引（含 `hasBriefing` / `briefLine` / `source`） | 链路 ① |
| `data/kline/<key>.json` / `_1w` / `_1M` | 27 个标的 × 日/周/月 | 链路 ② |
| `data/kline/<key>_full.json` | 10 个 CN 指数的全量日 K（紧凑数组 `[t,o,c,h,l,v]`） | 链路 ② |
| `data/kline/min/<key>_<period>.json` | 8 个标的 × 5 个分钟周期（含伦敦金） | 链路 ② |
| `data/macro/daily.json` | 5 个宏观指标日频序列 | 链路 ④ |
| `data/_last-run.json` | 各链路运行状态（字段并存，读改写） | 所有链路 |
| `data/_briefing-status.json` | 早报生成状态（最近 14 天，页脚读取） | `scripts/briefing/*` |

**给 AI / 脚本的读取规则**

- 要**行情 / 宏观** → 读 `quotes.json` + `macro/daily.json`，不要自己抓接口。
- 要**某天收盘价** → 读 `snapshots/`；`quotes.json` 里的 A股是实时价，不等于收盘价。
- 要**新闻全文** → 读 `archive/` 的 `items[].content`；`search.json` 没有正文。
- 要**近一年历史** → 读 `history/<day>.json`（只有标题/摘要）；同一天若 `archive/` 也有，以 archive 为准。
- 要**当日早报** → 读 `briefings/<day>.json`；索引里只有 `hasBriefing` + 一行 `briefLine`。
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

# 注册 / 更新 4 小时同步任务（Windows 计划任务）
powershell -ExecutionPolicy Bypass -File scripts\register-pull-task.ps1

# 手动验证宏观源（--force 忽略门禁，--dry-run 不写盘）
node scripts\collect-macro-if-due.mjs --force --dry-run

# 跨天回补宏观（默认最近 7 天、不含今天；云端门禁自动跑的是最近 14 天）
node scripts\backfill-macro.mjs --days 7 --dry-run

# 手动采集一次（新闻 + 行情，通常由 Actions 跑）
node src/collect.mjs

# 补最近 5 天缺失的时点快照
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\snapshot-collect-and-push.ps1 -Backfill 5

# 收盘快照 + 宏观 + 1Y国债日K
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portfolio-collect-and-push.ps1

# 只刷新当前交易时段的最后一根日K（看结果不写盘加 --dry-run）
node scripts/update-kline-last.mjs --dry-run

# 近一年历史切片：先测算体积（gap-only，默认不重写已存在的切片）
node scripts/export-history.mjs --days 365 --dry-run
node scripts/export-history.mjs --days 365

# 把本地早报发布到站点（只复制 JSON；Markdown 版留在 .local）
Copy-Item .local\briefings\*.json data\briefings\ -Force

# 早报三段式（2.3.0）：prepare 固化输入 → LLM 写 outline/draft/final → publish 校验发布
node scripts/briefing/prepare.mjs --date 2026-11-02
node scripts/briefing/publish.mjs --date 2026-11-02
node scripts/briefing/publish.mjs --date 2026-11-02 --draft-on-fail   # 降级事实清单

# 早报兜底（只补当天；缺失时只 prepare，等待 LLM，不再自动生成规则版）
node scripts/briefing/ensure.mjs --dry-run
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\briefing\run-ensure.ps1

# 规则版只保留为人工显式工具（不参与自动调度；正常流程不要用）
node scripts/briefing/generate.mjs --date 2026-11-02

# 手动补历史（默认关闭，必须显式给起止日期；只 prepare 快照，不生成规则版）
node scripts/briefing/ensure.mjs --backfill-from 2026-10-30 --backfill-to 2026-11-01

# 离线回归测试（不联网、不写盘）：切片/早报判据/锁/补跑、文件名大小写、时区、采集白名单
node --test "tests/*.test.mjs"
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

### 6.2 Cloudflare Worker（外部 cron + 行情采样备份）

仓库里有**两个** Worker，职责不同，不要混：

| Worker | 目录 | 作用 |
|---|---|---|
| `macro-news-cron` | `worker/gh-cron/` | 外部 cron：定时 `workflow_dispatch` 触发 Actions |
| `macro-news-proxy` | `worker/worker.js` | 行情采样备份：`/quote`、`/kline`、`/health` |

**行情代理的定位是「定时采样备份」，不是读者入口**：前端（`market.js` / `app.js` / `config.js`）
与采集器都不调用 `workers.dev`；读者直连东财/腾讯，失败回落本地快照。
`workers.dev` 在本机**仅开代理时可访问**（域名被 DNS 污染），所以它只用于开发验证与备用采样。
2.4.0 起 `/quote` 的回退顺序为：东财三镜像（`push2` / `1.push2` / `push2delay`）→ 腾讯 `qt.gtimg.cn`
→ Yahoo chart；每条 `quotes[]` 带 `source: eastmoney|tencent|yahoo` 与 `updatedAt`（源时间）。
`/kline` 只覆盖 20 个指数（`INDICES`），组合标的（xau/xag/brent 等）返回 400，前端不经此路径取 K 线。

GitHub 自带 `schedule` 实测只兑现约 3%，所以触发搬到仓库外：

| cron | 驱动 |
|---|---|
| `7,22,37,52 * * * *` | `collect.yml` |
| `13,43 * * * *` | `snapshot.yml` |
| `17,47 * * * *` | `kline-minute.yml`（UTC 04:17 那轮附带 `kline-full.yml`） |

**GitHub `schedule` 只做错峰兜底**（主触发是上面的 Cloudflare cron）：

| 任务 | GitHub 兜底 | 与 CF 主触发的关系 |
|---|---|---|
| `collect.yml` | `12,42 * * * *` | 与 CF 所有轮次不同分钟（+5 分钟；CF 每 15 分钟一轮，见 workflow 注释） |
| `snapshot.yml` | `3,33 * * * *` | +20 分钟 |
| `kline-minute.yml` | `2 * * * *` | +15 分钟；04 点这一轮顺带刷新日/周/月 K |
| `kline-full.yml` | `8 5 * * *`（05:08） | +51 分钟（全量单轮最长 30 分钟，避免并发写 `_full.json`） |

日K / 周K / 月K 的每日刷新由 `kline-minute.yml` 在 UTC 04 点执行（CF 04:47 / GH 04:02），
`kline-full.yml` 只写 `<key>_full.json`。

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

| 任务 | 计划 | 脚本 | 注册 |
|---|---|---|---|
| 本机回退采集 | 每 120 分钟 | `scripts\collect-and-push.ps1` | `scripts\register-task.ps1` |
| 远端同步 | 每 4 小时 | `scripts\pull-remote.ps1` | `scripts\register-pull-task.ps1` |

`MacroNews-Collect` 是**先同步、再按陈旧度**驱动的：每轮先 `git fetch origin main`
比较 `HEAD`/`origin/main`（落后且干净 → ff-only；有已跟踪改动 → stash → ff-only → pop；
分叉走普通 merge，冲突 abort 跳过）；同步结果与 `HEAD` 短哈希写入日志。
之后再**看** `data/latest.json` 的最新条目，不到 `-NewsStaleMinutes`（默认 45）分钟就整轮跳过新闻/行情采集 —— 云端 15 分钟一轮正常时，
本机一次都不会重复采；云端排程器丢事件时，最多 45 分钟后本机接管。
日/周/月 K 同理按 `-KlineStaleHours`（默认 6）判新鲜度。
2.4.16 起不再使用 `-X ours`；任何合并冲突只 abort/保留 stash，不覆盖本地文件。
同步跳过会写入 `data/_last-run.json` 的 `localSync`，页脚显示「本机同步跳过 N 轮」：
0 次不显示、1~2 次琥珀、≥3 次红色；它不改变既有链路总灯。

`MacroNews-Collect` / `MacroNews-Pull` 均用 `wscript + run-hidden.vbs` 零窗口启动，
`-StartWhenAvailable` 允许睡眠/关机后补跑。

此外还有一条 **minimax 定时任务**（不是 Windows 计划任务）：
`macro-news 宏观早报（每日 09:00）`（cron `0 9 * * *`，Asia/Shanghai，固定对话）——
见 §2.6。它只读新闻库、只写 `.local/briefings/`，**不碰站点文件、不提交 git**。

> minimax 的 4 个旧任务（12:05 上午快照、16:30 收盘+宏观、16:35 重试、4 小时同步）
> 已于 2026-10-31 下线；2026-11-01 又停用了列表里残留的一个 12:05 任务（用户已核对）。
> 本仓库不依赖它们：快照与宏观走 `snapshot.yml`，远端同步走 `MacroNews-Pull`。
> **09:00 宏观早报仍在运行**（见 §2.6），它只读新闻库、不碰站点数据。

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
8. **数据按新鲜度分级缓存**：`latest` / `quotes` / 今天的归档天用 `no-store`
   （首屏、15s 轮询、当天仍在增长）；`search` / `index` / `_last-run` / 历史归档天用浏览器缓存
   （Pages `max-age=600`）；打开过的「天」在内存里最多留 3 个（LRU），重复打开不再下载 ~166KB（gzip）。
9. **链路健康直接派生，不加心跳文件**：页脚的状态灯只读 `_last-run.json`（源成败 / 云端还是本机）、
   `latest.json`（最新一条新闻的时间）、`quotes.json`（各卡片的源时间）。
   采集每 15 分钟就可能提交一次 `data/`，再写一个「心跳」只会让仓库继续膨胀；
   `_last-run.json` 的 `startedAt` 在安静时段会偏旧（内容没变就不重写），所以新鲜度以
   **最新条目时间**为准。
10. **历史切片按天单文件、只导缺口**：一天一次请求、LRU 按天、文件写一次就不可变；
    `archive/` 已覆盖的天（带全文）不再导摘要版 —— 否则同一天两个真相，还多 6 MB。
    单日压到 1 字母键 + 省略空字段 + 400 条上限，实测 304 天共 15.1 MB（预算 30 MB 闸）。
11. **早报与归档同键、展开才取正文**：索引只多 `hasBriefing` + 一行 ≤80 字 `briefLine`，
    不新增索引文件、不在首屏/归档页预取 365 份早报；折叠块展开时才请求当天 JSON，
    历史日 `max-age=600`、当日 `no-store`。
12. **管道归脚本，写作归 LLM（2.3.0）**：脚本只做取数、去重、候选打分、输入固化、校验、落盘、
    索引、状态、锁、判据；语义判断全部交给 LLM。状态文件单列（`_briefing-status.json`），
    判据只看产物完整性与 `endedAt`（不看 `generatedAt`）；补跑缺失时只 prepare 快照，
    不生成规则版；模拟与测试一律写临时目录（见 2.2.1 规范 §13/§14、2.3.0 规范）。

### 8.1 视觉契约（改样式前先看这里）

**血缘**：本站视觉继承自 `micro-control-finance`（学术论文风 · 衬线正文 · 纸白底 · 单主色）。
相似是血缘，不是复制。**mcf 的 `--mcf-*` 令牌与本站的通用名已经漂移，不要同步、不要合并**
（两站各自演进，共享令牌包不在本仓库职责内）。本站以 `assets/style.css` 的 `:root` 为唯一真值。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--bg` / `--surface` | `#fdfdfb` / `#ffffff` | 纸面底 / 卡片底 |
| `--ink` / `--ink-soft` / `--ink-mute` / `--ink-faint` | `#1a1a1a` / `#3a3a3a` / `#6b6b6b` / `#9a9a9a` | 正文 / 次要 / 说明 / 占位 |
| `--rule` / `--rule-strong` | `#e5e2da` / `#c9c4b7` | 细分割线 / 表头重线 |
| `--accent` / `--accent-soft` | `#2c5e8e` / `#d6e3ee` | 主色（链接、选中、强调条）/ 浅底 |
| `--warm` | `#8b5a2b` | 暖棕：note 左边框、页脚「注意」灯 |
| `--up` / `--down` | `#b3261e` / `#1a6b3c` | 涨 / 跌（**文字**用深色，纸面上才够对比度） |
| `--code-bg` | `#f5f3ec` | 代码块 / 表头底 |
| `--serif` / `--sans` | 宋体栈 / 黑体栈 | 正文衬线；按钮、表头、数字用无衬线 |

**文件归属**（颜色只能从这几处来）：

| 文件 | 负责 |
|---|---|
| `assets/style.css` | 全站布局、排版、组件、页脚状态灯；**站点唯一的 CSS** |
| `assets/kline.js` | 图表专用色：`UP=#d93025` / `DOWN=#1a9e5f`（比 CSS 令牌更亮：细线与蜡烛在纸面上才看得清）、`MA_COLOR`（5/10/20/30/60/120/250）、坐标轴灰 `#8a8a8a` |
| `assets/app.js` | 页面渲染：只给元素加类名（`.up` / `.down` / `.ft-state`），颜色全部交给 style.css |
| `assets/market.js` | 行情 / K 线取数，不涉及颜色（图表由 kline.js 画） |
| `assets/icon.svg` | 站点图标：主色描边 + 暖棕折线 + 纸白底（换主色/纸色时同步这里） |

**换色 recipe（只动这几处，别全局替换色值）**：

1. 换主色：`--accent` + `--accent-soft`（style.css），再同步 `icon.svg` 描边；
   `kline.js` 的 `MA_COLOR[10]` 若想让均线跟着变，也在这里改。
2. 换纸色：`--bg` / `--surface` / `--code-bg` / `--rule` / `--rule-strong` **一起调**，
   否则分割线会「浮」在底色上。
3. 换涨跌色：CSS 的 `--up` / `--down` 与 `kline.js` 的 `UP` / `DOWN` **两处都要改**
   （两套色是有意的，不是遗漏：文字要深、细线要亮）。

**三条硬约束**：

- 正文衬线、按钮/表头/数字无衬线；数字一律 `tabular-nums`。
- 触控目标 ≥ 40px（手机按钮 40 / 34px，底部导航 4 等分 + 安全区）。
- canvas 的颜色只认 `kline.js` 里的常量，CSS 覆盖不到它（图表不读 CSS 变量）。

---

## 9. 已知限制 / 待办

- 新闻正文覆盖率不是 100%：人民银行、欧洲央行只有标题（原文在 PDF 里）。
- `search.json` 约 10 MB（gzip ≈2.7 MB）：**点搜索框或开始输入时才预取**，首屏/归档不再跟它抢带宽；
  首次全文检索要等索引下载完（Pages 带宽实测 5~30 KB/s）。
- **历史检索是浏览式的**：`data/history/` 覆盖近一年（304 天 / 15.1 MB，只有标题/摘要），
  但 `search.json` 仍只覆盖最近约 62 天 —— 365 天全量索引约 60 MB，浏览器里不可行。
  需要跨年检索时用本机 `scripts/news-db/query.mjs`；不要把它倒进静态站。
- cron 不认法定节假日：行情沿用上一交易日，快照直接不写文件（属正常行为）。
- `data/archive/` 持续增长，一年后值得重新评估归档策略。
- 上海金 17:00 前、中债曲线傍晚才发布，当天看准确收盘价用 `etf_518880`（黄金 ETF）。
- **现货金/银的报价源（腾讯/新浪 `hf_*`）在 04:55 冻结**，官方 05:00 收盘。2026-10-30 实测：
  伦敦金 3876.69（04:55）vs Wind 3875.19 / 同花顺 3875.06 / 支付宝 3875.02，差约 1.67（0.04%）。
- **伦敦金分钟 K**：东财 `122.XAU`「黄金/美元·现货」有日线与 1m/5m/15m/30m/60m（2026-11-03 实测）；
  与新浪外盘 `XAU` 同日收盘 **15 个交易日最大差 0.054%**，是同一标的同一条线。
  口径分工：**日/周/月走新浪外盘**（2006 起 5183 根），**分钟走东财 122.XAU**；
  国际商品没有多年分钟历史（1m ≈ 1~2 个交易日、5m/30m 数百根），缺就缺，不用日线伪造。
- **布伦特是连续合约**（新浪外盘 OIL）：与新闻里的「12 月合约」存在基差，
  2026-10-30 连续 113.4 vs 12 月合约 117.64（约 4 美元），但涨跌幅一致（+2.4%）。

---

## 附录 A：数据源

| 类别 | 源 | 取什么 | 备源 |
|---|---|---|---|
| 行情 | 东财 `ulist.np` | 20 指数 + 32 ETF 最新价（1 个请求） | 腾讯 `qt.gtimg.cn` |
| K 线 | 东财 `push2his` | 日/周/月 + 分钟 | 腾讯 `ifzq.gtimg.cn`；新浪（仅 CN 10 指数） |
| 组合 | 腾讯 `hf_XAU` / `hf_XAG` / `hf_OIL` / `usNDX` | 伦敦金/银、布伦特、纳指100 | 东财 `100.NDX100` |
| 组合 | 上金所官网 | 上海金 Au99.99 | 估算回退（note=estimated） |
| 组合 | 中国货币网 `ccpr.json` | 人民币中间价 | 东财 `133.USDCNH`（离岸） |
| 组合 | 中债 `queryGjqxInfo` | 1Y 国债收益率 | 无 |
| 宏观 | 东方财富数据中心 / 央行 / 统计局 | 两融、10Y 美债、社融、CPI、PMI | 上交所+深交所 / FRED |
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
│   ├── history/       近一年历史切片（标题/摘要 + index.json）
│   ├── briefings/     当日早报 JSON（与日期同键）
│   ├── kline/         日/周/月 + _full + min/
│   └── macro/daily.json
├── .local/             本机私有（已在 .gitignore）
│   ├── news.db         新闻库（SQLite + FTS5，52 万条）
│   ├── briefings/      每日早报 YYYY-MM-DD.json / .md
│   └── runs/           2.3.0 三段式中间产物（input/outline/draft/final + prompt）
├── scripts/news-db/    新闻库：db · history-slice · import-archive · brief-candidates · query · backfill-*
├── src/
│   ├── collect.mjs    新闻 + 行情主程序（--no-kline / --kline-only）
│   ├── brief-meta.mjs 早报索引元信息（hasBriefing / briefLine）
│   ├── sources.mjs    新闻源 + 20 指数适配器 + fetchKline
│   ├── quotes.mjs     批量行情（东财 → 腾讯）
│   ├── kline.mjs      日 K / 5 分钟 K（东财 → 腾讯）
│   ├── em.mjs         镜像 / 限速 / 退避 / 熔断 / 缓存
│   ├── snapshot.mjs   时点快照（am/pm，含 §3.1 收盘时刻表）
│   ├── portfolio.mjs  7 个组合行情 + 5 个宏观指标
│   └── portfolio-collect.mjs  宏观 + 1Y国债日K（每工作日 17:00 后，云端）
├── scripts/           serve · export-history · push-data.sh · update-kline-{full,minute,last} · 各 PowerShell 任务
├── scripts/briefing/  prepare · publish · pipeline · generate · ensure · core · run-ensure.ps1（早报三段式与兜底）
├── docs/superpowers/specs/  设计文档（2.2.0 历史新闻 / 2.2.1 早报容错 / 2.3.0 三段式）
└── worker/gh-cron/    Cloudflare 外部触发器（窄职责，仅 dispatch）
```

## 附录 C：历史与被弃用

- **GitHub schedule 时代**：曾用 `*/5` 声明 5 分钟，实测 3~6 小时一次；已由 Worker 外部触发取代。
- **Cloudflare Worker 行情代理**：早期想用它绕 CORS 给读者供数，实测 `workers.dev` 被 DNS 污染、
  国内不可达；且东财接口本身带 CORS ⇒ **不再作为读者入口**。2.4.0 重新启用为**定时采样备份**
  （东财三镜像 → 腾讯 → Yahoo，输出 `source`），前端与采集器均不依赖它；`/kline` 仅覆盖 20 个指数。
- **串行 K 线 fallback**：已被三源并发赛马取代。
- **16:30 组合行情链路**：已被并入 15 分钟链路；宏观改到云端 **17:00 后**（2026-10-31）。
- **minimax 定时任务**：曾承担 12:05 / 16:30 快照、16:30 宏观、4 小时同步；
  配额不可控且实测并不总准点（10-30 的宏观 19:28 才跑）。2026-10-31 起全部下线，
  快照/宏观改由 `snapshot.yml` 兜底，远端同步改 Windows 计划任务。
