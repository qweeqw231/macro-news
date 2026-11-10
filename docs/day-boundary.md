# 日界口径对照：新闻日 vs 自然日

> 2.12.0 新增。回答「新闻日和自然日分别影响什么」。
> 结论均从代码核实，逐条给出函数名与关键行；无法从代码确定的地方明确写「无法确定」。

## 0. 两个定义

| 名字 | 定义 | 代码 |
|---|---|---|
| **新闻日** | 北京时间 **08:00** 到**次日 08:00** 为一天；等价于该时刻的 **UTC 日期** | `src/news-day.mjs` 的 `newsDay(t)`：`new Date(t).toISOString().slice(0,10)` |
| **自然日** | 北京时间 00:00–24:00 | 只出现在早报候选的时间**过滤**里（见第 2 条），以及业务上的口语表述 |

`newsDay` 之所以能把「08:00 起算」写成「UTC 日期」：北京 08:00 = UTC 00:00，
所以北京 08:00 之后的时刻，其 UTC 日期恰好等于北京当天日期；08:00 之前的时刻，
UTC 日期还是前一天 —— 一次 `toISOString` 就完成了切日。

## 1. 归档文件名的键：新闻日

- 计算处：[src/collect.mjs](../src/collect.mjs) 第 289 行
  ```js
  const k = newsDay(it.time || startedAt) || newsDay(startedAt);
  ```
  `it.time` 是带 `+08:00` 的 ISO 串（`src/sources.mjs` 的 `isoFromUnix`），
  `newsDay` 解析后取 UTC 日期 ⇒ 键就是新闻日。
- 落盘：`data/archive/<k>.json`，文件里 `day` 与键一致。
- 派生：`data/index.json` 的 `days[].day` / `count` 直接来自这些文件名与 `items.length`。

**所以 `2026-11-10.json` 装的是北京 11-10 08:00 ~ 11-11 08:00 的条目。**

## 2. 早报的键：新闻日（`newsDay(now)`），内容窗口却是自然日

- 键：[scripts/briefing/core.mjs](../scripts/briefing/core.mjs) 第 29 行
  ```js
  date: newsDay(now),          // beijingNow() → NOW.date
  ```
  `prepare.mjs` 第 44 行 `const DATE = arg('date', NOW.date);`，
  `ensure.mjs` 的 `TODAY = arg('today', NOW.date)` —— 两者默认都取这个键。
- 候选窗口：[scripts/briefing/pipeline.mjs](../scripts/briefing/pipeline.mjs) 第 147 行
  ```js
  const window = { from: addDays(date, -1), to: date };
  ```
- 窗口**如何被解释**：[scripts/news-db/brief-candidates.mjs](../scripts/news-db/brief-candidates.mjs) 第 52–53 行
  ```js
  const fromTs = Date.parse(from + 'T00:00:00+08:00') / 1000;
  const toTs   = Date.parse(to   + 'T23:59:59+08:00') / 1000;
  ```
  —— 用的是**北京自然日**零点与 23:59:59，不是新闻日边界。

**09:00 运行时到底覆盖什么**（以 D 日 09:00 为例）：

- 名义窗口 = `[D-1 00:00, D 23:59:59]`（北京自然日）；
- 但候选只存在于「已经采集到的条目」，而 09:00 时 D 日只采到 08:00–09:00 这一小时；
- 于是实际内容 = **D-1 全天（自然日）+ D 日 08:00–09:00**。

换成新闻日语言：**≈ 前一个新闻日（D-1 08:00 ~ D 08:00）的全部 + D 日头一个小时**。
不是「只有前一个新闻日」，也不是「当天头一个小时」。这是代码事实，两句话都只说对一半。

## 3. 早报与归档卡片的绑定：同一把键，但语义错开一天

- 绑定处：[src/collect.mjs](../src/collect.mjs) 第 341–351 行
  ```js
  const briefs = readBriefingMeta(path.join(DATA, 'briefings'));
  ...
  hasBriefing: !!b,
  ```
  `readBriefingMeta`（[src/brief-meta.mjs](../src/brief-meta.mjs) 第 36 行）用
  `data/briefings/<YYYY-MM-DD>.json` 的文件名当键。
- 归档卡片同样用 `index.json` 的 `days[].day`（第 1 条的新闻日键）。

**是同一个键**，但两边的「D」指向的内容不重合：

| 键 D | 归档 `D.json` | 早报 `D.json` |
|---|---|---|
| 内容区间 | D 08:00 ~ D+1 08:00 | ≈ D-1 08:00 ~ D 09:00 |

即早报实际上在讲**上一个新闻日**的事，却挂在**当前新闻日**的卡片上（错开约一天）。
这是既有设计（早报 09:00 出稿，为的是当天早上能看到昨晚的隔夜新闻），
**2.12.0 只把这一点显式标在站点与文档上，没有改行为**。

## 4. `search.json` 的窗口：新闻日

- [src/search-window.mjs](../src/search-window.mjs) 第 9–10 行
  ```js
  export function searchCutoff(now = Date.now()) {
    return addDays(newsToday(now), -(SEARCH_WINDOW_DAYS - 1));   // SEARCH_WINDOW_DAYS = 62
  }
  ```
  `newsToday` = `newsDay(now)` ⇒ 截断点是**新闻日**日期串。
- 实际条目的挑选：`for (const d of sortedDays) if (d.day < searchFrom) break;` ——`d.day` 也是新闻日。
- 所以文件里的 `days`（当前 60）是「窗口内**实际存在**的新闻日文件数」，
  不是 62；62 是名义窗口，缺的两天是没有归档文件的日期。

## 5. 快照（am/pm）：按新闻日命名

- [src/snapshot.mjs](../src/snapshot.mjs) 第 66–70 行
  ```js
  function beijingNow(d = new Date()) {
    ...
    date: newsDay(d),
  ```
- 文件名：第 492 行 `path.join(SNAP_DIR, \`${date}_${session}.json\`)` ⇒ `data/snapshots/<新闻日>_am.json`。

即快照虽然对应「北京上午/下午两个采集时点」，但**文件名用的是新闻日**，
同一天 08:00 前后的两次采集会落到不同新闻日文件里（与归档同口径）。

## 6. K 线：与新闻日无关

- 全仓库 `newsDay` 的引用只在 `src/collect.mjs`、`src/snapshot.mjs`、`src/search-window.mjs`、
  `scripts/briefing/*`、`scripts/news-db/*` 里；`src/kline.mjs`、`src/kline-*`、`scripts/update-kline*.mjs` **没有任何引用**。
- K 线的日期来自数据源返回的**交易日**（`bars[].t`），并受 `src/kline-guard.mjs` 的「不倒退/不跳变」守护。
- 结论：交易日历与新闻日**无关**，两者只是恰好都用 `YYYY-MM-DD` 字符串。

## 7. 那 320 条历史残留：确认来自 2.4.19 之前的北京自然日口径

**判断依据（可复验）**：

1. 2.4.19（2026-11-05，commit `73ecd628`；该 commit 标题误写为 2.4.18）才引入
   `src/news-day.mjs` 并把归档键统一成新闻日；CHANGELOG 2.4.19 明确写「不回写历史」。
2. 取 2.4.19 之前的归档首版，例如 `git show 87188447:data/archive/2026-10-31.json`：
   66 条条目的 `time` 落在 `2026-10-30T16:01:28Z` ~ `2026-10-31T01:53:51+08:00`，
   **按 `newsDay` 全部属于 `2026-10-30`**（66/66），却被写进了 `2026-10-31.json`。
   只有「按北京自然日切日」才会出现这种归属。
3. 复验命令：
   ```bash
   node -e "const{execFileSync}=require('child_process');const j=JSON.parse(execFileSync('git',['show','87188447:data/archive/2026-10-31.json'],{encoding:'utf8'}));
   const nd=t=>new Date(t).toISOString().slice(0,10);
   console.log(j.items.length, j.items.filter(x=>nd(Date.parse(x.time))==='2026-10-30').length);"
   ```
   输出 `66 66`。
4. 这批条目共约 320 条，全部落在 10-02 ~ 11-04（2.4.19 之前写下的文件）；
   2.11.1 恢复时按规则「当前文件里已有的条目一律保留原位」，因此**没有搬动**它们。

**结论：是的，来自 2.4.19 之前按北京自然日切日的口径；不是采集错误，也不是恢复残留。**

## 8. 一页速查

| 对象 | 键 | 语义 |
|---|---|---|
| `data/archive/<D>.json` | 新闻日 | D 08:00 ~ D+1 08:00 |
| `data/index.json` `days[].day` | 新闻日 | 同上，与归档文件一一对应 |
| `data/briefings/<D>.json` | 新闻日（生成时刻） | 内容 ≈ D-1 08:00 ~ D 09:00 |
| 归档卡片上的早报 | 同上 | 与归档同键，但内容错开约一天 |
| `data/search.json` | 新闻日 | 最近 62 个新闻日（实际 60 天有文件） |
| `data/snapshots/<D>_am|pm.json` | 新闻日 | 北京上午/下午采集，按新闻日命名 |
| `data/kline/*.json` | 交易日 | 来自数据源，与新闻日无关 |
| `data/_last-run.json` `news.days[].day` | 新闻日 | 与本轮写盘用的键一致（`collect.mjs` 第 289 行同一个 `k`） |
