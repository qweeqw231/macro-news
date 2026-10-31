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
//   node scripts/backfill-macro.mjs --quiet             # 只打总结（云端门禁用）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchMargin, fetchUs10y, fetchCgbCurveOneY } from '../src/portfolio.mjs';
import { aggregateDaily } from '../src/aggregate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MACRO_FILE = path.join(ROOT, 'data', 'macro', 'daily.json');
const CGB_FILE = path.join(ROOT, 'data', 'kline', 'cgb_1y.json');
const CGB_1W = path.join(ROOT, 'data', 'kline', 'cgb_1y_1w.json');
const CGB_1M = path.join(ROOT, 'data', 'kline', 'cgb_1y_1M.json');

const DRY = process.argv.includes('--dry-run');
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
  const hasDay = (day) => list.some(
    (x) => x && x.date === day && Array.isArray(x.items) && x.items.length > 0
  );

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

  for (let day = lo; day <= hi; day = addDays(day, 1)) {
    if (weekday(day) === 0 || weekday(day) === 6) {
      skipped++;
      detail(`${day} ${WEEK[weekday(day)]}：周末，跳过`);
      continue;
    }
    if (hasDay(day)) {
      skipped++;
      detail(`${day}：已有记录，跳过`);
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
    let cgbText = '已有';
    if (!barDay.has(day)) {
      try {
        const c = await fetchCgbCurveOneY(day);
        if (c && c.srcDate === day && Number.isFinite(c.oneY)) {
          bars.push({ t: day, o: c.oneY, c: c.oneY, h: c.oneY, l: c.oneY, v: 0 });
          barDay.add(day);
          cgbChanged = true;
          cgbText = `${c.oneY}%`;
        } else {
          cgbText = '无当日曲线';
        }
      } catch (e) {
        cgbText = `失败（${e.message}）`;
      }
    }

    if (!dailyItems.length) {
      noData++;
      detail(`${day}：两融/美债均无数据，跳过（cgb ${cgbText}）`);
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

  if (filled && !DRY) {
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    writeJSON(MACRO_FILE, list.slice(0, 400));
  }
  if (cgbChanged && !DRY) {
    const at = new Date().toISOString();
    writeJSON(CGB_FILE, { ...cgbDoc, generatedAt: at, bars });
    for (const [period, unit] of [['1w', 'week'], ['1M', 'month']]) {
      const sub = aggregateDaily(bars, unit);
      if (!sub.length) continue;
      writeJSON(period === '1w' ? CGB_1W : CGB_1M, {
        key: 'cgb_1y', name: '1Y国债收益率', market: 'CN', period,
        generatedAt: at,
        source: '中债国债收益率曲线（queryGjqxInfo）· 由日K聚合',
        bars: sub,
      });
    }
  }

  say(
    `完成：补齐 ${filled} 天，跳过 ${skipped} 天（周末/已有），无数据 ${noData} 天` +
    `${DRY ? '（dry-run 未写盘）' : ''}`
  );
}

main().catch((e) => {
  console.error('[backfill] 失败：' + e.message);
  process.exit(1);
});
