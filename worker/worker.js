/**
 * 宏观资讯台 · Cloudflare Worker 行情代理
 *
 * 作用：解决两个静态站做不到的事
 *   1. 浏览器直连东方财富/新浪/腾讯会被 CORS 拦截 → Worker 代取并补 CORS 头
 *   2. 让行情真正实时：前端按需拉取，而不是等采集器写文件
 *
 * 路由：
 *   GET /quote?secids=1.000001,100.DJIA      实时行情（东方财富，逗号分隔）
 *   GET /kline?key=sh_comp&period=1d&limit=250  K线（按 key 内部映射到对应源）
 *   GET /health                                健康检查
 *
 * 部署（二选一）：
 *   A. wrangler：修改 wrangler.toml 里的 name，npx wrangler deploy
 *   B. 控制台：Cloudflare → Workers & Pages → Create → 粘贴本文件 → Deploy
 *      部署完把 https://<你的子域>.workers.dev 填到站点的 assets/config.js
 */

const INDICES = {
  sh_comp: { secid: '1.000001', sina: 'sh000001', tx: 'sh000001', market: 'CN' },
  sz_comp: { secid: '0.399001', sina: 'sz399001', tx: 'sz399001', market: 'CN' },
  chinext: { secid: '0.399006', sina: 'sz399006', tx: 'sz399006', market: 'CN' },
  star50: { secid: '1.000688', sina: 'sh000688', tx: 'sh000688', market: 'CN' },
  bse50: { secid: '0.899050', sina: 'bj899050', tx: 'bj899050', market: 'CN' },
  csi300: { secid: '1.000300', sina: 'sh000300', tx: 'sh000300', market: 'CN' },
  sse50: { secid: '1.000016', sina: 'sh000016', tx: 'sh000016', market: 'CN' },
  a500: { secid: '1.000510', sina: 'sh000510', tx: 'sh000510', market: 'CN' },
  a100: { secid: '1.000903', sina: 'sh000903', tx: 'sh000903', market: 'CN' },
  csi500: { secid: '1.000905', sina: 'sh000905', tx: 'sh000905', market: 'CN' },
  csi1000: { secid: '1.000852', sina: 'sh000852', tx: 'sh000852', market: 'CN' },
  hsi: { secid: '100.HSI', tx: 'hkHSI', market: 'HK' },
  hs_tech: { secid: '124.HSTECH', tx: 'hkHSTECH', market: 'HK' },
  dji: { secid: '100.DJIA', tx: 'usDJI', us: true, market: 'US' },
  ixic: { secid: '100.NDX', tx: 'usIXIC', us: true, market: 'US' },
  spx: { secid: '100.SPX', tx: 'usINX', us: true, market: 'US' },
  // 费城半导体：东财 251. 段（另一套海外指数转播市场），腾讯无代码 ⇒ 只能走东财
  sox: { secid: '251.SOX', market: 'US' },
  n225: { secid: '100.N225', market: 'JP' },
  dax: { secid: '100.GDAXI', market: 'EU' },
  cac40: { secid: '100.FCHI', market: 'EU' },
  ukx: { secid: '100.FTSE', market: 'UK' },
  kospi: { secid: '100.KS11', market: 'KR' },
  sensex: { secid: '100.SENSEX', market: 'IN' },
  vnindex: { secid: '100.VNINDEX', market: 'VN' },
  // 2.15.0 外汇：与 src/sources.mjs 的 INDICES 同步（东财 100.UDI / 133.USDCNH）。
  // 人民币交叉盘（eurcny…）走新浪外汇，Worker 没有这条腿，故不在此表。
  dxy: { secid: '100.UDI', market: 'FX' },
  usdcny: { secid: '133.USDCNH', market: 'FX' },
  // 2.16.0 美元兑各主要货币：与 src/sources.mjs 的 INDICES 同步（东财 119.*）。
  // ⚠ 改这张表后必须 `npx wrangler deploy` 才生效（前端不依赖 Worker，但 /kline?key= 会用到）。
  eurusd: { secid: '119.EURUSD', market: 'FX' },
  gbpusd: { secid: '119.GBPUSD', market: 'FX' },
  usdjpy: { secid: '119.USDJPY', market: 'FX' },
  usdkrw: { secid: '119.USDKRW', market: 'FX' },
  audusd: { secid: '119.AUDUSD', market: 'FX' },
  usdcad: { secid: '119.USDCAD', market: 'FX' },
  usdchf: { secid: '119.USDCHF', market: 'FX' },
};

const SINA_SCALE = { '1d': 240, '1w': 1200, '1M': 7200, '5m': 5, '30m': 30, '60m': 60 };
const TX_PERIOD = { '1d': 'day', '1w': 'week', '1M': 'month' };
// 东财 K 线周期码：101 日 / 102 周 / 103 月，分钟直接给 1/5/15/30/60
const EM_KLT = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1d': 101, '1w': 102, '1M': 103 };
const KLINE_HOSTS = ['https://push2his.eastmoney.com', 'https://1.push2his.eastmoney.com'];
const QUOTE_HOSTS = [
  'https://push2.eastmoney.com',
  'https://1.push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
];
// 腾讯没有代码的海外指数，用 Yahoo 最后兜底（CAC40/DAX/N225/KOSPI/FTSE）
const YAHOO_CODE = {
  '100.FCHI': '^FCHI',
  '100.GDAXI': '^GDAXI',
  '100.N225': '^N225',
  '100.KS11': '^KS11',
  '100.FTSE': '^FTSE',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function upstream(url, referer, timeoutMs = 10000, asBuffer = false) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: referer || 'https://finance.eastmoney.com/' },
    });
    return asBuffer ? r.arrayBuffer() : r.text();
  } finally {
    clearTimeout(t);
  }
}

// ---------- 实时行情 ----------
const num = (v) => {
  if (v === undefined || v === null || v === '' || v === '-' || v === '—') return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};
const isoFromEpoch = (sec) => {
  const t = Number(sec);
  if (!Number.isFinite(t) || t <= 0) return new Date().toISOString();
  const d = new Date(t * 1000 + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+08:00`;
};
const parseTencentTime = (s) => {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00` : null;
};

/** secid → 腾讯代码；腾讯没有的海外指数返回 null */
function tencentCodeFor(secid) {
  const meta = Object.values(INDICES).find((x) => x.secid === secid);
  if (meta && meta.tx) return meta.tx;
  const m = String(secid || '').match(/^([01])\.(\d{6})$/);
  if (!m) return null;
  return (m[1] === '1' ? 'sh' : 'sz') + m[2];
}
function yahooCodeFor(secid) {
  return YAHOO_CODE[secid] || null;
}
function decodeGbk(buf) {
  try { return new TextDecoder('gbk').decode(buf); } catch { return new TextDecoder().decode(buf); }
}

/** 解析腾讯批量文本；wanted = [{secid,key,code,name}] */
function parseTencentQuotes(text, wanted) {
  const byCode = new Map(wanted.map((w) => [w.code, w]));
  const out = [];
  for (const line of String(text).split(';')) {
    const m = line.match(/v_([^=]+)="([^"]*)"/);
    if (!m) continue;
    const w = byCode.get(m[1]);
    if (!w) continue;
    const a = m[2].split('~');
    if (a.length < 35) continue;
    const price = num(a[3]);
    if (price == null) continue;
    out.push({
      secid: w.secid,
      key: w.key || '',
      name: a[1] || w.name || '',
      price,
      prevClose: num(a[4]),
      open: num(a[5]),
      high: num(a[33]),
      low: num(a[34]),
      volume: num(a[6]),
      changePct: num(a[32]),
      updatedAt: parseTencentTime(a[30]),
      source: 'tencent',
    });
  }
  return out;
}

/** Yahoo chart → quote；wanted = {secid,key,name} */
function parseYahooQuote(j, wanted) {
  const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  if (!meta) return null;
  const price = num(meta.regularMarketPrice);
  if (price == null) return null;
  const prev = num(meta.chartPreviousClose) != null ? num(meta.chartPreviousClose) : num(meta.previousClose);
  return {
    secid: wanted.secid,
    key: wanted.key || '',
    name: meta.shortName || wanted.name || '',
    price,
    prevClose: prev,
    open: num(meta.regularMarketOpen),
    high: num(meta.regularMarketDayHigh),
    low: num(meta.regularMarketDayLow),
    volume: num(meta.regularMarketVolume),
    changePct: prev ? Number(((price - prev) / prev * 100).toFixed(2)) : null,
    updatedAt: isoFromEpoch(meta.regularMarketTime),
    source: 'yahoo',
  };
}

/** 东财批量：三个镜像主机并发，谁先给非空 data.diff 用谁 */
async function fetchEmBatch(ids) {
  const fields = 'f2,f3,f5,f12,f13,f14,f15,f16,f17,f18,f124';
  const qs = `fltt=2&invt=2&secids=${encodeURIComponent(ids.join(','))}&fields=${fields}`;
  const tries = QUOTE_HOSTS.map(async (h) => {
    const text = await upstream(`${h}/api/qt/ulist.np/get?${qs}`, 'https://quote.eastmoney.com/', 6000);
    const j = JSON.parse(text);
    if (!j || !j.data || !Array.isArray(j.data.diff) || !j.data.diff.length) {
      throw new Error('empty');
    }
    return j.data.diff;
  });
  try { return await Promise.any(tries); } catch { return []; }
}

async function handleQuote(url) {
  const ids = (url.searchParams.get('secids') || '1.000001,100.DJIA').split(',').filter(Boolean);
  const keys = url.searchParams.get('keys') || '';
  const keyList = keys ? keys.split(',') : [];
  const wanted = ids.map((secid, i) => ({ secid, key: keyList[i] || '', name: '' }));
  const found = new Map();

  // 1) 东财批量
  const diff = await fetchEmBatch(ids);
  for (const d of diff) {
    const secid = `${d.f13}.${d.f12}`;
    const w = wanted.find((x) => x.secid === secid);
    if (!w) continue;
    const price = num(d.f2);
    if (price == null) continue;
    found.set(secid, {
      secid,
      key: w.key,
      name: d.f14 || '',
      price,
      open: num(d.f17), high: num(d.f15), low: num(d.f16),
      prevClose: num(d.f18), volume: num(d.f5), changePct: num(d.f3),
      updatedAt: isoFromEpoch(d.f124),
      source: 'eastmoney',
    });
  }

  // 2) 腾讯备源（CN/ETF/港/美；ETF 由 secid 推导）
  const missing = wanted.filter((w) => !found.has(w.secid));
  const txWanted = missing
    .map((w) => ({ ...w, code: tencentCodeFor(w.secid) }))
    .filter((w) => w.code);
  if (txWanted.length) {
    try {
      const buf = await upstream(
        'https://qt.gtimg.cn/q=' + txWanted.map((w) => w.code).join(','),
        'https://gu.qq.com/', 8000, true
      );
      for (const q of parseTencentQuotes(decodeGbk(buf), txWanted)) found.set(q.secid, q);
    } catch { /* 继续 Yahoo */ }
  }

  // 3) Yahoo 最后兜底（CAC40/DAX/N225/KOSPI/FTSE）
  for (const w of wanted.filter((x) => !found.has(x.secid))) {
    const sym = yahooCodeFor(w.secid);
    if (!sym) continue;
    try {
      const text = await upstream(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`,
        'https://finance.yahoo.com/', 6000
      );
      const q = parseYahooQuote(JSON.parse(text), w);
      if (q) found.set(q.secid, q);
    } catch { /* 该标的缺失，不编造 */ }
  }

  const quotes = wanted.map((w) => found.get(w.secid)).filter(Boolean);
  return json({ updatedAt: new Date().toISOString(), quotes });
}

/** 东财 K 线：新浪/腾讯都没有代码的标的走这条（251.SOX、n225、dax…） */
async function eastmoneyKline(key, period, limit, secid) {
  const klt = EM_KLT[period];
  if (!klt) return json({ error: `东财不支持周期 ${period}` }, 400);
  const qs = `secid=${secid}&klt=${klt}&fqt=1&lmt=${limit}&end=20500101` +
    '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
  for (const h of KLINE_HOSTS) {
    try {
      const j = JSON.parse(await upstream(`${h}/api/qt/stock/kline/get?${qs}`, 'https://quote.eastmoney.com/'));
      const arr = (j && j.data && j.data.klines) || [];
      if (!arr.length) continue;
      // 东财顺序：日期,开盘,收盘,最高,最低,成交量,成交额,振幅
      return json({
        key, period,
        bars: arr.map((r) => {
          const a = String(r).split(',');
          return { t: a[0], o: +a[1], c: +a[2], h: +a[3], l: +a[4], v: +a[5] };
        }),
      });
    } catch { /* 换镜像 */ }
  }
  return json({ error: '上游返回空数据' }, 502);
}

// ---------- K线 ----------
async function handleKline(url) {
  const key = url.searchParams.get('key');
  const period = url.searchParams.get('period') || '1d';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '250', 10), 1000);
  const meta = INDICES[key];
  if (!meta) return json({ error: `未知指数 ${key}` }, 400);

  try {
    if (meta.sina) {
      const scale = SINA_SCALE[period];
      if (!scale) return json({ error: `新浪不支持周期 ${period}` }, 400);
      const u = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${meta.sina}&scale=${scale}&ma=no&datalen=${limit}`;
      const arr = JSON.parse(await upstream(u, 'https://finance.sina.com.cn/'));
      if (!Array.isArray(arr) || !arr.length) return json({ error: '上游返回空数据' }, 502);
      return json({
        key, period,
        bars: arr.map((b) => ({ t: b.day, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume })),
      });
    }

    if (meta.tx) {
      const p = TX_PERIOD[period];
      if (!p) return json({ error: `腾讯不支持周期 ${period}（仅日/周/月）` }, 400);
      const ep = meta.us
        ? 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get'
        : 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
      const j = JSON.parse(await upstream(`${ep}?param=${meta.tx},${p},,,${limit},qfq`, 'https://gu.qq.com/'));
      const d = j?.data?.[meta.tx];
      const arr = d?.qfqday || d?.day;
      if (!Array.isArray(arr) || !arr.length) return json({ error: '上游返回空数据' }, 502);
      // 腾讯顺序：日期,开盘,收盘,最高,最低,成交量
      return json({
        key, period,
        bars: arr.map((b) => ({ t: b[0], o: +b[1], c: +b[2], h: +b[3], l: +b[4], v: +b[5] })),
      });
    }

    // 3) 东财兜底：新浪/腾讯都没有代码的标的（SOX 的 251. 段只在这里有 K 线）
    return await eastmoneyKline(key, period, limit, meta.secid);
  } catch (e) {
    return json({ error: e.message || '上游请求失败' }, 502);
  }
}

// ---------- 入口 ----------
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (url.pathname === '/health') {
      return json({ ok: true, ts: new Date().toISOString(), indices: Object.keys(INDICES).length });
    }
    if (url.pathname === '/quote') return handleQuote(url);
    if (url.pathname === '/kline') return handleKline(url);

    return json({
      ok: false,
      routes: ['/quote?secids=&keys=', '/kline?key=&period=&limit=', '/health'],
    }, 404);
  },
};

// 供离线测试使用（Cloudflare 允许 default + 命名导出并存）
export { INDICES, tencentCodeFor, yahooCodeFor, parseTencentQuotes, parseYahooQuote };
