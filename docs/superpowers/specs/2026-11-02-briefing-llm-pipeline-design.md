# 2.3.0 · 早报三段式：脚本管道 + LLM 写作

日期：2026-11-02　状态：实施　范围：早报生成链路（不改采集 / K 线 / 检索 / 历史切片）

## 1. 边界（硬约束）

**管道归脚本，写作归 LLM。**

| 归属 | 负责内容 | 不负责内容 |
|---|---|---|
| 脚本（确定性事务） | 取数、去重、候选打分、输入固化、校验、落盘、索引、状态、锁、判据 | 选主线、写摘要、定观察项、写 `overview` / `why` |
| LLM（语义判断） | 从候选里选事件、合并同一事件、写 `overview` / `summary` / `why` / `watch` | 取数、重抓、改候选、写站点文件、发布 |

脚本**永远不生成摘要正文**。规则版 `generate.mjs` 只保留为人工显式调用的历史工具，
不参与 2.3.0 自动调度；自动链路不得用规则版充当早报。

## 2. 三段式

```
prepare --date
  ├─ 取数 / 导入 archive
  ├─ brief-candidates 去重 + 宏观打分
  ├─ 固化 .local/runs/<date>/input.json（不发布、不进仓库）
  └─ 写状态 awaiting（等待 LLM）
        ↓
LLM 写作段（mcode / 固定对话）
  ├─ 读 input.json 与 prompt.md
  ├─ outline.json → draft.json → final.json（分段检查点）
  └─ 只做语义判断，不联网、不重抓
        ↓
publish --date
  ├─ 校验 final.json（schema / 条数 / 可追溯 / 非空 / inputSha）
  ├─ 通过 → 原子写 data/briefings/<date>.json + .local/briefings/<date>.json
  ├─ 失败 → missed（无文件）或 draft 事实清单（source:"draft"）
  └─ 更新 data/index.json / data/history/index.json / _briefing-status.json
```

三段都幂等，可以重复执行：

- `prepare` 发现 `input.json` 已存在且日期一致 → **直接复用，不重抓、不重算候选**；
- LLM 发现 `outline/draft/final` 已存在 → 从最近检查点续写；
- `publish` 发现站点已有完整 AI 早报 → **永不覆盖**，只把状态校正为 `done/ai`。

## 3. 运行目录与检查点

所有中间产物在 `.local/runs/<date>/`（`.local/` 已 gitignore，不进仓库、不提交）：

| 文件 | 产出方 | 说明 |
|---|---|---|
| `input.json` | `prepare` | 输入快照：候选集、来源、打分、窗口、`inputSha` |
| `prompt.md` | `prepare` | 喂给 LLM 的提示词全文（含路径、schema、续写规则） |
| `outline.json` | LLM | 检查点 1：主线一句话、6~12 条 picks、2~4 条 watch |
| `draft.json` | LLM | 检查点 2：完整正文草稿 |
| `final.json` | LLM | 检查点 3：定稿，`publish` 只认这个文件 |
| `run.lock` | `prepare` / `publish` | 运行锁（pid + 启动时刻，20 分钟失效） |

检查点都带 `date` 与 `inputSha`。`inputSha` 与当前快照不一致 → 该检查点作废；
`prepare --force` 重建快照后，LLM 必须从 `outline` 重写，不能复用旧稿。

### 3.1 输入快照 `input.json`

```json
{
  "v": 1,
  "date": "YYYY-MM-DD",
  "preparedAt": "YYYY-MM-DDTHH:MM:SS+08:00",
  "generator": "prepare-v1",
  "window": { "from": "昨天", "to": "当天" },
  "candidateCount": 919,
  "selectedCount": 120,
  "inputSha": "sha256(canonical(date, window, items)) 前 16 位",
  "items": [
    {
      "rank": 1,
      "date": "YYYY-MM-DDTHH:MM",
      "source": "中国人民银行",
      "channel": "官方",
      "title": "……",
      "summary": "……",
      "url": "……",
      "score": 19,
      "content_status": "full",
      "published_ts": 1793580000
    }
  ]
}
```

`items` 已经是 `brief-candidates` 的去重 + 打分结果；`score` 只供参考，不替代 LLM 判断。
无 `url` 的候选保留在快照里，但最终产物不能引用（无法追溯）。

### 3.2 检查点 schema

`outline.json`：

```json
{
  "date": "YYYY-MM-DD",
  "inputSha": "……",
  "stage": "outline",
  "createdAt": "ISO",
  "thesis": "今日主线一句话，≤60 字",
  "picks": [
    { "rank": 1, "title": "……", "url": "候选 url", "angle": "为什么选它，≤40 字" }
  ],
  "watch": ["明日观察项 1", "明日观察项 2"],
  "notes": "取舍说明，可空"
}
```

`draft.json` / `final.json`：

```json
{
  "date": "YYYY-MM-DD",
  "inputSha": "……",
  "stage": "draft | final",
  "createdAt": "ISO（draft）",
  "generatedAt": "ISO（final）",
  "overview": "今日主线，60~140 字",
  "items": [
    {
      "rank": 1,
      "title": "……",
      "summary": "60~120 字，基于候选改写，不得编造",
      "why": "为什么今天重要，≤40 字",
      "source": "必须与候选 source 一致",
      "publishedAt": "候选时间",
      "url": "必须逐字出现在 input.json 的某个 item.url",
      "refs": ["可选：同一事件的其他候选 url"]
    }
  ],
  "watch": ["……"],
  "model": "可选，模型标识",
  "selfCheck": { "traceable": true, "notes": "可选" }
}
```

### 3.3 续写规则

`prepare` 输出当前检查点报告（`next` 字段）：

| 已有有效检查点 | `next` | LLM 动作 |
|---|---|---|
| 无 `input.json` | `prepare` | 先跑 `prepare` |
| `input.json` | `outline` | 写提纲 |
| `outline.json` | `draft` | 从提纲展开草稿 |
| `draft.json` | `final` | 从草稿定稿 |
| `final.json` | `publish` | 只自检，不重写；交给 `publish` |

`inputSha` 不一致的检查点视为不存在；更晚的有效检查点优先（`draft` 有效但 `outline` 缺失时从 `draft` 续）。

## 4. `publish` 校验规则

`final.json` 必须全部通过才写站点：

| 项 | 规则 |
|---|---|
| JSON | 可解析、对象 |
| `date` | 等于目标日期 |
| `inputSha` | 等于 `input.json.inputSha` |
| `stage` | 必须为 `final`（防止把 draft 当定稿发布） |
| `source` | 若出现，只能为 `ai`；出现 `rule` / `draft` 直接拒绝 |
| `overview` | 非空字符串 |
| `items` | 3~10 条 |
| 条目字段 | `title` / `summary` / `why` / `source` / `url` 全部非空 |
| 可追溯 | 每条 `url` 必须逐字存在于 `input.json`；`refs` 同规则 |
| 来源一致 | 条目 `source` 必须与对应候选的 `source` 一致 |
| 去重 | 主 `url` 在条目间不得重复 |
| `watch` | 数组，0~6 条，每条非空字符串 |

失败时**不写站点文件**，并记录具体字段路径到 `reason`。

## 5. 降级策略（不许冒充）

| 情况 | 产物 | 状态 | 退出码 |
|---|---|---|---|
| 定稿通过校验 | `source:"ai"` + `generator:"llm-v1"` | `done / source=ai` | 0 |
| 站点已有完整 AI 早报 | 不覆盖 | `done / source=ai` | 0 |
| 无 `final.json`（LLM 不可用/中断） | **不写文件** | `missed` | 1 |
| 定稿校验失败，未开 `--draft-on-fail` | **不写文件** | `missed` | 1 |
| 定稿校验失败，开 `--draft-on-fail` | `source:"draft"` 的事实清单（标题/来源/时间/链接，无 AI 摘要） | `done / source=draft` | 1（降级） |
| `prepare` 完成、等待写作 | 只写 `input.json` | `awaiting` | 0 |
| 锁被占用 | 不改状态 | 不变 | 2 |

- `draft` 事实清单的 `overview` 是固定模板句，条目不含 AI 写的 summary/why；
- `rule` 只允许人工显式 `generate.mjs --date` 产生，自动链路不产生；
- 前端角标：`ai` 无角标，`rule` 显示「自动摘要」，`draft` 显示「事实清单」；
- 页脚：`ai` 绿色，`rule`「早报 自动」，`draft`「早报 事实清单」，`awaiting`「早报 待写作」。

## 6. 状态、索引、锁

- 状态文件仍为 `data/_briefing-status.json`（14 天，低频）；
  `status` 扩展 `awaiting`，`source` 扩展 `draft`。
- `done ⇔ 存在对应文件`、`missed ⇔ 不存在文件且未成功生成` 不变式继续成立；
  `done.source` 必须等于文件实际 `source`。
- 发布后立即补索引（只改已存在的那一天，不新增日期）：
  - `data/index.json`（`day` 键）
  - `data/history/index.json`（`d` 键）
  - 写入 `hasBriefing:true`、`briefLine`（overview 截 80 字）、`source`；
  - 如果当天还没有归档条目，索引不新增日期，等下一次 `collect.mjs` 重建。
- 锁：`.local/runs/<date>/run.lock`，`prepare` 与 `publish` 共用；
  年龄 ≥ 20 分钟视为失效；释放只删自己的 pid。
- `prepare` 与 `publish` 的所有路径都可显式传入；测试必须传临时目录。

## 7. 调度契约（交给用户执行，不自动修改 mcode 任务）

### 7.1 命令

```powershell
# 09:00（Asia/Shanghai）：确定性取数 + 固化输入，不写作
node scripts\briefing\prepare.mjs --date 2026-11-02

# LLM 写作段：读 .local/runs/2026-11-02/prompt.md，写 outline/draft/final

# 09:35：校验 + 发布（LLM 不可用时标 missed；可加 --draft-on-fail 出事实清单）
node scripts\briefing\publish.mjs --date 2026-11-02
```

建议的 mcode 任务指令：

```
每天 09:00（Asia/Shanghai）：
1. node C:\Work\Minimax_Work\macro-news\scripts\briefing\prepare.mjs --date <今天>
2. 读取 .local\runs\<今天>\prompt.md，按其中的 schema 写 outline.json / draft.json / final.json
3. 09:35 执行 node scripts\briefing\publish.mjs --date <今天>
4. 若 publish 退出码非 0，把 data/_briefing-status.json 里今天的记录回帖到对话
```

> 本轮只交付文本与脚本，**不修改、不删除任何 mcode 定时任务**。

### 7.2 该不该重跑

| 现状 | 判断 | 动作 |
|---|---|---|
| `publish` 退出 0，状态 `done/ai` | 已完成 | 不再重跑 |
| `publish` 退出 0，状态 `done/draft` | 降级完成 | 不重跑；第二天照常 |
| 状态 `missed`，`input.json` 存在，`final.json` 不存在 | LLM 中断 | **只补写作 + `publish`**；不要重跑 `prepare` |
| 状态 `missed`，`final.json` 存在但校验失败 | 产物不合格 | 从 `draft` 或 `final` 修正后重跑 `publish` |
| `input.json` 不存在 | 首次 | 跑 `prepare` |
| `input.json` 存在，`inputSha` 与检查点不一致 | 快照被 `--force` 重建 | 从 `outline` 重写 |
| 站点已有 `source:"ai"` | 受保护 | 永远不覆盖 |

重跑 `prepare` 是安全的：默认复用已有 `input.json`，不会产生第二套候选。
只有确认取数不完整（候选为 0 / 窗口错误）时才用 `--force` 重建。

### 7.3 LLM 提示词全文

`prepare` 会把下面这段写入 `.local/runs/<date>/prompt.md`（占位符已替换）：

```
你是「宏观早报」的写作段（LLM）。你只负责语义判断：选主线、写摘要、定观察项。
确定性管道已经由脚本完成：取数、去重、候选打分、输入固化。你不要联网，不要重新抓取，
不要再运行 brief-candidates / import-archive / generate，也不要修改 input.json。

日期：{{DATE}}
输入快照：{{INPUT_PATH}}
快照指纹：{{INPUT_SHA}}
输出目录：{{RUN_DIR}}
当前续写点：{{RESUME}}

一、先读输入快照
input.json 结构：
{
  "v": 1,
  "date": "YYYY-MM-DD",
  "preparedAt": "...",
  "window": {"from": "...", "to": "..."},
  "candidateCount": 919,
  "selectedCount": 120,
  "inputSha": "...",
  "items": [
    {"rank":1,"date":"YYYY-MM-DDTHH:MM","source":"...","channel":"...","title":"...",
     "summary":"...","url":"...","score":12,"content_status":"full","published_ts":...}
  ]
}
候选已按宏观关键词权重 + 来源权重 + 全文/摘要质量排序；score 只用于参考，不替代你的判断。
只允许使用 items 里的条目；每条最终产物必须能通过 url 追溯到某个候选。

二、写三个检查点（只写这三个文件，全部 UTF-8 JSON）
1) outline.json —— 提纲（先想清楚再写）
{
  "date": "...",
  "inputSha": "...",
  "stage": "outline",
  "createdAt": "ISO",
  "thesis": "今日主线一句话，≤60字",
  "picks": [
    {"rank":1,"title":"...","url":"候选 url","angle":"为什么选它，≤40字"}
  ],
  "watch": ["明日观察项 1", "..."],
  "notes": "取舍说明，可空"
}
picks 6~12 条，按重要性排序；watch 2~4 条。

2) draft.json —— 草稿（完整正文，允许粗糙）
{
  "date": "...",
  "inputSha": "...",
  "stage": "draft",
  "createdAt": "ISO",
  "overview": "今日主线，60~140字",
  "items": [
    {"rank":1,"title":"...","summary":"60~120字","why":"为什么重要，≤40字",
     "source":"...","publishedAt":"...","url":"候选 url",
     "refs":["可选，同事件的其他候选 url"]}
  ],
  "watch": ["..."]
}

3) final.json —— 定稿（publish 只认这个文件）
{
  "date": "...",
  "inputSha": "...",
  "stage": "final",
  "generatedAt": "YYYY-MM-DDTHH:MM:SS+08:00",
  "overview": "...",
  "items": [...同 draft...],
  "watch": ["..."],
  "model": "可选：模型标识",
  "selfCheck": {"traceable": true, "notes": "可选：自检说明"}
}

三、写作口径
- 3~10 条；正常 8~10 条；合格事件不足 6 条时按实际条数输出，并在 selfCheck.notes 说明。
- 排序：中国政策/央行/利率/PMI/财政 > 三大央行/美国数据 > 地缘/原油/黄金/美元 > A股/港股/美股主线。
- 同一事件多源报道合并成一条：主 url 选信息最完整的一条，其他放 refs。
- summary 必须基于候选的 title/summary 改写，不得编造数字、时间、引语；不确定就不写。
- why 说明「为什么今天重要」，不要复述标题。
- watch 是明天要盯的 2~4 个具体变量（数据、会议、价格位），不要写空话。
- overview 只写今日主线，不要罗列全部条目。
- source 必须与候选的 source 一致；publishedAt 用候选的 date。
- items 的 url 必须逐字出现在 input.json 的某个 item.url 里；refs 里的 url 也必须能追溯。
- 不得写 source:"rule" 或 source:"draft"；来源由 publish 统一标记为 ai。
- 不得把规则版/模板拼接当早报；没有把握就少写，不要编。

四、中断续写
先看输出目录里已有的 outline.json / draft.json / final.json：
- 若 final.json 已存在且 inputSha 一致：只做自检，不要重写。
- 若 draft.json 已存在且 inputSha 一致：从定稿继续，不要重写提纲和草稿。
- 若只有 outline.json 且 inputSha 一致：从草稿继续，按提纲展开。
- 若 inputSha 不一致（脚本用 --force 重建了快照）：三个检查点全部作废，从 outline 重写。
- 任何情况下都不要重新抓取、不要生成另一套候选。

五、完成标准
final.json 通过以下校验才算完成：
- date 等于当天；inputSha 等于输入快照；
- overview 非空；
- items 3~10 条；每条 title/summary/why/source/url 非空；
- 每个 url 都能在 input.json 中找到，且 source 与候选一致；
- watch 为 0~6 条非空字符串；
- 没有 source:"rule"/"draft"。
写完 final.json 后停止，不要自己发布；发布由 publish 脚本完成。
```

## 8. 测试（离线，写盘只在临时目录）

新增 `tests/briefing-pipeline.test.mjs`：

1. **输入快照复用**：第一次 `prepare` 生成 `input.json`；移走 archive 后重跑，仍 `reused:true`，文件字节不变（证明不重抓）。
2. **检查点续写**：无 input → `prepare`；有 input → `outline`；有 outline → `draft`；有 draft → `final`；有 final → `publish`；`inputSha` 不一致 → 回 `outline`。
3. **schema 拒绝**：空 overview / 条目不足 / 非候选 url / source 不一致 / `stage:"draft"` 伪装 final / 超过 10 条。
4. **降级不冒充**：无 final → `missed` 且站点无文件；校验失败 + `--draft-on-fail` → `source:"draft"` 事实清单，绝不出现 `source:"rule"`。
5. **AI 覆盖保护**：站点已有 AI 早报时，即使 final 有效也不覆盖，状态 `done/ai`。
6. **发布原子性**：成功发布后无 `.tmp` 残留；校验失败时目标文件字节不变。
7. **索引透传**：`draft` 角标条件、`readBriefingMeta` / `buildIndex` 识别 draft，不被误判成 ai。

## 9. 硬约束

1. 任何模拟、演示、回归测试只能写 `os.tmpdir()` / `$env:TEMP`，仓库路径只读；
   命令必须显式传 `--runs / --site-out / --local-out / --status / --db / --archive / --data-dir`。
2. 不联网、不 force push、不提交 `.local/`、`*.db`、日志。
3. 不修改两份历史 AI 早报（`data/briefings/2026-11-01.json`、`2026-11-02.json`）。
4. 不修改或删除任何 mcode 定时任务；调度命令只在文档与本报告中交付。
5. 自动链路不得调用 `generate.mjs` 的规则版兜底；`rule` 仅限人工显式调用。

## 10. 非目标 / 回退

- 不改采集、K 线、检索、历史切片、归档 UI 的既有行为；
- 不新增页面、弹窗、要闻流条目；
- 回退：停止调度 `prepare/publish` 即可；已发布的 AI 早报不受影响，
  `ensure` 仍可把 `.local/briefings` 里已有的完整 AI 产物发布到站点（只发布、不生成）。
