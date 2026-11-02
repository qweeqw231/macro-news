# 2.4.0 · 行情新鲜度三态 + K线头部标记 + Worker 采样备源

日期：2026-11-03　状态：实施　范围：行情卡 / K线抽屉 / Worker 代理（不改采集与早报）

## 1. 目标

读者侧（不开代理、正常访问站点）必须：

1. **不空转**：报价直连失败时 1~2 秒内回落本地快照，不再等 16 秒；
2. **不冒充实时**：只有拿到可证的源时间才允许标「实时」；拿不到源时间或落后超阈值，
   必须标「延迟」或「本地快照」；
3. **口径一致**：卡片、报价区标题、页脚、K线头部标记使用同一套三态与时间文案；
4. **K线头部**显示来源、数据时间（带日期）、相对陈旧度、三态，切换周期跟着更新。

Worker 的定位重新明确：**定时采样备份，不是读者入口**。读者侧不依赖 Worker；
Worker 必须能在 Cloudflare 边缘真正取到数（东财失败 → 腾讯备源 → 必要时 Yahoo 兜底）。

## 2. 三态判定

### 2.1 定义

| 状态 | 条件 | 文案 | 颜色 |
|---|---|---|---|
| `realtime` | 有源时间，且 `now - sourceTime <= 5 分钟` | `实时` | `var(--down)`（绿，沿用页脚 ok） |
| `delayed` | 有源时间但落后 > 5 分钟；或**完全没有源时间** | `延迟` | `var(--warm)`（暖棕） |
| `local` | 直连失败/无数据，回落 `data/quotes.json` 或本地 K 线文件 | `本地快照` | `var(--ink-mute)`（灰） |

- **阈值 5 分钟**（`REALTIME_MAX_AGE_MS = 5 * 60 * 1000`），写死在 `assets/quote-status.js`；
- **没有源时间 → 永远不能是 `realtime`**，一律 `delayed`，文案附「无源时间」；
- 收盘后源时间会自然超过 5 分钟：按定义显示 `延迟`，但相对时间写 `收盘 15:00 / 5 小时前`，
  这是诚实口径，不把「收盘价」包装成「实时」；
- 本地快照的「数据时间」优先用快照里最大的 `updatedAt`；没有则用 `generatedAt`，
  再没有则显示「数据时间未知」。

### 2.2 源时间来源

| 源 | 字段 | 解析 |
|---|---|---|
| 东财 `ulist.np` | `f124`（epoch 秒） | `isoCNFromEpoch` → `+08:00` |
| 腾讯 `qt.gtimg.cn` | 字段 `[30]`（`YYYYMMDDHHMMSS`） | 转 `+08:00` |
| Yahoo（Worker 兜底） | `regularMarketTime`（epoch 秒） | 转 `+08:00` |
| K线 | 最后一根 bar 的 `t` | 日/周/月 `YYYY-MM-DD`；分钟 `YYYY-MM-DD HH:MM` |

`generatedAt = now` **不得**再当作数据时间；它只能作为「页面渲染时刻」。

### 2.3 全局与卡片

- 报价区全局状态取**直连主数据**（指数 + ETF + 纳指100）里最差的一档：
  任一 `delayed` → 全局 `延迟`；全部 `realtime` → 全局 `实时`；没有直连数据 → 全局 `本地快照`。
- `data/quotes.json` 里的组合类（xau/xag/brent/sge/usdcny/cgb）天然是本地快照，
  按卡片单独标 `本地快照`，**不把全局状态强行拉成 `本地快照`**（否则每页都显示本地）。
- 页脚 `行情` token 与 `#quoteTime` 使用**同一个全局状态与同一段文案**，不得一处实时一处快照。

## 3. 报价超时预算

```
总预算 QUOTE_TOTAL_BUDGET_MS = 2000ms
东财 EM_BUDGET_MS = 1200ms
腾讯 TX_BUDGET_MS = 800ms（用剩余预算，最多 800ms）
```

- `fetchQuotes()`：先 `Promise.race([fetchQuotesEM(), 1200ms])`；失败/空 → 用剩余预算
  `Promise.race([fetchQuotesTX(), min(800, remaining)])`；都失败 → 抛错，`app.js` 回落本地。
- 最坏读者等待 ≈ **2.0s**，不是原来的 8s + 8s = 16s。
- `req()` 内部仍保留 `AbortController`；外层 race 只负责 UI 预算，不改变各源自己的超时。
- 测试用假 promise（不联网）锁定：1.2s + 0.8s 的预算顺序、超时即 reject、剩余预算不为负。

## 4. 文案与位置

### 4.1 报价卡 / 报价区

- 卡片新增 `.q-time`：`15:59 · 实时` / `15:59 · 延迟` / `本地快照`；
- 报价区标题 `#quoteTime`：
  - `更新于 15:59 · 刚刚 · 实时`
  - `更新于 15:59 · 8 分钟前 · 延迟`
  - `本地快照 · 数据时间 15:59 · 8 分钟前`
  - 无源时间：`数据时间未知 · 延迟`
- 页脚：`行情 实时` / `行情 延迟 8 分钟` / `行情 本地快照 8 分钟前`
- 所有状态颜色复用 `--down` / `--warm` / `--ink-mute`，不新增色号。

### 4.2 K线头部标记

位置：`.km-title` 内，标的名与价格右侧，新增 `<span id="kmMeta">`。

- 桌面全文：`东财 · 11-02 15:00 · 3 分钟前 · 实时`
- 窄屏短文：`东财 15:00 · 3分钟 · 实时`
- 本地：`本地预生成 · 11-02 15:00 · 昨日收盘 · 本地快照`
- 年K：数据时间用 `2026`，来源与状态不变。
- 切换周期（日/周/月/年/分钟）后重新计算并更新；加载中显示 `加载中…`。
- 图下 `#kmNote` 只保留**口径说明**（如伦敦金/人民币中间价的代理差异），
  不再重复来源/时间/根数；来源/时间/根数/状态统一进 `#kmMeta`，避免两处口径冲突。
- CSS：`.km-title { flex-wrap: wrap }`，窄屏 `.km-meta` 可换行，不使用 ellipsis 截断。

## 5. Worker 采样备源

### 5.1 `/quote` 顺序

1. 东财 `ulist.np`，依次尝试 `push2.eastmoney.com` / `1.push2` / `push2delay`；
2. 东财全部失败/空 → 腾讯 `qt.gtimg.cn`，映射沿用 `src/sources.mjs` 的 `tx`：
   `sh000016` / `sz159819` / `hkHSI` / `usDJI` 等；ETF 由 secid 推导（`1.`→`sh`，`0.`→`sz`）；
3. 腾讯也没有代码的海外指数（CAC40/DAX/N225/KOSPI/FTSE）→ Yahoo `query1.finance.yahoo.com`
   最后兜底（`^FCHI` / `^GDAXI` / `^N225` / `^KS11` / `^FTSE`）；仍失败则该项缺失，不编造。
4. 输出结构保持：`{ quotes: [{ key, name, price, prevClose, changePct, updatedAt, source }] }`；
   `source` ∈ `eastmoney | tencent | yahoo`。

### 5.2 `/kline`

保持现状：东财 → 新浪/腾讯。线上实测新浪可用；若以后东财/新浪都挂，再讨论备源，
本轮不改 `/kline` 逻辑。

## 6. 测试

离线、只写临时目录：

1. `tests/quote-status.test.mjs`：无源时间不得 realtime；阈值边界 4/5/6 分钟；三态切换；
   相对时间（刚刚/分钟/小时/昨日收盘）；K线标记随周期（日/分钟/年）变化。
2. `tests/quote-budget.test.mjs`：超时预算 1.2s + 0.8s、超时即 reject、剩余预算不为负；
   用假 promise，不联网。
3. `tests/worker-indices.test.mjs` 扩展：腾讯映射（含 ETF 推导、CAC40 无腾讯→Yahoo）
   与 `source` 字段；Worker 源码锁定回退顺序。
4. 原有 63 项保持通过。

## 7. 验收

- 浏览器桌面 + 窄屏各一次；记录实际文案；
- 模拟东财/腾讯不可用（页面内覆盖 fetch）→ 1~2s 内出数，`#quoteTime` 显示
  `本地快照 · 数据时间 …`，卡片 `.q-time` 显示 `本地快照`；
- 线上 Worker 经代理 `/quote` 6 市场返回非空，`source` 为 `tencent` 或混合；
  上证50、中证A500、沪深300、恒生、CAC40 与仓库 `data/quotes.json` 一致；
- 版本号、README、CHANGELOG 2.4.0 更新。

## 8. 硬约束（沿用）

- 历史时点快照**不回填、不重写**（2026-11-02 仍 58 项）；
- 不提交 `.local/`、`*.db`、日志、`.screenshots/`；
- 不 force push；不自行迁移 Pages Functions / 自定义域名。
