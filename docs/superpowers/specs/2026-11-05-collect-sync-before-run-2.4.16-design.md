# 2.4.16 · 本机采集先同步再跑（去掉 `-X ours`）

日期：2026-11-05　状态：实施中　版本：补丁位（2.4.16）

## 1. 目标

`MacroNews-Collect` 现在直接跑本地工作树，提交后用 `merge -X ours` 合并远端。
风险：① 可能跑旧代码；② data 冲突时本地无条件赢。改为：

1. 每次运行**先** `git fetch origin main`，比较 `HEAD` 与 `origin/main`；
2. 落后且干净 → `merge --ff-only`；落后且有已跟踪改动 → stash → ff-only → pop；
3. 去掉所有 `-X ours`；普通 merge 冲突 → `merge --abort` + 记日志 + 跳过本轮；
4. 日志记录 `HEAD` 短哈希、behind/ahead、dirty、同步结果、同步后 HEAD；
5. 启动时自检 `src/kline-lock.mjs` 与 `update-kline-last.mjs` 的 `upsertBars`，
   缺失记 `guard:missing` 但**继续采集**；
6. 保持 wscript + `run-hidden.vbs` 静默宿主。

## 2. 行为表

| 情形 | 动作 | 失败/冲突时 | 是否采集 |
|---|---|---|---|
| fetch 失败 | 记 `fetch-failed` | **跳过本轮**（无法确认版本） | 否 |
| behind=0, ahead=0 | 记 `up-to-date` | — | 是 |
| behind=0, ahead>0 | 记 `ahead`（本地有未推提交） | — | 是 |
| behind>0, ahead=0, 干净 | `merge --ff-only` | 失败 → 记 `ff-only-failed`，跳过 | 是（成功后） |
| behind>0, ahead=0, 有已跟踪改动 | `stash push -- <paths>` → ff-only → `stash pop` | stash/pop 失败或冲突 → **stash 保留**，记 `stash-pop-conflict`，跳过 | 否 |
| behind>0, ahead>0（分叉） | 普通 `merge --no-edit origin/main` | 冲突 → `merge --abort`，记 `merge-conflict`，跳过 | 否 |
| 有未合并文件（上轮 pop 冲突遗留） | 记 `unmerged` | 跳过，等人工处理 | 否 |
| 同步成功 | 记 `ff-only` / `merge` + 同步前后 HEAD | — | 是 |
| guard 检查失败 | 记 `guard:missing` | **继续** | 是 |

**底线**：不出现 `reset --hard`、`checkout --`、`-X ours`、force push；
任何冲突只 abort/保留 stash，不覆盖本地改动。

## 3. 同步实现细节

- fetch：`git fetch origin main`；设置 `GIT_SSH_COMMAND` 的连接/存活超时
  （`ConnectTimeout=15`、`ServerAliveInterval=15`、`ServerAliveCountMax=3`），
  避免 SSH-443 卡死。
- 落后/领先：`git rev-list --count HEAD..origin/main` / `origin/main..HEAD`。
- 已跟踪改动：`git diff --name-only` + `git diff --cached --name-only`（不含未跟踪）。
- stash：`git stash push -m "macro-news sync <时间>" -- <改动路径>`；只暂存已跟踪改动。
- pop 冲突：`git stash pop` 返回非 0 时，stash 默认保留；脚本不再做任何解冲突动作，
  记 `sync:stash-pop-conflict stash=kept` 并跳过本轮。下一轮若检测到未合并文件
  （`git ls-files -u`）直接记 `sync:unmerged` 跳过，避免把冲突标记再次 stash。
- 分叉：普通 merge，冲突则 `git merge --abort`；本地提交保留，不 reset。
- 提交后的远端合并（原 `-X ours`）改为普通 `git merge --no-edit origin/main`；
  冲突 abort + 记日志 + 放弃推送，本地提交保留，下一轮重试（冲突可能需人工处理）。
- 推送重试：fetch + 普通 merge；冲突 abort，不再强推。

## 4. 启动日志

每轮固定写：

```
sync: head=<short> behind=<n> ahead=<n> dirty=<yes|no> result=<up-to-date|ahead|ff-only|merge|skipped:...> head_after=<short> stash=<none|restored|kept>
guard:ok | guard:missing（...）
```

`guard:missing` 只标日志，不退出。

## 5. 阻塞与兜底

- 只做 `ff-only`（干净/可 stash 时），不做 rebase；落后很多时 ff-only 仍是一次快进，
  耗时与变更文件数相关，通常几秒到十几秒；不设硬超时，避免中途杀掉 checkout 造成半更新。
- fetch 有 SSH 超时限制；fetch 失败直接跳过本轮（2 小时后重试），不会长时间阻塞。
- 分叉时普通 merge 只做一次；冲突立即 abort，不反复重试。
- 本机任务仍有兜底：fetch/合并失败只影响本机这一轮，云端 Cloudflare/Actions 主链路不受影响。

## 6. 验证

- 临时 git 仓库（`git init` + 本地 bare remote）里跑脚本副本的 `-SyncOnly`：
  1. 落后且干净 → ff-only；
  2. 落后且有本地改动（非冲突文件）→ stash→ff-only→pop，改动保留；
  3. pop 冲突 → stash 保留、脚本跳过、日志含 `stash-pop-conflict`；
  4. 未合并文件 → 下一轮 `unmerged` 跳过。
- 不在真实工作树制造冲突。
- 静态测试 `tests/collect-sync.test.mjs`：
  - 含 `git fetch origin main`、`merge --ff-only`、`git stash push`、`git stash pop`；
  - **不得**出现 `-X ours`、`reset --hard`、`checkout --`；
  - 必须写 `sync: head=` 日志；
  - 必须含 `guard:missing` 与 `src\kline-lock.mjs` / `upsertBars` 自检；
  - `scripts/register-task.ps1` 必须仍是 `wscript.exe` + `run-hidden.vbs`；
  - 同步块必须在陈旧度判定之前。
