# 外源历史补录：华尔街见闻 + 东方财富（2026-05-20 ~ 2026-10-04）

历史切片在 2026-11 之前只有「中新网 + 官方四源」，每天 100~300 条，没有一线财经快讯。
本次用两家外源回补 138 个新闻日，补进 `data/history/` 与 `data/history/index.json`。

## 数据源与可用边界（2026-11-15 实测）

| 源 | 接口 | 可回溯范围 | 单日体量（去重后） |
| --- | --- | --- | --- |
| 华尔街见闻 | `api-one.wallstcn.com/apiv1/content/lives?channel=&limit=&cursor=` | 只保留约 **180 天**：05-19 及更早返回空，05-20 起有数据 | 工作日 450~700，周末 60~180 |
| 东方财富 | `np-listapi.eastmoney.com/comm/web/getNewsByColumns?column=350` | `page_index+page_size` 可翻到约 20 万条偏移（≈2025-08），本窗口够用 | 90~850，多数 200~450 |
| 新浪财经 | `feed.mix.sina.com.cn/api/roll/get` | 约 59 页封顶（≈10 天） | **不可用于本窗口，未接入** |

五个 wscn 频道：`global / a-stock / forex / us-stock / commodity`，对应标签 全球 / A股 / 外汇 / 美股 / 大宗。

> 华尔街见闻是滚动保留窗口，越早的日期越接近永久丢失。本次先抓 wscn 再抓东财，就是为了抢在窗口前移之前落库。

## 脚本

- `scripts/news-db/backfill-external.mjs` —— 抓取并写入 `.local/news.db`（只写本机库，不碰 `data/`）
- `scripts/news-db/export-history-range.mjs` —— 从库按区间导出切片 + 重建 `data/history/index.json`

两者分开的原因：`scripts/export-history.mjs` 是常规「铺满近 365 天」导出器，会连带重建
`data/search-history` 分片；历史补录只应写 `data/history/`，不能影响搜索索引。

### 重跑

```bash
# 抓取（可断点续跑；--dry-run 只统计不写库）
node scripts/news-db/backfill-external.mjs --from 2026-05-20 --to 2026-10-04
node scripts/news-db/backfill-external.mjs --from 2026-05-24 --to 2026-05-24 --sources wscn

# 导出（--force 才会重写已存在的切片）
node scripts/news-db/export-history-range.mjs --from 2026-05-20 --to 2026-10-04 --force \
  --budget-total-mb 85 --budget-day-kb 900
```

## 口径

- **新闻日**：沿用 `assets/news-day.js`，北京 08:00 起算（等价 UTC 日期）。wscn 用 `display_time`，
  东财 `showTime` 为北京时间、早于 08:00 计入前一日。
- **字段**：与既有切片一致（`i/t/s/u/c/o/k/p`），摘要按 160 字截断，来源写真实来源，未做任何改写或补写。
- **去重**：
  1. 同源跨频道（同一快讯挂「全球」和「A股」、id 不同）按 `src/news-dedupe.mjs` 的频道优先级 + 正文/时间键合并；
  2. 翻页重复按源 id 去重（wscn 用 `oldest+1` 作游标，把同一秒的条目一并取回）；
  3. 与库内已有条目按「同源 + 归一化 URL」「同源 + 同时刻 + 同标题」查重；
  4. 切片层沿用既有 `titleHash` 规则，跨源同题同日只留优先级更高的一条（因此中新网条数会比原来少几个百分点）。
- **断点**：`backfill_state` 表（`wscn-api:<channel>` 按日、`em-api/pos` 按翻页游标），
  台账写在 `.local/backfill-external.jsonl`（不提交）。

## 体量与预算

| 指标 | 补录前 | 补录后 |
| --- | --- | --- |
| 切片天数 | 337 | 337 |
| 索引条数 | 77,256 | 168,913 |
| 切片总量 | 16.8 MB | 62.5 MB |
| 窗口内单日 | 64~140 KB | 81 KB ~ 842 KB（峰值 2026-06-17） |

单日体积已超出原先 300 KB 的常规预算，是「补全 1000+ 条/天」的必然结果；
`export-history-range.mjs` 的预算默认值因此放宽到单日 900 KB / 总量 85 MB，超限仍会停止且不写任何文件。

前端阅读侧只按天取一个切片（gzip 后约 100~200 KB），解析成本与归档页相当；索引文件本身仍是 32.9 KB。

## 已知缺口

- 2026-05-20 是 wscn 保留窗口的最左端，当天完整；05-19 及更早不可回溯，未做估算填充。
- 东财 2026-05-24 前的个别日期条数偏低（如 05-24 仅 145 条），是源端真实体量，未补造。
- 与 `data/archive/` 重叠的 33 天（08-17~10-04）一并补进了切片：归档多为 6~7 条的占位，
  前端既有规则「切片更全时优先 history」会自动接管；`data/archive/` 未被修改。
