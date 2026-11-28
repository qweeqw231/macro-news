# 周期性报告产物契约（周报 / 月报 / 年报）

> 版本：`macro-news/periodic-report@1` · 2026-11-23
> 适用对象：外部写作方（minimaxcode）产出周报/月报/年报；本站归档页渲染。
> 本文件是**唯一口径**。字段名、类型、路径、时间格式均按此执行，不要自行增删或改名。

---

## 0. 与日报同构

周期报告**不是新的文体**，只是把日报（`data/briefings/<YYYY-MM-DD>.json`）的时间粒度拉长：
同一套顶层字段（`date / source / generator / window / overview / items / watch / backfill`），
同一套条目结构（`rank / title / summary / why / source / publishedAt / url / refs`）。
归档页也复用日报的条目渲染函数，因此**不要**为周期报告另造 `sections`、`points`、`time` 等字段。

周期报告只多两个字段：`type`（区分周/月/年）与 `coverage`（本期采集覆盖自检）。

---

## 1. 周期 id 与文件路径

| 类型 | `type` | `date` / `id` 格式 | 示例 | 覆盖区间（含首尾） |
|---|---|---|---|---|
| 周报 | `week` | `YYYY-Www`（ISO-8601 周，两位周号） | `2026-W47` | 该 ISO 周的周一 ~ 周日 |
| 月报 | `month` | `YYYY-MM` | `2026-11` | 当月 1 日 ~ 月末 |
| 年报 | `year` | `YYYY` | `2026` | 1 月 1 日 ~ 12 月 31 日 |

规则：

- **周号按 ISO-8601**：周一为一周首日，含 1 月 4 日的那一周是第 1 周。
  跨年周沿用 ISO 周所属年，例如 `2026-12-31` 属于 `2026-W53`，`2027-01-04` 才是 `2027-W01`。
- 文件名 = `data/periodic/<date>.json`，例如 `data/periodic/2026-W47.json`。
- 同一 `type + date` 只能有一份文件；已存在的期**不许重写**（见第 6 节）。
- 文件名只用 ASCII，不加前缀/后缀（不要 `weekly-`、不要 `.zh`）。

`window.from / window.to` 按**新闻日键**选取：`2026-W47` 聚合
`data/archive/2026-11-16.json` 到 `data/archive/2026-11-22.json` 这 7 个新闻日，
物理时间是 11-16 08:00 到 11-23 08:00（北京时间）。新闻日定义见
[day-boundary.md](./day-boundary.md)。

---

## 2. 索引文件 `data/periodic/index.json`

索引只放**列表展示所需的最小元数据**，正文在各自报告文件里。

```json
{
  "schema": "macro-news/periodic-index@1",
  "generatedAt": "2026-11-23T10:00:00+08:00",
  "count": 1,
  "reports": [
    {
      "type": "week",
      "id": "2026-W47",
      "title": "2026 年第 47 周宏观周报：政策托底与紧缩预期拉锯",
      "summary": "国内稳市组合拳与海外鹰派表态并行，10Y 美债冲高回落，原油供给风险升温。",
      "window": {
        "from": "2026-11-16",
        "to": "2026-11-22",
        "fromAt": "2026-11-16T08:00:00+08:00",
        "toAt": "2026-11-23T08:00:00+08:00",
        "days": 7
      },
      "generatedAt": "2026-11-23T10:00:00+08:00",
      "backfill": false,
      "backfillAt": null,
      "itemCount": 8,
      "file": "periodic/2026-W47.json"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | string | 是 | 固定 `macro-news/periodic-index@1` |
| `generatedAt` | string | 是 | 索引生成时间，ISO-8601 带 `+08:00` |
| `count` | number | 是 | `reports` 长度，必须一致 |
| `reports` | array | 是 | 可为空数组；按 `window.to` 降序，同日按 `id` 降序 |
| `reports[].type` | `"week"｜"month"｜"year"` | 是 | 与正文一致 |
| `reports[].id` | string | 是 | 与正文 `date` 一致 |
| `reports[].title` | string | 是 | 与正文 `title` 一致，≤ 40 字 |
| `reports[].summary` | string | 是 | 一句话摘要，40~90 字，用于卡片 |
| `reports[].window` | object | 是 | 与正文 `window` 逐字段一致 |
| `reports[].generatedAt` | string | 是 | 与正文 `generatedAt` 一致 |
| `reports[].backfill` | boolean | 是 | 正文有 `backfill` 对象 ⇒ `true`，否则 `false` |
| `reports[].backfillAt` | string｜null | 是 | 等于正文 `backfill.at`；`backfill=false` 时必须为 `null` |
| `reports[].itemCount` | number | 是 | 正文 `items.length`，必须一致 |
| `reports[].file` | string | 是 | 固定 `periodic/<id>.json` |

`window` 结构（索引与正文共用）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `from` | `YYYY-MM-DD` | 是 | 覆盖首日（含），新闻日键 |
| `to` | `YYYY-MM-DD` | 是 | 覆盖末日（含），新闻日键 |
| `fromAt` | string | 是 | 覆盖起点，`from` 当日 `T08:00:00+08:00` |
| `toAt` | string | 是 | 覆盖终点（不含），`to` 次日 `T08:00:00+08:00` |
| `days` | number | 是 | 覆盖天数 = `to - from + 1`；周报固定 7 |
| `fromTs` / `toTs` | number | 否 | 与日报一致，Unix 秒；可省略 |

---

## 3. 报告正文 `data/periodic/<date>.json`

```json
{
  "date": "2026-W47",
  "type": "week",
  "generatedAt": "2026-11-23T09:58:00+08:00",
  "endedAt": "2026-11-23T10:00:00+08:00",
  "source": "ai",
  "generator": "minimaxcode",
  "title": "2026 年第 47 周宏观周报：政策托底与紧缩预期拉锯",
  "window": {
    "from": "2026-11-16",
    "to": "2026-11-22",
    "fromAt": "2026-11-16T08:00:00+08:00",
    "toAt": "2026-11-23T08:00:00+08:00",
    "days": 7
  },
  "overview": "本周主线是政策托底与紧缩预期拉锯……（150~300 字，概括全周，不逐日复述）",
  "items": [
    {
      "rank": 1,
      "title": "融资保证金比例下限降至 80%，稳市组合拳落地",
      "summary": "沪深北交易所 11-22 宣布将融资保证金比例下限从 100% 降至 80%，自 2026-11-30 起实施。业内测算有望释放约 4000 亿元增量资金，ETF 同步放量净流入。",
      "why": "逆周期调节直接释放增量资金",
      "source": "华尔街见闻",
      "publishedAt": "2026-11-22T18:44:00+08:00",
      "url": "https://wallstreetcn.com/livenews/3203741",
      "refs": [
        "http://stock.eastmoney.com/news/11215,202611223936977710.html"
      ]
    }
  ],
  "watch": [
    "下周关注 11-30 融资保证金新规实施后的两融余额变化"
  ],
  "coverage": {
    "archiveDays": 7,
    "newsItems": 12034,
    "missingDays": []
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `date` | string | 是 | 周期键，与文件名、索引 `id` 一致 |
| `type` | `"week"｜"month"｜"year"` | 是 | 与 `date` 格式匹配 |
| `generatedAt` | string | 是 | 首次生成时间，ISO-8601 带 `+08:00` |
| `endedAt` | string | 是 | 写作完成时间，ISO-8601 带 `+08:00` |
| `source` | string | 是 | 固定 `"ai"` |
| `generator` | string | 是 | 固定 `"minimaxcode"` |
| `title` | string | 是 | 报告标题，与索引一致，≤ 40 字 |
| `window` | object | 是 | 见第 2 节 |
| `overview` | string | 是 | 全周期概述，150~300 字 |
| `items` | array | 是 | 本期重点，6~10 条，按重要性排序 |
| `watch` | string[] | 否 | 下期观察项，0~5 条 |
| `backfill` | object | 否 | 补写时必填，结构同日报：`{kind, at, note}` |
| `coverage` | object | 是 | 采集覆盖自检 |

`backfill`（仅补写时出现）：

```json
"backfill": {
  "kind": "period-backfill",
  "at": "2026-11-23T10:00:00+08:00",
  "note": "周期结束后补写"
}
```

- `kind`：固定 `period-backfill`。
- `at`：补写时间，ISO-8601 带 `+08:00`，必须与索引 `backfillAt` 一致。
- `note`：一句说明。
- 非补写报告**不要**带这个字段（或写 `null`）。

`coverage`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `archiveDays` | number | 是 | 实际读到的归档天数，≤ `window.days` |
| `newsItems` | number | 是 | 参与写作的归档条目总数 |
| `missingDays` | string[] | 是 | 缺采的新闻日键，如实填写；无缺失写 `[]` |

### 3.1 `items[]` 条目结构（与日报完全一致）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `rank` | number | 是 | 从 1 连续递增，与数组顺序一致 |
| `title` | string | 是 | 事件标题，≤ 40 字；有原文链接时前端渲染为外链 |
| `summary` | string | 是 | 概述，60~150 字，说清发生了什么与量级 |
| `why` | string | 是 | 要点/为什么重要，一句话，≤ 40 字 |
| `source` | string | 是 | 来源名，逐字取自输入条目的 `source` |
| `publishedAt` | string | 是 | 事件时间，ISO-8601 带 `+08:00` |
| `url` | string | 是 | 主链接，`http://` 或 `https://`，逐字取自输入条目 |
| `refs` | string[] | 否 | 补充引用 URL 数组，1~4 条，逐字取自输入条目 |

写作口径（与日报一致）：

- 只写本期归档里出现的事实；数字、机构名、日期必须可在归档条目中复核。
- 不把日报逐日摘要拼接成周报；按主题归并，一条 `items` 可以跨多天。
- 标题不堆形容词；`summary` 先事实后量级；`why` 只说影响，不复述事实。
- `url` / `refs` 必须是输入快照里出现过的原文链接，**逐字复制**，不得改写、拼接或臆造。
- 时间一律北京时间并显式带 `+08:00`，不要用 `Z` 或裸日期。

---

## 4. 归档页的展示与降级规则

前端读取顺序：`data/periodic/index.json` → 展开某条时再取 `data/periodic/<date>.json`。

| 情况 | 页面行为 |
|---|---|
| `data/periodic/index.json` 404 / 网络失败 | **不显示周期报告区块**，按日归档照常渲染，不报错 |
| 索引存在但 `reports` 为空 | 同上，不显示空区块 |
| 某一类型没有报告（如只有周报） | 只显示有数据的类型分组，不出现空分组 |
| 三类齐全 | 按 周报 → 月报 → 年报 依次分组显示 |
| 某条索引字段缺失/类型不对 | 跳过该条，其余正常显示 |
| 报告正文 404 / 解析失败 | 该卡片展开位置显示「报告正文缺失」与「重试」，不影响其他卡片 |
| 正文 `items` 为空 | 仍显示 `overview`，并提示「本期无重点条目」 |

展示要求（与按日归档区分）：

- 周期报告区块在归档页内、按日归档列表之上，但不另开页面；3.4.0 起**收成一行汇总的折叠入口**
  （默认收起）：一行「周期报告 N 期 · 周报 x · 月报 y · 年报 z」，展开后才是三类分组。
  收起是默认状态，展开状态随刷新恢复。理由见 `2026-11-28/archive-ux-audit`：
  187 期全量铺开会把日期层推到 12 屏（桌面）/ 25 屏（手机）之外。
- 三类分组各有稳定入口 id：`periodic-week` / `periodic-month` / `periodic-year`；
  分组的跳转入口是按钮而不是 `#periodic-*` 锚点链接 —— 锚点会把归档层级从 URL 里冲掉。
- 分组内部按年份分区（默认只展开当前归档层所在年，没有则展开最新年），避免 187 期连排。
- 卡片打 `周报 / 月报 / 年报` 类型标签，显示 `window.from ~ window.to · 覆盖 N 天`，
  并直接渲染索引里的 `summary`（40~90 字）——长列表靠摘要扫描，不靠逐张展开。
- 补写状态在**分组标题**统一说明（该组全部为补写时标「均为补写」），不再逐行打「补写」标签；
  展开后仍显示该期补写时间。
- 归档各层（周 / 月 / 年）只在层头给一行「本期周报 / 月报」入口，**默认收起**，
  点开才加载正文；同一期报告不在页面上出现两份展开内容。
- 周期报告**不进入**按日归档的日期网格，也不参与「新闻日」条数统计。

---

## 5. 落地与验收清单（写作方自检）

- [ ] 文件名 = `<date>.json`，`date` 符合第 1 节规则，`type` 与 `date` 格式匹配
- [ ] `window.from/to` 与 `date` 对应；`days = to - from + 1`
- [ ] `fromAt = from T08:00:00+08:00`，`toAt = to 次日 T08:00:00+08:00`
- [ ] `window` 在索引与正文中逐字段一致
- [ ] `backfill` 仅在补写时出现，`at` 与索引 `backfillAt` 一致；否则索引 `backfill=false`、`backfillAt=null`
- [ ] `itemCount = items.length`，`rank` 从 1 连续
- [ ] 所有 `url` / `refs` 是 http(s) 绝对地址，且逐字来自输入快照
- [ ] 所有时间带 `+08:00`
- [ ] `coverage.missingDays` 如实反映缺采日
- [ ] UTF-8 无 BOM、无尾逗号；`JSON.parse` 可解析
- [ ] 新增报告后同步更新 `data/periodic/index.json`（`count`、排序、字段一致）

---

## 6. 禁止事项

- 不得重写或覆盖已存在的 `data/periodic/<date>.json`。
- 不得编造条目、数字、机构名或链接；链接必须能在本期归档中找到出处。
- 不得改动本任务以外的文件（`assets/`、`index.html`、`data/briefings/`、`data/archive/`、`data/index.json` 等）。
- 不得把周期报告写进按日归档目录或主索引 `data/index.json`。
