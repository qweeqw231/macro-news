# 更新日志

本项目按语义化版本记录变更。新增功能记 minor，修复与数据口径调整记 patch。

## [Unreleased]

### 待发布

## [1.2.0] - 2026-10-29

### 新增

- **`scripts/pull-remote.ps1` + 配套定时任务「macro-news 远端数据同步（每 4 小时）」**
  - 方向与采集链路相反：**远端 → 本机**。跑 `git fetch origin main` +
    `git merge --ff-only origin/main`，让本地 `data/` 随时跟上 GitHub 上的最新
    新闻（含标题与正文）、行情、归档与 K 线。
  - 频率定为**每 4 小时**：实测 GitHub Actions 实际每 **3~5 小时**才推一次
    （最近三次 10-28 19:39 → 23:30 → 10-29 02:43 UTC），拉得更勤拿到的还是同一份数据。
  - 安全性：快进失败（本地有未提交改动，或有本地独有提交）→ **跳过并报告**，
    绝不覆盖用户工作区。已实测 `git merge --ff-only` 在脏工作区下会拒绝合并并中止。
  - 运行状态写入 `logs/last-pull-status.json`（不入库）。

### 修正

- **README 加了置顶的「现状速览」章节**，按 2026-10-29 的真实状态重写：
  - 明确写清**站点未部署**（GitHub Pages `has_pages=false`）、**项目已停止主动开发**；
  - 三条链路（Actions 采集 / 16:30 组合采集 / 每 4 小时拉回本机）各自的负责范围、频率、产出；
  - 列出 3 个 minimax 定时任务的**任务名 + cron_id + 计划表达式**，并注明
    `cron_read` 返回的 `schedule` 才是准的（界面中文描述可能把 `1-5` 显示成"每周一"）；
  - 新增「如果你是来取数的 AI」小节：读哪些文件、不要自己抓 HTTP、不要手工改 `data/`；
  - 把「别踩的坑」扩到 15 条（含 `git restore --source` 不可用于同步、
    `fetch` 后才读 `origin/main`、Actions 的 `*/5` 实测 3~5 小时）；
  - 待办清单改为"还开着的口子"（启用 Pages / 压缩新闻滞后 / 归档策略 / 补正文等）。
- README 里「github.io / github.com 在国内均可直连」的旧结论已不成立
  （2026-10-29 实测 HTTPS 被重置），改为标注 SSH-443 推送方式与本机实测结论。
- README 标注 **GitHub Pages 尚未启用**（`has_pages=false`，
  `qweeqw231.github.io/macro-news/` 返回 "Site not found"），
  需在仓库 Settings → Pages 里把 Source 选成 `main` / 根目录。

### 踩坑

- 用 `git restore --source=origin/main --worktree -- data` 只拉数据会留下
  「脏工作区 + untracked 文件」，**反而阻塞下一次快进**；整体 ff 才是干净做法。
- `git fetch origin main` 之后 `origin/main` 会前进，但 `git rev-parse origin/main`
  要在 fetch **之后**再读，否则会误判「本地已是最新」。

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
