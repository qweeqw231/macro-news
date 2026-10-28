# 更新日志

本项目按语义化版本记录变更。新增功能记 minor，修复与数据口径调整记 patch。

## [Unreleased]

### 待发布

## [1.1.0] - 2026-10-29

### 新增

- **组合行情 + 宏观采集链路**（对应《采集规格.md》v1.0）
  - `src/portfolio.mjs`：5 个新增行情 key（`ndx` / `xau` / `sge_au9999` / `usdcny` / `cgb_1y`）
    与 5 个宏观指标（`margin` / `us10y` / `social_financing` / `cpi` / `pmi`）的适配器，
    含规格 §5 的全部校验（价格 > 0、涨跌幅 ±20%、上海金 500~1500、中间价 5.0~9.0、
    `updatedAt` 距今 ≥3 天标 `stale`）。
  - `src/portfolio-collect.mjs`：按 key 合并写 `data/quotes.json`（保留原 17 个 key）、
    按日期追加 `data/macro/daily.json`、读改写 `data/_last-run.json`。
  - `scripts/portfolio-collect-and-push.ps1`：采集 → 提交 → 推送的一条龙封装，
    供 minimax 定时任务调用（全程无 AI 判断）。
  - `采集规格.md`：本次实现所依据的规格书（随代码入库）。

- **minimax 定时任务**
  - `macro-news 组合行情+宏观采集（交易日 16:30）`：周一至周五 16:30（Asia/Shanghai），
    固定对话，模型 `MiniMax-M3.1-Flash`。
  - `macro-news 组合采集失败重试（16:35）`：规格 §1 要求的「失败重试 1 次，间隔 5 分钟」，
    读 `logs/last-portfolio-status.json` 判断是否需要补跑。

### 变更

- `src/collect.mjs` 的写盘改为**按 key 合并**（`quotes.json`）与**读改写**（`_last-run.json`）。
  原先是整份覆盖，会把 16:30 链路写入的 5 个组合行情 key 和运行日志在 5 分钟内抹掉。
- `scripts/portfolio-collect-and-push.ps1` 的同步策略：先与远端合并再采集，
  推送被拒时重新同步后重试一轮；合并冲突时 `data/` 取远端版本。

### 数据源口径（与规格书不一致处，一律以实测为准）

| 项 | 规格书写法 | 实测结论 |
|---|---|---|
| `xau` 昨收 / 开盘 | `[2]` 为开盘 | `[2]` 与现价同值（买一价）；昨收 `[7]`、开盘 `[8]`。照抄会让涨跌幅恒为 0 |
| `usdcny` 备用源 | 东财 `secid=133.USDCNY` | 该 secid 实测 `data:null`；可用的是 `133.USDCNH`（离岸价 CNH），已在 `note` 标注 |
| `usdcny` 主源 | 中国货币网页面（JS 渲染） | 改用站方公开 JSON 接口 `.../data/fx/ccpr.json`，`records` 在顶层，无需解析 DOM |
| `sge_au9999` 合约匹配 | `Au99.99` | 必须**精确等于** `Au99.99`，否则会误匹配递延合约 `iAu99.99` |
| `cgb_1y` 1 年期取值 | — | 数据行第 4 列（表头「1年」）；无「昨收」语义，用上一交易日同口径值反推 |

### 踩坑

- 写盘函数漏建目录：`data/macro/` 首次不存在时 `writeJSONIfChanged` 直接 ENOENT
  （`writeJSON` 有 `mkdir`，`writeJSONIfChanged` 没有）。
- `cgb_1y` 的「上一交易日」不能从「今天往前一天」起算：当天曲线未发布时会回退到前一交易日，
  再往前一天就取回了命中日本身 → `prevClose == price`、涨跌幅恒为 0。
  改为从**实际命中日的前一天**起算。
- `git over HTTPS` 到 `github.com` 在本机被 RST（`api.github.com` 通、TCP 通、TLS 被重置），
  改走 `ssh.github.com:443`，用仓库级 `url.insteadOf` 自动切换，remote URL 不变。

## [1.0.0] - 2026-10-05

### 新增

- 全球宏观资讯自动采集与归档站点（新闻 + 17 个指数行情 + K 线）。
- GitHub Actions 每 5 分钟采集并自动提交，GitHub Pages 部署。
- 浏览器直连东方财富取实时行情与 K 线，接口不可达时回退到本地快照。
