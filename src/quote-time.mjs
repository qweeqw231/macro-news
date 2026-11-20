// src/quote-time.mjs
// 腾讯行情「源时间」解析（采集侧）。
//
// 背景（2026-11-21）：东财不可达时降级到腾讯 qt.gtimg.cn，字段 [30] 的时间格式按市场不同：
//   · A股 / ETF：`YYYYMMDDHHMMSS`（北京时间）
//   · 港股     ：`YYYY/MM/DD HH:mm:ss`（北京时间）
//   · 美股     ：`YYYY/MM/DD HH:mm:ss`（**美东本地时间**）
// 采集侧原先只认 `YYYY-MM-DD HH:mm:ss`，港股/美股一律落回抓取时刻（或空），
// 下游（17:00 任务、pm 快照、同步哨兵的 pm.capturedAt）拿到的源时间因此是错的/空的。
//
// ⚠ 口径必须与前端 assets/quote-status.js 的 parseTencentTime 完全一致：
//   同一份响应算出的**时刻**相同（美股按 America/New_York 两遍修正 DST）。
//   前端返回 UTC ISO（Z），这里统一返回带 +08:00 的 ISO —— 与 quotes.json 的
//   updatedAt 既有语义一致（站内时间一律北京时间），两者 Date.parse 相等。

const pad = (n) => String(n).padStart(2, '0');

function tzParts(ms, tz) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const o = {};
  for (const x of p) o[x.type] = x.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), hh: Number(o.hour) % 24, mm: Number(o.minute), ss: Number(o.second) };
}

/** 某毫秒在指定时区的 UTC 偏移（毫秒） */
function tzOffsetMs(ms, tz) {
  const p = tzParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Number(ms);
}

/** 时区本地「日期 + 当日分钟」→ UTC 毫秒（两遍修正 DST，与前端 zonedToUtc 同算法） */
function zonedToUtc(dateStr, minutes, tz) {
  const a = String(dateStr).split('-').map(Number);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const guess = Date.UTC(a[0], a[1] - 1, a[2], hh, mm);
  const t = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(t, tz);
}

/** 毫秒 → 北京时间 ISO(+08:00) */
export function isoCNFromMs(ms) {
  const t = new Date(ms + 8 * 3600 * 1000);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`
  );
}

/**
 * 腾讯字段 [30] → 北京时间 ISO(+08:00)；无法识别返回 null（由调用方决定回落）。
 * @param {string} s
 * @param {string} [market] 'US' 按美东时间换算；其余按北京时间
 */
export function parseTencentTime(s, market) {
  const str = String(s == null ? '' : s).trim();
  const compact = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  const loose = str.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  const m = compact || loose;
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss = '00'] = m;
  if (String(market).toUpperCase() === 'US') {
    const utc = zonedToUtc(`${y}-${mo}-${d}`, Number(hh) * 60 + Number(mm), 'America/New_York');
    return isoCNFromMs(utc + Number(ss) * 1000);
  }
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}+08:00`;
}
