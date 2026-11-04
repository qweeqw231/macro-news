# 2.4.15 · K 线写盘锁（按标的一把锁）

日期：2026-11-05　状态：实施中　版本：补丁位（2.4.15）

## 1. 目标

对 `data/kline/` 的写入增加**同一文件系统内**的按标的互斥：同一个 `<key>` 同一时刻只允许
一个进程做「读旧文件 → 合并 → 写盘」。拿不到锁就跳过本轮并记录，不等待、不强写。

锁只包住**本地读写**，不包网络抓取；持锁时间通常 <1 秒，避免长任务把锁占死。

## 2. 锁的格式与行为

- 路径：`.cache/locks/kline-<key>.lock`（`.cache/` 已在 `.gitignore`）。
- 内容：`{key, pid, host, at, token}`。
- 获取：`open(path, 'wx')` 原子创建；已存在则读取 `mtime`。
- 超时：默认 **5 分钟**（`KLINE_LOCK_STALE_MS` 可覆盖）。
- 陈旧接管：`mtime` 超过阈值时，先 `rename` 到唯一临时名再删除；`rename` 原子，
  只有一个进程能成功，失败者重新尝试 `wx`。
- 释放：只删除 token 与文件内容一致的锁；若已被接管，旧进程不会误删新锁。
- 拿不到锁：`withKlineLock` 返回 `{ok:false, skipped:true, lock}`，调用方打印
  `⏭ <key> 跳过：写锁被占用（pid…，已持有 …s）`，然后 `continue`。
- 退出码：锁占用算“跳过”，不算失败；不改变各脚本原有成功/失败判定。
- 产物格式：不改。锁文件在 `.cache/`，不进入 `data/`，不产生提交。

## 3. 覆盖范围

| 写入脚本 | 产物 | 锁 key |
|---|---|---|
| `src/collect.mjs` | `<key>.json` / `_1w` / `_1M` | `<key>` |
| `scripts/update-kline-minute.mjs` | `min/<key>_<period>.json` | `<key>` |
| `scripts/update-kline-full.mjs` | `<key>_full.json` | `<key>` |
| `scripts/update-kline-last.mjs` | `<key>.json` 最后 5 根 | `<key>` |
| `scripts/backfill-cgb1y.mjs` | `cgb_1y*.json` | `cgb_1y` |
| `scripts/backfill-macro.mjs` | `cgb_1y*.json` | `cgb_1y` |
| `src/portfolio-collect.mjs` | `cgb_1y*.json` | `cgb_1y` |
| `scripts/repair-sge-volume.mjs` | `sge_au9999*.json` | `sge_au9999` |

`_status.json`（分钟K 的失败明细）是共享状态文件，不按标的，未加锁；它只写诊断信息，
不影响 K 线数据。

## 4. 边界（必须如实说明）

- 本地文件锁只能覆盖**同一文件系统**上的并发：本机计划任务、手动脚本、同一 Actions
  runner 内的进程。**不同 GitHub Actions runner 之间文件系统隔离，锁互不可见**。
- 跨 runner 的写冲突仍由以下机制兜底：
  - 2.4.14 的触发错峰；
  - `scripts/push-data.sh` 的 fetch + rebase 重试（冲突则放弃本轮，不强推）；
  - `kline-guard` 的短序列/成交量保护。
- 锁不改变 `cgb_1y` 的守卫现状：`cgb_1y` 仍是单一源、无 `decideBars`；
  本次锁覆盖它的写入互斥，但不补短序列守卫（成交量恒为 0，不涉及上金所）。

## 5. 实施与测试

1. 新增 `src/kline-lock.mjs`：`acquireKlineLock` / `releaseKlineLock` / `withKlineLock` /
   `lockSkipText` / `klineLockPath`。
2. 八个写入路径接入锁；锁只包读改写，不包 `fetchKline`。
3. `tests/kline-lock.test.mjs`：
   - 并发获取同一把锁只有一个成功；
   - 拿不到锁时返回 skip、不执行回调、文案含“写锁被占用”；
   - 释放后可重新获取；
   - 陈旧锁（mtime 超阈值）可接管，旧持有者释放不删新锁；
   - 静态断言：上述八个脚本都必须引用 `acquireKlineLock` 与 `lockSkipText`。
4. 全套测试保持全绿；锁测试使用系统临时目录，不污染 `.cache/`。

## 6. 本机任务与 `cgb_1y`（如实记录）

- `MacroNews-Collect` **不先 pull 再跑**：本次不处理，只记录为 B 类潜在风险。
  写锁不能解决“旧代码”问题，只能解决同机并发写。
- `cgb_1y` 未接 `kline-guard`：本次锁覆盖其写入互斥，但短序列/成交量守卫仍缺；
  它只有一个中债源、成交量恒 0，风险低于上金所双源。
