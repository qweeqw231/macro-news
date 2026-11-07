---
name: add-market-instrument
description: Add or audit a market instrument (index, ETF, commodity, FX) across quotes, K-line, snapshots, search, Worker and docs. Use when the user asks to add a new quote target or verify its full data chain. Do not use for news-only or briefing-only changes.
---

# 新增行情标的

把一个新标的接入本站的全部既有链路：行情卡、代码展示、搜索、K 线、时点快照、Worker 代理、
README/CHANGELOG/版本号、回归测试。**不要只改一处配置就宣布完成。**

## 先定标的类型

| 类型 | 真值文件 | 备注 |
|---|---|---|
| A股/港股/美股/日欧宽基指数 | `src/sources.mjs` 的 `INDICES` | 本项目最常见的类型 |
| 场内 ETF | `src/etf.mjs` 的 `ETFS` | 还需要 `assets/market.js` 的 META |
| 组合/商品/汇率/收益率 | `src/sources.mjs` 的 `PORTFOLIO_KLINE` | 日频值可能无法回溯，见第 4 步 |

## 九步流程

### 1. 数据源核对（不改任何配置）

至少两个独立源确认 **代码 / 名称 / secid** 一致，防止深沪同号、ETF 与指数同名等张冠李戴。

```powershell
# 东财 suggest：看 Code / Name / QuoteID / Classify
node -e "const u='https://searchapi.eastmoney.com/api/suggest/get?input='+encodeURIComponent('<中文名>')+'&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10'; fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}}).then(r=>r.text()).then(console.log)"

# 腾讯：返回 1~名称~代码~最新价…
node -e "fetch('https://qt.gtimg.cn/q=<腾讯代码>').then(r=>r.arrayBuffer()).then(b=>console.log(new TextDecoder('gbk').decode(b).slice(0,300)))"
```

核对结果必须写进交付说明；不确定就停，不要猜 secid。

### 2. 配置入组与位置

- `src/sources.mjs` `INDICES`：按分组连续放置（A股宽基放在沪深300/上证50附近；港股/美股/日欧各自分组）；
  字段 `key / name / market / secid / sina / tx` 齐全。
- `src/etf.mjs` `ETFS`（仅 ETF）：key 用 `etf_<代码>`，带 `secid`、`theme`、`region`。
- `PORTFOLIO_KLINE`（仅商品/汇率/收益率）：实时价与 K 线可能来自不同源，`klineNote` 写清口径差异。
- `assets/market.js` `META`：与 `INDICES`/`ETFS` 的 key、secid、market、name 对齐；
  同时补 `TX_CODE`、`SINA_CODE`（CN 指数）。
- `assets/app.js` `CODE_MAP`：卡片显示的纯代码（A股指数 `000510`，ETF `563360`，恒指 `HSI`）；
  `MKT_ALIAS` 补中文名之外的高频搜索词。
- `worker/worker.js` `INDICES`：key / secid / sina / tx / market 必须与 `src/sources.mjs` 完全一致。

### 3. K 线

```powershell
# 日/周/月（服务端预生成，日 1000 / 周 1821 / 月 500）
node src/collect.mjs --kline-only <key>

# 全量日 K（源侧全量，前端“尽可能多”用这份）
node scripts/update-kline-full.mjs --only <key> --force
```

⚠ 如果**源侧本身只有短历史**（新开转播的指数、新上市标的），`MIN_BARS = 1050` 会把它判成
「不足，不当全量写」而拒写 `_full.json`。此时把 key 加进 `SHORT_HISTORY_KEYS`
（门槛降到 30），并在 README/CHANGELOG 写明起点与根数。
先例：`sox`（东财 `251.SOX`）2026-07-06 才开始转播，日 K 只有 89 根。**不要拿 ETF 补历史。**

验收：
- `data/kline/<key>.json`、`_1w.json`、`_1M.json`、`_full.json` 的 `name` 与标的名称一致；
- 根数合理：全量至少覆盖该标的上市/发布以来的历史；月 K 至少 200 根（新指数除外）；
- 年 K 由月 K 聚合：前端 `aggregateYear()` 读 `_1M`，不需要单独生成年 K 文件；
- 均线按数据根数动态置灰：沿用 `MA_LIST` / `YEAR_MA`，不要为新标的写死按钮状态；
- 分钟 K：A股/港股/美股有客户端源，通常不预生成；欧日韩/商品等客户端无源的才进
  `scripts/update-kline-minute.mjs` 的 `TARGET_KEYS`。**例外**：美股里腾讯没代码的（如 `sox`）
  同样要进 `TARGET_KEYS`——「美股」不等于「有客户端源」，按标的实测，不按市场想当然。

### 4. 时点快照（硬规则）

```powershell
# 当天 pm（15:00 收盘后；am 是 11:30）
node src/snapshot.mjs --session pm --date <YYYY-MM-DD>
```

**硬规则：历史时点快照不回填、不重写。**
- 新增标的只保证**新增日之后**的 am/pm 快照包含它；
- 新增日之前的历史快照缺口如实保留，不补造、不重写；
- 当天 am 已生成、只补 pm 时，**不要重算 am**：am 的组合日频值会拿到当前时刻的值，
  污染 `asOf`；
- `buildSnapshot` 的 pm 闸门只要求 A股/ETF/港股是 `dailyK`；`kind=portfolio` 的日频值
  不走日 K，`asOf` 由源给出，不能被误判为“不是收盘价”。

### 5. 行情卡与代码展示

- `data/quotes.json` 必须出现新 key，`name` 与源一致，`price > 0`；
- 卡片 `.q-code` 显示 `CODE_MAP` 的代码；没有映射会退回 key 的大写，属不合格；
- 分组顺序由 `INDICES` 顺序决定，不要在前端硬编码排序。

### 6. 搜索

至少验证四个入口：中文名、纯代码、英文/别名、分组名。
`assets/app.js` 的 `quoteSearchText` = `name + key + codeOf(q) + MKT_ALIAS + 分组`。
纯代码命中失败，通常是 `CODE_MAP` 漏了；中文别名命中失败，通常是 `MKT_ALIAS` 漏了。

### 7. Worker 映射与部署

```powershell
# 映射逐项对比（也由 tests/worker-indices.test.mjs 锁定）
node --test tests/worker-indices.test.mjs

# 部署（不改 secret / 路由 / 缓存；只更新脚本）
cd worker
npx wrangler deploy --keep-vars --message "add <key>"
```

部署后至少抽 3 个既有标的 + 新标的做 `/quote` 回归；再测新标的 `/kline`。
`workers.dev` 在国内可能被 DNS 污染，本机打不开时用 `wrangler dev --local` 做运行时回归，
并在交付说明里如实标注“线上 URL 不可达、部署版本 ID 已确认”。

### 8. 文档与版本号

- `README.md`：指数名录表、行情标的总数、快照项数、K 线全量标的数、CN 指数数；
- `CHANGELOG.md`：新增标的、数据源核对结果、快照缺口/回填范围、测试数；
- `index.html`：所有 `?v=` 资源版本号统一升级（`YYYYMMDDx` 递增）；
- 不要改历史 CHANGELOG 条目来“对齐”新数字。

### 9. 测试

新增或扩展：
- `tests/index-<key>.test.mjs`：INDICES 字段、位置、K 线文件、quotes、当日 pm 快照（或缺口）；
- `tests/worker-indices.test.mjs`：Worker 与 `src/sources.mjs` 逐项一致（自动覆盖新标的）；
- 跑全量：`node --test "tests/*.test.mjs"`。

只写临时目录、不联网；不提交 `.local/`、`*.db`、日志。

## 验收清单

- [ ] 双源核对：代码 / 名称 / secid 一致，证据已留档
- [ ] `INDICES`/`ETFS`/`PORTFOLIO_KLINE` 入组且位置合理
- [ ] `assets/market.js` META / TX_CODE / SINA_CODE 补齐
- [ ] `assets/app.js` CODE_MAP / MKT_ALIAS 补齐
- [ ] `worker/worker.js` 映射与仓库一致，`worker-indices.test.mjs` 通过
- [ ] 日/周/月/全量 K 线文件存在，名称正确，年 K 可聚合
- [ ] `data/quotes.json` 有价、卡片代码正确
- [ ] 搜索：中文名 / 代码 / 别名 / 分组 至少各命中一次
- [ ] 当日 pm 快照含新标的（或按“历史不回填”明确记录缺口）
- [ ] README / CHANGELOG / 资源版本号已更新
- [ ] 全量测试通过（临时目录、不联网）
- [ ] 线上：版本号、卡片、搜索、K 线、快照逐项验收

## 常见坑

| 坑 | 表现 | 处理 |
|---|---|---|
| 深沪同号 | `000016` 既是上证50，也是深市个股代码 | 以东财 `QuoteID` 的 `1.`/`0.` 前缀和名称双重确认 |
| secid 市场前缀 | 把 `1.000510` 写成 `0.000510` | 1=沪、0=深、100=海外指数、124=港股、118=上金所、133=外汇 |
| 组合日频值污染 asOf | 事后重跑 am/pm，xau/cgb 等变成当前时刻值 | 时点快照不可重写；只补缺失 session |
| 历史快照缺口 | 新增标的前的快照没有该 key | **定案：不回填**；只保证新增日之后 |
| Windows 大小写 | `1m`（分钟）与 `1M`（月K）同名 | 分钟文件必须放 `data/kline/min/` |
| Worker 映射漂移 | 代理对 cac40/hs_tech 静默降级 | 跑 `tests/worker-indices.test.mjs`，逐项 compare |
| 总数漏改 | README 仍写旧数字（当前真值：23 指数 / 62 标的） | 按 `INDICES.length` + ETF + 组合重新算 |
| 整目录提交 | 把 `.local/`、日志、缓存带进 git | 只 `git add` 白名单文件；不要 `git add -A` |

## 演练脚本

```powershell
node .trae/skills/add-market-instrument/scripts/verify-instrument.mjs --key <key> --date <YYYY-MM-DD>
```

脚本只读仓库文件，逐项检查配置、Worker、K 线、quotes、当日 pm 快照；任何一项失败退出 1。
新增标的当天还没有 pm 快照时，加 `--skip-snapshot` 并在交付说明里记录缺口。
