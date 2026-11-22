// scripts/update-kline-minute.mjs
// 生成「服务端预生成的分钟K」：data/kline/min/<key>_<period>.json
// （2026-11-22 起入口节流到 1 轮/小时：CF :17/:47 与 GH :02 的重复触发会被自动跳过）
//   实测：重复触发退出 0.13 秒（不发请求）；完整一轮本机 330 秒（东财熔断）、Actions 7~11 分钟。
//
// ── 为什么必须有它（2026-10-30 实测）────────────────────────────────────
//   用户反馈：「所有非 A/非 H/非美指数 + 上海金都没有分钟级别K线」。
//   查下来是**能力边界 + 客户端被封**两件事叠加：
//     ① 能力边界：欧日韩指数、上海金、伦敦银的分钟K **只有东财一个源**
//        （腾讯对 jpNI225/ukFTSE/deDAX/krKOSPI 无可用代码；新浪只有实时价、没有分时序列；
//          新浪外盘的 MinKLine 接口一律 __ERROR）⇒ 东财挂了就是 0 根；
//     ② 客户端被封：东财 push2his 对**本机的非浏览器客户端**是 socket 级拒绝
//        （Node fetch 与 curl 实测都 http=000 / fetch failed），只有浏览器能连上；
//        而且浏览器连打几个大请求后**同样会被封**（实测：拉完 CAC40 9192 根日K 后，
//        紧接着的 5 分钟请求就变成「All promises were rejected」）。
//   ⇒ 结论：客户端直连东财做分钟K，**不可靠**。
//   补救：服务端（Actions 跑在美国节点，能稳定连东财）**预生成分钟K**，
//     客户端直连失败时回落到本地快照 ⇒ 欧日韩/上海金/伦敦银的分钟图**不再依赖东财在客户端可达**。
//
// ── 只覆盖「客户端没有别的分钟源」的标的 ──────────────────────────────────
//   A股/港股/美股：腾讯分时（minute / usMinute）稳定可用 ⇒ 不生成，省带宽也省仓库体积。
//   伦敦金：东财 122.XAU「黄金/美元·现货」分钟 **可用**，与新浪日线同日收盘差 <0.1%
//     （2026-11-03 实测 15 个交易日，最大 0.054%）⇒ 纳入本脚本；日线仍走新浪外盘。
//     （原注释「全网没有同口径分钟源」已过时，正是这句把 xau 排除在外。）
//   布伦特：**仍无同口径分钟源**（新浪外盘只有日线；东财 112.B00Y 是「当月连续结算价」，
//     换月基差可达 6%）⇒ 保持「无分钟级数据」，前端会明确说明原因，而不是画一张假图。
//
// ⚠⚠ **文件必须放在 data/kline/min/ 子目录**，不能直接放 data/kline/：
//   分钟周期 '1m' 的文件名是 <key>_1m.json，而月K 是 <key>_1M.json ——
//   **Windows 文件系统大小写不敏感 ⇒ 这两个是同一个文件名**！
//   实测后果（2026-10-30）：本地拉取远端产物时，1分钟的数据把月K 覆盖了，
//   git 里 6 个标的的 <key>_1M.json 全部变成 1分钟内容；
//   **Pages 部署同样会折叠这两个名字** ⇒ 线上那 6 个标的的月K 图直接变成 1分钟图。
//   ⇒ 分钟文件一律进子目录，物理隔离。
//
// ── 抗限流（2026-10-30 踩到）─────────────────────────────────────────────
//   同一台 Actions 机器一轮要抓 35 个文件；东财按 IP 限流，一旦触发，
//   请求会**挂住**而不是立刻失败 ⇒ 串行 35 次 × 15s 超时 = 9 分钟，作业直接超时失败。
//   ⇒ 每个请求加**硬超时**（超时算失败、不阻塞后面）+ 请求之间**间隔**+ 失败**重试一次**；
//     并按「重要度」排序（5m 优先），保证被打断时最新鲜的是最常用的那个。
//
// 格式：**紧凑数组行** [t,o,c,h,l,v]（与 <key>_full.json 同一套，前端 localKline 能直接读）。
//
// 用法：
//   node scripts/update-kline-minute.mjs              # 全部目标 × 全部周期
//   node scripts/update-kline-minute.mjs --dry-run    # 只抓不写（不参与 1 轮/小时节流）
//   node scripts/update-kline-minute.mjs --force      # 绕过 1 轮/小时节流
//   node scripts/update-kline-minute.mjs --only cac40
//   node scripts/update-kline-minute.mjs --periods 5m,15m
//
// 退出码：0 = 至少写成功一个（或全部已是最新）；1 = 一个都没成功

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKline, getKlineSource, klineTarget } from '../src/sources.mjs';
import { emStats } from '../src/em.mjs';
import { upsertBars } from '../src/kline-guard.mjs';
import { acquireKlineLock, releaseKlineLock, lockSkipText } from '../src/kline-lock.mjs';
import { minuteRoundDue } from '../src/kline-finalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'kline', 'min');
const STATUS_FILE = path.join(OUT_DIR, '_status.json');
const START_MS = Date.now();

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const ONLY = arg('only', '');
const PERIODS_ARG = arg('periods', '');

// 每轮**必刷**的周期：5m（最常用）+ 30m；
// 其余（60m / 15m / 1m）按**小时轮换**刷新 —— 它们的变化频率本来就慢，
// 而且每轮少打几个请求，被东财按 IP 限流的概率小得多
// （实测 2026-10-30：同一台 Actions 机器一轮打 35 个请求就被限流，作业直接超时失败）。
const ALWAYS_PERIODS = ['5m', '30m'];
const ROTATE_PERIODS = ['60m', '15m', '1m'];
const AUTO_PERIODS = [...ALWAYS_PERIODS, ROTATE_PERIODS[new Date().getUTCHours() % ROTATE_PERIODS.length]];

// 客户端没有别的分钟源 ⇒ 必须由服务端兜底
//
// 2.16.0：新增 12 个外汇标的（5 个人民币交叉盘 + 7 个美元对）。
// 2026-11-21（分钟K缺失排查后的整改）：
//   · 美元对里**重叠核对通过的 5 个**（eurusd/gbpusd/usdjpy/audusd/usdcad）改走新浪外汇
//     getMinKLine，不再是东财 119.*。理由不是「新浪更好」，而是**两端一致**：
//     浏览器连不上东财（socket 级拒绝），只能走新浪 JSONP；若服务端仍以东财为主，
//     就会出现「直连成功看新浪、失败看东财快照」，同一张图两个口径。
//     交叉盘本来就是两端新浪，这 5 个照同一套走才自洽。
//   · usdkrw **核对未通过，留在东财**，且仍只刷 5m/30m（见 MINUTE_HOLD_KEYS）；
//     usdchf 核对擦边（5m p99 0.0593%），产品接受 ⇒ 接新浪，东财仅在该周期新浪失败时兜底。
//   · **dxy / usdcny 补进来**：这两个此前只靠浏览器直连东财 ⇒ 东财不可达时全站无分钟图。
//     dxy 只有东财一个源（新浪/腾讯均无 DXY 分钟）；
//     usdcny 分钟新浪 fx_susdcnh 优先、东财 133.USDCNH 兜底（日/周/月仍东财优先）。
//
// ⚠ 请求预算（每轮只跑 5m + 30m + 1 个轮换周期）：
//     东财：10 个只走东财的标的 × 3 + usdkrw × 2 = 32 次/轮（配置基线）；
//           实测 **34~35 次/轮**（含失败重试，emStats 只在真正发 HTTP 时计数）——
//           会随东财可达性浮动，不是固定值。
//     新浪：12 个外汇 × 3 = 36 次/轮（无已知 IP 级限流）
//   ⚠ 实测 34~35 贴着历史限流阈值（约 35 次/轮）。若持续限流，M4 会把它降级成
//     「本周期剩余标的跳过、下一轮优先补」，不会整轮归零；真扛不住再把 dxy 砍回 5m/30m。
//   NO_ROTATE_KEYS 已删除 —— 它当初是为了压东财额度才砍掉美元对的 1m/15m/60m，
//   核对通过的 5 个不再占东财额度，砍掉的理由不存在了。
const TARGET_KEYS = [
  'n225',        // 日经225      100.N225
  'dax',         // 德国DAX30    100.GDAXI
  'cac40',       // 法国CAC40    100.FCHI
  'ukx',         // 英国富时100  100.FTSE
  'kospi',       // 韩国KOSPI    100.KS11
  'sge_au9999',  // 上海金Au99.99 118.AU9999
  'xag',         // 伦敦银       122.XAG（与报价 hf_XAG 同一条线，实测年均差 <0.7%）
  'xau',         // 伦敦金       122.XAU（现货；日线仍走新浪外盘，分钟只取东财）
  'sox',         // 费城半导体   251.SOX（腾讯无代码；分钟只东财有）
  // ---- 外汇：人民币交叉盘（新浪 getMinKLine）----
  'eurcny',      // fx_seurcny
  'gbpcny',      // fx_sgbpcny
  'jpycny',      // fx_sjpycny（×100）
  'krwcny',      // fx_skrwcny（×100）
  'audcny',      // fx_saudcny
  // ---- 外汇：美元对各主要货币（6 个走新浪 getMinKLine，东财 119.* 兜底；usdkrw 只走东财）----
  'eurusd',      // fx_seurusd
  'gbpusd',      // fx_sgbpusd
  'usdjpy',      // fx_susdjpy
  'usdkrw',      // 东财 119.USDKRW（新浪分钟不接，不混源）
  'audusd',      // fx_saudusd
  'usdcad',      // fx_susdcad
  'usdchf',      // fx_susdchf
  // ---- 汇率指数 / 离岸人民币：dxy 只有东财有分钟（新浪无 DXY）；
  //      usdcny 分钟新浪 fx_susdcnh 优先、东财 133.USDCNH 兜底 ----
  'dxy',         // 100.UDI
  'usdcny',      // 133.USDCNH
];

// 2026-11-21 重叠核对**未通过**的标的：分钟仍只走东财，且只刷 5m/30m（与整改前完全一致）。
// 核对方式：拿仓库里现存东财快照与新浪同时间键逐根比收盘（work/overlap-local.mjs）。
//   usdkrw 5m : p99 0.42% / 21% 的公共键超 0.05% / 极值 0.61%  ⇒ 明确不是同一口径
// 产品决定：不混源 ⇒ usdkrw 维持「只走东财、只刷 5m/30m」，1m/15m/60m 是**已知缺口**。
//   （usdchf 曾经也在这里，核对擦边 0.059%；产品决定接新浪并保留兜底标记 ⇒ 已移出本表。）
const MINUTE_HOLD_KEYS = new Set(['usdkrw']);

// 兜底识别用的「新浪优先」集合（5 个交叉盘 + 5 个美元对 + usdchf + usdcny，共 12 个）。
// 本轮若实际由东财供数 ⇒ 新浪在这个周期失败了，必须可区分、可计数（产品要求）。
// "同一文件长期两源交替" 就是 filename 在 新浪/东财 之间来回 —— 一旦出现要停下来报告。
// ⚠ usdcny 自 2026-11-22（北京）起纳入统计：此前它分钟已是新浪优先，但兜底未计数，
//   历史次数无法回溯，`fallbackCount` / `fallbacks` 从纳入当轮起算。
const SINA_PRIMARY_KEYS = new Set([
  'eurcny', 'gbpcny', 'jpycny', 'krwcny', 'audcny',
  'eurusd', 'gbpusd', 'usdjpy', 'audusd', 'usdcad', 'usdchf',
  'usdcny',
]);
let fallbackCount = 0;
const fallbacks = [];
let sourceSwitches = 0;
const sourceSwitchList = [];

// 周期 → 根数上限 + 抓取顺序。
// ⚠ 顺序按**重要度**：5m 最常用，排最前（被打断时最新鲜的是它）；
//   60m/30m 的历史变化慢、1m 一天就多几百根，根数可以少给。
//
// ⚠ 各组的真实跨度差一个量级，不强行合成一个数。下面是 2026-11-22 拿
//   data/kline/min/ 现有分钟文件反推（按「首末根差 / 覆盖自然日」）：
//     · 外汇：1000 根 5m ≈3.5~4.5 天 / 5；30m ≈21~29 天 / 25~30；60m ≈41~58 天 / 50~60；
//       600 根 15m ≈6~9 天 / 8~9；1m 源端到顶 1,361~1,411 根 ≈1 天。
//     · 股票：1000 根 5m ≈14~21 天 / 15~22；30m ≈79~131 天 / 83~133；60m ≈150~239 天 / 157~243；
//       600 根 15m ≈24~39 天 / 25~40；1m 只回当日一节（n225 330、欧洲 510、韩美 390 根）。
//     · 商品：1000 根 5m ≈9~11 天 / 10~12；30m ≈28~52 天 / 30~56；60m ≈56~110 天 / 58~115；
//       600 根 15m ≈8~16 天 / 9~17；1m 源端到顶：xau/xag 1,395 根≈1 天、上金所 389 根。
//
// ⚠ 1m 的 1,500 是「请求上限」，不是承诺：源端单次只给约 1 个交易日
//   （2026-11-22 实测：东财 lmt 传 300/2000/20000 都回同样的 1,439 根；
//    新浪 datalen≥2000 后不再增加，1,361~1,411 根）。
const PERIOD_SPEC = {
  '5m':  { limit: 1000, order: 1 },
  '30m': { limit: 1000, order: 2 },
  '60m': { limit: 1000, order: 3 },
  '15m': { limit: 600,  order: 4 },
  '1m':  { limit: 1500, order: 5 },
};

/**
 * 落盘窗口（根数）——与上面的抓取 limit **解耦**。
 *
 * 2026-11-18：原先这里是「抓 600 根 → 用 decideBars 和存量 1090 根比 → 判 shorter
 * 整条拒绝」，于是 15m/1m 只要被拒一次就永远回不去（84 个分钟文件全部冻结）。
 * 现在改成 upsert 合并后再按窗口裁掉最老的部分；窗口只决定保留多久，不参与新旧比较。
 */
// 落盘保留：1m 取 1440 根 = 24 小时品种约 1 个完整交易日。
// 想留 2 个交易日需要 2880 根，但每次 1m 轮换都会整文件重写，仓库历史增速约 3 倍；
// 2026-11-22 容量快照：repo 186.9 MiB / pack 176.1 MiB（黄档），本次不做 2880。
const KEEP_SPEC = { '5m': 2000, '30m': 1600, '60m': 1200, '15m': 1200, '1m': 1440 };
const DEFAULT_KEEP = 2000;

// 请求之间的间隔（毫秒）：东财按 IP 限流，打太密就会被挂住/拒绝。
// ⚠ Actions 的 runner IP 是**共享**的（同一 IP 上还有别的用户在打东财）⇒ 经常处于限流边缘，
//   间隔给到 4 秒，宁可慢也别把这一轮打挂。
const GAP_MS = 4000;
// 单个请求的**硬超时**（毫秒）：超时按失败处理，继续下一个，不让整轮被拖死
const REQ_TIMEOUT_MS = 20000;
// 失败重试次数（额外再试一次）
const RETRIES = 1;
const RETRY_WAIT_MS = 4000;

// 低于这个根数不写：宁可不写，也不要留一份「只有几根」的残缺快照
const MIN_BARS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 给 promise 加硬超时。
 * ⚠ 两个分支都**resolve**（不 reject）⇒ 落败的那条 promise 即使稍后 reject
 *   也不会变成 unhandled rejection 把进程带崩（Node 22 默认会崩）。
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, err: new Error(`${label} 超时 ${ms}ms`) }), ms);
    if (timer.unref) timer.unref();
  });
  const work = promise.then(
    (v) => ({ ok: true, value: v }),
    (e) => ({ ok: false, err: e })
  );
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const periodList = (PERIODS_ARG.length
  ? PERIODS_ARG.split(',').map((s) => s.trim()).filter(Boolean)
  : AUTO_PERIODS
)
  .sort((a, b) => (PERIOD_SPEC[a]?.order ?? 99) - (PERIOD_SPEC[b]?.order ?? 99));

const keys = ONLY ? TARGET_KEYS.filter((k) => k === ONLY) : TARGET_KEYS;

// ── 1 轮/小时节流（2026-11-22）───────────────────────────────────────────
//   CF 的 :17 / :47 与 GitHub 兜底 :02 都会触发本脚本。以前每个触发都完整跑一轮，
//   实测约 2 轮/小时。现在入口统一限到 50 分钟：同一次「上轮结束后 50 分钟内」直接退出。
//   · --force：代码 push（workflow 的 push 触发）或人工排查时绕过；
//   · --dry-run：只抓不写，不参与节流，方便测量。
if (!DRY && !FORCE) {
  let last = '';
  try {
    last = JSON.parse(await readFile(STATUS_FILE, 'utf8')).generatedAt || '';
  } catch { /* 没有状态文件 = 从没跑过，放行 */ }
  if (!minuteRoundDue(last)) {
    const min = Math.round((Date.now() - Date.parse(last)) / 60000);
    console.log(`[update-kline-minute] 距上轮 ${min} 分钟（<50）→ 跳过本轮，保持 1 轮/小时`);
    process.exit(0);
  }
}

console.log(
  `[update-kline-minute] 目标 ${keys.length} 个标的 × 周期 ${periodList.join('/')} ` +
  `· 间隔 ${GAP_MS}ms · 硬超时 ${REQ_TIMEOUT_MS}ms${DRY ? '（dry-run）' : ''}`
);

let changed = 0;
let same = 0;
let locked = 0;
const failures = [];
const rejected = [];
const results = [];

// 命中限流/熔断的特征（后端的错误文案里就有）
const isThrottle = (msg) => /限流|熔断|连续\s*\d+\s*次连接失败/.test(msg);

// ⚠⚠ **按「周期」优先遍历，不是按标的**：先把 5m 的**全部标的**刷完，再刷 30m。
//   理由：Actions 的 runner IP 共享、经常处于东财限流边缘，一轮打到一半被限流是常态。
//   若按标的遍历，被限流时只有前面少数标的拿到了 3 个周期、其余标的一个周期都没有；
//   按周期遍历则至少保证「5m 对所有标的」是齐的（5m 才是最常用的那个）。
//
// ── 2026-11-21 更正：限流不再「整轮终止」────────────────────────────────
//   实测 2026-11-21 11:50Z 那一轮 ok=16 / failed=1，唯一失败是 usdjpy/5m，
//   而它正好是 5m 这一遍的第 17 个标的 ⇒ 原来的 break outer 让 30m 与轮换周期
//   这一轮**一次请求都没发**（提交记录里只有 _heartbeat.json 变了）。
//   ⇒ 现在：命中限流只做一次冷却，然后**继续跑剩下的标的**。东财那组主机熔断后，
//     后续东财调用是零 HTTP 的秒失败；排在后面的新浪标的（外汇）不受影响。
//     不做「连续 N 个周期就整轮收手」——2026-11-21 本机实测证明那会让整轮 0 个更新。
const THROTTLE_COOLDOWN_MS = 30000;
let throttleHit = false;
let throttleCooled = false;

// 某标的某周期「上一次成功写入的时间」（文件里的 generatedAt）。
// 读不到（文件不存在/损坏）返回 0 ⇒ 排最前，优先补。
async function lastOkMs(key, period) {
  const file = path.join(OUT_DIR, `${key}_${period}.json`);
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    const t = Date.parse(doc.generatedAt || '');
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

// 每个周期内按「最久没成功」升序排 —— 限流时被落下的标的，下一轮先跑。
// 没有这一条时，限流总是发生在固定位置（5m 这一遍的第 17 个），
// 排在它后面的标的会**永远**轮不到。
async function orderByStaleness(period, list) {
  const pairs = await Promise.all(list.map(async (k) => [k, await lastOkMs(k, period)]));
  pairs.sort((a, b) => a[1] - b[1]);
  return pairs.map((p) => p[0]);
}

// 每个标的 × 周期的本轮结果，写进 _status.json。
// 目的：让「某个标的某个周期连续几天没刷新」在仓库里**一眼可见**，
// 而不是只能靠人工去翻 84 个文件的 generatedAt。
const perTarget = {};
const mark = (key, period, status, extra = {}) => {
  perTarget[`${key}/${period}`] = { status, ...extra };
};

for (const period of periodList) {
  const periodKeys = await orderByStaleness(period, keys);
  for (const key of periodKeys) {
    // 重叠核对未通过的标的：只刷每轮必刷的 5m/30m，不进入轮换周期（见 MINUTE_HOLD_KEYS 注释）
    if ((PERIOD_SPEC[period]?.order ?? 0) >= 3 && MINUTE_HOLD_KEYS.has(key)) continue;
    const meta = klineTarget(key);
    if (!meta) {
      failures.push(`${key}: 未知标的`);
      mark(key, period, 'error', { reason: '未知标的' });
      continue;
    }
    const spec = PERIOD_SPEC[period] || { limit: 1000 };
    const file = path.join(OUT_DIR, `${key}_${period}.json`);

    let bars = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= RETRIES && !bars; attempt++) {
      if (attempt > 0) {
        console.log(`  … ${key} ${period} 重试（${RETRY_WAIT_MS}ms 后）`);
        await sleep(RETRY_WAIT_MS);
      }
      const r = await withTimeout(
        fetchKline(key, period, spec.limit),
        REQ_TIMEOUT_MS,
        `${key} ${period}`
      );
      if (r.ok && r.value && r.value.length) {
        bars = r.value;
      } else {
        lastErr = r.err || new Error('返回空');
      }
    }

    if (!bars) {
      const why = String(lastErr?.message || lastErr).slice(0, 100);
      failures.push(`${key}/${period}: ${why}`);
      console.log(`  ⚠ ${key.padEnd(9)} ${period.padEnd(3)} 失败：${why}`);
      mark(key, period, 'fail', { reason: why, lastOkAt: await lastOkMs(key, period) });
      // 命中限流/熔断 ⇒ 东财那组主机已经/即将进入熔断：**后续东财调用是零 HTTP 的秒失败**，
      // 所以不中断循环 —— 否则按周期优先遍历时，排在后面的新浪标的（外汇）会被一起饿死，
      // 这就是 2026-11-21 本机实测到的问题（dxy 打头，东财一挂，整轮 0 个更新）。
      // 只在第一次命中时冷却一次，避免对「未熔断但返回限流文案」的情况连续猛打。
      if (isThrottle(why)) {
        throttleHit = true;
        mark(key, period, 'skip', { reason: why, lastOkAt: await lastOkMs(key, period) });
        if (!throttleCooled) {
          throttleCooled = true;
          console.log(`  ⛔ 东财限流/熔断：冷却 ${THROTTLE_COOLDOWN_MS / 1000}s 后继续跑其余标的（东财标的会秒失败，新浪标的照常）`);
          await sleep(THROTTLE_COOLDOWN_MS);
        }
        continue;
      }
      await sleep(GAP_MS);
      continue;
    }
    if (bars.length < MIN_BARS) {
      failures.push(`${key}/${period}: 只取到 ${bars.length} 根`);
      console.log(`  ⚠ ${key.padEnd(9)} ${period.padEnd(3)} 只取到 ${bars.length} 根，不足 ${MIN_BARS} 根，不写`);
      mark(key, period, 'short', { bars: bars.length, lastOkAt: await lastOkMs(key, period) });
      await sleep(GAP_MS);
      continue;
    }

    const incoming = bars.map((b) => [b.t, b.o, b.c, b.h, b.l, b.v]);
    const lock = await acquireKlineLock(key);
    if (!lock.ok) {
      locked++;
      console.log(`  ${lockSkipText(key, lock)}`);
      mark(key, period, 'locked', { lastOkAt: await lastOkMs(key, period) });
      await sleep(GAP_MS);
      continue;
    }
    try {
      // 2.4.10 的短覆盖守卫**不适用于分钟窗口**：分钟序列是「只增不减的滚动窗口」，
      //   且每一轮写入的最后一根都是还没走完的 bar，下一轮必被源侧重述
      //   （实测 eurusd/5m 只有最后一根 1.1052 → 1.1053 的差异）。
      //   用 decideBars 逐根精确比较 ⇒ 一条 1 分钱的差异就把整条判死、文件永久冻结。
      //   ⇒ 按时间键 upsert（保留旧历史、新值覆盖），再按 KEEP_SPEC 裁掉最老的头部。
      let outBars = incoming;
      let oldDoc = null;
      if (existsSync(file)) {
        try { oldDoc = JSON.parse(await readFile(file, 'utf8')); } catch { oldDoc = null; }
      }
      if (oldDoc && Array.isArray(oldDoc.bars) && oldDoc.bars.length) {
        const merged = upsertBars(oldDoc.bars, incoming);
        const keep = KEEP_SPEC[period] || DEFAULT_KEEP;
        outBars = merged.length > keep ? merged.slice(merged.length - keep) : merged;
      }

      const servedBy = getKlineSource() || '未知';
      // 兜底识别（2026-11-21 产品要求）：这些标的的分钟**应以新浪为准**，
      // 若本轮实际由东财供数，说明新浪在这个周期失败了 ⇒ 记一次 fallback，
      // 并和文件里上一次的取数源比对，判断是否出现「同一文件两源交替」。
      const isSinaServed = /新浪/.test(servedBy);
      const providerOf = (s) => {
        const t = String(s || '');
        if (/新浪/.test(t)) return '新浪';
        if (/东财|东方财富/.test(t)) return '东财';
        if (/腾讯/.test(t)) return '腾讯';
        if (/上金所/.test(t)) return '上金所';
        return '';
      };
      let fallbackInfo = null;
      if (!DRY && SINA_PRIMARY_KEYS.has(key) && !isSinaServed) {
        const prevProvider = providerOf(oldDoc?.source);
        fallbackInfo = {
          fallback: servedBy,
          prevSource: prevProvider || '未知',
          // 上一轮已经是新浪、这一轮退回东财 ⇒ 真正的「两源交替」（不是首次切换）
          alternated: prevProvider === '新浪',
        };
        fallbackCount++;
        fallbacks.push(`${key}/${period}: 新浪失败，本轮由${servedBy}兜底` + (fallbackInfo.alternated ? '（与上一轮源不同，出现交替）' : ''));
        console.log(`  ⚠ ${key.padEnd(9)} ${period.padEnd(3)} 本轮用${servedBy}兜底（应走新浪）` + (fallbackInfo.alternated ? '，且与上一轮源不一致' : ''));
      }
      // 任何标的只要「本轮取数源 ≠ 上一轮文件的取数源」，都记一次切换。
      // 分钟文件是 upsert 合并，换源会让同一文件前后半段来自不同后端（接缝），
      // 所以这个数字必须可见 —— 6 个美元对 + usdcny 是双源标的（usdkrw 与交叉盘为单源）。
      if (!DRY && oldDoc) {
        const prevProvider = providerOf(oldDoc.source);
        const nowProvider = providerOf(servedBy);
        if (prevProvider && nowProvider && prevProvider !== nowProvider) {
          sourceSwitches++;
          sourceSwitchList.push(`${key}/${period}: ${prevProvider} → ${nowProvider}`);
          console.log(`  ℹ ${key.padEnd(9)} ${period.padEnd(3)} 取数源变化：${prevProvider} → ${nowProvider}`);
        }
      }

      const payload = {
        key,
        name: meta.name,
        market: meta.market,
        period,
        generatedAt: new Date().toISOString(),
        source: `服务端预生成的分钟K（limit=${spec.limit}）· 取数源：${servedBy}`,
        caliber: meta.klineNote || '',
        // 紧凑数组行：[t,o,c,h,l,v]
        bars: outBars,
      };
      const text = JSON.stringify(payload);

      // 内容没变就不写 —— 免得每次跑都产生一个「只有 generatedAt 变了」的提交
      let unchanged = false;
      if (oldDoc) {
        if (JSON.stringify(oldDoc.bars || []) === JSON.stringify(payload.bars)) unchanged = true;
      }

      if (unchanged) {
        same++;
        console.log(
          `  ${key.padEnd(9)} ${period.padEnd(3)} ${String(payload.bars.length).padStart(4)} 根  内容未变，跳过`
        );
        mark(key, period, 'ok', {
          bars: payload.bars.length,
          unchanged: true,
          // 没重写文件 ⇒ 「最后一次成功」仍是旧文件里的时间
          lastOkAt: Date.parse(oldDoc?.generatedAt || '') || 0,
          ...(fallbackInfo || {}),
        });
      } else {
        if (!DRY) {
          await mkdir(OUT_DIR, { recursive: true });
          await writeFile(file, text, 'utf8');
        }
        changed++;
        console.log(
          `  ${key.padEnd(9)} ${period.padEnd(3)} ${String(payload.bars.length).padStart(4)} 根  ` +
          `${payload.bars[0][0]} → ${payload.bars[payload.bars.length - 1][0]}  [${getKlineSource() || '未知源'}]${DRY ? '（dry-run）' : ''}`
        );
        mark(key, period, 'ok', {
          bars: payload.bars.length,
          changed: true,
          lastOkAt: Date.parse(payload.generatedAt) || 0,
          ...(fallbackInfo || {}),
        });
      }
      results.push({ key, period, bars: payload.bars.length, from: payload.bars[0][0], to: payload.bars[payload.bars.length - 1][0] });
    } finally {
      await releaseKlineLock(lock);
    }
    await sleep(GAP_MS);
  }
}

// ── 失败时把原因落到仓库里 ──────────────────────────────────────────────
//   Actions 的作业日志要鉴权才看得到 ⇒ 写一个 _status.json（进仓库），
//   匿名也能通过 commits API 看到「哪几个标的没抓到、为什么」。
//
//   2026-11-21：**每轮都写**（含全成功），并带上 perTarget。
//   原因：旧逻辑「全成功就 rm」导致健康时反而没有任何可观测数据，
//   而真正的问题恰恰不是「全成功/全失败」，是「某个标的某个周期长期没刷新」——
//   那种状态在旧文件里完全看不出来，只能人工去翻每个文件的 generatedAt。
if (!DRY) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    STATUS_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        durationMs: Date.now() - START_MS,
        ok: results.length,
        failed: failures.length,
        throttleHit,
        // 东财实际发出的 HTTP 请求数（含重试，不含缓存命中/熔断拒绝）。
        // 实测 34~35 次/轮（含重试，随东财可达性浮动）；配置基线 32 次/轮。
        emRequests: emStats.requests,
        emFailures: emStats.failures,
        // 本轮 SINA_PRIMARY_KEYS 里「本应走新浪却由东财兜底」的次数
        // （5 个交叉盘无东财代码、无法兜底；6 个美元对 + usdcny 可兜底）。
        // 一旦同一文件两源交替，alternated=true，需要人工判断，不要自行放宽。
        fallbackCount,
        fallbacks,
        // 任意标的「本轮取数源 ≠ 上一轮文件取数源」的次数（换源会在文件里留接缝）
        sourceSwitches,
        sourceSwitchList,
        failures,
        rejected,
        periodList,
        // 本轮每个 标的/周期 的结果：ok | fail | skip | short | locked | error
        // lastOkAt = 该文件里 generatedAt 的毫秒值（0 = 从来没有过）
        perTarget,
      },
      null,
      2
    ),
    'utf8'
  );
  const stale = Object.entries(perTarget)
    .filter(([, v]) => v.status !== 'ok' && v.status !== 'locked')
    .map(([k]) => k);
  console.log(
    `  ℹ 状态已写入 ${path.relative(ROOT, STATUS_FILE)}` +
    `（非 ok ${stale.length} 项：失败 ${failures.length} / 拒绝 ${rejected.length}）`
  );
}

console.log(
  `[update-kline-minute] 更新 ${changed} 个 / 无变化 ${same} 个 / 锁占用 ${locked} 个 / 拒绝 ${rejected.length} 个（短覆盖） / 失败 ${failures.length} 个` +
  (throttleHit ? '（本轮有限流：部分周期被跳过，明细见 _status.json）' : '')
);
// 实测的东财请求数（含重试）——多轮实测 34~35 次/轮，随东财可达性浮动
console.log(`[update-kline-minute] 东财实际请求 ${emStats.requests} 次（失败 ${emStats.failures} 次）`);
if (fallbackCount) {
  console.log(`[update-kline-minute] ⚠ 新浪兜底 ${fallbackCount} 次：`);
  fallbacks.forEach((f) => console.log('  - ' + f));
  if (fallbacks.some((f) => f.includes('交替'))) {
    console.log('  ⛔ 出现「同一文件两源交替」——按约定应停下并人工判断，不要自行放宽。');
  }
}
if (rejected.length) {
  console.log('拒绝明细：');
  rejected.forEach((f) => console.log('  - ' + f));
}
if (failures.length) {
  console.log('失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
// ⚠ **限流是常态**（Actions 的 runner IP 是共享的，经常在东财的限流边缘）
//   ⇒ 不把作业标成失败：失败明细写在 _status.json 里（进仓库，匿名可读），
//   下一轮（每小时）自动补齐。作业标红只会把真正的问题淹没在噪声里。
if (!results.length && failures.length) {
  console.log('本轮一个都没抓到（多半是东财限流），下一轮再试。');
}
