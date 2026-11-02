# 2.2.1 · 早报生成的容错改造（设计）

日期：2026-11-02　状态：第一阶段实施　范围：早报生成链路（不改采集 / K 线 / 前端既有行为）

## 1. 现状事实（动工前核实）

| 项 | 事实 |
|---|---|
| 触发 | 完全依赖 mcode 的 agent 定时任务 `macro-news 宏观早报（每日 09:00）`（cron `0 9 * * *`，Asia/Shanghai，固定对话）。仓库里**没有任何早报调度配置**。 |
| 执行 | agent 在同一上下文里完成：`pull-remote.ps1` → `import-archive.mjs` → `brief-candidates.mjs` → **AI 自己挑 ≤10 条并写 `overview` / `why` / `watch`** → 写 `.local/briefings/YYYY-MM-DD.json` 与 `.md`。 |
| 产物 | `.local/briefings/YYYY-MM-DD.json`（7~8 KB，结构 `{date, generatedAt, window, overview, items[], watch[]}`）+ `.md`；站点副本 `data/briefings/` 靠手动 `Copy-Item` 发布。 |
| 日志 | **没有**。`.local/` 下只有 `briefings/` 与 `news.db`；`logs/` 只有采集任务日志。agent 中断不会留下任何记录。 |
| 状态 | **没有**。`_last-run.json` 不含早报字段，页脚也看不到早报是否生成。 |

### 2026-11-02 事故复盘（根因证据）

| 时刻 | 事件 |
|---|---|
| 09:00:26 | `news.db` 被 import 写入（说明任务启动、候选已就绪） |
| 09:02:00 | 早报 JSON 里的 `generatedAt` = `2026-11-02T09:02:00+08:00` |
| 09:02 ~ 12:15 | **进程被中断**，无错误、无日志、无半成品、无状态 |
| 12:15:56 | 用户手动恢复，文件才真正落盘；内容里的 `generatedAt` 仍写着 09:02 |
| 12:16:08 | Markdown 版落盘 |

关键结论：**`generatedAt` 是「开始时刻」，不能用来判断产物是否完成、是否按时**。
现在唯一能判断「今天有没有早报」的方法，是人工去看 `.local/briefings/` 有没有文件 —— 这正是要修掉的。

## 2. 目标与非目标

**目标**

- 早报生成有一个**确定性入口**（不依赖 agent 上下文）：
  `node scripts/briefing/generate.mjs --date YYYY-MM-DD`；
- 产物**原子写入**（`.tmp` + rename），半成品不会被站点读到；
- 每次运行写**状态记录**（阶段 / 时刻 / 退出码 / 条数 / 失败原因），页脚能看见；
- **缺了自动补**：启动扫最近 7 天，缺哪天按日期顺序补；今天过 09:30 仍未完整则补跑；
- **防重入**（lockfile + pid + 启动时刻，超时失效）与**15 分钟硬超时**。

**非目标**

- 不改早报内容结构（仍是 `date/generatedAt/window/overview/items/watch`，只增加 `endedAt`）；
- 不改采集链路、K 线、检索、归档切片；
- 不自动修改/删除 mcode 定时任务（调度侧由用户执行，见 §12）；
- 不新增独立页面、弹窗或要闻流条目。

## 3. 完成判据

对 `data/briefings/YYYY-MM-DD.json`（站点产物）执行 `checkBriefing()`：

| 判定 | 条件 | 结果 |
|---|---|---|
| 缺失 | 文件不存在 | `missing` |
| 半成品 | JSON 解析失败（写入被截断） | `invalid` |
| 不完整 | `items` 为空，或 `overview` 为空，或既无 `endedAt` 也无 `generatedAt` | `incomplete` |
| 完整（新） | 有 `endedAt`、`items > 0`、`overview` 非空 | `complete` |
| 完整（旧） | 无 `endedAt`，但有 `generatedAt` 且 `items > 0`、`overview` 非空 | `complete`（兼容 2.2.0 之前的 AI 产物） |

**为什么不用 `generatedAt` 判「按时」**：11-02 的事故文件写着 09:02，实际 12:15 才落盘。
是否迟到看**状态记录的 `endedAt` / 文件 mtime**，不看内容里的开始时刻。
**为什么半成品能被识别**：原子写保证正常产物不会残缺；一旦有人绕过脚本直接写，截断的 JSON 会解析失败。

## 4. 时间窗口与自动补跑（2.2.2 起：只补当天）

- 预期完成时刻 `09:00`，宽限 `+30 分钟` → **09:30** 之后仍未完整才算「超期」；
- `ensure` 自动模式**只处理今天**：

| 站点产物 | 本地产物 | 动作 |
|---|---|---|
| 今天完整 | — | `skip` |
| 今天缺失/不完整，未到 09:30 | — | `skip`（还不到宽限） |
| 今天缺失/不完整，已过 09:30 | 完整（AI 已生成但没发布） | `publish`：原子复制到 `data/briefings/`，**不重新生成** |
| 今天缺失/不完整，已过 09:30 | 也缺失/不完整 | `prepare`：只固化输入快照、标 `awaiting`，等待 LLM 写作；2.3.0 起**不再生成规则版** |

- **历史日期不再自动生成任何早报**。最近的缺口只在状态文件里标 `missed`（日期 + 原因），
  不产出 JSON、不进索引，`hasBriefing` 保持 false。
  依据：早报是 AI 写的判断性内容，用规则版补历史等于造假资产 —— **宁缺不假**。
- 手动补齐（默认关闭，不参与自动调度）：`--backfill-from YYYY-MM-DD --backfill-to YYYY-MM-DD`，
  两个参数必须同时给出；窗口内的日期按升序处理，规则同上（完整跳过 / 本地完整发布 / 否则 `prepare`）。
- 单日失败不影响其它日期（继续补，但整体退出码 1）。
- **2.3.0 更新**：自动链路不再生成规则版；缺失时只 `prepare` 输入快照，降级由 `publish` 标
  `missed` 或 `source:"draft"` 事实清单。详见
  `docs/superpowers/specs/2026-11-02-briefing-llm-pipeline-design.md`。

## 5. 锁

- 文件 `.local/briefing.lock`（不进 git），内容 `{pid, startedAt, host}`；
- 存在且**年龄 < 20 分钟** → 视为有人正在跑，`ensure` 直接退出 0（日志说明）；
- 年龄 ≥ 20 分钟（> 硬超时 15 分钟 + 5 分钟余量）→ 视为失效，删除后接管；
- 内容损坏 → 视为失效；
- 释放时只删自己 pid 的锁；`generate` 默认持锁，`ensure` 持锁后给子进程加 `--no-lock`。

## 6. 硬超时

- `generate`：进程内 15 分钟看门狗，到点写状态 `status=timeout / exitCode=124 / reason=超过 15 分钟` 后 `process.exit(124)`；
- `ensure`：用 `spawnSync(..., { timeout: 15 分钟 })` 拉起子进程，超时由父进程 kill，
  并补写 `timeout` 状态（覆盖子进程没来得及写的情况）；
- 退出码约定：`0` 成功 / `1` 失败 / `2` 锁被占用 / `124` 超时。

## 7. 状态文件 `data/_briefing-status.json`

```json
{
  "v": 1,
  "updatedAt": "2026-11-02T09:02:10+08:00",
  "days": {
    "2026-11-02": {
      "date": "2026-11-02",
      "status": "running|done|failed|timeout|missed|skipped",
      "stage": "start|import|select|write|done|publish|missed",
      "startedAt": "09:00:26",
      "endedAt": "09:02:10",
      "exitCode": 0,
      "candidates": 919,
      "items": 10,
      "reason": "",
      "durationMs": 104000,
      "generator": "rule-v1|publish|existing|missed",
      "source": "ai|rule|"
    }
  }
}
```

- 只保留**最近 14 天**，单文件 3 KB 量级，一天写 1~3 次（不是高频文件）；
- 每次写入也走 `.tmp + rename`；
- **为什么不塞进 `_last-run.json`**：该文件被 15 分钟采集反复读改写，`snapshot.yml` 还会
  `git checkout -- data/_last-run.json`；早报的多阶段状态会与采集冲突/被回滚。
  按需求「字段冲突再新增单文件」，这是单文件、低频、可被页脚直接读取的最小方案。

**页脚呈现**（`assets/app.js` 的 `renderFoot`）：

| 状态 | 文案 | 颜色 |
|---|---|---|
| `done` | `早报 09:02` | 绿 |
| `running` | `早报 补跑中` | 暖棕 |
| `failed` / `timeout` | `早报 失败`（`title` 里放 reason） | 红 |
| 09:30 后无记录/无产物 | `早报 未记录` | 暖棕 |
| 09:30 前无记录 | 不显示 | — |

状态灯不改变「链路健康」总灯的判定，只增加一个独立 token，避免早报问题把行情/新闻的正常状态染红。

## 8. 确定性生成（`scripts/briefing/generate.mjs`）

```
--date YYYY-MM-DD（默认北京今天）
--limit 10            最终条数
--candidates 120      候选池
--db .local/news.db
--out .local/briefings
--site-out data/briefings
--status data/_briefing-status.json
--no-import           跳过 archive → DB 导入（ensure 统一导入后会用）
--sync                先跑 scripts/pull-remote.ps1（可选）
--no-site             只写本地，不发布
--no-lock             由 ensure 持锁时使用
```

流程：`status(start) → [sync] → import → status(select) → buildCandidates(复用) →
buildBriefing(规则组装) → status(write) → 原子写 JSON/MD → 原子发布站点副本 → status(done)`。

**内容口径（降级版，结构不变）**

| 字段 | 规则版来源 |
|---|---|
| `overview` | `今日主线：` + 得分最高的 2~3 条标题 |
| `items` | `brief-candidates` 前 10 条；`why` = 命中的宏观关键词 / 来源权重 |
| `watch` | 空数组（规则版没有前瞻判断；AI 版可覆盖） |
| `source` | `rule`（2.2.2）；AI 产物为 `ai`，旧文件缺字段时按 `ai` 处理 |
| `generator` | `rule-v1`（规则版生成器标识） |
| `endedAt` | 本次真正写完的时刻（新增字段，用来判断「按时」） |

**覆盖语义**：`generate` 同名覆盖（重复运行结果一致 = 幂等）；但 **2.2.2 起拒绝覆盖已存在的
完整 AI 早报**（`source` 缺失或 `ai`，且未加 `--force`），只允许覆盖规则版。

## 9. 站点发布

- `generate` 写完 `.local/briefings/<date>.json` 后，原子复制到 `data/briefings/<date>.json`；
- `data/index.json` 的 `hasBriefing/briefLine` 仍由 `collect.mjs` 下一次运行时重建（≤15 分钟）；
- 页脚状态读取 `data/_briefing-status.json`（`cache:'default'`），不预取早报正文；
- 未改任何前端既有行为（归档折叠块的展开/缓存/刷新恢复保持原样）。

## 10. 根因排查线索（以后出问题先看这里）

1. `data/_briefing-status.json`：今天的 `status/stage/reason/exitCode` 直接说明卡在哪一步；
2. `.local/briefing.lock`：是否有人正在跑、pid 与开始时间是否对得上；
3. `data/briefings/<date>.json` 的 `endedAt` 与文件 mtime：判断是否迟到、是否被重写；
4. `brief-candidates` 的候选数（`candidates` 字段）：为 0 说明新闻库没同步（先查 `MacroNews-Pull`）；
5. 页脚是否出现 `早报 未记录`：说明最近一次 ensure 没跑或没写状态。

## 11. 测试（离线，写盘只在临时目录）

`tests/briefing-core.test.mjs`：

1. 原子写：目标存在旧内容 → 覆盖后内容完整，目录里没有遗留 `.tmp`；
2. 幂等：同一输入 + 固定时刻，连续生成两次字节一致；
3. 完成判据：缺失 / 截断 JSON / `items=0` / 完整（新）/ 完整（旧，无 `endedAt`）；
4. 锁：空锁可获取；同进程二次获取失败；20 分钟以上的旧锁自动接管；释放后可用；
5. 补跑计划：最近 7 天缺 2 天 → 升序；今天未到 09:30 不补；到 09:31 才补；
6. 跨日：UTC 17:30 = 北京次日；`deadlinePassed` 在 09:29 / 09:31 的边界；
7. 组装：≤10 条、`why` 非空、`overview` 非空、`endedAt` 存在。

`ensure` 的实测模拟（不写站点、用临时目录）：

- 缺失：清空输出 → 补跑 → 记录耗时；
- 半成品：写截断 JSON → 判 `invalid` → 覆盖修复；
- 超期：`--now-hm 09:40` + 今天缺失 → 进入补跑队列。

## 12. 第二阶段（2.3.0 已实施）

2.3.0 已按「管道归脚本、写作归 LLM」落地三段式（`prepare` / LLM 检查点 / `publish`），
本节的「mcode 只调度」目标已由新文档承接，旧 `run-ensure.ps1` 仅作兜底，不再自动生成规则版。

建议切换后的任务指令（示例，**不自动修改任何 mcode 任务**）：

```
每天 09:00（Asia/Shanghai）执行：
node scripts\briefing\prepare.mjs --date <今天>
读取 .local\runs\<今天>\prompt.md，按 schema 写 outline.json / draft.json / final.json
09:35 执行 node scripts\briefing\publish.mjs --date <今天>
若退出码非 0，把 data/_briefing-status.json 里今天的记录回帖到对话。
```

另配一条每 30 分钟（08:30–12:00）的兜底调度，执行 `ensure.mjs`；它只在「缺失且已到 09:30」时
`prepare`，不会重复写作、不会生成规则版。
agent 任务不再写早报内容，只做「触发 + 失败摘录」。

## 13. 硬约束

1. **任何模拟、演示、回归测试只能写临时目录（`os.tmpdir()` / `$env:TEMP`），仓库路径一律只读。**
   命令必须显式传 `--out / --site-out / --status / --lock`；不允许依赖默认路径做“试跑”。
2. 每次模拟前后都要核对 `git status --porcelain -- data` 为空、`data/briefings` 文件哈希不变。
3. 采集任务提交数据必须走白名单（`scripts/collect-and-push.ps1` 的 §4），禁止整目录 `git add -- data`。
4. 早报产物一旦由 AI 写入并被站点引用，任何自动化都不得用规则版覆盖它；补跑只处理「缺失/不完整」。

## 14. Lessons（2026-11-02 模拟误写事故）

| 项 | 内容 |
|---|---|
| 现象 | 在临时目录做补跑模拟时，`ensure.mjs` 拉起的 `generate.mjs` 只传了 `--date`，没传 `--out/--site-out/--status`；子进程落回仓库默认路径，覆盖了 `data/briefings/2026-11-01.json`、`2026-11-02.json`，并新生成了 10-30/31 与 `data/_briefing-status.json`。 |
| 扩大 | 15:54 的本机计划任务 `MacroNews-Collect` 用 `git add -- data` 整目录提交，把上述事故文件一并推送到了远端（`origin/main`）。 |
| 影响 | 远端两份 AI 早报被换成规则版；多出两份不该存在的早报与状态文件；`data/index.json` 把 10-30/31 标成 `hasBriefing`。 |
| 恢复 | 从事故前最后一个含 AI 原文的提交 `988632f` 恢复 11-01/11-02；删除 10-30/31 与状态文件；清理提交 `f94a7ab` 正常推送（不 force）。`data/index.json` 由下一次采集按恢复后的文件重建。 |
| 根因 1 | 子进程参数没有白名单/透传约束。 |
| 修复 1 | 统一用参数拼装函数（2.2.x 的 `generateArgs()`，2.3.0 起改为 `prepareArgs()`），ensure 必须显式传全部路径；新增测试「ensure 子进程参数显式携带全部路径」。 |
| 根因 2 | 本机采集任务整目录 `git add -- data`，把「不属于采集链路的文件」也提交了。 |
| 修复 2 | 改为白名单：`git add -u -- data/archive data/kline` + 今天/昨天 archive + 5 个固定 JSON；新增静态测试 `tests/collect-whitelist.test.mjs`，禁止整目录 add 与 briefings/history/snapshots/macro。 |
| 教训 | 「临时目录模拟」必须同时约束子进程路径；自动化落盘前先确认目标路径；提交范围必须白名单，不能假设目录里只有自己的文件。 |

## 15. 2.2.2 语义修正：宁缺不假 + 来源标记

### 15.1 只补当天，历史缺口只标 `missed`

- 自动模式 `ensure` 只处理**今天**；历史日期不再生成任何早报。
- 最近 `--scan-days`（默认 7）的历史缺口写入状态 `status=missed`，
  `reason=历史日期不自动生成（早报是 AI 判断性内容，宁缺不假）`；不写 JSON、不进索引，
  `hasBriefing` 保持 false。
- 手动补齐必须显式给 `--backfill-from` 与 `--backfill-to`，默认关闭、不参与调度。
- **理由**：早报的价值在 AI 的判断（主线性、为什么、观察项），规则版只能拼标题；
  用它补历史会制造看似真实、实则机器拼装的“假资产”，与项目「宁缺不假」的口径冲突。

### 15.2 兜底产物加 `source` 标记

| 位置 | 规则 |
|---|---|
| 早报 JSON | 规则版写 `source:"rule"` + `generator:"rule-v1"`；AI 版为 `source:"ai"` |
| 旧文件 | **不改写**；缺字段时读取端按 `ai` 处理 |
| 索引 | `hasBriefing` 为 true 时透传 `source`（不新增文件、不新增请求） |
| 归档卡片 | `rule` 显示「自动摘要」角标；`ai` 不显示 |
| 状态文件 | 每日记录 `source`（`ai` / `rule` / 空） |
| 页脚 | `rule` 显示 `早报 自动 HH:MM`（暖棕）；`ai` 为绿色；不改链路健康总灯 |
| 覆盖保护 | 已有完整 AI 早报时 `generate` 拒绝覆盖，除非显式 `--force` |

## 16. 2.2.3 元数据与状态修正

1. **AI 原文只补 `source:"ai"`**：两份历史文件各追加一行，正文/条数/时间/watch 不变；
   回归测试 `tests/briefing-metadata.test.mjs` 用「剔除 source 后的 SHA256」锁定内容。
2. **状态必须如实**：新增 `checkStatusInvariants()`：
   - `done` ⇔ 存在完整早报文件；
   - `missed` ⇔ 不存在文件（且未成功生成）；
   - `done.source` 必须与实际文件一致。
3. **每次 ensure 先校正再校验**：`reconcileStatus()` 扫描 `data/briefings/`，
   把「有文件但缺记录/记录为 missed」的天补成 `done`，把「done 但文件没了」纠正为 `missed`；
   校正后仍有违规 → 退出码 1，不再静默。
4. 只补当天、不自动补历史的语义不变（§4）。
