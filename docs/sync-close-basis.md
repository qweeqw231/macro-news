# 收盘基准 `closeBasis` 字段说明

> 面向**外部消费方**（如 dsh 的收盘复盘脚本）：照这份文档就能自己改判定，不需要本仓库改消费端代码。
> 版本：3.2.0（2026-11-25 起）· 文件：[scripts/git-sync-lib.ps1](../scripts/git-sync-lib.ps1) 的 `Resolve-CloseBasis`

## 0. 它解决什么问题

同步层过去只有两个布尔值：`localFresh`（本地是否最新）和 `remoteRefStale`（本轮 fetch 是否失败）。
这两个值混在一起描述了两件**互相独立**的事：

- 「这台机器有没有把 git 同步到最新」
- 「今天有没有可用的收盘快照」

结果是 11-24 / 11-25 / 11-26 连续三天，出口到 GitHub 443 间歇性 reset ⇒ `fetch` 失败 ⇒
`result=skipped:fetch-failed` + `localFresh=false` ⇒ 下游把当天所有数字标成「估（本地未同步）」，
**而实际上当天的 `data/snapshots/<date>_pm.json` 早就合格地躺在本地工作树里**。

3.2.0 起新增 `closeBasis`：它只回答一件事——**今天这份复盘该拿哪份数据当收盘基准、它有多可信**。
git 同步状态与收盘数据可用性从此分开表达。

## 1. 读取位置与写入者

| 项 | 值 |
|---|---|
| 文件 | `<repo>/.local/metrics/sync-state.json`（`.local/` 已 gitignore，不入库、不随仓库分发） |
| 写入者 | `scripts/sync-close.ps1`（每个交易日 16:18 / 16:33 / 16:48）与 `scripts/collect-and-push.ps1`（每 2 小时及休眠补跑） |
| 写入语义 | 每次运行**整体覆盖**。后写的覆盖先写的，所以 17:54 的采集轮会覆盖 16:48 的 sync-close 结论 |
| 台账 | `.local/metrics/close-sync.jsonl`（仅 sync-close 追加，逐轮一行，用于回溯） |

注意：`sync-state.json` 是**本机状态**，不在 git 里。跨机消费需要各自的本机同步层，或直接读 `data/`。

## 2. 顶层字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `updatedAt` | ISO8601Z | 本文件最后一次写入时刻 |
| `source` | string | 写入者（`sync-close.ps1` / `collect-and-push.ps1`） |
| `result` | string | 本轮同步结果：`synced` / `up-to-date` / `skipped-dirty` / `skipped-local-ahead` / `fetch-failed` … |
| `localFresh` | bool | **3.2.0 起严格等价 `closeBasis.tier == 'local-pm'`**，不再表示「git 已同步」 |
| `remoteRefStale` | bool | 本轮 fetch 是否失败 ⇒ 本地 `origin/main` ref 不是远端最新。**与收盘数据可用性无关** |
| `remoteRefAt` | ISO8601Z | `origin/main` ref 最后一次刷新成功（即最后一次 fetch 成功）的时刻 |
| `head` / `behind` / `ahead` | string / int / int | 本地 HEAD 与相对 `origin/main` 的落后/领先提交数（fetch 失败时 `behind/ahead` 为 `null`） |
| `fetchAttempts` | int | 本轮 fetch 尝试次数 |
| `error` | string | fetch 失败原文（成功时为空） |
| `dirtyPaths` | string[] | 工作树未提交改动的受控文件（只记录，不参与收盘判定） |
| `pm` | object | 当天 pm 体检结果（见 §3.1） |
| `closeBasis` | object | 收盘基准裁决（见 §3.2）——**消费方只需要读这一块** |

> **不要再用** `ok = localFresh && !remoteRefStale` 作为可用性判据。
> `remoteRefStale=true` 只说明「这台机器这次没连上 git」，不说明「没有收盘数据」。
> 11-25、11-26 两天的误报都出自这一条。

## 3. 字段详解

### 3.1 `pm`（当天快照体检，原始观测值）

| 字段 | 含义 |
|---|---|
| `date` | 被体检的日期（`yyyy-MM-dd`） |
| `available` | 本地工作树是否有 `data/snapshots/<date>_pm.json` |
| `capturedAt` | 本地 pm 的 `capturedAt`（北京时间带偏移） |
| `gate` | 本地 pm 门禁：`ok` / `pending` / `unreadable` |
| `inRemote` | `origin/main` 的**本地 ref** 里是否有该文件（fetch 失败时该 ref 是旧的） |
| `remoteCapturedAt` / `remoteGate` | 远端 blob 的 `capturedAt` 与门禁（读不到时为 `unreadable`） |
| `drift` | 本地 pm 与本地 `origin/main` ref 中的同名文件是否内容不同 |

**门禁 `ok` 的三个条件**（本地与远端一视同仁）：

1. `doc.date == <date>`
2. `doc.isTradingDay === true`
3. `capturedAt` 的时:分 ≥ `16:10`（计划任务 16:18/16:33/16:48 的起点；早于 16:10 的快照一律 `pending`）

### 3.2 `closeBasis`（收盘基准裁决结果）

| 字段 | 含义 |
|---|---|
| `date` | 裁决针对的交易日 |
| `tier` | **档位**，五档之一（§4） |
| `usable` | 是否可作为当天收盘基准 |
| `partial` | 是否为「部分腿是盘中值」的降级数据（仅 `quotes` 为 true） |
| `stale` | 数据本身合格，但取数通道不可信、可能滞后（仅 `origin-main-stale` 为 true） |
| `source` | 数据来源：`worktree` / `ref:origin/main` / `https:raw.githubusercontent.com` / `worktree:data/quotes.json` |
| `path` | **实际文件绝对路径**——消费方直接读它，不必自己 `git show` 或拼路径 |
| `ref` | 若取自 ref，给出 `origin/main:data/snapshots/<date>_pm.json`；否则为空 |
| `capturedAt` | 该基准的采集时刻（`quotes` 档为空，见 `quotesGeneratedAt`） |
| `gate` | 该基准的门禁结果 |
| `fetchedAt` | 走 HTTPS 反通道时的取回时刻（仅 `http-raw`） |
| `refAt` / `refHead` | 本地 `origin/main` ref 的提交时间与短哈希，用于判断 ref 有多旧 |
| `quotesGeneratedAt` | 退回 `quotes` 时该 quotes 的 `generatedAt`（仅 `quotes`） |
| `reason` | 中文裁决理由，可直接展示给用户 |

## 4. 五档 `tier`

按优先级从上到下，**命中即止**：

| # | `tier` | 判定条件 | `usable` | `partial` | `stale` | `path` 指向 | 建议标注 |
|---|---|---|---|---|---|---|---|
| 1 | `local-pm` | 本地 pm 存在 + `gate=ok` + 无未提交改动 + 与 `origin/main` ref 无漂移 | true | false | false | 工作树原文件 | **收盘** |
| 2 | `origin-main` | fetch 成功，但本地缺/不合格；远端 ref 里当天 pm 过门禁 | true | false | false | `.local/cache/snapshots/<date>_pm.json` | 收盘（取自 origin/main） |
| 3 | `http-raw` | fetch 失败；`raw.githubusercontent.com` 取到当天 pm 且过同一门禁 | true | false | false | `.local/cache/snapshots/<date>_pm.json` | 收盘（fetch 失败，走 raw 回退） |
| 4 | `origin-main-stale` | fetch 与反通道都失败；本地**旧** ref 里有当天 pm 且过门禁 | true | false | **true** | `.local/cache/snapshots/<date>_pm.json` | 收盘（基准截至 `refAt`，可能滞后） |
| 5 | `quotes` | 当天 pm 在本地/ref/反通道都不可得 | **false** | **true** | false | `data/quotes.json` | **估**（收盘口径缺失；港股/黄金腿可能是盘中值） |
| — | `unavailable` | 连 `data/quotes.json` 也没有 | false | false | false | （空） | 不可用 |

要点：

- 第 3 档是「fetch 失败」的**确定性恢复路径**。它不依赖 git，也不写 `data/`，只把内容缓存到 `.local/cache/`。
- 第 4 档只在「反通道也不通」时出现，且一定会带 `stale=true` 与 `refAt`——消费方必须把这个陈旧度标出来。
- 第 5 档的 `partial=true` 表示「不是收盘口径」，不是「数据坏了」。当天 A 股 15:00 已收盘，但港股 16:00、上海金 15:30 的腿会停在 quotes 的生成时刻。
- 任何档位都不会修改 `data/`：裁决是只读的。

## 5. 消费方推荐判定（可直接照抄）

```python
state = json.load(open(f"{repo}/.local/metrics/sync-state.json", encoding="utf-8"))
cb = state.get("closeBasis") or {}
tier = cb.get("tier", "unavailable")

if cb.get("usable"):
    pm_path = cb["path"]                      # 直接读，不要自己拼 data/snapshots
    basis_note = {
        "local-pm":          "收盘",
        "origin-main":       "收盘（取自 origin/main）",
        "http-raw":          "收盘（fetch 失败，已走 raw 回退）",
        "origin-main-stale": f"收盘（基准截至 {cb.get('refAt','?')}，可能滞后）",
    }[tier]
elif tier == "quotes":
    pm_path = cb["path"]                      # data/quotes.json
    basis_note = f"估（收盘口径缺失，quotes@{cb.get('quotesGeneratedAt','?')}）"
else:
    pm_path, basis_note = None, "不可用"
```

报告里只需带两样东西：**`tier`** 与 **`capturedAt`（或 `refAt`/`quotesGeneratedAt`）**。
`result` / `remoteRefStale` 属于运维信息，不应进入数据质量标注。

## 6. 已知限制

1. **同一个出口的间歇性 reset（连续三天）**
   `20.205.243.160:443` 上，`ssh.github.com`（SSH-over-443）与 `github.com`（HTTPS）**同一 IP:port 同时被掐**，
   而 `raw.githubusercontent.com`（不同边缘路径）正常。实测：

   | 时间 | 事件 |
   |---|---|
   | 2026-11-24 | 17:00 轮 `ssh: connect ... Connection timed out` |
   | 2026-11-25 21:34 | `ssh ... Software caused connection abort` |
   | 2026-11-25 21:57 / 22:54 | `Connection reset by 20.205.243.160 port 443`，**紧接着重试即成功** |
   | 2026-11-26 16:48 | 两次尝试均 `Connection reset by 20.205.243.160 port 443`；17:54 轮一次成功 |

   因此：**单次 fetch 失败不等于通道坏了，也不等于当天没有收盘数据**。同步层已内置「重试 2 次 + 退避」，
   失败后再走五档降级。把 fetch 失败当故障升级、或据此给数据打「未同步」标签，都会误报。

2. **fetch 失败时 `drift` 只能对旧的 ref**
   此时第 1 档仍可能落在 `local-pm`，含义是「本地 pm 合格，但它与远端最新是否一致本轮**未验证**」。
   组合 `tier=local-pm` + `remoteRefStale=true` 就表示这种情况，`refAt`/`refHead` 给出比对的基准。

3. **`pmRemoteGate` 可能是 `unreadable`**
   本地 ref 能确认文件存在、但读取 blob 失败（管道/分页器吞输出等）。此时不影响第 1 档，只是无法给出远端一致性。

4. **`http-raw` 是只读通道**
   它只能取文件，不能用于 push；且依赖 `raw.githubusercontent.com` 可用（实测 ~1.25 s / 28 KB）。
   它解决的是「读收盘数据」，不是「推送」。

5. **`.local/cache/` 不是归档**
   每次裁决都会重写同名副本，带 `.meta.json`（sha256 / fetchedAt / refHead / refAt）。
   需要长期留存请读 `data/snapshots/`，那才是唯一权威。

6. **裁决是时点快照**
   `sync-state.json` 会被后续轮次覆盖。要复现某一轮结论，请看 `close-sync.jsonl`
   （sync-close 逐轮追加，含完整 `closeBasis` 与 `syncError`）。

## 7. 现场核对：2026-11-26（本地 pm 合格 + fetch 失败）

16:48 轮实测 `.local/logs/sync-close-20261126.log`：

```text
[2026-11-26 16:48:21] sync: fetch 第 1/2 次失败（20s）：Connection reset by 20.205.243.160 port 443 | fatal: Could not read from remote repository.
[2026-11-26 16:48:48] sync: fetch 第 2/2 次失败（22s）：Connection reset by 20.205.243.160 port 443 | fatal: Could not read from remote repository.
[2026-11-26 16:48:48] git fetch 失败（已重试 2 次）：...
[2026-11-26 16:48:48] ⚠ 本地工作树与本地 origin/main ref 都不是远端最新；本轮按五档降级裁决当天收盘基准
[2026-11-26 16:48:48] pm：2026-11-26 已到本地 · capturedAt=2026-11-26T16:14:20+08:00 · gate=ok · localFresh=True
[2026-11-26 16:48:48] closeBasis: tier=local-pm usable=True partial=False stale=False capturedAt=2026-11-26T16:14:20+08:00
```

同轮台账 `.local/metrics/close-sync.jsonl`：

```json
{"at":"2026-11-26T08:48:48Z","result":"fetch-failed","fetchAttempts":2,
 "syncError":"Connection reset by 20.205.243.160 port 443 | fatal: Could not read from remote repository.",
 "pmExists":true,"pmGate":"ok","localFresh":true,
 "closeBasis":{"tier":"local-pm","usable":true,"partial":false,"stale":false,
               "path":"...\\data\\snapshots\\2026-11-26_pm.json",
               "capturedAt":"2026-11-26T16:14:20+08:00","refAt":"2026-11-26T08:23:25Z","refHead":"796ffb52"}}
```

复现命令（把 fetch 结论强制置为失败，观察裁决）：

```powershell
. .\scripts\git-sync-lib.ps1
$r = (Get-Location).Path
$pm = Get-PmSnapshotState -Root $r -Date '2026-11-26'
Resolve-CloseBasis -Root $r -Date '2026-11-26' -FetchOk $false -PmState $pm | ConvertTo-Json -Depth 4
```

结果：`tier=local-pm`、`usable=true`、`path` 指向工作树里的当天 pm（`coverage 76/76`、`capturedAt 16:14:20`）。
即**降级链在「fetch 失败但本地 pm 合格」时确实保住了收盘口径**，当天 17:00 复盘不必退回 quotes。

## 8. 变更历史

| 版本 | 日期 | 变更 |
|---|---|---|
| 3.2.0 | 2026-11-25 | 引入 `closeBasis` 五档降级；`localFresh` 收敛为 `tier=='local-pm'`；fetch 失败不再直接放弃；sync-close 加单实例锁 |
