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

## 3. 方案选择

| 方案 | 结论 | 理由 |
|---|---|---|
| A. fetch 重试 + 退避 | **采用** | 与 push 侧既有实践一致；SSH-443 的 reset 是瞬时的，重试即可 |
| B. 单次硬超时 | **采用** | 无 deadline 时一次 fetch 可以卡死整档任务（21:24 实测） |
| C. 换备用拉取路径（HTTPS / 镜像） | 不采用 | 需引入凭证或第三方代理，且国内 HTTPS 同样会被 reset；收益不抵复杂度 |
| D. 失败时把告警做得更醒目 | **部分采用** | 但**不能**再靠写 `data/` 来告警——那正是自锁来源；改成本地哨兵 + 日志 + 台账 |

修复后的不变式：**任何对 `data/` 的写，都必须紧跟着一次提交尝试**。
只写不提交的路径一律改成写 `.local/`。

## 4. 实现

新增 `scripts/git-sync-lib.ps1`（被两个 ps1 点源引入，只写 `.local/`）：

- `Invoke-GitWithTimeout`：`Start-Process` + `WaitForExit(ms)`，超时用 `taskkill /T /F` 连 ssh 子进程一起杀。
- `Invoke-GitFetchRetry`：默认 3 次，间隔 5s / 15s，每次硬超时 90s（最坏约 5 分钟，
  仍在 15 分钟档位内）。返回 `{ ok, attempts, error }`，错误文本去掉 PowerShell 装饰行。
- `Write-SyncState`：写 `.local/metrics/sync-state.json`：
  `{ updatedAt, source, result, localFresh, remoteRefStale, remoteRefAt, head, behind, ahead, fetchAttempts, error }`。

`scripts/collect-and-push.ps1`：

| 分支 | 旧行为 | 新行为 |
|---|---|---|
| fetch 失败 | 写 `data/_last-run.json` 后 exit（留下永久脏） | **不写 `data/`**；写哨兵；日志明确「本地不是最新 + origin/main ref 停在 `<sha>(<time>)`」 |
| `dirty-worktree` | 只写台账 | 追加哨兵（`localFresh = behind==0`） |
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
| `localFresh=false` | 本地工作树不含（最近一次成功 fetch 到的）`origin/main`，`data/` 截面不可当收盘基准 |

外部消费方（如 `投资组合研究/daily_update.py`）建议检查顺序：
`data/snapshots/<date>_pm.json` 存在且 gate=ok → 用；
否则读 `.local/metrics/sync-state.json`，`localFresh=false` 就**拒绝**退回 `quotes.json` 当收盘基准，
并把 `result/error/remoteRefStale` 原样写进自己的报告。

## 6. 测试

`tests/collect-sync.test.mjs` 新增静态守卫：

- fetch 重试 / 退避 / 硬超时存在；
- fetch 失败分支不得出现 `Write-LocalSync` 或 `_last-run.json`；
- `Publish-LocalSync` 里「fetch → at-origin → 写盘」的顺序；
- 两脚本都点源 `git-sync-lib.ps1`，且 lib 不写 `data/`；
- `sync-close` 必须用 `git cat-file -e` 探测 `origin/main`，且不得再出现「云端可能尚未生成」。

手工验证（2026-11-16）：

1. `Invoke-GitFetchRetry` 指向不可达 remote：2 次尝试、错误文本干净；
2. 临时把 `remote.origin.url` 改成不可达地址跑 `collect-and-push.ps1 -SyncOnly`：
   3 次重试 + 5s/15s 退避（28.5s 结束），**`git status` 无任何 `data/` 变更**，
   哨兵 `remoteRefStale=true / localFresh=false / fetchAttempts=3`；
3. 真仓库 `git cat-file -e origin/main:data/snapshots/2026-11-16_pm.json` 命中，
   证明「pm 在远端、本地没有」这个场景可以被如实报告。
