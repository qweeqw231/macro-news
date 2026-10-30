// scripts/update-kline-minute.mjs
// 生成「服务端预生成的分钟K」：data/kline/min/<key>_<period>.json
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
//   伦敦金/布伦特：**全网都没有同口径的分钟源**（新浪外盘只有日线）⇒ 保持「无分钟级数据」，
//     前端会明确说明原因，而不是画一张假图。
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
//   node scripts/update-kline-minute.mjs --dry-run    # 只抓不写
//   node scripts/update-kline-minute.mjs --only cac40
//   node scripts/update-kline-minute.mjs --periods 5m,15m
//
// 退出码：0 = 至少写成功一个（或全部已是最新）；1 = 一个都没成功

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKline, getKlineSource, klineTarget } from '../src/sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'kline', 'min');
const STATUS_FILE = path.join(OUT_DIR, '_status.json');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DRY = process.argv.includes('--dry-run');
const ONLY = arg('only', '');
const PERIODS = arg('periods', '').split(',').map((s) => s.trim()).filter(Boolean);

// 客户端没有别的分钟源 ⇒ 必须由服务端兜底
const TARGET_KEYS = [
  'n225',        // 日经225      100.N225
  'dax',         // 德国DAX30    100.GDAXI
  'cac40',       // 法国CAC40    100.FCHI
  'ukx',         // 英国富时100  100.FTSE
  'kospi',       // 韩国KOSPI    100.KS11
  'sge_au9999',  // 上海金Au99.99 118.AU9999
  'xag',         // 伦敦银       122.XAG（与报价 hf_XAG 同一条线，实测年均差 <0.7%）
];

// 周期 → 根数上限 + 抓取顺序。
// ⚠ 顺序按**重要度**：5m 最常用，排最前（被打断时最新鲜的是它）；
//   60m/30m 的历史变化慢、1m 一天就多几百根，根数可以少给。
const PERIOD_SPEC = {
  '5m':  { limit: 1000, order: 1 },   // ≈ 13 个交易日
  '30m': { limit: 1000, order: 2 },   // ≈ 80 个交易日
  '60m': { limit: 1000, order: 3 },   // ≈ 160 个交易日
  '15m': { limit: 600,  order: 4 },   // ≈ 24 个交易日
  '1m':  { limit: 300,  order: 5 },   // ≈ 1.2 个交易日
};

// 请求之间的间隔（毫秒）：东财按 IP 限流，打太密就会被挂住/拒绝
const GAP_MS = 1200;
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

const periodList = (PERIODS.length ? PERIODS : Object.keys(PERIOD_SPEC))
  .sort((a, b) => (PERIOD_SPEC[a]?.order ?? 99) - (PERIOD_SPEC[b]?.order ?? 99));

const keys = ONLY ? TARGET_KEYS.filter((k) => k === ONLY) : TARGET_KEYS;

console.log(
  `[update-kline-minute] 目标 ${keys.length} 个标的 × 周期 ${periodList.join('/')} ` +
  `· 间隔 ${GAP_MS}ms · 硬超时 ${REQ_TIMEOUT_MS}ms${DRY ? '（dry-run）' : ''}`
);

let changed = 0;
let same = 0;
const failures = [];
const results = [];

for (const key of keys) {
  const meta = klineTarget(key);
  if (!meta) {
    failures.push(`${key}: 未知标的`);
    continue;
  }
  for (const period of periodList) {
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
      await sleep(GAP_MS);
      continue;
    }
    if (bars.length < MIN_BARS) {
      failures.push(`${key}/${period}: 只取到 ${bars.length} 根`);
      console.log(`  ⚠ ${key.padEnd(9)} ${period.padEnd(3)} 只取到 ${bars.length} 根，不足 ${MIN_BARS} 根，不写`);
      await sleep(GAP_MS);
      continue;
    }

    const payload = {
      key,
      name: meta.name,
      market: meta.market,
      period,
      generatedAt: new Date().toISOString(),
      source: `服务端预生成的分钟K（limit=${spec.limit}）· 取数源：${getKlineSource() || '未知'}`,
      caliber: meta.klineNote || '',
      // 紧凑数组行：[t,o,c,h,l,v]
      bars: bars.map((b) => [b.t, b.o, b.c, b.h, b.l, b.v]),
    };
    const text = JSON.stringify(payload);

    // 内容没变就不写 —— 免得每次跑都产生一个「只有 generatedAt 变了」的提交
    let unchanged = false;
    if (existsSync(file)) {
      try {
        const old = JSON.parse(await readFile(file, 'utf8'));
        if (JSON.stringify(old.bars || []) === JSON.stringify(payload.bars)) unchanged = true;
      } catch {
        /* 文件损坏 → 重新写 */
      }
    }

    if (unchanged) {
      same++;
      console.log(
        `  ${key.padEnd(9)} ${period.padEnd(3)} ${String(bars.length).padStart(4)} 根  内容未变，跳过`
      );
    } else {
      if (!DRY) {
        await mkdir(OUT_DIR, { recursive: true });
        await writeFile(file, text, 'utf8');
      }
      changed++;
      console.log(
        `  ${key.padEnd(9)} ${period.padEnd(3)} ${String(bars.length).padStart(4)} 根  ` +
        `${bars[0].t} → ${bars[bars.length - 1].t}  [${getKlineSource() || '未知源'}]${DRY ? '（dry-run）' : ''}`
      );
    }
    results.push({ key, period, bars: bars.length, from: bars[0].t, to: bars[bars.length - 1].t });
    await sleep(GAP_MS);
  }
}

// ── 失败时把原因落到仓库里 ──────────────────────────────────────────────
//   Actions 的作业日志要鉴权才看得到 ⇒ 写一个 _status.json（进仓库），
//   匿名也能通过 commits API 看到「哪几个标的没抓到、为什么」。
//   全成功时不写这个文件（避免每次跑都产生一个只改时间戳的提交）。
if (!DRY) {
  await mkdir(OUT_DIR, { recursive: true });
  if (failures.length) {
    await writeFile(
      STATUS_FILE,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          ok: results.length,
          failed: failures.length,
          failures,
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`  ⚠ 失败明细已写入 ${path.relative(ROOT, STATUS_FILE)}（${failures.length} 条）`);
  } else if (existsSync(STATUS_FILE)) {
    await rm(STATUS_FILE, { force: true });
    console.log('  ✓ 全部成功，删除上一轮的失败状态文件');
  }
}

console.log(
  `[update-kline-minute] 更新 ${changed} 个 / 无变化 ${same} 个 / 失败 ${failures.length} 个`
);
if (failures.length) {
  console.log('失败明细：');
  failures.forEach((f) => console.log('  - ' + f));
}
// 只要写成功过一个就算这轮可用（下一轮会补齐没抓到的）——
// 全部失败才报错，避免每小时都把作业标成失败、淹没真正的问题。
if (!changed && !same && failures.length) process.exitCode = 1;
