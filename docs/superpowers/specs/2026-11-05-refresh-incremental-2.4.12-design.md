# 2.4.12 · 刷新增量更新（不推倒重绘）

日期：2026-11-05　状态：实施中　版本：补丁位（2.4.12）

> 本条目曾拟定为 2.5.0；按 `CHANGELOG.md` 版本规则（无新增用户可见功能、无用户可见错误数据/数据丢失），降为补丁位。

## 1. 目标

刷新（15s 行情轮询 / 浏览器重载）时：

- **保留**：K 线抽屉开关、标的、周期、缩放级别、视窗 offset、画布元素与尺寸、坐标轴/外框结构；
  归档页所处日期、滚动位置、早报展开状态。
- **只更新**：价格、涨跌色、时间标记、新到达的 K 线、归档新增条目。
- 不回退 2.1.2 的 `sessionStorage` 恢复（`macroNewsUI.v1`），在其之上扩展。

## 2. 判定表

| 区域 | 轮询刷新是否需要重绘 | 浏览器重载是否需要重绘 | 实现方式 |
|---|---|---|---|
| 行情卡片外框 / 分组标题 | 否 | 是（首帧） | 轮询时按 `data-key` 原地改文本/class，不 `replaceChildren` |
| 价格 / 涨跌 / 涨跌色 | 是（值变化时） | 是 | 只改 `.q-px` / `.q-chg` 的 `textContent` 与 class |
| 时间标记 / 状态色 | 是（分钟桶变化） | 是 | 只改 `.q-time` 文案与状态 class |
| 行情筛选结果 | 否（只改 hidden） | 是 | `applyQuoteFilter()` 原地显隐 |
| K 线画布元素 / 尺寸 / 外框 | 否 | 是（重建一次） | 单例 `KlineChart` 复用；`setData` 不创建新 canvas |
| 坐标轴 / 网格 | 否（同一画布重绘） | 是 | `render()` 在同一 canvas 上重画；不替换 DOM |
| K 线缩放 / 视窗 offset | **保持** | **恢复** | `kChart.barsShown/offset` 写入 sessionStorage，重载后 `setView()` |
| K 线最新一根 | 是 | 是 | `setData` 追加/更新，`offset/barsShown` 不变 |
| 归档日期列表 | 否（无轮询） | 是（首帧） | 静态渲染 |
| 归档页滚动位置 | 否 | 恢复 | `sessionStorage.y` |
| 早报展开状态 / 正文 | 否 | 恢复 | `briefOpen` + `restoreBriefOpen()`；不收起、不重载到顶部 |
| 打开的某天详情 | 否 | 恢复 | 保存 `day`，重载后 `openDay(day, kind)` |

## 3. 实现

1. `assets/kline.js`：新增 `getView()` / `setView({barsShown, offset})`；`setData` 只做越界钳制，
   不再重置缩放/视窗（`reset()` 仍保留，仅用于切换标的时回到默认视窗）。
2. `assets/app.js#saveUI`：K 线状态从 `{key,period}` 扩展为
   `{key,period,barsShown,offset}`；新增 `day`（打开的归档日）。
   恢复途中优先沿用 `pendingKlineView`，避免 `openKline → reset()` 的 90 根默认值写回。
3. `restoreKlineUI()` 把 view 挂到 `pendingKlineView`；`loadKline` 首帧落图后调用 `setView`。
4. `renderQuotes()` 新增 `patchQuotes()`：卡片集合/顺序与分组标题一致时原地更新价格、涨跌、
   涨跌色、状态文案/状态色与搜索串；集合或顺序不一致才返回 `false`，回退整块 `replaceChildren`。
5. `restoreFeedUI()`：若有保存的 `day`，先 `openDay(day, kind)`（并放宽到刷新前的条数），
   再恢复滚动位置与阅读器。
6. 归档页：`restoreBriefOpen()` 返回正文加载 Promise；`renderArchive()` 在其落位后调用
   `restoreArchiveScroll()`（只执行一次，`alignState.userMoved = true` 停掉自动纠偏）。

## 4. 测试

`tests/refresh-incremental.test.mjs`（7 项静态断言）：
- `patchQuotes` 在 `renderQuotes` 的 `replaceChildren` 之前被调用，且成功时 `return`；
- 分组/卡片数量或 `data-key` 不一致时返回 `false`（回退整块重建）；
- K 线 `getView/setView` 存在，`setData` 不重置 `barsShown/offset`（`reset()` 仍重置）；
- `saveUI` 写入 `barsShown/offset` 与 `day`，恢复途中不被默认视窗覆盖；
- `restoreKlineUI` → `pendingKlineView` → 首帧 `setView` 链路完整；
- 归档早报保持 `det.open = true`，正文落位后恢复 `uiState.y`；
- 归档某天刷新后 `openDay(savedDay.day, kind)`，不回到最新要闻流；
- 不得删除 `UI_KEY` / sessionStorage 恢复逻辑。

## 5. 验收（2026-11-05 22:42，Chrome headless）

环境：本地 `node scripts/serve.mjs`；Chrome headless（`--hide-scrollbars`）；
CDP `Page.captureScreenshot`。桌面 1440×900，窄屏 390×844（DPR 2）。
操作：打开上证指数日 K → 滚轮放大 4 档 → 向左拖出回看区间 → 刷新页面。
归档：展开 2026-11-04 早报 → 滚动到该日卡片 → 刷新页面。

### 5.1 截图（`docs/verify/2.4.12/`）

| 场景 | 刷新前 | 刷新后 | SHA-256（前 16 位） |
|---|---|---|---|
| 桌面 1440×900 · K 线 | `desktop-market-before.png` | `desktop-market-after.png` | `A2B848CE1ADB8738` / 同 |
| 桌面 1440×900 · 归档早报 | `desktop-archive-before.png` | `desktop-archive-after.png` | `BCA3F76D5D9F4E36` / `C4F77E208946B3DB` |
| 窄屏 390×844 · K 线 | `mobile-market-before.png` | `mobile-market-after.png` | `B6D7BEBE9560293F` / `968487925B2B8F83` |
| 窄屏 390×844 · 归档早报 | `mobile-archive-before.png` | `mobile-archive-after.png` | `44DF93033DA92821` / 同 |

- 桌面 K 线、移动端归档：刷新前后**逐字节相同**。
- 桌面归档：仅 6 字节差异（渲染器抗锯齿），肉眼一致。
- 移动端 K 线：0.121% 像素差异，定位在数据源状态文案（刷新前本地预生成、刷新后东财实时）
  与对应 K 线细微差异；`barsShown=36.864`、`offset=47`、画布 722×680 前后完全一致。

### 5.2 运行指标

| 指标 | 桌面 | 窄屏 |
|---|---|---|
| K 线弹窗刷新后仍打开 | 是 | 是 |
| `barsShown` 前 → 后 | 37.891199… → 同 | 36.864 → 同 |
| `offset` 前 → 后 | 33 → 33 | 47 → 47 |
| 画布像素 | 943×440，哈希相同 | 722×680，哈希不同（源切换） |
| 16s 轮询后首张行情卡仍是同一 DOM 节点 | 是 | 是 |
| 归档 scrollY 前 → 后 | 189 → 189 | 205 → 205 |
| 早报 `details.open` 前 → 后 | true → true | true → true |
| 早报正文长度（刷新后重新载入） | 2,608 字 | 2,608 字 |

### 5.3 逐区域判定与实测

| 区域 | 需要重绘？ | 实测证据 | 结论 |
|---|---|---|---|
| 行情卡片外框 / 分组标题 | 否 | 16s 轮询后 `window.__q0 === document.querySelector('#quotes .q')` 为 true | 通过 |
| 价格 / 涨跌 / 涨跌色 | 是（值变化时） | 只改 `.q-px` `.q-chg` 文本与 class，节点不变 | 通过 |
| 时间标记 / 状态色 | 是（分钟桶变化） | 只改 `.q-time` 文案与三态 class | 通过 |
| 行情筛选结果 | 否 | `applyQuoteFilter()` 原地 hidden | 通过 |
| K 线画布元素 / 尺寸 / 外框 | 否 | 单例画布，尺寸前后一致（943×440 / 722×680） | 通过 |
| 坐标轴 / 网格 | 否（同一画布重画） | 桌面画布像素哈希完全一致 | 通过 |
| K 线缩放 / 视窗位置 | 保持（刷新后恢复） | `barsShown`/`offset` 前后完全相同 | 通过 |
| K 线最新一根 | 是（有新数据时） | `setData` 保留视图；桌面截图整图逐字节相同 | 通过 |
| 归档日期列表 | 否（无轮询） | 首帧渲染，刷新后停在同一日期与位置 | 通过 |
| 归档页滚动位置 | 否（恢复） | scrollY 189/205 前后一致，`alignState.userMoved` 停掉纠偏 | 通过 |
| 早报展开状态 / 正文 | 否（保持展开） | `details.open` 前后 true，正文 2,608 字重新载入 | 通过 |
| 打开的某天详情 | 否（恢复） | `sessionStorage.day` + `openDay(day, kind)`，静态测试锁住 | 通过 |

> 说明：浏览器「刷新」必然重建文档对象，DOM 节点不可能跨文档存活；本条的验收口径是
> **刷新后静态结构、视窗参数与视觉结果与刷新前等价**，且轮询路径不再重建 DOM。


