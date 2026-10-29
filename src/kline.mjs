// src/kline.mjs
// K 线取数：日 K + 5 分钟 K，**东财 / 腾讯双源**
//
// ── 为什么要双源（2026-10-29 实测）──
//   东财的 kline 端点有独立的 IP 级限流：实测打密之后
//     push2his.eastmoney.com 与 1.push2his.eastmoney.com 全部 UND_ERR_SOCKET，
//     而**同一时刻**的 ulist 批量行情端点仍然正常 —— 说明东财是**按接口**限流，
//     不是按主机、也不是按 IP 总量。
//   ⇒ K 线必须有第二个源，否则「时点快照的历史回溯能力」会随东财一次限流而全废。
//
// ── 两源口径一致性（已交叉验证）──
//   同一标的同一时点，两源完全一致：
//     日 K 2026-10-29 收盘：上证 3651.43 / 沪深300ETF 4.111 / 机器人ETF 1.287
//       → 东财日K = 腾讯日K = 东财 5 分钟 15:00 bar 的收盘价，三方全等
//     5 分钟 11:30 bar（上证）：开 3653.53 / 收 3647.12 / 高 3653.56 / 低 3647.12
//       → 东财 5 分钟K = 腾讯 5 分钟K，两源全等
//
// ── 时间戳约定 ──
//   5 分钟 K 的时间戳是**该 bar 的结束时刻**：
//     首根 09:35 = 覆盖 09:30–09:35；末根 15:00 = 覆盖 14:55–15:00。
//   所以「11:30 那根」= 上午盘收盘，「15:00 那根」= 全天收盘。
//   ⚠ 东财港股 5 分钟 K 只到 15:35（缺 15:40–16:00），港股收盘价要走日 K。

import { emGetJSON, emGetText, KLINE_HOSTS } from './em.mjs';

const KL_FIELDS = 'fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
// ⚠ 本机 DNS 解析不了 web.ifzq.gtimg.cn（ENOTFOUND），
//   但 ifzq.gtimg.cn（无 web. 前缀）与 proxy.finance.qq.com 都通 —— 腾讯源必须用后者。
const TX_HOSTS = ['https://ifzq.gtimg.cn', 'https://proxy.finance.qq.com/ifzqgtimg'];

const TTL_DAILY = 3 * 3600 * 1000;
const TTL_MINUTE = 15 * 60 * 1000;

/** 日 K → Map('YYYY-MM-DD' → {o,c,h,l}) */
export async function fetchDailyK(secid, tx) {
  const errors = [];
  // ---- 主源：东财 ----
  try {
    const j = await emGetJSON(
      `/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=120&end=20500101&${KL_FIELDS}`,
      { hosts: KLINE_HOSTS, cacheTtlMs: TTL_DAILY, cacheTag: 'dailyK', timeout: 15000 }
    );
    const map = parseEMRows(j?.data?.klines || []);
    if (map.size) return map;
    errors.push('东财日K为空');
  } catch (err) {
    errors.push(`东财日K失败(${String(err.message).slice(0, 80)})`);
  }
  // ---- 备用源：腾讯 ----
  if (tx) {
    try {
      const text = await emGetText(
        `/appstock/app/fqkline/get?param=${tx},day,,,120,qfq`,
        { hosts: TX_HOSTS, timeout: 12000 }
      );
      const j = JSON.parse(text);
      const node = j?.data?.[tx] || {};
      const rows = node.qfqday || node.day || [];
      const map = new Map();
      for (const r of rows) {
        if (!Array.isArray(r) || r.length < 5) continue;
        const c = Number(r[2]);
        if (!r[0] || !Number.isFinite(c)) continue;
        map.set(String(r[0]).slice(0, 10), { o: Number(r[1]), c, h: Number(r[3]), l: Number(r[4]) });
      }
      if (map.size) return map;
      errors.push('腾讯日K为空');
    } catch (err) {
      errors.push(`腾讯日K失败(${String(err.message).slice(0, 80)})`);
    }
  }
  throw new Error(`日K不可得：${errors.join('；')}`);
}

/** 5 分钟 K → Map('YYYY-MM-DD HH:MM' → {o,c,h,l}) */
export async function fetchKline5m(secid, tx) {
  const errors = [];
  try {
    const j = await emGetJSON(
      `/api/qt/stock/kline/get?secid=${secid}&klt=5&fqt=1&lmt=300&end=20500101&${KL_FIELDS}`,
      { hosts: KLINE_HOSTS, cacheTtlMs: TTL_MINUTE, cacheTag: 'k5m', timeout: 15000 }
    );
    const map = parseEMRows(j?.data?.klines || []);
    if (map.size) return map;
    errors.push('东财5分钟K为空');
  } catch (err) {
    errors.push(`东财5分钟K失败(${String(err.message).slice(0, 80)})`);
  }
  if (tx) {
    try {
      const text = await emGetText(
        `/appstock/app/kline/mkline?param=${tx},m5,,320`,
        { hosts: TX_HOSTS, timeout: 12000 }
      );
      const j = JSON.parse(text);
      const rows = j?.data?.[tx]?.m5 || [];
      const map = new Map();
      for (const r of rows) {
        if (!Array.isArray(r) || r.length < 5) continue;
        const t = String(r[0]); // YYYYMMDDHHMM
        if (t.length < 12) continue;
        const c = Number(r[2]);
        if (!Number.isFinite(c)) continue;
        const key = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`;
        map.set(key, { o: Number(r[1]), c, h: Number(r[3]), l: Number(r[4]) });
      }
      if (map.size) return map;
      errors.push('腾讯5分钟K为空');
    } catch (err) {
      errors.push(`腾讯5分钟K失败(${String(err.message).slice(0, 80)})`);
    }
  }
  throw new Error(`5分钟K不可得：${errors.join('；')}`);
}

/** 解析东财 K 线行：日期或时间,开,收,高,低,量,额,振幅 */
function parseEMRows(rows) {
  const map = new Map();
  for (const r of rows) {
    const p = String(r).split(',');
    const c = Number(p[2]);
    if (!p[0] || !Number.isFinite(c)) continue;
    map.set(String(p[0]), { o: Number(p[1]), c, h: Number(p[3]), l: Number(p[4]) });
  }
  return map;
}
