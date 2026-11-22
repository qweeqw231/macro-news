// scripts/backfill-macro.mjs
// 跨天回补宏观日记录（data/macro/daily.json）与 1Y 国债日 K（data/kline/cgb_1y*.json）。
//
// 背景：日常增量由 src/portfolio-collect.mjs 只写「今天」；云端某个工作日全失败时，
//      这一天的记录就永久缺失。本脚本按日期重建：
//   · 两融余额 / 10Y 美债：按目标日期取当日（或之前最近）的值；
//   · 1Y 国债：查中债该日曲线，补一根日 K（周/月 K 同步重算）；
//   · 社融 / CPI / PMI 是月度值：从现有记录里取**离目标日最近**的一条（它们不会逐日变化）。
//
// 用法：
//   node scripts/backfill-macro.mjs                    # 默认回补最近 7 天（不含今天）
//   node scripts/backfill-macro.mjs --days 14
//   node scripts/backfill-macro.mjs --from 2026-10-26 --to 2026-10-30
//   node scripts/backfill-macro.mjs --dry-run           # 只抓不写
//   node scripts/backfill-macro.mjs --refresh           # 已有记录也重取日频（换源/修口径时用）
//   node scripts/backfill-macro.mjs --quiet             # 只打总结（云端门禁用）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchMargin, fetchUs10y, fetchCgbCurveOneY } from '../src/portfolio.mjs';
import { mergeLatestDaily } from '../src/macro-refresh.mjs';
import { syncMacroSeries } from '../src/macro-series.mjs';
import { aggregateDaily } from '../src/aggregate.mjs';
import { mergeBars } from '../src/kline-guard.mjs';
import { acquireKlineLock, releaseKlineLock, lockSkipText } from '../src/kline-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MACRO_FILE = path.join(ROOT, 'data', 'macro', 'daily.json');
const STATUS_FILE = path.join(ROOT, 'data', 'macro', '_backfill-status.json');
const CGB_FILE = path.join(ROOT, 'data', 'kline', 'cgb_1y.json');
const CGB_1W = path.join(ROOT, 'data', 'kline', 'cgb_1y_1w.json');
const CGB_1M = path.join(ROOT, 'data', 'kline', 'cgb_1y_1M.json');

const DRY = process.argv.includes('--dry-run');
const REFRESH = process.argv.includes('--refresh');
const QUIET = process.argv.includes('--quiet');
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const pad = (n) => String(n).padStart(2, '0');
const addDays = (day, n) =>
  new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const weekday = (day) => new Date(day + 'T00:00:00Z').getUTCDay();
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const bjToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const say = (m) => console.log(`[backfill] ${m}`);
const detail = (m) => { if (!QUIET) console.log('  ' + m); };

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

const MONTHLY_KEYS = new Set(['social_financing', 'cpi', 'pmi']);
const hasDailyItems = (rec) =>
  Array.isArray(rec?.items) &&
  rec.items.some((it) => it.key === 'margin') &&
  rec.items.some((it) => it.key === 'us10y');
const fmtVal = (it) => (it == null ? '失败' : `${it.value}${it.unit || ''}`);

async function main() {
  const to = arg('to', addDays(bjToday(), -1));
  const days = Math.max(1, Number(arg('days', '7')));
  const from = arg('from', addDays(to, -(days - 1)));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('日期格式必须是 YYYY-MM-DD');
  }
  const lo = from <= to ? from : to;
  const hi = from <= to ? to : from;
  say(`${lo} ~ ${hi}${DRY ? '（dry-run，不写盘）' : ''}`);

  const macro = readJSON(MACRO_FILE, []);
  const list = Array.isArray(macro) ? macro : [];

  // 月度值：取离目标日最近的一条现有记录（跨月时可能差一个月，但不会逐日变化）
  const nearestMonthly = (day) => {
    let best = null;
    for (const rec of list) {
      if (!rec || !rec.date || !Array.isArray(rec.items)) continue;
      const d = Math.abs(Date.parse(rec.date + 'T00:00:00Z') - Date.parse(day + 'T00:00:00Z'));
      if (!best || d < best.d) {
        best = { d, items: rec.items.filter((it) => MONTHLY_KEYS.has(it.key)) };
      }
    }
    return best ? best.items.map((it) => ({ ...it })) : [];
  };

  const cgbDoc = readJSON(CGB_FILE, {
    key: 'cgb_1y', name: '1Y国债收益率', market: 'CN', period: '1d',
    source: '中债国债收益率曲线（queryGjqxInfo）', bars: [],
  });
  const bars = Array.isArray(cgbDoc.bars) ? cgbDoc.bars.slice() : [];
  const barDay = new Set(bars.map((b) => String(b.t)));
  let cgbChanged = false;

  let filled = 0;
  let skipped = 0;
  let noData = 0;
  let toppedUp = 0;
  const errors = [];

  /** 补某一天的 1Y 国债日 K（已有则返回「已有」；返回是否真的追加） */
  async function fillCgbBar(day) {
    const before = bars.length;
    if (barDay.has(day)) return { text: '已有', added: false };
    try {
      const c = await fetchCgbCurveOneY(day);
      if (c && c.srcDate === day && Number.isFinite(c.oneY)) {
        bars.push({ t: day, o: c.oneY, c: c.oneY, h: c.oneY, l: c.oneY, v: 0 });
        barDay.add(day);
        cgbChanged = true;
        return { text: `${c.oneY}%`, added: bars.length > before };
      }
      return { text: '无当日曲线', added: false };
    } catch (e) {
      return { text: `失败（${e.message}）`, added: false };
    }
  }

  // ---- 2.19.0：最新一条记录补新 ----
  // 17:13 的日更拿不到「当天才发布」的两融（晚间）与 10Y 美债（美股收盘后），
  // 之后门禁又不会再跑 → 消费端一整天停在 T-1（11-17 实测：11-16 记录里还是 11-13）。
  // 每轮回到源侧取一次最新可用值，只有数据日期变新才写回。
  const newest = list.reduce(
    (a, b) => (!a || String(b?.date || '') > String(a.date || '') ? b : a),
    null
  );
  if (newest && !REFRESH) {
    const [mLate, uLate] = await Promise.allSettled([fetchMargin(), fetchUs10y()]);
    const latest = [];
    if (mLate.status === 'fulfilled') latest.push(mLate.value);
    if (uLate.status === 'fulfilled') latest.push(uLate.value);
    const merged = mergeLatestDaily(newest.items, latest);
    if (merged.changes.length) {
      newest.items = merged.items;
      toppedUp++;
      detail(`${newest.date}（最新记录）：源侧有新值 ${merged.changes.join('、')}`);
    }
    if (!latest.length) {
      detail(
        `${newest.date}：源侧最新值均取不到（两融 ${mLate.reason?.message || mLate.reason || '失败'}；` +
        `美债 ${uLate.reason?.message || uLate.reason || '失败'}）`
      );
    }
  }

  for (let day = lo; day <= hi; day = addDays(day, 1)) {
    if (weekday(day) === 0 || weekday(day) === 6) {
      skipped++;
      detail(`${day} ${WEEK[weekday(day)]}：周末，跳过`);
      continue;
    }
    const existing = list.find((x) => x && x.date === day);
    if (existing && hasDailyItems(existing) && !REFRESH) {
      // 2.19.0：记录完整时通常跳过；但最近 3 个自然日里可能有「17:13 那次中债曲线还没发布，
      //   日 K 被回退成前一交易日」造成的缺根（2026-11-16 实测缺了一根），必须单独补，
      //   否则 hasDailyItems 会让这根永久漏掉。
      if (day >= addDays(bjToday(), -3) && !barDay.has(day)) {
        const { text, added } = await fillCgbBar(day);
        if (added) filled++;
        detail(`${day} ${WEEK[weekday(day)]}：记录完整，补 1Y 国债日 K ${text}`);
      } else {
        skipped++;
        detail(`${day}：两融/美债都在，跳过`);
      }
      continue;
    }

    const [mRes, uRes] = await Promise.allSettled([
      fetchMargin(day),
      fetchUs10y(day),
    ]);
    const dailyItems = [];
    if (mRes.status === 'fulfilled') dailyItems.push(mRes.value);
    if (uRes.status === 'fulfilled') dailyItems.push(uRes.value);
    const mText = mRes.status === 'fulfilled' ? fmtVal(mRes.value) : `失败（${mRes.reason?.message || '未知'}）`;
    const uText = uRes.status === 'fulfilled'
      ? `${fmtVal(uRes.value)}${uRes.value.note ? `（${uRes.value.note}）` : ''}`
      : `失败（${uRes.reason?.message || '未知'}）`;

    // 1Y 国债：只补目标日那一根
    const { text: cgbText } = await fillCgbBar(day);

    if (!dailyItems.length) {
      noData++;
      errors.push({
        date: day,
        margin: mRes.status === 'fulfilled' ? 'ok' : String(mRes.reason?.message || mRes.reason),
        us10y: uRes.status === 'fulfilled' ? 'ok' : String(uRes.reason?.message || uRes.reason),
        cgb: cgbText,
      });
      detail(`${day}：两融/美债均无数据，跳过（cgb ${cgbText}）`);
      continue;
    }
    if (mRes.status !== 'fulfilled' || uRes.status !== 'fulfilled') {
      errors.push({
        date: day,
        margin: mRes.status === 'fulfilled' ? 'ok' : String(mRes.reason?.message || mRes.reason),
        us10y: uRes.status === 'fulfilled' ? 'ok' : String(uRes.reason?.message || uRes.reason),
        cgb: cgbText,
      });
    }

    // 已有记录但缺日频（例如云端先写了月度）：把取到的日频合并进去，不丢原有月度项
    if (existing) {
      const items = Array.isArray(existing.items) ? existing.items.slice() : [];
      for (const it of dailyItems) {
        const i = items.findIndex((x) => x.key === it.key);
        if (i >= 0) items[i] = it;
        else items.push(it);
      }
      existing.items = items;
      filled++;
      detail(
        `${day} ${WEEK[weekday(day)]}：补日频 两融 ${mText} · 美债 ${uText} · 1Y国债 ${cgbText}`
      );
      continue;
    }

    const monthly = nearestMonthly(day);
    const items = [...dailyItems];
    for (const it of monthly) if (!items.some((x) => x.key === it.key)) items.push(it);
    list.push({ date: day, items });
    filled++;
    detail(
      `${day} ${WEEK[weekday(day)]}：两融 ${mText} · 美债 ${uText} · ` +
      `1Y国债 ${cgbText} · 月度 ${monthly.length} 项`
    );
  }

  // 2.19.0：今天的曲线 17:00 后才发布，17:13 的日更可能还没拿到（2026-11-17 实测：
  //   当轮把 11-16 当成最新写了，11-17 的日 K 要等次日才回退补上）。这里每轮幂等补一次。
  if (!DRY) {
    const today = bjToday();
    if (weekday(today) !== 0 && weekday(today) !== 6 && !barDay.has(today)) {
      const { text } = await fillCgbBar(today);
      if (barDay.has(today)) {
        filled++;
        detail(`${today}（今天）：补 1Y 国债日 K ${text}`);
      }
    }
  }

  if ((filled || toppedUp) && !DRY) {
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    writeJSON(MACRO_FILE, list.slice(0, 400));
  }

  // ---- 2.36.0：回补后的记录同样沉淀进历史序列 ----
  // 两融是 T+1（次日才发布）、10Y 美债要等美股收盘，最新点只会在这里出现；
  // 不同步的话「宏观」视图的末根会永远停在 17:13 那次。
  try {
    const synced = await syncMacroSeries(path.join(ROOT, 'data', 'macro'), list, {
      dryRun: DRY,
      log: detail,
    });
    if (!DRY && (synced.changed.length || synced.indexChanged)) {
      detail(`宏观序列已更新：${synced.changed.join(',') || 'index'}`);
    }
  } catch (e) {
    console.log(`  ⚠ 宏观序列同步失败（不影响 daily.json）：${e.message}`);
  }
  if (cgbChanged && !DRY) {
    const lock = await acquireKlineLock('cgb_1y');
    if (!lock.ok) {
      console.log(`  ${lockSkipText('cgb_1y', lock)}（cgb_1y 本轮不写）`);
    } else {
      try {
        const at = new Date().toISOString();
        // 锁内重读一次：避免覆盖拿到锁之前别的进程刚追加的 cgb 日 K。
        const latestDoc = readJSON(CGB_FILE, cgbDoc);
        const mergedBars = mergeBars(bars, Array.isArray(latestDoc.bars) ? latestDoc.bars : []);
        writeJSON(CGB_FILE, { ...latestDoc, generatedAt: at, bars: mergedBars });
        for (const [period, unit] of [['1w', 'week'], ['1M', 'month']]) {
          const sub = aggregateDaily(mergedBars, unit);
          if (!sub.length) continue;
          writeJSON(period === '1w' ? CGB_1W : CGB_1M, {
            key: 'cgb_1y', name: '1Y国债收益率', market: 'CN', period,
            generatedAt: at,
            source: '中债国债收益率曲线（queryGjqxInfo）· 由日K聚合',
            bars: sub,
          });
        }
      } finally {
        await releaseKlineLock(lock);
      }
    }
  }

  if (!DRY && (filled > 0 || noData > 0 || toppedUp > 0)) {
    // 诊断文件：云端回补失败时（例如 Actions 访问不了两融接口）能直接从仓库里看到原因。
    // 用「日期」而不是精确时刻，避免同一天重复运行时反复产生提交。
    writeJSON(STATUS_FILE, {
      at: bjToday(),
      from: lo,
      to: hi,
      filled,
      toppedUp,
      noData,
      skipped,
      errors: errors.sort((a, b) => a.date.localeCompare(b.date)),
    });
  }

  say(
    `完成：补齐 ${filled} 天，最新记录补新 ${toppedUp} 条，跳过 ${skipped} 天（周末/已有），无数据 ${noData} 天` +
    `${DRY ? '（dry-run 未写盘）' : ''}`
  );
}

main().catch((e) => {
  console.error('[backfill] 失败：' + e.message);
  process.exit(1);
});
