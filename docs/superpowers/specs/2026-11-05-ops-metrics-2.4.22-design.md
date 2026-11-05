# 2.4.22 管道操作底账 · 设计

> 目标：把「我们自己的数据管道处理了多少次」变成随时可复算、可留存、可与 GitHub Traffic 对照的底账。
> 不做 48 小时停采对照实验；外部 clone 来源仍无法指认，本底账只服务长期趋势与自证用量。

## 1. 本机运行台账

`scripts/collect-and-push.ps1` 每轮结束（成功 / 跳过 / 失败）向
`.local/metrics/collect-runs.jsonl` 追加一行 JSON。`.local/` 已 gitignore，不入库。

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `at` | string | 本轮结束时刻，UTC ISO（`yyyy-MM-ddTHH:mm:ssZ`） |
| `host` | string | `COMPUTERNAME` |
| `mode` | string | `collect` / `sync-only`（`-SyncOnly` 只做同步自检，不采集） |
| `result` | string | `ok` / `skipped` / `failed` |
| `headBefore` | string | 同步前 HEAD 短哈希 |
| `headAfter` | string | 结束时 HEAD 短哈希（含本轮提交/合并） |
| `behind` | number/null | 同步时落后 `origin/main` 的提交数；fetch 失败为 null |
| `ahead` | number/null | 同步时领先数；fetch 失败为 null |
| `filesWritten` | number | 本轮暂存的数据文件数（跳过/失败为 0） |
| `commitCreated` | boolean | 本轮是否创建了提交（含跳过轮只提交 `_last-run.json`） |
| `skipReason` | string | 跳过/失败原因：`unmerged` / `fetch-failed` / `stash-failed` / `ff-only-failed` / `stash-pop-conflict` / `merge-conflict` / `news-fresh` / `no-data-changes` / `sync-only` / `commit-failed` / `push-failed`；成功为空 |
| `syncResult` | string | `up-to-date` / `ff-only` / `merge` / `stash-restored` / `skipped:*` |
| `durationMs` | number | 从脚本启动到写台账的毫秒数 |

约束：

- 覆盖已有分支：`up-to-date` / `ff-only` / `stash-restored` / `skipped:*` / 正常采集 / `-SyncOnly`。
- 所有 `exit` 都在 `try/finally` 内；PowerShell 实测 `exit` 仍会执行 `finally`，退出码不变。
- 写台账用 `try/catch` 包住：失败只在日志里告警，不改变主流程与退出码。
- 以 `[System.IO.File]::AppendAllText` + 无 BOM UTF-8 追加，保证 JSONL 首行不带 BOM。

`-SyncOnly` 记 `mode: "sync-only"`，聚合与表格中不计入「本机采集次数」，单独展示。

## 2. 云端只读统计

新增 `scripts/ops-stats.mjs`（只读，不写仓库、不提交）：

- GitHub REST **匿名** `GET /repos/{owner}/{repo}/actions/runs`，`per_page=100`，按 `created` 过滤；
- 按 `created_at` 转 Asia/Shanghai 日期分组，统计每日总运行数与按 workflow 名称的次数；
- **push 次数**：同一 `head_sha` 的 `event=push` 运行只算一次（同一 push 会触发多个 workflow）；
- **Pages 构建次数**：优先直接计数同一份 `runs` 里的 `pages build and deployment`；
  若整窗没有 pages 运行（API 缺失/仓库未启用），回退到「一次 push 一次构建」的推断；
- **clone 当量**：`workflow 运行数 + Pages 构建数`，按「1 次运行 ≈ 1 次 clone」粗算；
  本机运行不计入 clone 当量（本机是 fetch，不是 clone）；
- 读取 `.local/metrics/collect-runs.jsonl`，按新闻日（`at` 的 UTC 日期）聚合：
  跑了几轮、成功/跳过/失败各几轮、跳过原因分布、`sync-only` 单独计数；
- 输出每日操作次数表：`日期 | GH workflow | Pages 构建 | 本机采集 | 合计`，并写快照
  `.local/metrics/ops-stats-<yyyy-mm-dd>.json`（本地留存，不入库）。

产物不写 `data/`，避免为统计制造额外提交与 clone。

## 3. 口径与已知误差

- **匿名分页上限 1,000**：`actions/runs` 匿名分页最多翻到 1,000 条；超出部分只能标注
  `truncated=true` 与 `missing≈total_count-已取`，不能假装完整。按 15 分钟一轮估算，
  1,000 条约覆盖最近 3~5 天；更长的历史需要 token 或 GH Archive。
- **GH Archive 采样**：本脚本不依赖 GH Archive；如需更长历史，GH Archive 是小时级归档、
  可覆盖全量事件，但属于外部采样数据，时间边界与匿名 API 可能不一致。
- **Pages 构建是否计入 clone 属推断**：本仓库 Pages 由分支发布，一次 push 一次构建；
  仓库设置变化或手动重跑会使推断偏差。
- **Traffic 需 token**：`/traffic/views`、`/traffic/clones` 需要带 token 才能按日拉取；
  本脚本不读取 token，Traffic 数字由人工在 GitHub Insights 页面读取后对照。
- **本机台账只覆盖本机脚本**：云端 workflow 的运行动作不在本机台账里；两边合计是
  「自有操作次数」的下界，不是全部外部访问。
- **新闻日口径**：本机台账按 `at` 的 UTC 日期聚合，与站点新闻日（北京 08:00 起算、
  等价 UTC 日期）一致。

## 4. 用途边界

这套台账用于**长期趋势与自证用量**：我们可以证明自己每天跑了多少轮、push 了多少次、
Pages 构建了多少次；它**不能**证明外部 clone 的来源，也不能指认任何第三方访问者。
外部来源仍只能靠 GitHub Traffic / referrer 等平台侧数据观察。

## 5. 测试

- 聚合纯函数：分日/分 workflow、push 去重、Pages 派生、本机台账成功/跳过/失败与原因分布、
  `sync-only` 排除、合计与 clone 当量。
- `collect-and-push.ps1` 静态断言：`try/finally` 存在、台账路径在 `.local/`、
  `-SyncOnly` 独立标记、写台账失败不改退出码、字段齐全。
- 测试不联网、不写仓库；临时目录用 `os.tmpdir()`。
