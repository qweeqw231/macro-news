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
  sh_comp: { secid: '1.000001', sina: 'sh000001', market: 'CN' },
  sz_comp: { secid: '0.399001', sina: 'sz399001', market: 'CN' },
  chinext: { secid: '0.399006', sina: 'sz399006', market: 'CN' },
  star50: { secid: '1.000688', sina: 'sh000688', market: 'CN' },
  bse50: { secid: '0.899050', sina: 'bj899050', market: 'CN' },
  csi300: { secid: '1.000300', sina: 'sh000300', market: 'CN' },
  csi500: { secid: '1.000905', sina: 'sh000905', market: 'CN' },
  csi1000: { secid: '1.000852', sina: 'sh000852', market: 'CN' },
  hsi: { secid: '100.HSI', tx: 'hkHSI', market: 'HK' },
  hs_tech: { secid: '124.HSTECH', market: 'HK' },
  dji: { secid: '100.DJIA', tx: 'usDJI', us: true, market: 'US' },
  ixic: { secid: '100.NDX', tx: 'usIXIC', us: true, market: 'US' },
  spx: { secid: '100.SPX', tx: 'usINX', us: true, market: 'US' },
  n225: { secid: '100.N225', market: 'JP' },
  dax: { secid: '100.GDAXI', market: 'EU' },
  ukx: { secid: '100.FTSE', market: 'UK' },
  kospi: { secid: '100.KS11', market: 'KR' },
};

const SINA_SCALE = { '1d': 240, '1w': 1200, '1M': 7200, '5m': 5, '30m': 30, '60m': 60 };
const TX_PERIOD = { '1d': 'day', '1w': 'week', '1M': 'month' };

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

async function upstream(url, referer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Referer: referer || 'https://finance.eastmoney.com/' },
    });
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// ---------- 实时行情 ----------
async function handleQuote(url) {
  const ids = (url.searchParams.get('secids') || '1.000001,100.DJIA').split(',').filter(Boolean);
  const keys = url.searchParams.get('keys') || '';           // 可选：与 secids 同序，用于回填 name
  const keyList = keys ? keys.split(',') : [];
  const fields = 'f43,f44,f45,f46,f47,f57,f58,f60,f170';
  const out = [];

  for (let i = 0; i < ids.length; i++) {
    try {
      const u = `https://push2.eastmoney.com/api/qt/stock/get?fltt=2&invt=2&secid=${ids[i]}&fields=${fields}`;
      const j = JSON.parse(await upstream(u));
      const d = j?.data;
      if (!d?.f58) continue;
      const n = (v) => (v === undefined || v === null || v === '-' ? null : Number(v));
      out.push({
        key: keyList[i] || '',
        name: d.f58,
        price: n(d.f43), open: n(d.f46), high: n(d.f44), low: n(d.f45),
        prevClose: n(d.f60), volume: n(d.f47), changePct: n(d.f170),
        updatedAt: new Date().toISOString(),
      });
    } catch { /* 单个失败不影响其他 */ }
  }
  return json({ updatedAt: new Date().toISOString(), quotes: out });
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

    return json({ error: `${key} 暂无可用 K 线数据源` }, 404);
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
