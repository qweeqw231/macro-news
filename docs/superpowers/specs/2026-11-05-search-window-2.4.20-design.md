# 2.4.20 · search.json 窗口与摘要取舍

日期：2026-11-05　版本：补丁位（2.4.20）

## 1. 结论

- 窗口：**最近 62 个新闻日**（今天 + 前 61 天），按新闻日边界；超窗口的 archive 日期不再进索引。
- 字段：**去掉 220 字摘要，只留 `id/ts/time/source/title/url`**；同时去掉 `channel`。
- 取舍：牺牲正文关键词命中（标题/来源仍可搜），换取首次搜索下载量减半；
  62 天窗口与 README 原承诺一致。

## 2. 实测（当前 archive 65 天，窗口内实际 56 个有文件日期、21,850 条）

| 方案 | 条数 | 原始体积 | gzip 体积 | 单条均值 |
|---|---|---|---|---|
| 现状：全 archive + 220 字摘要 | 21,850 | 12.66 MB | ≈3.45 MB | 607 B |
| **新：62 天 + 无摘要** | **21,850** | **6.43 MB** | **≈1.42 MB** | **309 B** |
| 对照：62 天 + 80 字摘要 | 21,869 | 9.35 MB | 2.74 MB | 449 B |

- 62 天是窗口上限；archive 中间有缺日，窗口内实际 56 个日期文件。
- 首次搜索下载从 12.66 MB 降到 6.43 MB（gzip 3.45→1.42 MB），约减半。
- 命中质量：标题权重提高到 0.8、来源 0.2；渠道筛选/正文关键词不再参与。
  搜索仍能命中标题中的「降息/CPI/美联储」等，摘要里的细节词会漏。

## 3. 实现

- 新增 `src/search-window.mjs`：
  - `SEARCH_WINDOW_DAYS = 62`
  - `searchCutoff(now) = addDays(newsToday(now), -(62-1))`
  - `inSearchWindow(day, now)`
  - `compactSearchItem(it) → { id, ts, time, source, title, url }`
- `src/collect.mjs` 构建 search.json 时：
  - 按文件名倒序遍历，`day < searchCutoff` 立即 break；
  - 每条走 `compactSearchItem`；
  - 元数据加 `windowDays/from/days`，不改 `items` 的既有读取方式。
- `assets/app.js`：Fuse keys 去掉 summary，title 0.8 / source 0.2；
  搜索结果不再显示摘要行（字段本来就没有）。
- 历史切片/`archive` 内容不变；搜索只覆盖 archive 最近 62 天。

## 4. 测试

- `tests/search-window.test.mjs`：
  - 62 天窗口边界（含当天、第 62 天、第 63 天）；
  - `compactSearchItem` 恰好 6 个字段、不含 summary/channel；
  - 静态断言 collect 使用 `compactSearchItem` 与窗口 break；
  - 静态断言 Fuse 不再索引 summary。
- 全套测试保持全绿。

