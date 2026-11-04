# 2.4.17 · 本机同步跳过的页脚可见性

日期：2026-11-05　状态：实施中　版本：补丁位（2.4.17）

## 1. 目标

本机 `MacroNews-Collect` 因同步失败 / stash pop 冲突 / 未合并文件跳过时，不能只有日志。
在 `data/_last-run.json` 的独立子对象 `localSync` 中记录状态与连续跳过数，页脚新增一个
独立 token；云端采集写入时必须保留该字段。

## 2. 字段结构

```json
"localSync": {
  "result": "skipped:stash-pop-conflict",
  "reason": "stash 恢复冲突",
  "at": "2026-11-05T01:06:00.000Z",
  "consecutiveSkips": 2
}
```

`result` 枚举：

| 值 | 含义 | 计数 |
|---|---|---|
| `up-to-date` | 无需同步 / 本地领先 | 重置 0 |
| `ff-only` | 干净落后，快进成功 | 重置 0 |
| `stash-restored` | 脏落后，stash→ff-only→pop 成功 | 重置 0 |
| `merge` | 分叉，普通 merge 成功 | 重置 0 |
| `skipped:fetch-failed` | fetch 失败 | +1 |
| `skipped:stash-failed` | stash 失败 | +1 |
| `skipped:ff-only-failed` | 快进失败 | +1 |
| `skipped:stash-pop-conflict` | stash pop 冲突，stash 保留 | +1 |
| `skipped:unmerged` | 上轮冲突未解决 | +1 |
| `skipped:merge-conflict` | 分叉 merge 冲突，abort | +1 |

`reason` 是上述结果的中文短句；成功轮为空字符串；`at` 为写入时刻 ISO。

## 3. 计数规则

`nextLocalSync(prev, result, at)`：

- `result` 以 `skipped:` 开头 → `consecutiveSkips = (prev.consecutiveSkips || 0) + 1`；
- 其它结果 → `0`；
- 只替换 `localSync` 子对象，其它字段原样保留。

成功轮的判定：**同步成功**（up-to-date / ff-only / stash-restored / merge）即重置；
采集本身失败不改变本 token（本 token 只描述本机同步兜底，不是整站采集健康）。

## 4. 页脚 token

规则（纯函数 `localSyncView`）：

| consecutiveSkips | 颜色 | 文案 |
|---|---|---|
| 0 | 不显示 | — |
| 1~2 | 琥珀 `warn` | `本机同步跳过 N 轮 · <原因>` |
| ≥3 | 红 `bad` | 同上 |

- title：`本机兜底连续跳过 N 轮；云端主链路可能仍正常；原因：…；最近：<at>；结果：<result>`
- 与既有总灯的关系：**不改变总灯 `level`**。总灯仍按云端 `_last-run.json` 的
  sources / startedAt / 行情等判定；本机 token 只说明本机兜底是否在跳过。
- 文案明确写「本机同步跳过」，不写成「采集停摆」。

## 5. 云端与本地两个写者

- 云端 `src/collect.mjs` 与 `src/portfolio-collect.mjs` 都是读改写：
  `const prevLog = await readJSON(...); const next = { ...prevLog, ... }`。
  已保留未知字段（`localSync` 不会被抹掉），本版只加注释与测试锁住该行为，不改写盘逻辑。
- 本机写入通过 `scripts/local-sync-write.mjs`，只修改 `localSync`，不再整文件重建。
- 跳过轮发布：写 `_last-run.json` 后，**只提交该文件**（`git commit -- data/_last-run.json`）
  并尝试推送一次；不 merge、不 force。若仓库处于未合并状态或 fetch 已失败，提交/推送可能失败，
  只记录 `localSync:publish=failed`；此时线上页脚看不到本轮跳过（网络/冲突恢复后下一轮会补）。
  这是可见性的天花板，必须如实记录。

## 6. 测试

- 纯函数：计数递增/重置、reason 映射、0/1/3 阈值颜色与文案、merge 保留云端字段。
- CLI：临时 `_last-run.json` 含云端字段，连续 skipped → 1/2，success → 0，云端字段逐字段不变。
- 静态：
  - 两个云端写者保留 `...prevLog`，不得 `delete localSync`；
  - `app.js` 调用 `MacroLocalSync.localSyncView` 且不影响 `level`；
  - `index.html` 加载 `assets/local-sync.js`；
  - 本机脚本在跳过分支调用 `local-sync-write`，并只提交 `_last-run.json`。

## 7. 验收截图

`docs/verify/2.4.17/`（桌面 1440×900，页脚实际渲染）：

| 文件 | localSync | 页脚 token |
|---|---|---|
| `footer-0.png` | 无 / 0 | 不显示 |
| `footer-1.png` | 1 次 `skipped:fetch-failed` | `本机同步跳过 1 轮 · git fetch 失败`（琥珀 `ft-state warn`） |
| `footer-3.png` | 3 次 `skipped:stash-pop-conflict` | `本机同步跳过 3 轮 · stash 恢复冲突`（红色 `ft-state bad`） |

总灯未因 token 改变：截图中仍显示既有的「7/8 源失败」状态。
