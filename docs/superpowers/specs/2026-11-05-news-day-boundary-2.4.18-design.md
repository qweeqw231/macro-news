# 2.4.18 · 统一「新闻日」边界（北京 08:00）

日期：2026-11-05　版本：补丁位（2.4.18）

## 1. 定义

新闻日 D = **[D 08:00 北京, D+1 08:00 北京)**。

因为北京 08:00 正好是 UTC 00:00，等价显式算法：

```text
newsDay(t) = (t 的 UTC 日历日期) = floor(t / 24h) 的日期
```

实现不调用 `getFullYear/getMonth/getDate`，不依赖进程 `TZ`。
唯一实现：`assets/news-day.js`（UMD，浏览器/Node 共用）；`src/news-day.mjs` 只做 re-export。

边界样例：

| 时间戳（UTC） | 北京 | 新闻日 |
|---|---|---|
| 2026-11-04 23:59:59 | 11-05 07:59:59 | 11-04 |
| 2026-11-05 00:00:00 | 11-05 08:00:00 | 11-05 |
| 2026-11-05 00:00:01 | 11-05 08:00:01 | 11-05 |
| 2026-11-05 01:30:00 | 11-05 09:30 | 11-05 |
| 2026-11-04 16:00:00 | 11-05 00:00 | 11-04 |
| 2026-11-05 15:59:59 | 11-05 23:59:59 | 11-05 |

## 2. 调用点清单

| 位置 | 原口径 | 改为 |
|---|---|---|
| `src/collect.mjs` 归档分组 | 本地 `getFullYear/getMonth/getDate`（本机=北京零点） | `newsDay(it.time \|\| startedAt)` |
| `scripts/news-db/history-slice.mjs#beijingDay` | `+8h` 北京自然日 | `ND.newsDay(ts*1000)` |
| `history-slice#beijingToday` / `dayWindow` | 北京自然日 | `ND.newsToday` |
| `scripts/news-db/backfill-chinanews.mjs` 默认 `to` | 北京自然日 | `newsToday()` |
| `scripts/news-db/backfill-pbc.mjs` 默认 `to` | 北京自然日 | `newsToday()` |
| `scripts/news-db/brief-candidates.mjs#beijingToday` | 北京自然日 | `newsToday()` |
| `scripts/briefing/core.mjs#beijingNow.date` | 北京自然日 | `newsDay(now)`（`hm` 仍是北京墙钟） |
| `src/snapshot.mjs#beijingNow.date` / `--backfill` 日期 | 北京自然日 | `newsDay` |
| `assets/app.js` 今日归档判断 | `+8h` 北京自然日 | `MacroNewsDay.newsDay` |
| `assets/app.js` 页脚早报今日 key | `+8h` 北京自然日 | `MacroNewsDay.newsDay` |
| `index.html` | — | 新增 `assets/news-day.js`，资源串 `20261105d` |

`index.json` / `latest.json` / `search.json` 都由 archive 文件名派生，不单独切日；
`scripts/export-history.mjs` 通过 `history-slice` 的 `beijingDay/dayWindow` 自动跟随。
市场 K 线、CGB、宏观日线、行情快照的**交易日**语义不属于新闻日；其中 `src/snapshot.mjs`
的日期已跟随新闻日（当前调度在 21:43/23:43 北京，不跨 08:00，行为不变）。

## 3. 历史不重写

- 不重排、不改写已存在的 `data/archive/*.json`、`data/history/*.json`。
- 2026-11-05 之前（含 11-04/11-05 文件中由旧本机运行写入的部分）是 UTC 与北京自然日混合口径；
  日界存在不确定性，README 与 CHANGELOG 写明。
- 新采集从 2.4.18 起按新闻日写。

## 4. 对现有 11-04 / 11-05 文件的影响（实测）

读取现有归档，逐条按新函数计算归属：

| 文件 | 条数 | 落在新窗口内 | 落在窗口外 |
|---|---|---|---|
| `2026-11-04.json` | 800 | 800 | 0 |
| `2026-11-05.json` | 383 | 383 | 0 |

- 不会出现条数跳变，也没有新闻换天（现有条目全部已符合新边界）。
- 变化只发生在**未来**：本机在 16:00–24:00 UTC 采集到的条目过去可能按北京自然日写进次日，
  现在一律写 UTC/新闻日，不再把凌晨条目推到次日文件。

## 5. 测试

- `tests/news-day.test.mjs`：07:59:59 / 08:00:00 / 08:00:01 / 09:30 / 00:00 / 23:59；
  `TZ=UTC` 与 `TZ=Asia/Shanghai` 子进程输出完全相同；实现不含本地日期 API；
  所有调用点静态接线。
- `tests/history-slice.test.mjs`、`tests/briefing-core.test.mjs` 更新为新闻日预期。
- 全套 227 项通过。
