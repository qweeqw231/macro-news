// src/snapshot.mjs
// 「时点快照」采集：上午盘收盘价（am）与当日收盘价（pm）
//
// ── 要解决的问题 ──
//   quotes.json 里的价格是「谁先跑到谁抓到」的实时价：A 股指数可能记的是盘中价，
//   上午盘的值会被下午盘覆盖、无法回溯 —— 所以需要一个**按交易日归档、不可覆盖**
//   的时点记录。
//
// ── 定价逻辑：时点价一律走 K 线（确定性，不依赖「休市即冻结」这类假设）──
//   pm（收盘）→ 日 K 收盘价：A股 15:00 / 港股 16:00 / 美股隔夜收盘
//   am（上午）→ 5 分钟 K 的目标 bar：A股 11:30 / 港股 12:00
//   昨收       → 日 K 的上一行；A股 上午盘则用 5 分钟 K 里前一交易日的 15:00 那根
//
//   ⚠ 曾经尝试用「实时价 + 源时间戳自证」来省掉 K 线请求，实测**行不通**：
//     东财的源时间戳（f124 / f86）在收盘后仍会继续跳动（实测 15:32 → 16:26），
//     它是「数据推送时间」而不是「最后成交时刻」，因此无法证明价格冻结在目标价上。
//     K 线请求数虽然多，但每天每档只跑 1~2 次且带缓存，可接受；确定性更重要。
//
//   ★ 关键价值：K 线是**历史数据**，所以「断网了怎么办」= 事后任意时刻重跑一次
//     即可补出那天的真值，而不是只能从设备在线那一刻开始记录。
//     补拉上限 = 行情源的历史保留期（实测东财约 30+ 个交易日、腾讯 320 根 5 分钟 bar）。
//
// ── 口径校验（2026-10-29 本机实测）──
//   · 日 K 行：日期,开,收,高,低,量,额,振幅
//   · 5 分钟 K 行：时间,开,收,高,低,量,额,振幅；时间戳是**该 bar 的结束时刻**
//     （首根 09:35 = 覆盖 09:30–09:35；末根 15:00 = 覆盖 14:55–15:00）
//   · 交叉验证：5 分钟「15:00」bar 收盘价 == 日 K 当日收盘价
//     （上证 3651.43 / 沪深300ETF 4.111 / 机器人ETF 1.287，东财与腾讯三方全等）✔
//   · 交叉验证：5 分钟「11:30」bar（上证 开3653.53 收3647.12 高3653.56 低3647.12）
//     东财与腾讯全等 ✔
//   · ⚠ 东财港股 5 分钟 K 只到 15:35（缺 15:40–16:00），港股收盘价一律走日 K。
//
// 用法：
//   node src/snapshot.mjs                              # 自动：补齐今天缺失的 am/pm
//   node src/snapshot.mjs --session am                 # 强制采今天上午盘
//   node src/snapshot.mjs --session pm --date 2026-10-27  # 指定日期补拉
//   node src/snapshot.mjs --backfill 5                 # 回补最近 5 个自然日里缺失的快照
//   node src/snapshot.mjs --dry-run                    # 只打印，不写盘

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES } from './sources.mjs';
import { ETFS, etfTxCode } from './etf.mjs';
import { fetchPortfolioQuotes } from './portfolio.mjs';
import { fetchDailyK, fetchKline5m } from './kline.mjs';
import { emPool } from './em.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SNAP_DIR = path.join(DATA, 'snapshots');

const DRY_RUN = process.argv.includes('--dry-run');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 当前北京时间的日期与时刻 */
function beijingNow(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    hm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
  };
}

function isoCN(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`
  );
}

/** 'HH:MM' 加分钟 */
function hmAdd(hm, min) {
  const [h, m] = hm.split(':').map(Number);
  const t = h * 60 + m + min;
  return `${pad(Math.floor(t / 60) % 24)}:${pad(t % 60)}`;
}

// ---- 时点定义（北京时间）----
// ⚠ readyAt 必须取「该 session 里最晚收盘的那个市场 + 2 分钟缓冲」，不是 A 股收盘时刻：
//   pm 文件同时含 CN/ETF（15:00）与 HK（16:00），15:10 跑的话港股日 K 还是盘中值；
//   am 文件同时含 CN（11:30）与 HK（12:00），11:35 跑的话港股上午 bar 还没收。
//   2026-10-30 事故：`--backfill` 根本没检查 readyAt，14:24 就跑出 pm，
//   把盘中日 K 当收盘价写进 asOf=15:00（csi300 4002.41 vs 官方 3985.50，+0.42%）。
const SESSIONS = {
  am: { label: '上午盘', readyAt: '12:02' },
  pm: { label: '收盘', readyAt: '16:02' },
};
// 目标时点：A股/ETF 上午 11:30、收盘 15:00；港股上午 12:00、收盘 16:00
const SESSION_TARGET = {
  am: { CN: '11:30', ETF: '11:30', HK: '12:00' },
  pm: { CN: '15:00', ETF: '15:00', HK: '16:00' },
};
// 没有「上午盘/收盘」固定时刻的市场（美股/日经/欧股…）：取最近一个已收盘交易日
const NO_SESSION_TARGET = new Set(['US', 'JP', 'EU', 'UK', 'KR']);
// 实时价「已冻结在目标价」的容忍窗口（分钟）
const FREEZE_TOLERANCE_MIN = 5;

async function readJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 目标清单：指数 + 场内 ETF + 组合日频值 */
function buildTargets() {
  const list = [];
  for (const i of INDICES) {
    list.push({
      key: i.key, name: i.name, market: i.market, kind: 'index', secid: i.secid, tx: i.tx,
      amBar: i.market === 'CN' ? '11:30' : i.market === 'HK' ? '12:00' : null,
    });
  }
  for (const e of ETFS) {
    list.push({
      key: e.key, name: e.name, market: 'ETF', kind: 'etf', secid: e.secid,
      tx: etfTxCode(e.secid), theme: e.theme, region: e.region || 'CN',
      amBar: '11:30',
    });
  }
  // 组合 7 个 key：日频/24 小时连续，无分钟级历史 → 只在当日有效
  for (const [key, name, market] of [
    ['ndx', '纳指100', 'US'],
    ['xau', '伦敦金', 'CMDTY'],
    ['xag', '伦敦银', 'CMDTY'],
    ['brent', '布伦特原油', 'CMDTY'],
    ['sge_au9999', '上海金Au99.99', 'SGE'],
    ['usdcny', '人民币中间价', 'FX'],
    ['cgb_1y', '1Y国债收益率', 'CN'],
  ]) {
    list.push({ key, name, market, kind: 'portfolio', secid: null, tx: null, amBar: null });
  }
  return list;
}

/**
 * 实时价是否可当作「目标时点价」使用。
 * ⚠ 实测行不通，故已废弃：东财的源时间戳（f124 / f86）在收盘后仍持续跳动
 *   （实测 15:32 → 16:26），它是「数据推送时间」而非「最后成交时刻」，
 *   无法证明价格冻结在目标价上。保留此函数仅作对照说明。
 */
function realtimeIsTargetPrice(q, targetDate, targetHm, nowHm) {
  if (!q || !(q.price > 0) || !q.updatedAt) return false;
  const srcDate = String(q.updatedAt).slice(0, 10);
  const srcHm = String(q.updatedAt).slice(11, 16);
  if (srcDate !== targetDate) return false;
  const tol = hmAdd(targetHm, FREEZE_TOLERANCE_MIN);
  if (!(nowHm >= tol)) return false;
  return srcHm <= tol;
}

/** 日 K 里「不晚于 date 的最近一条」 */
function pickDaily(map, date) {
  if (!map) return null;
  if (map.has(date)) return { date, bar: map.get(date) };
  let best = null;
  for (const [d, bar] of map) {
    if (d <= date && (!best || d > best.date)) best = { date: d, bar };
  }
  return best;
}

/** 日 K 里「严格早于 date 的最近一条」（= 昨收） */
function pickPrevDaily(map, date) {
  if (!map) return null;
  let best = null;
  for (const [d, bar] of map) {
    if (d < date && (!best || d > best.date)) best = { date: d, bar };
  }
  return best;
}

/** 5 分钟 K 里「date 之前最近的一个 HH:MM bar」（A股/ETF 的昨收 = 前一交易日 15:00 那根） */
function pickPrevBar(map, date, hm) {
  if (!map) return null;
  let best = null;
  for (const [t, bar] of map) {
    const d = t.slice(0, 10);
    if (d < date && t.endsWith(hm) && (!best || d > best.date)) best = { date: d, bar };
  }
  return best;
}

/**
 * 日 K 收盘时刻标签。
 * A股/ETF 15:00 收盘，港股 16:00 收盘；其余市场（美股/欧股…）的日 K 日期是
 * 交易所当地日期，换算到北京会跨天，所以只给日期、不编造时刻。
 */
function closeLabel(market, date) {
  if (market === 'CN' || market === 'ETF') return `${date}T15:00:00+08:00`;
  if (market === 'HK') return `${date}T16:00:00+08:00`;
  return `${date}`;
}

/**
 * 生成一份快照。
 * @param {string} date    交易日 YYYY-MM-DD
 * @param {'am'|'pm'} session
 */
async function buildSnapshot(date, session) {
  const targets = buildTargets();
  const secidTargets = targets.filter((t) => t.secid);
  const now = beijingNow();
  const isToday = date === now.date;

  // ---- 1. 组合日频值（只在当日有效）----
  let portfolio = new Map();
  if (isToday) {
    try {
      const res = await fetchPortfolioQuotes();
      portfolio = new Map(res.quotes.map((q) => [q.key, q]));
    } catch (err) {
      console.log(`  ⚠️ 组合行情失败：${err.message}`);
    }
  }

  // ---- 2. 决定每个标的取哪种 K 线 ----
  //   pm → 日 K（收盘价）；am → 5 分钟 K（上午盘时点价）
  //   美股/欧股…：没有「上午盘」概念，两种 session 都取日 K（最近已收盘交易日）
  //   港股上午盘额外要日 K：它的昨收是「上一交易日 16:00 收盘价」，
  //   而东财/腾讯的 5 分钟 K 里港股只到 15:35，没有 16:00 那根。
  const needDaily = [];
  const needMinute = [];
  for (const t of secidTargets) {
    if (NO_SESSION_TARGET.has(t.market)) {
      needDaily.push(t);
      continue;
    }
    if (session === 'pm') needDaily.push(t);
    else needMinute.push(t);
    if (session === 'am' && t.market === 'HK') needDaily.push(t);
  }

  // ---- 4. 取 K 线 ----
  const [dailyRes, minuteRes] = await Promise.all([
    emPool(needDaily, 3, (t) => fetchDailyK(t.secid, t.tx)),
    emPool(needMinute, 3, (t) => fetchKline5m(t.secid, t.tx)),
  ]);
  const daily = new Map();
  const dailyFail = {};
  dailyRes.forEach((r, i) => {
    if (r.ok) daily.set(needDaily[i].key, r.value);
    else dailyFail[needDaily[i].key] = r.error;
  });
  const minute = new Map();
  const minuteFail = {};
  minuteRes.forEach((r, i) => {
    if (r.ok) minute.set(needMinute[i].key, r.value);
    else minuteFail[needMinute[i].key] = r.error;
  });

  // ---- 5. 组装 ----
  const quotes = {};
  const missing = {};
  let priced = 0;

  for (const t of targets) {
    const base = {
      name: t.name, market: t.market, kind: t.kind,
      ...(t.theme ? { theme: t.theme } : {}),
      ...(t.region ? { region: t.region } : {}),
    };

    // 5a. 组合日频值
    if (t.kind === 'portfolio') {
      if (!isToday) {
        missing[t.key] = '日频值无法回溯（仅当日有效）';
        continue;
      }
      const q = portfolio.get(t.key);
      if (!q || !(q.price > 0)) {
        missing[t.key] = '当日采集失败';
        continue;
      }
      quotes[t.key] = {
        ...base,
        name: q.name || t.name,
        price: q.price,
        prevClose: q.prevClose ?? null,
        changePct: q.prevClose
          ? Number((((q.price - q.prevClose) / q.prevClose) * 100).toFixed(4))
          : (q.changePct ?? null),
        open: q.open ?? null, high: q.high ?? null, low: q.low ?? null,
        asOf: q.updatedAt,
        priceSource: 'daily',
        note: t.key === 'xau' ? '24小时连续交易，非收盘价' : '',
      };
      priced++;
      continue;
    }

    const dmap = daily.get(t.key);
    const mmap = minute.get(t.key);
    const exact = t.market === 'CN' || t.market === 'ETF' || t.market === 'HK';

    let price = null, asOf = null, priceSource = null, note = '';
    let open = null, high = null, low = null, prevClose = null;

    if (session === 'pm') {
      const pick = dmap ? (exact ? (dmap.has(date) ? { date, bar: dmap.get(date) } : null) : pickDaily(dmap, date)) : null;
      if (pick) {
        price = pick.bar.c; open = pick.bar.o; high = pick.bar.h; low = pick.bar.l;
        asOf = closeLabel(t.market, pick.date);
        priceSource = 'dailyK';
        if (pick.date !== date) note = '该市场当日尚未收盘，取最近一个已收盘交易日';
        const prev = pickPrevDaily(dmap, pick.date);
        prevClose = prev ? prev.bar.c : null;
      }
    } else {
      // 上午盘：5 分钟 K 的目标 bar
      const bar = t.amBar ? mmap?.get(`${date} ${t.amBar}`) : null;
      if (bar) {
        price = bar.c; open = bar.o; high = bar.h; low = bar.l;
        asOf = `${date}T${t.amBar}:00+08:00`;
        priceSource = 'kline5m';
        // A股/ETF 的昨收 = 前一交易日 15:00 那根（5 分钟 K 覆盖约 6 个交易日，够用）
        // ⚠ 港股例外：5 分钟 K 只到 15:35、没有 16:00 收盘 bar，拿 15:00 那根会把
        //   盘中价当成收盘价（2026-10-29 hsi 差 18.75 点）；交给下面的日 K 兜底。
        const prevBar = t.market === 'HK' ? null : pickPrevBar(mmap, date, '15:00');
        prevClose = prevBar ? prevBar.bar.c : null;
      } else if (NO_SESSION_TARGET.has(t.market)) {
        const pick = dmap ? pickDaily(dmap, date) : null;
        if (pick) {
          price = pick.bar.c; open = pick.bar.o; high = pick.bar.h; low = pick.bar.l;
          asOf = pick.date;
          priceSource = 'dailyK';
          note = '该市场无上午盘概念，取最近一个已收盘交易日（交易所当地日期）';
          const prev = pickPrevDaily(dmap, pick.date);
          prevClose = prev ? prev.bar.c : null;
        }
      }
      // 港股上午盘的昨收来自日 K（5 分钟 K 里港股没有 16:00 收盘 bar）
      if (prevClose === null && dmap) {
        const prev = pickPrevDaily(dmap, date);
        if (prev) prevClose = prev.bar.c;
      }
    }

    if (price === null) {
      missing[t.key] = session === 'pm'
        ? '无该日收盘价数据（非交易日、超出保留期或源限流）'
        : '无该时点数据（非交易日、超出保留期或源限流）';
      continue;
    }

    quotes[t.key] = {
      ...base,
      name: t.name,
      price,
      prevClose: prevClose ?? null,
      changePct: prevClose ? Number((((price - prevClose) / prevClose) * 100).toFixed(4)) : null,
      open, high, low,
      asOf,
      priceSource,
      note,
    };
    priced++;
  }

  const failDetail = {
    ...(Object.keys(dailyFail).length ? { dailyK: dailyFail } : {}),
    ...(Object.keys(minuteFail).length ? { kline5m: minuteFail } : {}),
  };

  // 非交易日判定：一个 A 股指数都拿不到价 → 这一天没有交易，别写文件
  const cnIndex = quotes.sh_comp || quotes.csi300 || quotes.sz_comp;

  return {
    date,
    session,
    sessionLabel: SESSIONS[session].label,
    capturedAt: isoCN(),
    generator: 'src/snapshot.mjs',
    targets: {
      am: { cn: '11:30', hk: '12:00' },
      pm: { cn: '15:00', hk: '16:00', note: 'pm 取日K官方收盘价' },
    },
    coverage: {
      total: targets.length,
      ok: priced,
      missing: Object.keys(missing).length,
      missingDetail: missing,
      ...(Object.keys(failDetail).length ? { sourceFailures: failDetail } : {}),
    },
    isTradingDay: !!cnIndex,
    quotes,
  };
}

function snapshotFile(date, session) {
  return path.join(SNAP_DIR, `${date}_${session}.json`);
}

/** 写盘；内容与既有文件一致则跳过（避免 git 反复存同样的 blob） */
async function writeSnapshot(file, doc) {
  const text = JSON.stringify(doc, null, 2);
  if (existsSync(file)) {
    try {
      const old = await readFile(file, 'utf8');
      const strip = (s) =>
        s.replace(/"(capturedAt|asOf|updatedAt|startedAt|endedAt|durationMs)"\s*:\s*"[^"]*"/g, '"_":"_"');
      if (strip(old) === strip(text)) return false;
    } catch { /* 读不了就照常写 */ }
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, 'utf8');
  return true;
}

async function listSnapshots() {
  if (!existsSync(SNAP_DIR)) return [];
  const files = await readdir(SNAP_DIR);
  return files.filter((f) => f.endsWith('.json')).sort();
}

async function main() {
  const started = Date.now();
  const now = beijingNow();
  const forceSession = arg('--session', null);
  const dateArg = arg('--date', null);
  const backfill = Number(arg('--backfill', '0')) || 0;

  // ---- 决定要补哪些 (date, session) ----
  const jobs = [];
  if (backfill > 0) {
    const base = Date.now();
    for (let i = 0; i < backfill; i++) {
      const d = ymd(new Date(base - i * 86400000));
      for (const s of ['am', 'pm']) {
        if (!existsSync(snapshotFile(d, s))) jobs.push({ date: d, session: s });
      }
    }
  } else if (forceSession) {
    jobs.push({ date: dateArg || now.date, session: forceSession });
  } else {
    for (const s of ['am', 'pm']) {
      if (now.hm >= SESSIONS[s].readyAt && !existsSync(snapshotFile(now.date, s))) {
        jobs.push({ date: now.date, session: s });
      }
    }
  }

  if (!jobs.length) {
    console.log(`[snapshot] 无需补采（当前北京时间 ${now.date} ${now.hm}）`);
    const files = await listSnapshots();
    console.log(`[snapshot] 现有快照 ${files.length} 份：${files.slice(-6).join(', ') || '无'}`);
    return;
  }

  // ⚠ 当天的 session 必须等「最晚收盘市场 + 2 分钟」之后才允许生成。
  //   否则拿到的日 K / 分时 bar 还是盘中值，却会被打上 asOf=收盘时刻的标签 ——
  //   这比缺一份快照更糟：下游无法分辨它是收盘价还是盘中价。
  const tooEarly = jobs.filter((j) => j.date === now.date && now.hm < SESSIONS[j.session].readyAt);
  if (tooEarly.length) {
    for (const j of tooEarly) {
      console.log(
        `  ⏭ ${j.date} ${j.session}：未到 ${SESSIONS[j.session].readyAt}（当前 ${now.hm}），` +
          '盘中价不能当成收盘价，跳过'
      );
    }
  }
  const readyJobs = jobs.filter((j) => !(j.date === now.date && now.hm < SESSIONS[j.session].readyAt));
  if (!readyJobs.length) {
    console.log(`[snapshot] 本轮全部未到采集时刻（当前 ${now.hm}）`);
    return;
  }

  console.log(`[snapshot] 待采 ${readyJobs.length} 份：${readyJobs.map((j) => `${j.date} ${j.session}`).join('、')}`);

  let written = 0, skipped = 0;
  for (const job of readyJobs) {
    const t0 = Date.now();
    let doc;
    try {
      doc = await buildSnapshot(job.date, job.session);
    } catch (err) {
      console.error(`  ❌ ${job.date} ${job.session}：${err.message}`);
      continue;
    }
    if (!doc.isTradingDay) {
      console.log(`  ⏭ ${job.date} ${job.session}：非交易日或数据不可得，不写文件`);
      if (doc.coverage.sourceFailures) {
        const s = doc.coverage.sourceFailures;
        console.log(`     源失败样例：${Object.entries(s.dailyK || s.kline5m || {}).slice(0, 3).map(([k, v]) => `${k}=${v}`).join('；')}`);
      }
      skipped++;
      continue;
    }
    const cov = doc.coverage;
    console.log(
      `  ${job.date} ${job.session}：${cov.ok}/${cov.total} 项有价（缺 ${cov.missing}）· ${Date.now() - t0}ms`
    );
    if (cov.sourceFailures) {
      const s = cov.sourceFailures;
      console.log(
        `     源失败：日K ${Object.keys(s.dailyK || {}).length} 个 / 5分钟K ${Object.keys(s.kline5m || {}).length} 个` +
        `  例：${Object.entries(s.dailyK || s.kline5m || {}).slice(0, 3).map(([k, v]) => `${k}=${v}`).join('；')}`
      );
    }
    if (DRY_RUN) {
      console.log(JSON.stringify(doc.quotes.sh_comp, null, 2));
      continue;
    }
    const file = snapshotFile(job.date, job.session);
    const changed = await writeSnapshot(file, doc);
    console.log(`     → ${path.relative(ROOT, file)}${changed ? '' : '（内容未变，跳过写盘）'}`);
    if (changed) written++;
  }

  console.log(`[snapshot] 完成：新写 ${written} 份，跳过 ${skipped} 份，用时 ${Date.now() - started}ms`);
}

main().catch((err) => {
  console.error('[snapshot] 致命错误', err);
  process.exit(1);
});
