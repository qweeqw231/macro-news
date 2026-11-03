# 2.4.4：交易日历补齐 + 早报「已入库」状态

日期：2026-11-03
状态：已实施

## 1. 背景

2.4.1 引入了第四态（`已收盘` / `休市`），但假日表只核实了 JPX 与 NYSE。
CN / HK / KR / 德 / 法 / 英 全部留空，导致这些市场在真实假日只能降级成「已收盘」，
无法把「休市」与「本应交易却拿不到新价」区分开。与此同时，`publish --push` 在
推送早报文件后只更新了**本地** `data/_briefing-status.json`，线上长期是
`pushed: null`，读者无法判断当天早报是否已入库。

## 2. 范围

### 2.1 假日表

`assets/market-calendar.json` 新增 `markets.CN/HK/DE/FR/UK` 与 `coverageByMarket`，
只登记**全天不交易**的日期；半日市（HKEX 平安夜/除夕、Euronext 12-24/12-31）
不登记——半日市仍是交易日，登记成整天休市会误判。

官方来源（逐市场写入 `sources`，核实日期 `verifiedAt: 2026-11-03`）：

| 市场 | 官方来源 | 覆盖 |
|---|---|---|
| CN | 上交所「休市安排」年度页面 `sse.com.cn/disclosure/dealinstruc/closed/` | 2026 |
| HK | HKEX 通告 CT/075/25（2026）、CT/077/26（2027） | 2026–2027 |
| DE | 德意志交易所官方交易日历页 `live.deutsche-boerse.com/.../trading-calendar` | 2026–2027 |
| FR | Euronext「Trading hours & holidays」2026 假期表 | 2026 |
| UK | LSE「Business days」页（LSE 明确遵循英格兰及威尔士银行假日）；2026 上半年日期以 gov.uk 银行假日表复核 | 2026–2027 |
| KR | 官方 Market Closing(Holiday) 页为 JS 动态渲染，**未能取得完整可核验表** | 留空 |

**不编造**：KRX 整表留空；CN / FR 的 2027 安排尚未发布，`coverageByMarket.to` 只到
2026-12-31。超出表范围的日期不进入假日集合，`sessionAt` 自然降级为 `已收盘`。

**德/法拆分**：此前 DAX 与 CAC40 都用 `market: 'EU'`，共用同一个假日集合。
Xetra 与 Euronext Paris 的休市日并不完全相同（例如 12-24 Xetra 全天休市、巴黎半日市），
合并会互相污染。新增 `calendarMarket` 字段（DAX→`DE`、CAC40→`FR`）与独立时段
`MARKET_SESSIONS.DE/FR`；页面分组仍显示 `EU`（`ORDER` 不变），只有状态判定用
`calendarMarket`。

### 2.2 pushed 状态二次提交

`publish --push` 成功后：

1. 第一次提交：早报 4 个路径（含 `_briefing-status.json`，此时 `pushed:null`）；
2. 推送成功；
3. 写 `pushed:true / pushAt`；
4. 第二次提交：**只含** `data/_briefing-status.json`，提交信息
   `data: 记录早报入库 <date>`，再 fetch/rebase/push。

二次提交失败不回滚早报，写 `statusCommit:false / statusError` 留痕；文件内容未变
（已经 `pushed:true`）时直接返回，不发多余的 fetch/push。

## 3. 测试

- `tests/market-session.test.mjs`
  - CN/HK/DE/FR/UK 每个市场至少一条「假日当天 ⇒ holiday」用例（含 2027 的 HK/UK）；
  - 每个市场 `coverageByMarket.to >= 2026-12-31`；全局 `coverage.to >= 2027-12-31`；
  - KR 表为空且 `gaps.KR` 说明原因；
  - 假日表不得包含周末日期。
- `tests/briefing-push.test.mjs`
  - `commitStatusPush` 只 add 状态文件、不碰早报正文；
  - 内容无变化时不重复 commit/push；
  - `publish.mjs` 源码锁定 `commitStatusPush` 接线。

## 4. 已知限制

- KRX 仍为 gap；若后续拿到官方完整表，直接补 `markets.KR` 与 `coverageByMarket.KR`。
- 半日市未建模：港交所平安夜 12:00 收盘、Euronext 12-24/12-31 半日市，
  当前按正常收盘时刻判断，可能在半日市当天多显示几小时「交易中」。
  本次不扩大范围，留作后续版本。
