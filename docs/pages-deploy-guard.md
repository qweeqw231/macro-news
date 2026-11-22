# Pages 部署去重：guard 与 concurrency 的分工（2026-11-22）

## 1. 结论

- **同一 SHA 只部署一次**。判据有两条，写在 `.github/workflows/pages.yml` 的 `guard` 作业里：
  1. `github-pages` 环境最新一条 deployment 的 SHA == 本轮 SHA ⇒ 跳过；
  2. 同一 `head_sha` 存在**更早创建、尚未完成**的 pages.yml 运行
     （`queued` / `in_progress` / `waiting` / `pending` / `requested`）⇒ 最多等 120 秒；
     仍未完成就让路给它。
- **并发控制只作用在 `deploy` 作业**（`group: pages`、`cancel-in-progress: false`），
  `guard` 不占组、可并行执行。2026-11-22 之前并发组挂在 workflow 级，整个运行（含 guard）
  都被串行化，第 2 条判据实际上永远看不到「对方在跑」。
- **陈旧窗口 15 分钟**：`deploy` 作业 `timeout-minutes: 15`，正常部署实测 41~47 秒。
  超过 15 分钟仍未完成的运行只可能是平台卡单或记录滞后，一律忽略，避免永久挡住后续部署。
- **统计口径提醒**：`capacity.mjs` 里「重复部署 3.0%」是按 `head_sha` 数**运行**，不是数
  deployment。这些重复运行的 `deploy` 作业实际是 `skipped`；近 100 次 `github-pages`
  deployment 中没有同一 SHA 重复，真实重复部署为 0。

## 2. 两条判据与实现

判据 1 覆盖「已经有人在部署这个 SHA」：deployment 记录在 `deploy-pages` 作业**开始时**
就会创建，不等部署完成，所以正在进行的部署也能被认出来。

判据 2 覆盖「deployment 记录还没出现」的几秒空窗，以及同一 SHA 的运行重叠：

```bash
# 只统计 run_id 更小（更早创建）、未完成、且 created_at 在 15 分钟内
gh api "repos/$REPO/actions/workflows/pages.yml/runs?head_sha=$SHA&per_page=30" \
  --jq "[.workflow_runs[]
         | select(.id < ${RUN_ID})
         | select(.status == \"queued\" or .status == \"in_progress\"
                  or .status == \"waiting\" or .status == \"pending\"
                  or .status == \"requested\")
         | select((now - (.created_at | fromdateiso8601)) < 900)] | length"
```

两个细节：

- **只认更早的运行**（`run_id` 更小）。GitHub 的 run_id 单调递增；两条运行同时起跑时，
  若互相把对方算作「进行中」就会**互相跳过**，这个 SHA 反而没人部署。用 run_id 做确定性排序，
  后到者让路。
- **等待而不是立即跳过**：发现更早的运行未完成时先等（10 秒一轮，最多 120 秒），
  期间它若部署完成，判据 1 会命中；它若失败/被取消，本运行接手续上。这样既不重复部署，
  也不会出现「两条都跳过、没人部署」的空窗。

## 3. 和 concurrency 的关系（为什么不打架）

| 层 | 位置 | 负责 | 不负责 |
|---|---|---|---|
| `guard` | 独立作业，不进 `pages` 组 | 同一 SHA 去重（两条判据） | 不同 SHA 之间不排队 |
| `deploy` 作业的 `concurrency` | `group: pages`，`cancel-in-progress: false` | 不同 SHA 串行部署、互不取消 | 不做 SHA 去重 |

- 两层管的是不同维度，不会互相遮蔽：过去并发组在 workflow 级，`guard` 也被串行化，
  第 2 条判据形同虚设；下移到作业级后，`guard` 几秒内并行跑完，`deploy` 仍严格串行。
- 即使 `guard` 因 API 秒级延迟漏判，`concurrency` 也只让两次部署**排队**，不会并发部署。
- `cancel-in-progress: false` 保持不变：连续提交最坏只是排队，不会互相取消。

## 4. 实测（北京时间 2026-11-22）

### 4.1 修改前：重复运行 ≠ 重复部署

- 近 300 次 `pages.yml` 运行里，7 个 `head_sha` 各出现 2 次；逐一检查 deploy 作业：
  6 次的第二次为 `skipped`，1 次为第一条被同组取消、第二条正常部署。
- 近 100 次 `github-pages` deployment（11-21 20:25 → 11-22 08:53 UTC）没有同一 SHA 重复。
- 结论：那 3% 是**同 SHA 的重复运行**，第二次并没有真的再部署一遍。

### 4.2 连续两次 dispatch 同一 SHA（旧配置，workflow 级并发）

提交 `ec688d00`（push 与两次 dispatch 抢同一 SHA）：

| 时间 | 运行 | 结果 |
|---|---|---|
| 16:58:48 | push `45005297725` | 部署成功 |
| 16:58:54 | dispatch `45005303673` | 被同组待运行取代，`cancelled`（未进 guard） |
| 16:59:00 | dispatch `45005311062` | guard `HEAD=ec688d00 LAST=ec688d00 ACTIVE=0` → 「已完成部署，跳过」（`deploy` skipped） |

3 条运行、1 次部署。也说明旧的 workflow 级并发会**取消**待运行，而不是让它优雅跳过。

### 4.3 连续两次 dispatch 同一 SHA（新配置，并发组在 deploy 作业）

提交 `e2ae953e`：

| 时间 | 运行 | 结果 |
|---|---|---|
| 17:06:06 | push `45005883949` | 部署成功（17:06:54 完成） |
| 17:06:11 | dispatch `45005891216` | guard `LAST=e2ae953e ACTIVE=1` → 「已完成部署，跳过」 |
| 17:06:17 | dispatch `45005899081` | guard `LAST=e2ae953e ACTIVE=2` → 「已完成部署，跳过」 |

3 条运行、1 次部署；三条运行在 11 秒内全部启动（旧配置下后两条只能排队或被杀），
`ACTIVE` 判据正确数出了更早的未完成运行。没有出现互相跳过。

### 4.4 正常 push 不被误拦

- `1af58388`（16:29:58）：`HEAD=1af5838 LAST=28816bf ACTIVE=0` → `need=true`，部署成功。
- `d4ba5572`（17:04:34，本次配置变更本身）：`HEAD=d4ba5572 LAST=331b3410 ACTIVE=0`
  → `need=true`，部署成功（47 秒）。

## 5. 已知边界

- `guard` 只能阻止部署，不能阻止运行创建：重复「运行」仍会出现，但它们几秒内结束，
  `deploy` 作业是 `skipped`，不产生额外部署。
- 若更早的运行最终失败或被取消，本运行已经让路 ⇒ 该 SHA 要等下一次触发。
  15 分钟陈旧窗口保证最多挡住 15 分钟，之后任何触发都能重新部署。
- 判据依赖 GitHub API 的列表一致性；`deploy` 作业的 `concurrency` 是最后一道保险
  （最坏只是排队，不会并发部署）。

## 6. 复查方式

```bash
# 最近的运行与事件
gh api "repos/qweeqw231/macro-news/actions/workflows/pages.yml/runs?per_page=20" \
  --jq '.workflow_runs[] | [.id,.event,.status,.conclusion,.head_sha[0:8],.created_at] | @tsv'

# 最近的部署（按 sha 看是否重复）
gh api "repos/qweeqw231/macro-news/deployments?environment=github-pages&per_page=100" \
  --jq '[.[] | .sha] | group_by(.) | map(select(length>1)) | length'

# 某次运行的 guard 判断
gh api "repos/qweeqw231/macro-news/actions/runs/<run_id>/jobs" \
  --jq '.jobs[] | select(.name=="guard") | .id'
```

guard 日志里会打印一行 `HEAD=… LAST=… ACTIVE=…`，随后是跳过原因。
