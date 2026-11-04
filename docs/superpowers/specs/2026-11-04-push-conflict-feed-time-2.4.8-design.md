# 2.4.8：早报 push 冲突自愈 + 统计局时间重复 +8

日期：2026-11-04
状态：已实施

## 1. 问题 1：11-04 早报 publish 成功但 push 失败

### 现象与取证

- `data/_briefing-status.json`：`status=done / source=ai`，最终 `pushed=true`（09:07:14）。
- `git reflog`（2026-11-04）：
```
09:02:56 commit c0486be data: 早报入库 2026-11-04
09:04:15 rebase (start): checkout origin/main
09:04:15 rebase (abort): returning to refs/heads/main
09:05:45 rebase (start): checkout origin/main
09:06:40 rebase (continue): data: 早报入库 2026-11-04
09:07:14 commit 8113578 data: 记录早报入库 2026-11-04
```
- `git merge-tree f5ec11b 4244658 c0486be` 证明唯一冲突在 `data/index.json`：
```
changed in both
  base  ... data/index.json
  our   ... data/index.json
  their ... data/index.json
+<<<<<<< .our
         "count": 345,
         "hasBriefing": false
```
  即 08:53 的采集提交把 11-04 `count` 改成 345，09:02 的发布提交把同一天
  `hasBriefing` 改成 true，两边改同一个 JSON 块 ⇒ rebase 冲突、abort、返回失败。
- **原始错误文本未被持久化**：失败后状态文件被 09:07 的成功重试覆盖，`pushError`
  为空。按 git 标准行为复原为：
```
CONFLICT (content): Merge conflict in data/index.json
error: could not apply c0486be... data: 早报入库 2026-11-04
```
- 兜底已补：09:05 重跑 publish（重新读取归档后 index 计数变为 345）→ 7bb18f7，
  09:07 状态二次提交 8113578；线上 `data/briefings/2026-11-04.json` 200、
  `index.json` 的 `hasBriefing=true`（count 556，后续采集更新）。

### 判定

**结构性**：采集器每 15 分钟提交一次 `data/index.json`，早报 09:02 发布时
必然有概率与同一分钟附近的采集提交撞车；不是凭证/网络问题（fetch 成功、
push 在 09:07 成功）。

### 修复

`scripts/briefing/git-push.mjs`：

1. rebase 失败时检查 `git diff --name-only --diff-filter=U`；
2. 若冲突**只**在 `data/index.json` / `data/history/index.json`：
   - 以远端版本（`:3:`）为底（保留最新 `count` / 历史切片计数）；
   - 把本地版本（`:2:`）中当天的 `hasBriefing` / `briefLine` / `source` 覆盖上去；
   - `git add` → `git rebase --continue` → 继续 push；
3. 其它任何文件冲突：`rebase --abort`，返回 `kind:'conflict'`，不 force、不改历史；
4. 失败分类：`fetch` / `conflict` / `push` / `no-files`，写入状态 `pushErrorKind`。

## 2. 问题 2：统计局 09:30 显示成 17:30

### 逐层证据

| 层 | 值 | 结论 |
|---|---|---|
| 统计局 RSS 原文 | `<pubDate>2026-11-04 09:30:00</pubDate>` | 北京时间、**不带时区** |
| 统计局原文页 | `<meta name="PubDate" content="2026/11/04 09:30">` | 官方确认 09:30 |
| 云端采集进程 | GitHub Actions `TZ=UTC` | `new Date('2026-11-04 09:30:00')` → 09:30Z |
| 归档 JSON | `ts=1793784600`, `time=2026-11-04T09:30:00.000Z` | 比真实晚 8 小时 |
| `latest.json` / `search.json` | 同上 | 索引层未二次转换，继承错误 |
| 前端 | `new Date(time)` → 北京 +8 | 09:30Z → **17:30** |

本机（Asia/Shanghai）解析同一字符串得到 01:30Z（正确），所以这是
**runner 时区差异**，只在云端采集的条目上出现。

### 影响范围（逐条抓原文页核验，46 条统计局记录）

- **+480 分钟（错误）**：13 条，已回填；
- 0 分钟（正确）：25 条；
- **-720 分钟（异常）**：8 条（2026-08 的旧批次），原因不明，**未动**。

### 修复

`src/sources.mjs` 新增 `parseFeedDate(value, tz)`：

- 有 `Z` / `±HH:MM` / `±HHMM` / `GMT` / `UTC` → 原样解析；
- 无时区 → 按来源 `tz` 用 IANA 规则换算（默认 `Asia/Shanghai`）；
- `rssSource` 只用解析后的毫秒生成 `ts` 与 `time`，不再二次 `new Date(raw)`；
- 国家统计局适配器显式 `tz: 'Asia/Shanghai'`。

历史回填：`scripts/repair-nbs-time.mjs`（默认 dry-run，`--apply` 写盘并重建
`index/latest/search`）。只修 `stored - 原文页时间 ≈ +480 分钟（±2 分钟）` 的条目，
保留 RSS 秒；其它差异不动。

## 3. 测试

- `tests/feed-time.test.mjs`（6 项）：无时区按来源时区、UTC 下不偏移、显式时区原样、
  空值安全、回填仅认约 +480 分钟、sources 接线锁定。
- `tests/briefing-push.test.mjs` 新增 3 项：index 冲突自动合并（计数取远端、
  早报字段取本地）、非派生冲突中止、`pushErrorKind` 接线。
- 全套 **160 项**通过。

## 4. 没有修的部分

1. 8 条 **-720 分钟**的统计局旧记录：原文页与 RSS 时间本身不一致，无法判断哪个正确，
   保持原样。
2. 其它来源未做逐条页面核验：中新网 / 美联储 / ECB 的 `pubDate` 都带显式时区，
   本次只验证了格式，未回填。
3. 11-04 首次失败的原始 `pushError` 文本已丢失（被成功重试覆盖），只能由
   reflog + `merge-tree` 复原冲突位置与标准报错。
