# 2.23.0 · 本机同步层：fetch 重试 + 失败不留脏工作区

日期：2026-11-16　状态：已实施　版本：中版本（2.23.0）

> 中版本理由：本缺陷让下游 17:00 收盘复盘拿到的是 15:08 的盘中截面（当日 pm 明明已在远端），
> 属于「用户可见的错误数据」，按版本规则走中版本。

## 1. 事故（2026-11-16）

| 时刻（北京） | 事件 |
|---|---|
| 15:54:11 | `MacroNews-Collect` 起跑 |
| 15:57:09 | `git fetch` 被 peer reset（耗时 178s），本轮 `skipped:fetch-failed` |
| 16:18 / 16:33 / 16:48 | `sync-close` 三次 ff-only 全部失败：「local changes would be overwritten」 |
| 17:00 | 下游收盘复盘只读本地文件，拿不到当日 pm |
| 17:54 / 19:54 | 采集继续被 `dirty-worktree` 跳过（dirty: `data/_last-run.json`） |

远端 `origin/main` 当时已有 `data/snapshots/2026-11-16_pm.json`
（capturedAt `2026-11-16T16:14:12+08:00`、coverage 76/76），本地却因自锁拿不到。

`logs/collect-20261116.log` 原文：

```
sync: head=56279d0c behind=unknown ahead=unknown dirty=no result=skipped:fetch-failed
      head_after=56279d0c stash=none（git.exe : Read from remote host ssh.github.com: Connection reset by peer）
```

上一次同签名失败：2026-11-11 11:54:53（`Connection reset by 20.205.243.160 port 443`）。
台账 137 轮里 `fetch-failed` 共 2 次（约 1.5%），是**低频突发网络重置**，不是凭证 / GitHub 拒绝 / DNS。

## 2. 三层根因

1. **触发**：origin 走 `url.ssh://git@ssh.github.com:443/.insteadOf=https://github.com/`，
   SSH-443 通道会被随机 reset；push 侧早有 6 次重试，fetch 侧只有一次。
2. **放大器（真正的可靠性缺陷）**：fetch 失败分支调用 `Write-LocalSync`，
   把 `data/_last-run.json` 的 `localSync` 块写进**受版本控制的文件**后直接 `exit 0` ——
   既不提交也不回滚。工作区从此永久变脏，之后每一轮都被 `dirty-worktree` 判据挡下，
   连 `sync-close` 的只读 ff-only 都失败。一次网络抖动 = 3 小时以上断档，且无法自愈。
   `Publish-LocalSync` 同样是「先写盘、后 fetch/后判 at-origin」，是同一类自锁。
3. **掩盖**：`sync-close` 只查本地工作树，ff 被挡住时把「本地没同步」写成
   「云端可能尚未生成」——消费方拿到的是一个错误归因，无从判断本地已陈旧。
   dirty 轮按规则不写 `data/`，`consecutiveSkips` 停在 1，页脚也不会升级告警。

补充证据：2026-11-16 21:24 复测时，`git fetch` 在 `ConnectTimeout=15 / ServerAlive*`
生效的前提下仍卡了 6 分钟以上 —— 这两个 SSH 选项只约束建连与会话保活，**不构成整体 deadline**。
进一步实测发现同一通道有两种形态：有时 90 秒只下来 2~3 MB（被限速，但一直在动），
有时整 90 秒一个字节都不动（真停滞）。因此**固定总超时会误杀前者**，必须以「有无数据增长」为判据。

## 3. 方案选择

| 方案 | 结论 | 理由 |
|---|---|---|
| A. fetch 重试 + 退避 | **采用** | 与 push 侧既有实践一致；SSH-443 的 reset 是瞬时的，重试即可 |
| B. 单次固定总超时 | 不采用 | 实测「慢但在动」（2~3 MB/90s）与「真停滞」都会触发，会误杀大包拉取 |
| B'. 单次停滞检测 | **采用** | 持续 120s 无进展才中止；慢速大包只要在动就让它跑完（单次绝对上限 10 分钟） |
| C. 换备用拉取路径（HTTPS / 镜像） | 不采用 | 需引入凭证或第三方代理，且国内 HTTPS 同样会被 reset；收益不抵复杂度 |
| D. 失败时把告警做得更醒目 | **部分采用** | 但**不能**再靠写 `data/` 来告警——那正是自锁来源；改成本地哨兵 + 日志 + 台账 |

修复后的不变式：**任何对 `data/` 的写，都必须紧跟着一次提交尝试**。
只写不提交的路径一律改成写 `.local/`。

## 3.5 补丁 2.23.1：behind 的测量时点与 pm 可用性解耦

2026-11-17 的哨兵出现 `result=synced` + `localFresh=false` + `behind=1` 的自相矛盾。
根因不是语义，是**测量时点**：`behind` 在 `git merge --ff-only` 之前算，ff 成功后没有重算；
`localFresh = (behind -eq 0)` 与写入的 `head` 都用了同步前的值。
`collect-and-push.ps1` 同病（合并后用旧 behind，`localFresh` 直接写 true）。

> **口径更新（2.28.1 / 2026-11-20）**：本节「保持 `behind==0` 严格定义」的结论已被 §3.6 取代 ——
> `localFresh` 现按「当天 pm 收盘基准可用」判定。下文保留为当时的推理记录，不要按它实现。

判据选择（结论）：**保持 `localFresh` 的严格定义**（本地工作树是否已与最近一次成功 fetch 的
`origin/main` 对齐，即重算后的 `behind == 0`），**不**把它改成「当天 pm 可用」。
理由：这两件事的失效原因完全不同 ——
前者是「仓库内容落后」，后者是「快照有没有生成/合格」。用一个字段同时表达，会让
「落后但 pm 可用」被粉饰成健康（正是把门放宽），也会让「不落后但 pm 缺失」被误判成同步故障。
因此只修测量时点，并把 pm 可用性做成独立的 `pm.{date,available,capturedAt,gate,inRemote}`。

补充：`pm(remote)` 探测改用 `git --no-pager cat-file blob`。旧写法 `git show ... | Out-String`
一旦触发分页器，管道会拿到空串，台账因此出现 `pmInRemote=true` + `pmRemoteGate=unreadable`。

## 4. 实现

新增 `scripts/git-sync-lib.ps1`（被两个 ps1 点源引入，只写 `.local/`）：

- `Invoke-GitWithTimeout`：直接构造 .NET `Process`（**不用 `Start-Process`**）+ 异步读 stdout/stderr，
  以 `WaitForExit(5000)` 轮询；以 `tmp_pack_*` 字节数为进度信号，**持续 180s 不增长**才判定停滞，
  绝对上限 10 分钟；超时用 `taskkill /T /F` 连 ssh 子进程一起杀（避免孤儿连接占着通道）。
  两个实测坑都写进了注释：① `Start-Process -PassThru` 在 PS 5.1 下 `$p.ExitCode` 恒为空，
  会把「fetch 成功」判成失败（21:54 那轮就因此白让路了一整轮）；② 用进程 CPU 时间做进度信号无效，
  父进程的毫秒级 tick 会不断重置停滞计时器。
- `Invoke-GitFetchRetry`：默认 3 次，间隔 5s / 15s（`sync-close` 用 2 次，保证能塞进 16:18→16:33 的档位）；
  顺手清掉超过 1 天的 `tmp_pack_*` 残骸。返回 `{ ok, attempts, error, bytes, elapsedSec }`，
  错误文本去掉 PowerShell 装饰行。
- `Write-SyncState`：写 `.local/metrics/sync-state.json`：
  `{ updatedAt, source, result, localFresh, remoteRefStale, remoteRefAt, head, behind, ahead, fetchAttempts, error }`。

`scripts/collect-and-push.ps1`：

| 分支 | 旧行为 | 新行为 |
|---|---|---|
| fetch 失败 | 写 `data/_last-run.json` 后 exit（留下永久脏） | **不写 `data/`**；写哨兵；日志明确「本地不是最新 + origin/main ref 停在 `<sha>(<time>)`」 |
| `dirty-worktree` | 只写台账 | 追加哨兵（`localFresh = behind==0`；2.28.1 起改按当天 pm 基准，见 §3.6） |
| 其它 `skipped:*` | `Publish-LocalSync` 先写后判 | 先 fetch → at-origin → 未合并则直接不写 → 才写 → 提交 → 推送 |
| 同步成功 | 写 `localSync` | 同左 + 哨兵 `localFresh=true`、刷新 `remoteRefAt` |

台账新增 `fetchAttempts`、`syncError`（只增字段，不改既有字段）。

`scripts/sync-close.ps1`：

- fetch 走同一套重试 / 硬超时；
- 新增只读探测 `git cat-file -e origin/main:data/snapshots/<date>_pm.json`
  并把 `pmInRemote / pmRemoteCapturedAt / pmRemoteGate` 写进 `close-sync.jsonl`；
- 本地缺 pm 但远端有 → 明说「本地不是最新（behind/ahead/result）+ 可用行号里那条 `git show` 取」；
  两端都没有才说「云端尚未生成或尚未提交」；
- 结束时写同一份哨兵。

## 5. 消费端能据此判断什么

`origin/main` 是**本地 ref**，`git fetch` 失败时它本身也是旧的 —— 读它**不等于**拿到远端最新。
因此哨兵里的 `remoteRefStale` 是关键字段：

| 字段 | true 的含义 |
|---|---|
| `remoteRefStale` | 本轮 fetch 失败，`.git/refs/remotes/origin/main` 未刷新，不能当远端现状 |
| `localFresh=false` | **2.28.1 前**：本地工作树不含（最近一次成功 fetch 到的）`origin/main`，`data/` 截面不可当收盘基准；**2.28.1 起**：当天 pm 收盘基准不可用（判据见 §3.6） |

外部消费方（如 `投资组合研究/daily_update.py`）建议检查顺序：
`data/snapshots/<date>_pm.json` 存在且 gate=ok → 用；
否则读 `.local/metrics/sync-state.json`，`localFresh=false` 就**拒绝**退回 `quotes.json` 当收盘基准，
并把 `result/error/remoteRefStale` 原样写进自己的报告。

## 6. 测试

`tests/collect-sync.test.mjs` 新增静态守卫：

- fetch 重试 / 退避 / **停滞检测**（`StallSeconds`、`tmp_pack_`）存在，且没有再退回固定总超时；
- fetch 失败分支不得出现 `Write-LocalSync` 或 `_last-run.json`；
- `Publish-LocalSync` 里「fetch → at-origin → 写盘」的顺序；
- 两脚本都点源 `git-sync-lib.ps1`，且 lib 不写 `data/`；
- `sync-close` 必须用 `git cat-file -e` 探测 `origin/main`，且不得再出现「云端可能尚未生成」。

`tests/local-sync.test.mjs` 同步更新：`Write-LocalSync 'skipped:fetch-failed'` 必须不存在。

手工验证（2026-11-16 夜间，真实环境 + 故障环境）：

1. `Invoke-GitFetchRetry` 指向不可达 remote（`ssh://git@127.0.0.1:1`）：2 次尝试、1s 退避，错误文本干净无 PowerShell 装饰；
2. 临时把 `remote.origin.url` 指向不可达地址跑 `collect-and-push.ps1 -SyncOnly`：
   3 次重试 + 5s/15s 退避（27.5s 结束），**`git status` 无任何 `data/` 变更**，
   哨兵 `remoteRefStale=true / localFresh=false / fetchAttempts=3`，日志明确写出
   「本地 origin/main ref 停在 cd123dfe（2026-11-16T11:53:15Z），也不能代表远端现状」；
3. 真仓库 `git cat-file -e origin/main:data/snapshots/2026-11-16_pm.json` 命中
   （capturedAt `2026-11-16T16:14:12+08:00`、`isTradingDay=true`），本地无该文件 ——
   「pm 在远端、本地没有」这个事故场景现在能被如实报告出来；
4. 真实弱网下的形态记录：一次 fetch 在 281s 后被 reset，期间 stderr 一直在输出
   `remote: Counting objects` 进度（说明是限速/饿死，不是纯挂死）；另一次 71s 收下 17 MB
   后被旧的 60s 固定判据误杀 —— 这两条直接促成了「停滞检测」取代「固定总超时」。
5. 21:54 的定时采集在真实弱网下跑了一遍新逻辑：fetch 实际成功并更新了 `origin/main`，
   却因为 `Start-Process` 的退出码恒为空被判成 `skipped:fetch-failed` —— 这一条促成了
   改用 .NET `Process` 直读 ExitCode。修正后同一仓库同一网络下 fetch 1 次 6s 返回 `ok=True`。

## 3.6 补丁 2.28.1：脏判定与新鲜度判定收敛到「当天收盘基准」

2026-11-18~20 连续多天 17:00 收盘同步都以 `result=skipped-dirty` 跳过，`localFresh=false`，
而当天 pm（16:14:40 / gate=ok / 76 键）早就在本地。下游只能退回 `quotes.json` 并标「估（本地未同步）」。

### 根因

1. **让路判据是全树**：`git status --porcelain --untracked-files=no` 把并行开发会话的
   `.github/workflows/diag-stats.yml`、`src/collect.mjs`、`tests/pbc-fetch.test.mjs`、`CHANGELOG.md`、
   `scripts/briefing/pipeline.mjs`，以及早报线持续改写的 `data/_briefing-status.json`、
   `data/history/index.json`、`data/index.json` 全算成脏。
2. **云端每 15 分钟提交「采集 6 件套」**（`_last-run / archive/<day> / index / latest / quotes / search`），
   其中 `data/index.json` 长期是脏的 ⇒ `git merge --ff-only` 必然报
   "Your local changes to the following files would be overwritten by merge"，于是每天 skipped-dirty。
   已用临时 worktree 复现：把 `_briefing-status.json` + `history/index.json` 弄脏后 ff 到 16:48 那个
   落后提交**能成功**，说明这两个不是今天的阻断者，真正阻断的是采集 6 件套里的脏文件（`data/index.json`）。
3. **告警无诊断**：旧实现只把 git 报错的**第一行**写进日志，事后无法知道被哪个文件挡住。

### 判据（结论）

`localFresh` 改为「**当天收盘基准可用**」，而不是「整树 behind==0」：

```
localFresh = pm.exists && pm.gate == 'ok' && !pm.dirty && !pm.drift
```

- `pm` 指 `data/snapshots/<date>_pm.json`（下游 17:00 真正消费的文件）；
- `dirty` = 该文件有未提交改动；`drift` = 该文件落后 `origin/main`；
- gate 口径沿用下游：date 匹配、`isTradingDay`、`capturedAt >= 16:10`。

让路判据同步收敛到 `data/snapshots`（`CloseBasisPaths`）：只有快照本体脏才跳过。

**为什么不算放宽核心保证**：
- pm 缺失时下游才退回 `quotes.json`，而那时 `pm.exists=false` ⇒ `localFresh=false`，保护伞仍在；
- pm 被本地改动（dirty）或远端重新生成（drift）⇒ 仍为 false；
- fetch 失败 ⇒ `localFresh=false` 且 `remoteRefStale=true`；
- 被忽略的只是「与收盘数字无关」的脏：源码/测试/工作流/早报索引。它们的落后由 `behind/ahead`
  与 `dirtyPaths` 如实记录，只是不再冒充「本地快照不可用」。

### 实现

- `git-sync-lib.ps1`：新增 `$script:CloseBasisPaths`、`Get-GitDirtyPaths -Pathspec`、
  `Get-CloseBasisDirtyPaths`、`Get-PmSnapshotState`（本地文件 + `origin/main` 对象 + dirty/drift）。
  pm 探测继续用 `git --no-pager cat-file blob`（`git show` 会走分页器拿到空串）。
- `sync-close.ps1`：门禁按 `data/snapshots`；ff 失败时解析**完整**阻断清单，写日志与台账
  （`dirtyBlocking`），并按是否命中 `data/snapshots` 区分 `skipped-dirty` / `skipped-dirty-unrelated`。
- `collect-and-push.ps1`：同样的门禁与 `localFresh` 判据；fetch 失败时 `pm` 子对象沿用上一轮值，
  不拿空值冒充「云端没有」。
- 哨兵新增 `consumedDirty`（快照目录脏清单）、`pm.drift`、`dirtyPaths`（全树诊断，≤20 条）。
- 判定口径变更写进 `CHANGELOG.md` 2.28.1 与 README 中英。

### 验收（真实网络 + 临时 worktree）

| 场景 | result | behind | localFresh | pm.available |
|---|---|---|---|---|
| 无关脏（`index.json` + `history/index.json`）挡住 ff | `skipped-dirty-unrelated` | 21 | **true** | true |
| `data/snapshots/<day>_pm.json` 改一个字节 | `skipped-dirty` | 21 | false | true |
| 干净且落后 21 个提交 | `synced` | 0 | true | true |
| 本地提交改写 pm（drift） | `skipped-local-ahead` | 0 | false | true |
| origin 不可达 | `fetch-failed` | null | false | — |
| 真仓库（改完后） | `synced` | 0 | true | true |

## 3.7 补丁 3.2.0：把「拿不到 git」与「拿不到当天收盘」分开

### 根因（2026-11-25）

两个独立故障叠加：

1. **本机休眠错过收盘同步窗口。** 11-24 的采集按 01:54…23:54 每 2 小时运行；11-25 的 15:54 / 17:54 /
   19:54 三轮日志整段缺失，三个 `MacroNews-Sync-1618/1633/1648` 任务的 Last Run Time 全部是
   21:34:19、Last Result=1 —— 睡眠唤醒后 Windows 把错过的任务一起补跑，且并发执行。
2. **SSH over 443 在连接阶段被掐断。** 补跑时 `ssh: connect to host ssh.github.com port 443:
   Connection timed out` → `Software caused connection abort`；同机 push 对同一 IP
   `20.205.243.160:443` 也报 `Connection reset`（重试后成功）。没有认证 / keepalive / 连接数报错，
   也没有代理配置 ⇒ 属出口到 GitHub 的通道抖动，不是本地 SSH 配置问题。

云端 16:14:26 已生成 `2026-11-25_pm.json` 并提交（`28644ff1`，16:14:34），77 项覆盖 76/76。
所以「16:1x 采集没成功」是误判：云端采集成功，失败的是**本地落地**。事后验证
`https://raw.githubusercontent.com/qweeqw231/macro-news/main/data/snapshots/2026-11-25_pm.json`
1.25s / 28,385 B 可取到，与本地 pm 的 `capturedAt`、`coverage` 完全一致。

### 判据：五档降级（`closeBasis`）

| tier | 触发 | usable | 标注 |
|---|---|---|---|
| `local-pm` | 本地 pm 存在 + gate ok + 无未提交改动 + 不落后 `origin/main` | true | — |
| `origin-main` | 本轮 fetch 成功，但本地没有可用 pm（例如快照目录脏挡住 ff） | true | `ref` |
| `http-raw` | fetch 失败，`raw.githubusercontent.com` 取到当天 pm 且过门禁 | true | `fetchedAt / path` |
| `origin-main-stale` | fetch 与反通道都失败，只能用本地 ref 的 blob | true | `stale=true / refAt` |
| `quotes` | 当天 pm 本地 / ref / 反通道都不可得 | false | `partial=true / quotesGeneratedAt` |

`localFresh` 现在严格等价于 `tier == 'local-pm'`。

### 为什么不算放宽

- 五档里只有 `local-pm` 会给出 `localFresh=true`；其余档位即使 `usable=true`，也必然带
  `stale` 或 `partial` 或来源标注，下游无法把它误当成「本地就是最新」。
- pm 是**按日固化**的文件：只要当天 pm 存在、过门禁、无本地改动，它就等于远端那份内容；
  fetch 失败时它的可用性与本地 ref 新旧无关。旧实现把这两件事绑在一起，才产生假告警。
- `http-raw` 取回的内容仍要过与本地相同的门禁（日期、`isTradingDay`、`capturedAt>=16:10`），
  且只缓存到 `.local/cache/snapshots/`，不写 `data/`、不产生未提交改动。
- `data/snapshots` 脏时 `sync-close` 仍走 `skipped-dirty`，该保证未动。

### 实现

- `git-sync-lib.ps1`：`Resolve-CloseBasis`、`Get-RemotePmViaHttp`；`Write-SyncState` 新增 `closeBasis`。
- `sync-close.ps1`：`Resolve-AndLogBasis` 统一体检 + 裁决；fetch 失败分支先裁决再返回；
  命名互斥量 `MacroNews-SyncClose` 防并发补跑。
- `collect-and-push.ps1`：四处写哨兵全部带 `closeBasis`，`localFresh` 同源判定。
- 下游契约：改用 `closeBasis.date == 今天 && closeBasis.usable`，按 `tier` 标注来源；
  `quotes` 档必须标 `partial`。

### 验收

| 场景 | 期望 tier | 实测 |
|---|---|---|
| 本地 pm 合规 | `local-pm` | PASS |
| fetch 失败 + 本地缺 pm | `http-raw` | PASS（28,385 B，`fetchedAt` 写入缓存 meta） |
| fetch 成功 + 本地缺 pm | `origin-main` | PASS |
| fetch 失败 + 反通道不通 | `origin-main-stale` | PASS（带 `refAt / refHead`） |
| 当天 pm 完全不可得 | `quotes` | PASS（`partial=true`） |
| 本地 pm 有未提交改动 | ≠ `local-pm` | PASS（落到 `origin-main`） |
| 另一实例持锁 | 立即让路 | PASS（`exit 0`） |

复现：`2026-11-25/sync-gate-recurrence/verify-close-basis.ps1`。