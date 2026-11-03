# 2.4.2 · 早报发布即入库（publish --push）

## 1. 问题

2026-11-03 首跑：生成、publish、索引重建都成功，`data/briefings/2026-11-03.json`
与 `.local/briefings/` 都已写入，但文件**未进 git**：

- `publish` 只写文件，不负责提交/推送；
- 本机 `collect-and-push.ps1` 的提交白名单**排除** `data/briefings/`；
- 云端 Actions 看不到本机文件，重建索引时 `hasBriefing` 从 `true` 覆盖回 `false`；
- 线上文件 404，归档页无法展开当日早报。

结论：publish 与 git 入库之间缺少一个明确的负责人。

## 2. 不变式

> `data/index.json` 中 `hasBriefing=true` ⇔ `data/briefings/<day>.json` 存在**且已被 git 跟踪**。

- 由 `tests/briefing-index-invariant.test.mjs` 锁定：逐日检查文件存在 + `git ls-files`；
- 也反向检查「文件已跟踪但索引 false」。

## 3. `publish --push`

发布成功后（`ok=true`，含已有 AI 早报的 `skipped`）执行：

1. `git add --` 只加 4 个路径（存在的）：
   - `data/briefings/<date>.json`
   - `data/index.json`
   - `data/history/index.json`
   - `data/_briefing-status.json`
2. 有暂存内容才 `git commit -m "data: 早报入库 <date>"`；
3. `git fetch origin main`；
4. `git rebase origin/main`；失败 → `git rebase --abort`，记录原因；
5. `git push origin HEAD:main`。

**失败语义**：push/rebase/fetch 失败**不回滚已发布文件**（不 reset / checkout / restore），
只在 `data/_briefing-status.json` 写：

```
pushed: false
pushError: "push 失败：…"
pushAt: ""
```

页脚读到 `done + pushed=false` 时显示 `早报 已发布未入库`（暖棕），悬停显示 `pushError`。
成功时写 `pushed:true, pushAt:<ISO>`。命令退出码仍为 0（发布已成功，避免上层误判重跑写作）。

## 4. 本机采集兜底

`scripts/collect-and-push.ps1` 只放行**今天/昨天**且**已存在**的单个文件：

```powershell
$bp = "data/briefings/$d.json"
if (Test-Path $bp) { $null = git add -- $bp }
```

**禁止** `git add -- data/briefings`（整个目录）。静态测试锁定该写法。
风险：兜底最多延迟 2 小时；publish --push 是主路径。

## 5. 测试

- `tests/briefing-push.test.mjs`（7 项）：白名单、成功顺序、push 失败不回滚、rebase 失败 abort、
  publish 源码接线、采集白名单、页脚文案；
- `tests/briefing-index-invariant.test.mjs`（2 项）：索引 true ⇔ 文件存在且已跟踪，反向检查。

## 6. 验收

- 11-03 线上 `data/briefings/2026-11-03.json` 200；
- 线上 `data/index.json` `hasBriefing=true`（下一次云端 collect 自愈）；
- 归档页出现当日早报并可展开；
- 重跑 `publish --date 2026-11-03` 不覆盖 AI 正文（已有离线测试 + 线上文件哈希不变）。
