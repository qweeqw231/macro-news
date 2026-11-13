// src/fx-calendar.mjs
// 外汇（FX）日切口径的**唯一真源**。
//
// ── 为什么需要这个模块 ──
//   FX 是 24 小时连续交易，没有交易所式的开收盘，仓库里因此出现过三套互相矛盾的
//   硬编码：snapshot 的 BAR_CLOSED_AT 写「05:00+1」、kline-finalize 的 NO_SESSION_CLOSE
//   写「北京自然日切分 · D+1 00:00」、前端 quote-status 则干脆没有 FX 时段。
//
// ── 实测依据（2026-11-13 本机）──
//   · 东财 119.USDJPY / 133.USDCNH 的日 K，`2026-11-13` 这根的开盘价 159.8570
//     恰好等于当天 `06:01` 的 1 分钟 K 开盘价；而 `00:00` 的 5 分钟 K 开盘是 159.9148
//     ⇒ 源端的交易日是**北京 06:00 切日**，不是自然日 00:00。
//   · 1 分钟 K 序列起点为 `06:01`、5 分钟序列起点为 `06:05`（周一），周末整段缺失
//     ⇒ 06:00 = 前一日收盘 / 新一日开盘的同一秒。
//   · 北京 06:00 == **22:00 UTC**（固定偏移，东财按 UTC 切日，不随美国夏令时移动）。
//
// ⚠ 待复核（2027-03 美国转夏令时后第一周）：
//   若届时源端切日变成 21:00 UTC（= 纽约 17:00 EDT），说明它是跟着 America/New_York
//   的收盘走，而不是固定 22:00 UTC。届时需要把 FX_DAY_CUT 改为从
//   `America/New_York` 的 17:00 派生，并重跑 docs 里的复核用例。
//   复核方法：取任意美元对当日日 K 的开盘价，与当天 05:01 / 06:01 的 1 分钟 K 开盘价比对。

/** FX 日切时刻（UTC，固定）。北京 = UTC+8 ⇒ 06:00。 */
export const FX_DAY_CUT_UTC_HM = '22:00';
/** FX 日切时刻（北京）。由 FX_DAY_CUT_UTC_HM 派生，不要单独维护。 */
export const FX_DAY_CUT_BJ_HM = '06:00';
/** FX 日切时刻在「次日北京时间」里的分钟数（06:00 = 360）。 */
export const FX_DAY_CUT_BJ_MINUTES = 6 * 60;
/**
 * snapshot.BAR_CLOSED_AT 的配置串：D 日那根 bar 在 D+1 的 06:00 才收完。
 * 格式与 snapshot.mjs 的 `'HH:MM+1'` 一致。
 */
export const FX_BAR_CLOSED_AT = `${FX_DAY_CUT_BJ_HM}+1`;

/** 交易周窗口（用于文档与前端时段配置的交叉校验）：周一 06:00 开盘 → 周六 06:00 收盘。 */
export const FX_TRADING_WEEK = {
  tz: 'Asia/Shanghai',
  opensWeekday: 1, // 周一
  opensHm: FX_DAY_CUT_BJ_HM,
  closesWeekday: 6, // 周六
  closesHm: FX_DAY_CUT_BJ_HM,
};

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' 加天数（UTC 计算，不依赖进程时区） */
function shiftDate(dateStr, deltaDays) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 北京时间的日期 / 当日分钟 */
function bjParts(nowMs) {
  const t = new Date(Number(nowMs) + 8 * 3600 * 1000);
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

/**
 * D 日那根 FX 日 K 的收盘时刻（UTC 毫秒）= D+1 北京 06:00 = D 22:00 UTC。
 * @param {string} dateStr D 日（北京日期，YYYY-MM-DD）
 */
export function fxDayCloseMs(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = FX_DAY_CUT_UTC_HM.split(':').map(Number);
  // D 日 22:00 UTC == D+1 06:00 北京
  const base = Date.UTC(y, m - 1, d, hh, mm);
  const bj = bjParts(base);
  // 自检：22:00 UTC 必须落在北京次日 06:00，派生关系被改动时立刻暴露
  if (bj.minutes !== FX_DAY_CUT_BJ_MINUTES) {
    throw new Error(`FX 日切派生不自洽：${FX_DAY_CUT_UTC_HM}Z → 北京 ${pad(Math.floor(bj.minutes / 60))}:${pad(bj.minutes % 60)}`);
  }
  return base;
}

/**
 * 某个时刻「最近一根已经收完的 FX 日 K」的日期（北京日期）。
 * 06:00 之前：再前一天的 bar 都还没收完 ⇒ 返回前天；06:00 之后：返回昨天。
 */
export function fxLastClosedBarDate(nowMs = Date.now()) {
  const bj = bjParts(nowMs);
  return shiftDate(bj.date, bj.minutes >= FX_DAY_CUT_BJ_MINUTES ? -1 : -2);
}
