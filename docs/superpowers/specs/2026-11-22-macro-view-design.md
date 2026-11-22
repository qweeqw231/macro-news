# 宏观视图（2.36.0）设计

> 2026-11-22。把已采集的 5 个宏观指标补拉历史、做成可点开的折线/柱状图，新增独立「宏观」视图。
> 交互与 K 线一致：**列表（最新值）→ 点开全屏图（历史序列）**；数据同样是「一个指标一个文件 + 一个索引文件」。

## 1. 数据分层（与 K 线同构）

| 用途 | 文件 | 对应 K 线 |
|---|---|---|
| 列表卡片 | `data/macro/index.json` | `data/quotes.json` |
| 单指标历史 | `data/macro/<key>.json` | `data/kline/<key>.json` |
| 原有机器可读日记录（不改） | `data/macro/daily.json` | — |

`index.json`：

```json
{
  "generatedAt": "2026-11-22T20:00:00+08:00",
  "items": [
    {
      "key": "margin", "name": "两融余额", "unit": "亿元", "freq": "D",
      "source": "东方财富（三市两融）",
      "latest": { "t": "2026-11-19", "v": 22222.85 },
      "prev":   { "t": "2026-11-18", "v": 22378.3 },
      "first": "2010-03-31", "last": "2026-11-19", "count": 4041,
      "series": "margin.json"
    }
  ]
}
```

`<key>.json`：

```json
{
  "key": "margin", "name": "两融余额", "unit": "亿元", "freq": "D",
  "source": "东方财富（三市两融）", "generatedAt": "…",
  "bars": [{ "t": "2026-11-19", "v": 22222.85 }]
}
```

- `freq`：`D` = 日频（两融、10Y 美债），`M` = 月频（社融、CPI、PMI）。
- `t`：日频 `YYYY-MM-DD`；月频 `YYYY-MM`。
- `v`：展示单位下的数值（两融/社融=亿元；美债/CPI=%；PMI=指数点）。
- 月频指标的 `t` 是**所属期**，不是采集日。
- 存量 `daily.json` 保持原 schema，供 AI/月度分析读取，不动。

## 2. 历史回补

| 指标 | 源 | 可回补范围 | 说明 |
|---|---|---|---|
| `margin` | 东财 `RPT_MARGIN_DATASTATISTICS` | 2010-03 起 4041 条 | `MARGIN_BALANCE` 元 ÷ 1e8 = 亿元 |
| `us10y` | 东财 `RPTA_WEB_TREASURYYIELD`（`EMG00001310`） | 1989 起 9393 条 | 与现有日更同源同字段 |
| `cpi` | 东财 `RPT_ECONOMY_CPI` | 约 2008 起 226 个月 | `NATIONAL_SAME`（同比） |
| `pmi` | 东财 `RPT_ECONOMY_PMI` | 约 2008 起 226 个月 | `MAKE_INDEX` |
| `social_financing` | 2025-12 及以前：商务部数据中心 `shrzgmQuery`（`tiosfs`，2015-01 起）；2026 起：人民银行当年增量表 | 2015-01 起 | 2026 重叠月以央行表为准（含修订） |

- 回补脚本 `scripts/backfill-macro-series.mjs`：分页拉取（pageSize 500，逐页直到 `pages`），
  速率 300ms/请求，失败重试 2 次；写盘沿用「内容无变化不写」。
- 全量回补只在人工执行；日常只 upsert 最新点。
- 两融/美债的「最新点」允许**回填当天**（T+1 发布），月频指标按所属期覆盖（统计局会修订）。

## 3. 采集管线

新增纯函数模块 `src/macro-series.mjs`：

- `periodKey(item)`：`margin/us10y` 取 `note` 的日期（缺省用采集日）；月度项把
  `2026年10月份` / `2026-10` 统一成 `2026-10`。
- `upsertSeries(bars, points)`：按 `t` 合并、升序、同键以新值覆盖（修订）。
- `buildMacroIndex(map)`：从 5 份序列生成 `index.json` 的 `items`（含 latest/prev/first/last/count）。
- `macroSeriesMeta`：5 个 key 的名称/单位/频率/源/文件名。

调用点：

1. `src/portfolio-collect.mjs`：写完 `daily.json` 后，把本次 5 条 upsert 进序列并重建 index。
2. `scripts/backfill-macro.mjs`：补最新记录（两融 T+1、美债收盘后）后，同样 upsert 并重建 index。
3. 两者都只在有变化时写盘；`--dry-run` 不写。

失败语义：单个指标失败不影响其它指标；序列文件缺失时 `index.json` 少一项，前端显示「暂无数据」。

## 4. 前端交互（已确认）

- 顶部/底部导航在「行情」后新增「宏观」，hash `#view-macro`；`VIEWS`、`viewFromHash()`、
  刷新恢复三处同步。
- 宏观视图：
  - 标题「宏观指标」+ 副标题（日频/月频、每交易日 16:30 更新）+ 数据时间；
  - 5 张卡片（桌面 2 列、手机 1 列）：名称 + `日`/`月` 徽标、最新值+单位、
    环比（日频对比上一交易日、月频对比上月，红涨绿跌）、所属期、来源 + 「图表 ›」；
  - 整卡可点（Enter/Space 同效）；文件缺失时灰显「暂无数据」。
- 全屏图 `#macroModal`（复用 K 线抽屉外观，独立状态）：
  - 头部：指标名 + 最新值/单位 + 所属期；× 关闭；
  - 区间 chips：`1年 / 3年 / 5年 / 全部`，**默认 5 年**，历史不足自动选「全部」；
  - 两融/美债/CPI/PMI 用折线，**社融用柱状**（月度流量，零基线）；
  - 悬停/触摸：竖直十字线 + 吸最近点 + 浮窗（日期/所属期、数值+单位、环比）；
    不做缩放/平移；
  - 图下注记：来源 + 口径（两融 T+1、月度项所属期、社融为当月增量）。
- 状态：进入视图并行读 `index.json`；打开图才读该指标序列，内存缓存 10 分钟；
  `uiState.macro = { key, range }` 刷新恢复（与 K 线一致，不写 URL hash）。
- 加载失败：卡片「暂无数据」；图内「暂无数据」+「宏观数据由每日 16:30 采集生成」。

## 5. 测试与验收

- 纯函数：`periodKey` 月份归一、`upsertSeries` 去重/覆盖/排序、`buildMacroIndex` 的
  latest/prev/count、坏值过滤；前端 `filterRange` 的 1/3/5 年边界。
- 静态契约：导航/`VIEWS`/hash 正则含 `macro`；`index.html` 引入两个新脚本；
  `portfolio-collect`/`backfill-macro` 调用 `upsertSeries`。
- 浏览器：宏观页 5 张卡、点开两融折线、点开社融柱状、5 年/全部切换、手机宽度。
- 全量 `node --test "tests/*.test.mjs"` 通过。

## 6. 非目标

- 不做指标对比叠加、不做导出、不做实时刷新（宏观是日频/月频）。
- 不改 `daily.json` 的消费者契约，不删旧字段。
