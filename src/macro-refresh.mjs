// src/macro-refresh.mjs
// 2.19.0：宏观「最新一条」日频字段的补新（纯函数，无 IO）。
//
// 背景：data/macro/daily.json 的记录由 17:13 的日更写入，但两个源在那之前拿不到当天值：
//   · 两融：交易所晚间才发布（17:13 时最新只有前一交易日，2026-11-16 实测就是这样）；
//   · 10Y 美债：要等美股收盘（北京时间次日 05:00）。
// 之后 collect-macro-if-due 看到「今天已有记录」就跳过，backfill 又按 hasDailyItems 跳过，
// 于是消费端会整天停在 T-1（2026-11-17 实测：11-16 记录里还是 11-13 的值）。
//
// 这里只处理「最新一条记录」：源侧有更新的数据日期（note 更大）才替换对应 item，
// 相同或更旧一律保留现有值（源抖动不能把数据改回旧的）。月度项（社融/CPI/PMI）不在这里动。

export const DAILY_MACRO_KEYS = ['margin', 'us10y'];

/**
 * @param {Array<{key:string,value:number,note?:string}>} items 现有记录的 items
 * @param {Array<{key:string,value:number,note?:string}>} latestItems 源侧最新可用值
 * @returns {{items: Array, changes: string[]}} changes 用于日志（空数组=无需写盘）
 */
export function mergeLatestDaily(items, latestItems) {
  const out = Array.isArray(items) ? items.slice() : [];
  const changes = [];
  for (const it of Array.isArray(latestItems) ? latestItems : []) {
    if (!it || !DAILY_MACRO_KEYS.includes(it.key)) continue;
    const i = out.findIndex((x) => x && x.key === it.key);
    const old = i >= 0 ? out[i] : null;
    const newNote = String(it.note || '');
    if (!old) {
      out.push(it);
      changes.push(`${it.key} 新增（${newNote || '无日期'}）`);
      continue;
    }
    const oldNote = String(old.note || '');
    // 没有日期就无法判断新旧 → 不动；只有严格更新才替换
    if (!newNote || newNote <= oldNote) continue;
    out[i] = it;
    changes.push(`${it.key} ${oldNote || '—'}→${newNote}`);
  }
  return { items: out, changes };
}
