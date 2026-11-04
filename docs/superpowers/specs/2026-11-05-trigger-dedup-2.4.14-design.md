# 2.4.14 · 触发去重（Cloudflare 主触发，GitHub 错峰兜底）

日期：2026-11-05　状态：实施中　版本：补丁位（2.4.14）

## 1. 目标与原则

- 每个任务只有一个**主触发方**（Cloudflare Worker Cron）。
- GitHub Actions 的 `schedule` 只做**错峰兜底**，不说明、不与 Cloudflare 同一分钟。
- 所有 workflow 保留 `workflow_dispatch`，Cloudflare 仍可随时手动/定时触发。
- 同一分钟内不再有两个入口写**同一批文件**。

已知事实：GitHub Actions 的 schedule 实际兑现率约 5 次/天，远低于声明频率；
Cloudflare 的 `macro-news-cron` 是当前可靠主触发。

## 2. 改前冲突表

| 任务 | Cloudflare 触发 | GitHub 触发 | 实际冲突 |
|---|---|---|---|
| `kline-minute` | `17,47 * * * *` | `17 * * * *` | **:17 同分钟**；且 CF 04:17 同时 dispatch `kline-full` |
| `kline-full` | 随 `17,47` 的 UTC 04:17 附带 | `23 4 * * *`（04:23） | 与 CF 04:17 相差 6 分钟；04:17 与 `kline-minute` 同分钟写日 K |
| `collect` | `7,22,37,52 * * * *` | `7,22,37,52` + `14,44` | **:07/:22/:37/:52 同分钟** |
| `snapshot` | `13,43 * * * *` | `13,43 * * * *` | **:13/:43 同分钟** |

## 3. 改后触发时刻表

| 任务 | Cloudflare（主） | GitHub（兜底） | 同分钟？ | 偏移 |
|---|---|---|---|---|
| `collect` | `7,22,37,52` | `12,42` | 否 | +5 分钟（见 §4 说明） |
| `snapshot` | `13,43` | `3,33` | 否 | 20 分钟 |
| `kline-minute` | `17,47` | `2`（每小时） | 否 | 15 分钟 |
| `kline-full` | UTC `04:17` | UTC `05:08` | 否 | 51 分钟（见 §4 说明） |

补充：`kline-minute` 内新增“UTC 04 点刷新日/周/月 K”步骤：
- GitHub `04:02`（schedule）执行一次；
- Cloudflare `04:47`（workflow_dispatch 且分钟 ≥40）执行一次；
- Cloudflare `04:17` 不执行（避免与同分钟的 `kline-full` 写同一批日 K）。

`kline-full` 只写 `<key>_full.json`；`kline-minute` 在 04:17 只写分钟快照 + 最后一根日 K。
两者在 04:17 的文件集合不相交，**同一分钟内不再有两个入口写同一批文件**。

## 4. 为什么 collect / full 不用 10~25 分钟

- `collect` 的 CF 主触发是**每 15 分钟**一轮（:07/:22/:37/:52）。任意分钟都落在某一轮的
  ±7.5 分钟内，因此不存在“与所有主轮次都相距 10~25 分钟”的 GitHub 分钟。
  要满足 10~25 只能把 CF 降到每 30 分钟或改 20 分钟网格，会降低新闻新鲜度或需要改 CF 配置，
  本次不做。这里取 `:12/:42`：与所有主轮次不同分钟，同时把 GitHub 兜底降到 2 次/小时，
  减少重复写盘。
- `kline-full` 是 20 个标的的全量抓取，单轮最长 30 分钟；若 GitHub 兜底放在 CF 04:17 后
  10~25 分钟（04:27~04:42），很可能与主触发**并发执行**并写同一个 `_full.json`。
  因此放到 05:08（+51 分钟），保证主触发最坏 30 分钟也已结束。
  这也满足“不同分钟、不同批文件”的核心目标。

## 5. 兜底是否丢失

没有：

| 任务 | 主触发 | 兜底 | 说明 |
|---|---|---|---|
| `collect` | CF 4 次/小时 | GH 2 次/小时 | 兜底频率降低，但保留 |
| `snapshot` | CF 2 次/小时 | GH 2 次/小时 | 保留 |
| `kline-minute` | CF 2 次/小时 | GH 1 次/小时 | 保留 |
| `kline-full` | CF 1 次/天 | GH 1 次/天 | 保留 |
| 日/周/月 K 刷新 | `kline-minute` CF 04:47 | `kline-minute` GH 04:02 | 原在 `kline-full`，现移到 `kline-minute`，仍有两个触发方 |

## 6. 实施

1. `.github/workflows/collect.yml`：`12,42 * * * *`，保留 `workflow_dispatch` 与 push 触发。
2. `.github/workflows/snapshot.yml`：`3,33 * * * *`。
3. `.github/workflows/kline-minute.yml`：`2 * * * *`；`timeout-minutes` 30 → 45；
   新增“UTC 04 点刷新日/周/月 K”步骤（`src/collect.mjs --kline-only`）。
4. `.github/workflows/kline-full.yml`：`8 5 * * *`；删除 `collect.mjs --kline-only` 步骤。
5. Cloudflare `worker/gh-cron/` **不改**：cron 仍是 `7,22,37,52` / `13,43` / `17,47`，
   04:17 仍同时 dispatch 两个 workflow；由上面的文件集合拆分消除同批写盘。
6. README 的触发说明同步更新。

## 7. 验证

新增 `tests/trigger-schedule.test.mjs`（静态断言）：
- 从 workflow 提取 cron，与 CF 的 crons 逐任务比对，**同一任务不得同分钟**；
- `kline-minute` / `snapshot` 的 GH 偏移 ≥10 分钟；
- `kline-full` 的 GH 与 CF 不同小时（且间隔 >45 分钟）；
- 四个 workflow 均保留 `workflow_dispatch`；
- `kline-minute` 含 UTC 04 点日/周/月刷新步骤，`kline-full` 不再含 `collect.mjs --kline-only`。

## 8. 残留风险

- 长任务仍可能**时间上重叠**（不是同一触发分钟）：CF `kline-full` 最坏 30 分钟，
  GH `kline-full` 在 05:08 理论上仍可能碰上主轮次尾部；CF `kline-minute` 在 04:47
  执行日/周/月刷新，若前一轮分钟任务超时，会与下一轮排队。
  这部分由 2.4.15 的写锁（同机）与 `push-data.sh` 的 rebase 兜底，不能完全消除跨 runner 并发。
- 跨 GitHub runner 的并发无法用本地文件锁互斥（见 2.4.15 的边界说明）。
