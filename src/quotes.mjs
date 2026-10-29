// src/quotes.mjs
// 批量行情：一次请求拿到全部标的的最新价
//
// ── 实测要点（2026-10-29 本机）──
//   · 东财 ulist.np 批量端点对**指数与 ETF 都有效**：一次请求覆盖 49 个标的
//     （17 指数 + 32 场内 ETF），全部有有效价。
//   · 字段口径（fltt=2&invt=2 时）：
//       f2 最新 / f3 涨跌幅% / f5 量 / f12 代码 / f13 市场(1沪 0深) / f14 名称
//       f15 最高 / f16 最低 / f17 开盘 / f18 昨收 / f124 源时间戳(epoch 秒) / f297 交易日
//   · ⚠ 之前记的「ulist 对 ETF 返回 "-"」是**错的** —— 那次用的是 stock/get 的
//     字段口径（f43 之类）。换成 f2/f12/f13/f14/f18 之后 ETF 全部正常。
//     这个错误曾让人以为「ETF 必须逐只请求」，实际可以一次批量拿完。
//   · ⚠ 单只 stock/get 端点与 kline 端点会被东财**按接口**做 IP 级限流
//     （实测打密后 socket 级拒绝 UND_ERR_SOCKET，而同一主机上的 ulist 仍正常）。
//     ⇒ 默认走批量；单只接口只作为最后的兜底。
//
// ── 备用源：腾讯 qt.gtimg.cn ──
//   支持一次请求多只代码（逗号分隔），GBK 编码，字段以 ~ 分隔：
//     [3] 最新 [4] 昨收 [5] 开盘 [30] 时间 [31] 涨跌额 [32] 涨跌幅% [33] 最高 [34] 最低
//   与东财口径一致（实测上证：3651.43 / 3681.47 / 3676.77 两源全等）。

import { emGetJSON, emGetText } from './em.mjs';

const UA_QUOTE_FIELDS = 'f2,f3,f5,f12,f13,f14,f15,f16,f17,f18,f124,f297';
const TX_HOSTS = ['https://qt.gtimg.cn', 'https://sqt.gtimg.cn'];
const TTL_QUOTES = 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

/** epoch 秒 → 北京时间 ISO(+08:00) */
export function isoCNFromEpoch(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  const t = new Date(n * 1000 + 8 * 3600 * 1000);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`
  );
}

const num = (v) => {
  if (v === undefined || v === null || v === '' || v === '-' || v === '—') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 批量取行情。
 * @param {Array<{key:string,name:string,market:string,secid:string,tx?:string,theme?:string,region?:string}>} targets
 * @returns {Promise<{quotes: object[], ok: string[], fail: object}>}
 */
export async function fetchBatchQuotes(targets) {
  const bySecid = new Map(targets.map((t) => [t.secid, t]));
  const quotes = new Map();
  const fail = {};

  // ---- 主源：东财 ulist 批量 ----
  try {
    const secids = targets.map((t) => t.secid).join(',');
    const j = await emGetJSON(
      `/api/qt/ulist.np/get?fltt=2&invt=2&secids=${secids}&fields=${UA_QUOTE_FIELDS}`,
      { hosts: ['https://push2.eastmoney.com', 'https://1.push2.eastmoney.com', 'https://push2delay.eastmoney.com'],
        cacheTtlMs: TTL_QUOTES, cacheTag: 'batch', timeout: 12000 }
    );
    const diff = j?.data?.diff || [];
    for (const d of diff) {
      const meta = bySecid.get(`${d.f13}.${d.f12}`);
      if (!meta) continue;
      const price = num(d.f2);
      if (price === null) {
        fail[meta.key] = `批量端点返回无效价(f2=${d.f2})`;
        continue;
      }
      quotes.set(meta.key, {
        key: meta.key,
        name: d.f14 || meta.name,
        market: meta.market,
        ...(meta.theme ? { theme: meta.theme } : {}),
        ...(meta.region ? { region: meta.region } : {}),
        price,
        open: num(d.f17),
        high: num(d.f15),
        low: num(d.f16),
        prevClose: num(d.f18),
        volume: num(d.f5),
        changePct: num(d.f3),
        // updatedAt 用**源时间戳**而不是抓取时刻：
        // 行情源自己知道最后一次更新是什么时候，抓取时刻会掩盖「数据其实很旧」这件事。
        updatedAt: isoCNFromEpoch(d.f124) || new Date().toISOString(),
        source: 'eastmoney',
      });
    }
    // 批量端点没返回的，标成失败（后面用腾讯补）
    for (const t of targets) {
      if (!quotes.has(t.key) && !fail[t.key]) fail[t.key] = '批量端点未返回该标的';
    }
  } catch (err) {
    for (const t of targets) fail[t.key] = `东财批量失败：${String(err.message).slice(0, 120)}`;
  }

  // ---- 备用源：腾讯批量（只补东财没给出的）----
  const missing = targets.filter((t) => !quotes.has(t.key) && t.tx);
  if (missing.length) {
    for (const chunk of chunkArray(missing, 40)) {
      try {
        const codes = chunk.map((t) => t.tx).join(',');
        const text = await emGetText(`/q=${codes}`, { hosts: TX_HOSTS, gbk: true, timeout: 10000 });
        const byTx = new Map(chunk.map((t) => [t.tx, t]));
        for (const line of String(text).split(';')) {
          const m = line.match(/v_([^=]+)="([^"]*)"/);
          if (!m) continue;
          const meta = byTx.get(m[1]);
          if (!meta) continue;
          const a = m[2].split('~');
          if (a.length < 35) continue;
          const price = num(a[3]);
          if (price === null) continue;
          quotes.set(meta.key, {
            key: meta.key,
            name: meta.name,
            market: meta.market,
            ...(meta.theme ? { theme: meta.theme } : {}),
            ...(meta.region ? { region: meta.region } : {}),
            price,
            open: num(a[5]),
            high: num(a[33]),
            low: num(a[34]),
            prevClose: num(a[4]),
            volume: num(a[6]),
            changePct: num(a[32]),
            updatedAt: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(a[30])
              ? `${a[30].replace(' ', 'T')}+08:00`
              : new Date().toISOString(),
            source: 'tencent',
          });
          delete fail[meta.key];
        }
      } catch (err) {
        for (const t of chunk) {
          if (!quotes.has(t.key)) fail[t.key] = `腾讯备用失败：${String(err.message).slice(0, 100)}`;
        }
      }
    }
  }

  const ok = [];
  const out = [];
  for (const t of targets) {
    if (quotes.has(t.key)) {
      out.push(quotes.get(t.key));
      ok.push(t.key);
    } else {
      fail[t.key] = fail[t.key] || '未知原因';
    }
  }
  return { quotes: out, ok, fail };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
