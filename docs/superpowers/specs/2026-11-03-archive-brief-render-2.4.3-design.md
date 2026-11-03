# 2.4.3 · 归档早报：去重与全文渲染

## 1. 问题

2026-11-01 的归档早报展开后，折叠摘要（`briefLine`，由 `overview` 截断 ≤80 字）与正文
`overview` 是同一句话，上下重复；同时展开只渲染 `overview + watch`，读者看不到 10 条正文。

## 2. 折叠/展开文案

- 折叠态：`summary` 显示索引里的 `briefLine`（≤80 字，小字，`0.8rem`）。
- 展开后加载成功：`summary` 替换为**中性信息行** `当日早报 · <N> 条 · <HH:MM> 生成`
  （`0.72rem`、`ink-faint`），不再与 `overview` 重复；收起时恢复 `briefLine`。
- 正文 `overview` 用更大字号/更深颜色（`0.95rem` / `ink` / 500），层级明确。
- 不新增索引字段、不预取正文；`briefLine` 仍是索引里唯一的一句摘要。

## 3. 全文渲染（按需）

展开时才 `fetch data/briefings/<date>.json`（历史日 `default`、当日 `no-store`）：

1. `overview` 全文；
2. 全部 `items`：`rank` / 标题（有 `url` 时新窗口链接）/ `summary` / `why` / `source` /
   `publishedAt` / `refs`（可折叠或并列链接）；
3. `watch` 观察项收尾。

- 加载态：`早报载入中…`；
- 失败态：`早报载入失败：…` + 「重试」按钮；不写 `loaded`，重试可重新请求；
- 缺字段降级：无 `overview` 且无 `items` 时显示「该日早报正文缺失（只有摘要）」，
  并保留 `briefLine`，**不伪造正文**；
- 展开状态/滚动位置沿用 `sessionStorage`（`briefOpen`），异步加载不重置。

## 4. 实测数字（2026-11-03 的早报）

| 指标 | 数值 |
|---|---|
| 单份 JSON 原始字节 | **10,089 B** |
| gzip 后 | **4,085 B** |
| 本地展开网络耗时（localhost） | **33 ms** |
| 线上展开网络耗时（Pages + 本机代理） | **≈43 s**（当前带宽 5~30 KB/s） |
| 首屏 `briefings` 请求 | **0**（展开前不拉正文） |
| 卡片高度（桌面） | **8,418 px**（10 条 + 4 条观察项） |
| 卡片高度（390px） | **3,522 px** |

> 结论：按需拉取是必要的 —— 单份 10 KB，但 Pages 带宽下要几十秒；若 365 天预取不可行。

## 5. 测试

`tests/briefing-render.test.mjs`（6 项）：摘要替换/恢复、全文结构、按需加载、
失败重试、缺字段降级、排版层级与窄屏断行。

## 6. 验收

- 桌面：展开前 summary 为 `briefLine`；展开后为 `当日早报 · 10 条 · 09:03 生成`；
  `.brief-items` 10 条、watch 4 条；无同句重复。
- 390px：卡片 `clientWidth = scrollWidth = 346`，无横向溢出；summary/items 正常。
- 首屏 0 个 `briefings` 请求。
