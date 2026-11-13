// src/kline-guard.mjs
// 2.4.10：K 线「短序列覆盖长序列」守卫（纯函数、无 IO）。
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

// ── 2.18.0：仅收盘（closeOnly）bar ──
//
// 背景：新浪长历史接口对 2005 年底之前的中证指数只返回 `open/high/low="0.000"`、
//   `volume="0"`，只有 close 有效（a100 726 根 / 2003-01-02~2005-12-30，
//   csi300 721 根 / 2002-01-04~2004-12-31，周/月同理）。其他源都补不到该区间（已实测），
//   所以**不造值**：这类 bar 保留，但必须带标记进库，前端才能按「只有收盘」画，
//   而不是把 0 当真实最高/最低把 y 轴拉平。
//
// 标记格式（两种行都要认）：
//   · 对象行 {t,o,c,h,l,v} → `z: 1`
//   · 紧凑数组行 [t,o,c,h,l,v] → 第 7 位 `1`（即 [t,o,c,h,l,v,1]）
//
// 判定：o=h=l=0 且 close 有效（> 0）。这是「源侧没有开高低」的唯一判据；
//   close 也缺失（=0）的 bar 不是 closeOnly，它根本无效，不该被原谅。
export const CLOSE_ONLY_FLAG = 1;

/** 是否为「仅收盘」bar（已标记或符合 o=h=l=0 的特征都算） */
export function isCloseOnlyBar(b) {
  if (Array.isArray(b)) {
    if (b[6] === CLOSE_ONLY_FLAG || b[6] === true) return true;
    return +b[1] === 0 && +b[3] === 0 && +b[4] === 0 && +b[2] > 0;
  }
  if (!b) return false;
  if (b.z === CLOSE_ONLY_FLAG || b.z === true) return true;
  return +b.o === 0 && +b.h === 0 && +b.l === 0 && +b.c > 0;
}

/** 给一根 bar 补/去标记（返回新对象，不改入参） */
export function markCloseOnly(b) {
  const z = isCloseOnlyBar(b);
  if (Array.isArray(b)) {
    if (z) return b.length > 6 ? b.slice() : [...b, CLOSE_ONLY_FLAG];
    if (b.length <= 6) return b;
    return b.slice(0, 6);
  }
  const { z: _drop, ...rest } = b || {};
  return z ? { ...rest, z: CLOSE_ONLY_FLAG } : rest;
}

/**
 * 写库前统一打标：把「o=h=l=0 且只有收盘」的 bar 显式标记。
 * 写库路径必须调它 —— 不允许这类 bar 静默当正常 bar 进库（防回归）。
 * @returns {{bars: Array, count: number}} count = 标记/命中的 closeOnly 根数
 */
export function markCloseOnlyBars(bars) {
  const list = Array.isArray(bars) ? bars : [];
  let count = 0;
  const out = list.map((b) => {
    if (!isCloseOnlyBar(b)) return markCloseOnly(b);
    count++;
    return markCloseOnly(b);
  });
  return { bars: out, count };
}

/** 时间键：对象行取 t，数组行取 [0] */
export function barTime(b) {
  if (Array.isArray(b)) return String(b[0]);
  return String((b && b.t) || '');
}

/** 成交量：对象行 v，数组行 [5] */
export function barVolume(b) {
  if (Array.isArray(b)) return Number(b[5]) || 0;
  return Number((b && b.v)) || 0;
}

function withVolume(b, v) {
  if (Array.isArray(b)) {
    const c = b.slice();
    c[5] = v;
    return c;
  }
  return { ...b, v };
}

/**
 * 成交量保护：incoming 的 0 成交量不得覆盖现有非零成交量。
 * 上金所官网日线没有 volume 字段（全部 v=0），东财有；两者会交替写同一个文件。
 * 只保护成交量，OHLC/时间仍按 incoming 更新。
 */
export function preserveVolumes(existing, incoming) {
  const oldVol = new Map((existing || []).map((b) => [barTime(b), barVolume(b)]));
  return (incoming || []).map((b) => {
    if (barVolume(b) > 0) return b;
    const v = oldVol.get(barTime(b));
    return v > 0 ? withVolume(b, v) : b;
  });
}

/** 按时间键 union；同键用 incoming 覆盖（更新值），结果按时间升序 */
export function mergeBars(existing, incoming) {
  const map = new Map();
  for (const b of existing || []) map.set(barTime(b), b);
  for (const b of incoming || []) map.set(barTime(b), b);
  return [...map.values()].sort((a, b) => (barTime(a) < barTime(b) ? -1 : 1));
}

/**
 * 增量 upsert：把 incoming 的时间键覆盖到现有序列上，并保留非零成交量。
 * 用于「只刷新最后 N 根」的路径（scripts/update-kline-last.mjs）：
 * incoming 天然比现有序列短，不能直接走 decideBars（会被判成 shorter 而整体拒绝）。
 */
export function upsertBars(existing, incoming) {
  const old = Array.isArray(existing) ? existing : [];
  return mergeBars(old, preserveVolumes(old, incoming));
}

/**
 * 2.14.1：左端缺失（源侧历史起点后移）的并集合并判据。
 *
 * 背景：新浪外盘日线的起点从 2006-11-10 后移到 2006-11-13，聚合出的 xau_1w
 * 比现有文件少最左 4 周。这不是「源端残缺」，只是**起点变了**；直接拒绝会让周 K 永久停更，
 * 直接用新序列覆盖又会丢掉旧文件里更早的那几根。所以对「仅左端缺失」走并集。
 *
 * 放行必须同时满足（任何一条不满足都拒绝，reason 互相区分，便于排查）：
 *   1. 重叠区间逐根一致：时间键相同的 bar，OHLC 必须完全相同（不是只比日期）；
 *   2. 新序列右端不落后：newLast >= oldLast；
 *   3. 覆盖率 >= LEFT_MERGE_MIN_COVERAGE：新序列至少保留现有序列的 80%。
 *      ⚠ 这一条是用户要求「源端只回几十根的真短序列仍必须拒绝」的必要条件 ——
 *      一条干净的 30 根尾巴同样满足 1、2，只有覆盖率能把它和「少几周」区分开。
 */
export const LEFT_MERGE_MIN_COVERAGE = 0.8;

/** 归一化 OHLC（对象行 {t,o,h,l,c} / 数组行 [t,o,c,h,l,v]） */
function normBar(b) {
  if (Array.isArray(b)) {
    return { t: String(b[0]), o: +b[1], c: +b[2], h: +b[3], l: +b[4] };
  }
  return { t: String((b && b.t) || ''), o: +(b && b.o), c: +(b && b.c), h: +(b && b.h), l: +(b && b.l) };
}

const sameBar = (a, b) =>
  a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c;

/**
 * @returns {string|null} null = 允许并集；否则返回拒绝原因
 *   · shorter-too-partial     新序列不足现有 80%（源端残缺/只回几十根）
 *   · shorter-right-behind    新序列右端比现有末根更旧
 *   · shorter-no-overlap      新旧序列没有共同时间键
 *   · shorter-overlap-mismatch 重叠区间 OHLC 对不上（不是同一序列）
 */
export function leftEdgeVerdict(old, next) {
  const list = Array.isArray(old) ? old : [];
  const inc = Array.isArray(next) ? next : [];
  if (!list.length || !inc.length) return 'shorter-no-overlap';
  if (inc.length < list.length * LEFT_MERGE_MIN_COVERAGE) return 'shorter-too-partial';
  if (barTime(inc[inc.length - 1]) < barTime(list[list.length - 1])) return 'shorter-right-behind';
  const oldMap = new Map(list.map((b) => [barTime(b), normBar(b)]));
  let overlap = 0;
  for (const b of inc) {
    const o = oldMap.get(barTime(b));
    if (!o) continue;
    overlap++;
    if (!sameBar(o, normBar(b))) return 'shorter-overlap-mismatch';
  }
  if (!overlap) return 'shorter-no-overlap';
  return null;
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
  const keepVol = (bars) => preserveVolumes(old, bars);

  // 1) 起点更晚且更短：先看是否「仅左端缺失且重叠一致」⇒ 并集，否则拒绝
  if (newFirst > oldFirst && next.length < old.length) {
    const why = leftEdgeVerdict(old, next);
    if (!why) {
      return { action: 'merge', bars: mergeBars(old, keepVol(next)), reason: 'left-edge-merge' };
    }
    return { action: 'reject', bars: old, reason: why };
  }

  const missingOld = [...oldKeys].some((k) => !newKeys.has(k));

  // 2) 等长/更长、覆盖现有全部时间键、末根不倒退 ⇒ 正常接受
  if (next.length >= old.length && !missingOld && newLast >= oldLast) {
    return {
      action: 'accept',
      bars: keepVol(next),
      reason: next.length > old.length ? 'longer' : 'same-length-newer',
    };
  }

  // 3) 其余：短但末根更新 / 更长但中间有缺口 ⇒ 合并保留历史
  return {
    action: 'merge',
    bars: mergeBars(old, keepVol(next)),
    reason: missingOld ? 'gap-merge' : 'shorter-merge',
  };
}
