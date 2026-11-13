// src/pm-gate.mjs
// pm 快照的「消费者门禁」——纯函数，无 IO。
//
// 背景（2026-11-06 事故）：下游 dsh「交易日收盘复盘」在 17:00 只读本地文件，
// 以 data/snapshots/<date>_pm.json 的 quotes.<key>.price 作为当日收盘基准。
// 它的三条硬门禁是：
//   1. capturedAt >= 16:10（港股收市竞价结束）；
//   2. date === 当日；
//   3. isTradingDay === true。
// 任一条不满足，它就退回 quotes.json / 上一有效值——而 11-06 的 quotes.json
// 是 15:52 的盘中截面，港股拿到 15:53 竞价前价、黄金拿到 15:23。
//
// 所以 pm 必须在「16:10 之后」才允许落盘，且落盘前要能自证这三条。
export const PM_MIN_CAPTURED_HM = '16:10';

const dt = (s) => {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  return m ? { date: m[1], hm: `${m[2]}:${m[3]}` } : null;
};

/**
 * 校验一份 pm 快照能否被消费方当作「当日收盘基准」。
 * @param {object} doc 快照 JSON
 * @param {{today?:string, minCapturedHm?:string}} [opts]
 *        today：只在快照是「今天」这份时才要求 capturedAt 晚于收盘（历史回补不受此限）
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function checkPmGate(doc, opts = {}) {
  const reasons = [];
  if (!doc || typeof doc !== 'object') return { ok: false, reasons: ['no-doc'] };
  const minHm = opts.minCapturedHm || PM_MIN_CAPTURED_HM;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.date || ''))) reasons.push('date-missing');
  if (doc.isTradingDay !== true) reasons.push('not-trading-day');

  const cap = dt(doc.capturedAt);
  if (!cap) {
    reasons.push('capturedAt-invalid');
  } else {
    // 只有「今天这份」才卡「capturedAt 与 date 同日、且 >= 16:10」；
    // 历史回补的 capturedAt 是补采时刻，与快照 date 本来就不同日。
    const isToday = !!opts.today && doc.date === opts.today;
    if (opts.today && !isToday) reasons.push('date-not-today');
    if (isToday) {
      if (cap.date !== doc.date) reasons.push('capturedAt-date-mismatch');
      if (cap.hm < minHm) reasons.push(`capturedAt-before-${minHm}`);
    }
  }
  if (opts.today && doc.date !== opts.today && !reasons.includes('date-not-today')) {
    reasons.push('date-not-today');
  }

  if (doc.session && doc.session !== 'pm') reasons.push('not-pm-session');
  return { ok: reasons.length === 0, reasons };
}

/**
 * pm 门禁要校验的「关键 key」清单。
 * 固定的 4 个是对齐下游 dsh 的硬门禁；此外把快照里**实际出现的全部 A 股指数**
 * 一并纳入 —— 新增标的（如 2.16.0 的 a100）只要进了快照就自动被校验，
 * 不需要再改任何硬编码清单；旧快照里没有的 key 也不会被凭空要求（历史文件照常通过）。
 */
export function pmGateKeys(doc) {
  const fixed = ['csi300', 'hsi', 'hs_tech', 'sge_au9999'];
  const quotes = (doc && doc.quotes) || {};
  const cnIndex = Object.keys(quotes).filter(
    (k) => quotes[k] && quotes[k].kind === 'index' && quotes[k].market === 'CN'
  );
  return [...new Set([...fixed, ...cnIndex])];
}

/**
 * 校验「关键 key 都是当日的」——对应 dsh 的 check_macro_news.py 质量门。
 * 只查有明确「当日」语义的市场；portfolio（xau/ndx…）按各自口径放行。
 * @param {object} doc
 * @param {string[]} keys
 */
export function checkPmKeys(doc, keys) {
  const out = [];
  const quotes = (doc && doc.quotes) || {};
  for (const key of keys) {
    const q = quotes[key];
    if (!q) { out.push(`${key}:missing`); continue; }
    if (q.kind === 'portfolio') continue;
    const asOf = dt(q.asOf);
    if (!asOf) out.push(`${key}:asOf-missing`);
    else if (doc.date && asOf.date !== doc.date) out.push(`${key}:asOf-${asOf.date}`);
  }
  return out;
}
