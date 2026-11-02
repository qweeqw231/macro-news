# 2.2.0 · 近一年历史新闻接入静态站（设计）

日期：2026-11-02　状态：实施中　范围：只读 `.local/news.db` → 静态每日切片 → 归档页浏览

## 1. 背景与目标

站点目前的「可浏览的历史」只有 `data/archive/` 的 62 天（2026-08-17 起，随采集自动增长）。
本地新闻库已经回补到 2021-11（525,925 条），但静态站查不了 SQLite。

本节目的目标：把**最近 365 天**的历史新闻以**静态切片**的形式接回站点，做到

- 归档页能看到近一年任意一天的要闻（标题 + 摘要 + 原文链接）；
- 打开历史天不发额外的大请求：一天一个文件，按需加载；
- 不改变现有首屏、搜索、刷新状态、HTTP 缓存策略；
- 仓库体积可控（预算见 §9）。

## 2. 非目标

- **不做运行时查库**：静态站没有后端，SQLite 不可能在浏览器里跑。
- **不扩 `search.json`**：现在 61 天 / 1.9 万条已经 10.7 MB；365 天约 10 万条 / 60 MB，
  Fuse 在浏览器里不可行。历史切片**只供浏览，不进全文检索**。
- **不导出 5 年全量**：2021-11 ~ 2025-11 的 4 年多数据保持只在本机库里。
- 不做事件聚类、时间线、AI 摘要（另立需求）。

## 3. 数据源与实测分布

`.local/news.db`（SQLite + FTS5，`scripts/news-db/db.mjs` 维护）：

| 表 | 用途 |
|---|---|
| `items` | 主表：id / source / channel / title / summary / content / url / published_at / published_ts / kind / content_status / hash |
| `items_fts` | 全文检索（历史导出不用） |
| `backfill_state` | 回补游标（历史导出不用） |

近 365 天（2025-11-02 ~ 2026-11-01）实测：

| 指标 | 值 |
|---|---|
| 条数 | 103,174 |
| 有数据的天数 | 365（每天都 ≥ 63 条） |
| 单日条数 | 平均 283，最大 1,161（2026-10-30 量级），最小 63 |
| 超过单日上限（400）的天数 | 26 |
| 来源结构 | 中新网约 8.5 万（多为 `date_precision=day`、`title_only`）、华尔街见闻约 8.8 千、东方财富约 4.5 千、新浪财经约 3.9 千、官方源约 450 |
| 摘要长度 | p50=130、p90=141、p99=201、max=963（中文字符） |
| 正文 | 近 60 天 `content_status=full`；更早的中新网回填行无正文 |

`published_ts` 是入库时算好的 epoch 秒（UTC 解析正确），**日期一律由 `published_ts`
换算成北京时间**，不用 `published_at` 字符串切片（`Z` 结尾的行按 UTC 切会差一天）。
极少数 `published_ts=0` 的行（无有效时间）直接丢弃。

## 4. 切片粒度：推荐与备选

### 推荐：按日单文件 `data/history/YYYY-MM-DD.json`

- 与现有「打开某天 = 一个文件」的读取模型完全一致，`getDay()` 只需多一条路径分支；
- LRU 缓存天然按天生效（最多 3 天），和 `data/archive` 共用同一套逻辑；
- 一天一次请求，移动端不会出现「8 个源 = 8 个并发请求」；
- 历史文件写一次就不可变，天然适合 `max-age=600` 的浏览器缓存。

### 备选：按日 + 按源拆分 `YYYY-MM-DD/<source>.json`

- 优点：增量更新时只重写变化的源；单文件更小（~10–20 KB）。
- 缺点：一天要 5–8 个请求；前端要合并、排序、去重；LRU 的键变成「天 + 源」；
  历史切片本身**不可变**，增量更新的好处在这里用不上。
- 结论：不采用，除非将来历史天需要每小时级更新（目前不需要）。

## 5. 目录与命名

```
data/briefings/
├── 2026-11-01.json          # 当日早报（沿用现有结构，与日期同键绑定）
└── 2026-11-02.json

data/history/
├── index.json              # 索引（约 30 KB，含 hasBriefing，归档页打开时按需加载）
├── 2025-11-02.json         # 单日切片（不可变）
├── ...
└── 2026-09-19.json
```

- 只导出**未被 `data/archive/` 覆盖**的日期（gap-only）：archive 已有 62 天且带全文，
  再导一份摘要版是纯重复（全年会多 6.3 MB、且同一天有两个真相）。
- 站点上的「近一年」= `history`（304 天）+ `archive`（62 天），合计 366 天。
- 文件名即北京日期，Windows / Pages 大小写不敏感规则下无冲突（纯数字 + 连字符）。

## 6. 单日文件 schema（v2）

```json
{
  "v": 2,
  "d": "2025-11-09",
  "n": 132,
  "gen": "2026-11-02T09:00:00+08:00",
  "items": [
    {
      "i": "5f1fhj",
      "t": "标题原文",
      "s": "摘要，最多 160 字（没有就省略）",
      "u": "https://…（原文链接）",
      "c": "全球",
      "o": "华尔街见闻",
      "k": "official",
      "p": 1793580700
    }
  ]
}
```

| 字段 | 含义 | 精简规则 |
|---|---|---|
| `v` | schema 版本 | 固定 2 |
| `d` | 北京日期 | `YYYY-MM-DD` |
| `n` | 条数 | — |
| `items[].i` | 条目 id | 与站点/库一致，用于阅读器定位 |
| `items[].t` | 标题 | 必填，空白折叠 |
| `items[].s` | 摘要 | 去换行 + 最多 `--summary-chars`（默认 160）；空则**省略键** |
| `items[].u` | 原文链接 | 空则省略 |
| `items[].c` | 频道 | 空则省略 |
| `items[].o` | 来源 | 空则省略 |
| `items[].k` | 类型 | 仅 `official` 时写入，普通新闻省略（省 ~12 字节/条） |
| `items[].p` | 发布时间（epoch 秒） | 前端按 +08:00 还原成 ISO |

**为什么用 1 字母键**：单文件是主要成本（365 天 × 几百条），键名占 JSON 体积的 20–30%；
1 字母键 + 省略空字段把实测单日均值从 64 KB 压到 60 KB 以内，且仍可肉眼调试。
**为什么不存 `content`**：正文让单日文件翻 5–10 倍，而历史浏览以标题/摘要为主；
需要全文的日期都在 `archive/` 里，阅读器可以直接跳原文。

### 选取规则（`limit-per-day` 默认 400）

1. 丢弃 `published_ts <= 0` 的行；
2. 同日按 `hash`（标题规范化后的 hash）去重，保留优先级最高的一条：
   `来源权重 ×10 + 全文/摘要 + 官方源加成`；
3. 按优先级降序取前 `limit-per-day` 条；
4. 再按 `published_ts` 降序输出（与要闻流、归档一致的「新的在前」）。

实测 365 天里有 **26 天**超过 400 条（最大 1,161），封顶 + 去重后共 **69,731 条**
（gap-only 304 个文件），既能保住官方与全文条目，又不会让单日文件失控。

## 7. 索引 `data/history/index.json`

```json
{
  "v": 2,
  "generatedAt": "2026-11-02T09:00:00+08:00",
  "from": "2025-11-03",
  "to": "2026-11-01",
  "total": 69731,
  "days": [{ "d": "2026-11-01", "n": 400, "b": 199800 }, …]
}
```

- `days` 按日期**降序**（与归档页网格一致），`b` 是该文件的字节数，用于体积审计；
- 索引由导出器在写完后**扫描目录重建**，因此分批导出（样本周 → 全年）不会互相覆盖；
- **加载时机**：只在用户切到「归档」视图时请求（`renderArchive()`），首屏、行情、要闻流都不碰；
- 缓存：`cache:'default'`（Pages `max-age=600`），一天最多变一次（导出器手动运行）；
- 大小：304 天约 29.5 KB（含每日 `hasBriefing` 布尔），可忽略；若连 archive 的天也导出则 365 天约 35.7 KB。

### 7.1 早报与归档同键绑定（`data/briefings/`）

归档以日期为主键，早报是这一天的「结论层」，用同一个键挂上去，不另建页面/不另建索引。

**文件与结构**

- 路径：`data/briefings/YYYY-MM-DD.json`，**沿用现有早报 JSON**：
  `{ date, generatedAt, window, overview, items[], watch[] }`。
- 搬迁：`.local/briefings/*.json` → `data/briefings/`，只复制不改内容
  （Markdown 版仍留本地，不上站）。
- 站在哪里：`overview` 是折叠时的一行主线摘要；`watch` 是展开后的观察项；
  `items` 保留在文件里但本站暂不渲染（不混入要闻流）。

**索引字段（两个索引各加两个字段，不新增文件、不新增请求）**

| 字段 | 类型 | 说明 |
|---|---|---|
| `hasBriefing` | boolean | 默认 false；`data/briefings/<day>.json` 存在即为 true |
| `briefLine` | string，≤80 字 | `overview` 折叠成一行；只在 hasBriefing=true 时写 |

`data/index.json`（archive 天，`src/collect.mjs` 生成）与
`data/history/index.json`（历史天，导出器生成）采用**完全相同**的字段口径。
为什么不把整份早报塞进索引：早报逐日累积到 365 份，索引会从 30 KB 涨到几百 KB；
为什么不额外建 `briefings/index.json`：为了一张卡片的折叠块多一次索引请求不值得。
`briefLine` 是唯一为「默认一行摘要」付出的代价（每天 ≤80 字）。

**渲染与缓存**

- 归档页的「当日卡片」：有早报时多一个原生 `<details>` 折叠块。
  - 折叠：一行 `briefLine`（CSS 单行截断，`title` 里放全文）；
  - 展开：先显示 `overview` 全文，再列 `watch`；
  - 无早报：**静默不渲染**，没有占位、没有空态提示。
- 早报正文只在**展开时**请求 `data/briefings/<day>.json`：
  - 历史日 → `cache:'default'`（Pages `max-age=600`，文件不变）；
  - 当日 → `cache:'no-store'`（当天可能被重新生成）。
- 展开状态并入现有 `sessionStorage`（`macroNewsUI.v1` 的 `briefOpen: ["YYYY-MM-DD"]`），
  刷新后恢复；不新增 storage key。
- 不新增独立页面、不做弹窗/遮罩、不把早报条目混进要闻流列表。

**发布流程**：早报任务写 `.local/briefings/`；上站时执行一次
`Copy-Item .local\briefings\*.json data\briefings\ -Force`，
下一次 `collect.mjs` 会自动把 `hasBriefing/briefLine` 写进 `data/index.json`。
历史天由导出器在重建 `history/index.json` 时读取同一目录（无需重跑切片）。

## 8. 前端读取路径与缓存

```
归档页
├── loadIndex()            data/index.json          (default, 现有)
├── loadHistoryIndex()     data/history/index.json  (default, 新增, 失败→空)
└── 点击某天
    ├── kind='live'  → getDay(day) → data/archive/<day>.json   （今天 no-store，历史 default）
    └── kind='hist'  → getDay(day,'hist') → data/history/<day>.json（永远 default，文件不可变）
```

- `dayCache` 键改为 `kind:day`，LRU 仍为 3 天、今天仍 5 分钟失效；
- 历史条目在加载时归一化成与 archive 相同的字段形状（`id/title/summary/url/channel/
  source/kind/content/time`），`content` 为空、打 `_hist` 标记；
- 阅读器对 `_hist` 条目**不再回读 archive 补全文**（省一次请求），直接显示摘要；
- `latest.json` / `quotes.json` / 今天的归档天继续 `no-store`；历史切片 `default`。规则不变。

## 9. 体积预算与实测

| 口径 | 天数 | 条数 | 原始体积 | gzip | 单日最大 |
|---|---|---|---|---|---|
| 若连 archive 已覆盖的 61 天也导出 | 365 | 88,216 | 21.3 MB | 7.3 MB | 202.5 KB（2026-10-11） |
| **实际 gap-only（采用）** | **304** | **69,731** | **15.1 MB** | **5.1 MB** | **88.4 KB（2026-03-05）** |
| 样本周 2025-11-09~15 | 7 | 1,546 | 345.7 KB | 117.1 KB | 68.8 KB |

预算：单日 ≤ 300 KB、总量 ≤ 30 MB。实测均远低于上限；超过时导出器以退出码 3 停下，
不会静默写爆仓库。按 git blob 压缩估计，仓库实际增长约 +8 ~ +12 MB。

## 10. 导出器 `scripts/export-history.mjs`

```
node scripts/export-history.mjs --from 2025-11-09 --to 2025-11-15   # 样本周
node scripts/export-history.mjs --days 365 --dry-run                 # 全年测算，不写盘
node scripts/export-history.mjs --days 365                           # 铺满 gap（默认）
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--days` | 365 | 到**昨天**为止的天数窗口 |
| `--from` / `--to` | — | 指定区间（优先于 `--days`） |
| `--db` | `.local/news.db` | 只读打开 |
| `--out` | `data/history` | 输出目录 |
| `--limit-per-day` | 400 | 单日条数上限 |
| `--summary-chars` | 160 | 摘要截断 |
| `--force` | 关 | 重写已存在的切片（默认跳过，保持不可变） |
| `--include-archived` | 关 | 连 archive 已覆盖的天也导出（仅调试） |
| `--dry-run` | 关 | 只测算体积，不写盘 |
| `--allow-over-budget` | 关 | 超预算仍写（默认退出码 3） |

输出：逐天文件 + 重建 `index.json`；索引**仅在内容变化时写盘**；语料为空时不写。
退出码：0 成功、1 参数/DB 错误、3 超预算。

## 11. 归档页入口形态：推荐与备选

### 推荐：顶部「历史新闻」面板 + 日期跳转 + 合并日网格

- 面板显示覆盖范围、总条数、数据形态（「仅标题/摘要」）；
- `<input type="date">` + 「打开」按钮：手机调用原生日期选择器，桌面可直接输入；
- 下方日网格把 `live`（archive）与 `hist`（切片）合并，按日期降序，历史格带「历史」角标；
- 日期跳转与网格点击走同一个 `openDay(day, kind)`。

### 备选：按月份折叠 / 月份下拉

- 365 个格子确实长，月份折叠能把首屏缩短到 12 行；
- 但多一层交互（先选月再选日），且移动端折叠动画与现有网格布局冲突；
- 结论：先用「日期跳转 + 完整网格」，等真的觉得长再按月折叠（不改数据结构）。

## 12. 测试

新增 `tests/history-slice.test.mjs`（9 项，纯函数、不联网、不写盘）：

1. `beijingDay(ts)` 的 UTC→北京跨日；
2. `dayWindow` 的 365 天窗口（含首尾，到昨天为止）；
3. 去重优先级：官方/全文 > 摘要 > 标题，且同日同 hash 只留一条；
4. 封顶：超过 `limit-per-day` 时按优先级截断，输出仍按时间降序；
5. 字段精简：空摘要/空链接省略键、普通新闻不写 `k`、摘要按 `--summary-chars` 截断；
6. 空天与 `buildDayDoc` 的 `n` 一致性；
7. 索引：日期降序、`total` 求和、空数据集不产生越界 `from/to`；
8. 索引早报字段透传（`hasBriefing` 默认 false、`briefLine` 只在有早报时出现）；
9. `briefLineOf` 的空白折叠与 ≤80 字截断。

加上原有的 11 项（路径大小写 / publishedAt 时区 / 快照已收拢），测试总数 **20 项**。

## 13. 风险与回退

| 风险 | 处理 |
|---|---|
| 历史切片把仓库撑大 | gap-only + 单日 400 上限 + 预算闸（300 KB / 30 MB） |
| 用户以为历史能全文检索 | 归档面板明确写「近一年只供浏览，检索覆盖最近 62 天」 |
| `history/index.json` 缺失（未导出） | 前端按空处理，归档页退回只有 live 天，不报错 |
| 日期错位（UTC 行） | 一律用 `published_ts` 换算北京日期 |
| 重复导出导致文件漂移 | 默认跳过已存在文件；只有 `--force` 才重写 |

回退：删除 `data/history/` 与前端 `loadHistoryIndex()` 调用即可，不影响现有归档/搜索/刷新逻辑。
