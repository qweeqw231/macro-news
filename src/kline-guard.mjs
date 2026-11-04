// src/kline-guard.mjs
// 2.5.0：K 线「短序列覆盖长序列」守卫（纯函数、无 IO）。
//
// 背景：2026-11-04 04:19 的日更把 dji_1w 从 1821 根压到 910、hsi_1w 1821→1000、
// spx/ixic/hs_tech/bse50 等也被更短的源结果覆盖；a500_1w、a500_1M 则被 111/27 根覆盖。
// 根因：各写盘脚本只判断「内容是否变化」，不比较新旧文件的长度与起点。
//
// 规则：
//   · 新结果为空 → reject
//   · 新结果首根晚于现有首根且根数更少 → reject(shorter)，保留现有
//   · 新结果 >= 现有根数、包含现有全部时间键、末根不倒退 → accept
//   · 其它情况（缺中间段 / 首根更晚但数量够）→ merge（按时间键 union，去重）
// 兼容对象行 {t,...} 与紧凑数组行 [t,...]。

/** 时间键：对象行取 t，数组行取 [0] */
export function barTime(b) {
  if (Array.isArray(b)) return String(b[0]);
  return String((b && b.t) || '');
}

/** 按时间键 union；同键用 incoming 覆盖（更新值），结果按时间升序 */
export function mergeBars(existing, incoming) {
  const map = new Map();
  for (const b of existing || []) map.set(barTime(b), b);
  for (const b of incoming || []) map.set(barTime(b), b);
  return [...map.values()].sort((a, b) => (barTime(a) < barTime(b) ? -1 : 1));
}

/**
 * @param {Array} existing 现有文件 bars（可为空/未定义）
 * @param {Array} incoming 本次抓取 bars
 * @returns {{action:'accept'|'reject'|'merge', bars:Array, reason:string}}
 */
export function decideBars(existing, incoming) {
  const old = Array.isArray(existing) ? existing : [];
  const next = Array.isArray(incoming) ? incoming : [];
  if (!next.length) return { action: 'reject', bars: old, reason: 'empty' };
  if (!old.length) return { action: 'accept', bars: next, reason: 'no-existing' };

  const oldFirst = barTime(old[0]);
  const newFirst = barTime(next[0]);
  const oldLast = barTime(old[old.length - 1]);
  const newLast = barTime(next[next.length - 1]);
  const oldKeys = new Set(old.map(barTime));
  const newKeys = new Set(next.map(barTime));

  // 1) 起点更晚且更短 ⇒ 明确短覆盖，直接拒绝
  if (newFirst > oldFirst && next.length < old.length) {
    return { action: 'reject', bars: old, reason: 'shorter' };
  }

  const missingOld = [...oldKeys].some((k) => !newKeys.has(k));

  // 2) 等长/更长、覆盖现有全部时间键、末根不倒退 ⇒ 正常接受
  if (next.length >= old.length && !missingOld && newLast >= oldLast) {
    return { action: 'accept', bars: next, reason: next.length > old.length ? 'longer' : 'same-length-newer' };
  }

  // 3) 其余：短但末根更新 / 更长但中间有缺口 ⇒ 合并保留历史
  return {
    action: 'merge',
    bars: mergeBars(old, next),
    reason: missingOld ? 'gap-merge' : 'shorter-merge',
  };
}
