// assets/market.js
// 实时行情 + K线数据层：浏览器直连公开行情接口，无需自建代理。
//
// 为什么不需要代理：东财与腾讯的行情接口都返回
//   Access-Control-Allow-Origin（东财反射来源，腾讯为 *），国内可达，浏览器可直接 fetch。
//
// 稳健性：东财镜像主机**会间歇性不可达**（同一时刻有的通、有的断）。
// 因此：
//   行情 = 东财批量接口（多主机，缓存优先）→ 腾讯批量接口 → 调用方回退本地快照
//   K线  = 东财（全 17 指数，含分钟，多主机）→ 腾讯（仅日/周/月，覆盖 CN/HK/US）
(function () {
  'use strict';

  const QUOTE_HOSTS = [
    'https://push2.eastmoney.com',
    'https://1.push2.eastmoney.com',
    'https://push2his.eastmoney.com',
    'https://push2delay.eastmoney.com',
  ];
  const KLINE_HOSTS = [
    'https://1.push2his.eastmoney.com',
    'https://push2his.eastmoney.com',
    'https://2.push2his.eastmoney.com',
    'https://push2.eastmoney.com',
    'https://1.push2.eastmoney.com',
    'https://push2delay.eastmoney.com',
  ];
  // ulist 批量行情字段：f2 价 / f3 涨跌幅 / f5 量 / f12 代码 / f13 市场 / f14 名称 /
  //   f15 高 / f16 低 / f17 开 / f18 昨收
  const QUOTE_FIELDS = 'f2,f3,f5,f12,f13,f14,f15,f16,f17,f18';
  const KLINE_FIELDS1 = 'f1,f2,f3,f4,f5,f6';
  const KLINE_FIELDS2 = 'f51,f52,f53,f54,f55,f56,f57';

  // key → secid / market / name（secid 与 src/sources.mjs 的 INDICES 一致）
  // name 本地保存：腾讯接口返回 GBK 文本，浏览器按 UTF-8 解码会乱码，不能用它的名称
  const META = [
    { key: 'sh_comp', secid: '1.000001', market: 'CN', name: '上证指数' },
    { key: 'sz_comp', secid: '0.399001', market: 'CN', name: '深证成指' },
    { key: 'chinext', secid: '0.399006', market: 'CN', name: '创业板指' },
    { key: 'star50',  secid: '1.000688', market: 'CN', name: '科创50' },
    { key: 'bse50',   secid: '0.899050', market: 'CN', name: '北证50' },
    { key: 'csi300',  secid: '1.000300', market: 'CN', name: '沪深300' },
    { key: 'csi500',  secid: '1.000905', market: 'CN', name: '中证500' },
    { key: 'csi1000', secid: '1.000852', market: 'CN', name: '中证1000' },
    { key: 'hsi',     secid: '100.HSI',  market: 'HK', name: '恒生指数' },
    { key: 'hs_tech', secid: '124.HSTECH', market: 'HK', name: '恒生科技' },
    { key: 'dji',     secid: '100.DJIA', market: 'US', name: '道琼斯' },
    { key: 'ixic',    secid: '100.NDX',  market: 'US', name: '纳斯达克' },
    { key: 'spx',     secid: '100.SPX',  market: 'US', name: '标普500' },
    { key: 'n225',    secid: '100.N225', market: 'JP', name: '日经225' },
    { key: 'dax',     secid: '100.GDAXI', market: 'EU', name: '德国DAX' },
    { key: 'ukx',     secid: '100.FTSE', market: 'UK', name: '英国富时100' },
    { key: 'kospi',   secid: '100.KS11', market: 'KR', name: '韩国KOSPI' },
  ];
  const byKey = new Map(META.map((m) => [m.key, m]));

  // 周期 → 东财 klt（1/5/15/30/60 分钟；101 日 / 102 周 / 103 月）
  const KLT = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1d': 101, '1w': 102, '1M': 103 };

  // 腾讯代码（备用源）；仅日/周/月可用
  const TX_CODE = {
    sh_comp: 'sh000001', sz_comp: 'sz399001', chinext: 'sz399006', star50: 'sh000688',
    bse50: 'bj899050', csi300: 'sh000300', csi500: 'sh000905', csi1000: 'sh000852',
    hsi: 'hkHSI', hs_tech: 'hkHSTECH',
    dji: 'usDJI', ixic: 'usIXIC', spx: 'usINX',
  };
  const TX_PERIOD = { '1d': 'day', '1w': 'week', '1M': 'month' };

  const num = (v) => (v === undefined || v === null || v === '-' || v === '' ? null : Number(v));

  async function req(url, timeout, asText) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return asText ? res.text() : res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // 主机缓存：上次成功的主机先用，失败再并发赛其余（避免每次多倍请求）
  const hostCache = { quote: null, kline: null };
  // 失败主机冷却：已知不可达的主机 60s 内不再重试，
  // 否则每次取数都会撞一遍全部镜像，控制台刷满 ERR_EMPTY_RESPONSE 且拖慢回退
  const hostDown = new Map();
  const DOWN_MS = 60000;

  async function viaHosts(which, hosts, buildUrl, timeout, pick) {
    const now = Date.now();
    const alive = hosts.filter((h) => !(hostDown.get(h) && now - hostDown.get(h) < DOWN_MS));
    if (!alive.length) throw new Error('镜像主机均在冷却中');

    const cached = hostCache[which];
    if (cached && alive.includes(cached)) {
      try {
        const v = pick(await req(buildUrl(cached), timeout));
        if (v != null) return v;
      } catch (e) { hostDown.set(cached, Date.now()); }
    }
    const got = await Promise.any(
      alive.filter((h) => h !== cached).map(async (h) => {
        try {
          const v = pick(await req(buildUrl(h), timeout));
          if (v == null) throw new Error('空数据');
          return { h, v };
        } catch (e) {
          hostDown.set(h, Date.now());
          throw e;
        }
      })
    );
    hostCache[which] = got.h;
    hostDown.delete(got.h);
    return got.v;
  }

  // ---- 行情：东财批量接口 ----
  async function fetchQuotesEM() {
    const secids = META.map((m) => m.secid).join(',');
    const qs = `fltt=2&invt=2&secids=${secids}&fields=${QUOTE_FIELDS}`;
    const diff = await viaHosts(
      'quote',
      QUOTE_HOSTS,
      (h) => `${h}/api/qt/ulist.np/get?${qs}`,
      8000,
      (j) => (j && j.data && j.data.diff && j.data.diff.length ? j.data.diff : null)
    );
    return diff
      .map((d) => {
        const meta = META.find((m) => m.secid === `${d.f13}.${d.f12}`);
        if (!meta) return null;
        return {
          key: meta.key, name: meta.name, market: meta.market,
          price: num(d.f2), open: num(d.f17), high: num(d.f15), low: num(d.f16),
          prevClose: num(d.f18), volume: num(d.f5), changePct: num(d.f3),
        };
      })
      .filter(Boolean);
  }

  // ---- 行情备源：腾讯批量接口（一次取回，CORS *） ----
  async function fetchQuotesTX() {
    const pairs = META.filter((m) => TX_CODE[m.key]).map((m) => [TX_CODE[m.key], m]);
    if (!pairs.length) throw new Error('腾讯无可用指数');
    const byCode = new Map(pairs.map((p) => [p[0], p[1]]));
    const text = await req('https://qt.gtimg.cn/q=' + pairs.map((p) => p[0]).join(','), 8000, true);
    const out = [];
    for (const line of String(text).split(';')) {
      const m = line.match(/v_([^=]+)="([^"]*)"/);
      if (!m) continue;
      const meta = byCode.get(m[1]);
      if (!meta) continue;
      const a = m[2].split('~');
      if (a.length < 35) continue;
      // 腾讯字段：3 价 / 4 昨收 / 5 开 / 6 量 / 32 涨跌幅 / 33 高 / 34 低
      out.push({
        key: meta.key, name: meta.name, market: meta.market,
        price: num(a[3]), prevClose: num(a[4]), open: num(a[5]),
        volume: num(a[6]), high: num(a[33]), low: num(a[34]), changePct: num(a[32]),
      });
    }
    if (!out.length) throw new Error('腾讯返回空数据');
    return out;
  }

  async function fetchQuotes() {
    try {
      return await fetchQuotesEM();
    } catch (e) {
      return await fetchQuotesTX();
    }
  }

  // ---- K线主源：东财（全 17 指数，含分钟） ----
  async function fetchKlineEM(key, period, limit) {
    const m = byKey.get(key);
    const klt = KLT[period];
    if (!m) throw new Error('未知指数 ' + key);
    if (!klt) throw new Error('不支持的周期 ' + period);
    const path =
      `/api/qt/stock/kline/get?secid=${m.secid}&klt=${klt}&fqt=1&lmt=${limit || 250}` +
      `&end=20500101&fields1=${KLINE_FIELDS1}&fields2=${KLINE_FIELDS2}`;
    const kl = await viaHosts(
      'kline',
      KLINE_HOSTS,
      (h) => h + path,
      10000,
      (j) => (j && j.data && j.data.klines && j.data.klines.length ? j.data.klines : null)
    );
    // 东财字段顺序：日期, 开, 收, 高, 低, 量, 额
    return kl.map((row) => {
      const p = String(row).split(',');
      return { t: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5] };
    });
  }

  // ---- K线备源：腾讯（仅日/周/月） ----
  async function fetchKlineTX(key, period, limit) {
    const code = TX_CODE[key];
    const p = TX_PERIOD[period];
    if (!code || !p) throw new Error('腾讯无该指数/周期');
    const ep = /^us/.test(code)
      ? 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get'
      : 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
    const j = await req(`${ep}?param=${code},${p},,,${limit || 250},qfq`, 10000);
    const d = j && j.data && j.data[code];
    const arr = d && (d[p] || d['qfq' + p]);
    if (!Array.isArray(arr) || !arr.length) throw new Error('腾讯返回空数据');
    // 腾讯字段顺序：日期, 开, 收, 高, 低, 量
    return arr.map((b) => ({ t: b[0], o: +b[1], c: +b[2], h: +b[3], l: +b[4], v: +b[5] }));
  }

  // ---- K线备源 B：腾讯分时（分钟周期兜底，仅当日） ----
  // 东财是唯一提供历史分钟K的源，不可达时用腾讯分时数据聚合出当日分钟K。
  const TX_MIN = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60 };

  async function fetchKlineTXMinute(key, period) {
    const code = TX_CODE[key];
    const step = TX_MIN[period];
    if (!code || !step) throw new Error('腾讯无该指数/周期');
    const j = await req(`https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`, 10000);
    const d = j && j.data && j.data[code] && j.data[code].data;
    const rows = d && d.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('腾讯分时返回空数据');

    // 每行："HHMM 价 累计量 累计额"，量需做差分
    const pts = [];
    let prevVol = 0;
    for (const row of rows) {
      const p = String(row).trim().split(/\s+/);
      if (p.length < 3) continue;
      const price = +p[1];
      const cum = +p[2];
      if (!Number.isFinite(price)) continue;
      pts.push({ hm: p[0], price, v: Number.isFinite(cum) ? Math.max(0, cum - prevVol) : 0 });
      if (Number.isFinite(cum)) prevVol = cum;
    }
    if (!pts.length) throw new Error('腾讯分时为空');

    const date = d.date ? `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}-${d.date.slice(6, 8)}` : '';
    const bars = [];
    for (let i = 0; i < pts.length; i += step) {
      const chunk = pts.slice(i, i + step);
      if (!chunk.length) break;
      let h = -Infinity, l = Infinity, v = 0;
      chunk.forEach((x) => { if (x.price > h) h = x.price; if (x.price < l) l = x.price; v += x.v; });
      const end = chunk[chunk.length - 1].hm;
      bars.push({
        t: `${date} ${end.slice(0, 2)}:${end.slice(2)}`.trim(),
        o: chunk[0].price, c: chunk[chunk.length - 1].price, h, l, v,
      });
    }
    return bars;
  }

  async function fetchKline(key, period, limit) {
    try {
      return await fetchKlineEM(key, period, limit);
    } catch (e) {
      console.warn('[market] 东财K线不可用，转腾讯兜底：', e && e.message);
      try {
        return TX_PERIOD[period]
          ? await fetchKlineTX(key, period, limit)
          : await fetchKlineTXMinute(key, period);
      } catch (e2) {
        console.warn('[market] 腾讯K线不可用，转本地兜底：', e2 && e2.message);
        throw e2;
      }
    }
  }

  // ---- 本地兜底：采集器预生成的日K；周/月由日K聚合（零网络，必可用） ----
  function aggregateDaily(daily, unit) {
    const weekKey = (t) => {
      const d = new Date(String(t).slice(0, 10) + 'T00:00:00Z');
      if (isNaN(d)) return String(t);
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 该周周一
      return d.toISOString().slice(0, 10);
    };
    const out = [];
    let cur = null;
    let curKey = '';
    daily.forEach((b) => {
      const k = unit === 'month' ? String(b.t).slice(0, 7) : weekKey(b.t);
      if (!cur || k !== curKey) {
        cur = { t: b.t, o: b.o, c: b.c, h: b.h, l: b.l, v: b.v };
        curKey = k;
        out.push(cur);
      } else {
        cur.c = b.c;
        cur.t = b.t;
        if (b.h > cur.h) cur.h = b.h;
        if (b.l < cur.l) cur.l = b.l;
        cur.v += b.v;
      }
    });
    return out;
  }

  async function localKline(key, period) {
    if (!byKey.has(key)) throw new Error('未知指数 ' + key);
    const r = await fetch(`data/kline/${key}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error('本地日K不存在');
    const daily = (await r.json()).bars;
    if (!Array.isArray(daily) || !daily.length) throw new Error('本地日K为空');
    if (period === '1d') return daily;
    if (period === '1w') return aggregateDaily(daily, 'week');
    if (period === '1M') return aggregateDaily(daily, 'month');
    throw new Error('本地无该周期');
  }

  window.MarketData = { META, KLT, fetchQuotes, fetchKline, localKline };
})();
