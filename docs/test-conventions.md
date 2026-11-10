# 测试断言规范（2.12.1）

> 起因：`data/` 是**每天会被采集器改写**的真实数据。凡是把「今天刚好是多少」写进断言，
> 测试就会自己变红，然后靠改测试（而不是改代码）恢复全绿——这类断言等于没有断言。

## 1. 硬规则

对**真实 `data/`**（`archive/`、`kline/`、`quotes.json`、`index.json`、`latest.json`、`search.json`、`snapshots/`）**禁止**：

1. `assert.equal(x.length, <精确数字>)` —— 条数、根数、标的数；
2. `assert.equal(<末条日期>, '<某一天>')` —— 末根 K 线、最新条目时间戳；
3. 任何隐含「今天是哪天」的判据（例如「距今天不超过 N 天」里把 N 写死到刚好卡住）。

## 2. 替代写法（按性质选一种）

| 想保住的事实 | 写法 |
|---|---|
| 结构没坏 | 字段/类型/周期/`key` 唯一，`bars[i].length === 6` |
| 历史起点没缩水 | `first <= '<源侧固定起点>'`（如 SENSEX 全量 `<= 1990-01-02`） |
| 数量没缩水 | `length >= <下限>`（下限取「文件承诺的最小覆盖」，不是当前值） |
| 数据是新的 | `last >= '<基准日>'`（只写不早于，不写等于） |
| 两处口径一致 | 用代码常量互证：`quotes.length === snapshotTargets('am').length`、`index.count === 归档 items.length` |
| 文件不许被改写 | 冻结件比对内容哈希（如 `briefing-metadata`） |

## 3. 允许精确断言的三类

1. **合成夹具**：测试自己构造的输入（`quota` / `news-dedupe` / `kline-guard` / `ops-stats` 等），
   精确值就是被测逻辑的预期输出，必须保留。
2. **代码常量**：`INDICES.length`、`ETFS.length`、`SEARCH_WINDOW_DAYS`、`DAY_TOTAL` 这类不随日期漂移，
   只随「有意改代码」变化。**仍优先用导出的常量本身**，不要复制数字：
   `assert.equal(kept.length, DAY_TOTAL)` 优于 `=== 1800`。
3. **冻结的历史文件**：`data/snapshots/2026-11-02_am|pm.json`、`data/briefings/<老日期>.json`
   按设计「时点快照不重写」，可以钉精确值（最好再叠一个内容哈希）。

## 4. 加标的 / 加源 / 改上限时的检查单

- 行情条数：不要动数字，`TARGET_COUNT = snapshotTargets('am').length` 会自己长大；
- K 线：只钉起点与下限，不钉根数与末根日期；
- 休市表：只钉「关键日子在 / 禁入日子不在 / 覆盖区间」，不钉条数；
- 上限：一律引用 `DAY_TOTAL`，不复制当前值。

## 5. 已清理的历史用例

| 版本 | 位置 | 原断言 | 现断言 |
|---|---|---|---|
| 2.11.1 | `tests/index-sox.test.mjs`、`tests/index-sensex-vnindex.test.mjs` | 日 K「89 根」、末根 `2026-11-06` | 起点固定 + 根数下限 + 末根不早于基准日 |
| 2.12.1 | `index-a500` / `index-sse50` / `index-sox` / `index-sensex-vnindex` | `quotes.length === 62` | `=== snapshotTargets('am').length` |
| 2.12.1 | `index-sensex-vnindex` | 印度 16 天 / 越南 13 天 | `>= 16` / `>= 13` + 关键日子与禁入日子 |
| 2.12.1 | `quota.test.mjs` | `kept.length === 1800` | `=== DAY_TOTAL` |
