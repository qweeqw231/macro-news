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
    // ---- 场内 ETF（32 只）----
    // 清单真值在 src/etf.mjs（按主题取「成交额 + 规模」最优的代表）；
    // 这里只放前端需要的 secid / name / 腾讯代码。
    // 东财 ulist 批量端点对 ETF **同样有效**（早前「ulist 对 ETF 返回 '-'」的
    // 结论是错的 —— 那次用了 stock/get 的字段口径），所以 ETF 与指数共用一次批量请求。
    { key: 'etf_563360', secid: '1.563360', market: 'ETF', name: '中证A500ETF' },
    { key: 'etf_159819', secid: '0.159819', market: 'ETF', name: '人工智能ETF' },
    { key: 'etf_159530', secid: '0.159530', market: 'ETF', name: '机器人ETF' },
    { key: 'etf_588200', secid: '1.588200', market: 'ETF', name: '科创芯片ETF' },
    { key: 'etf_159516', secid: '0.159516', market: 'ETF', name: '半导体设备ETF' },
    { key: 'etf_158050', secid: '0.158050', market: 'ETF', name: '创业板算力ETF' },
    { key: 'etf_159732', secid: '0.159732', market: 'ETF', name: '消费电子ETF' },
    { key: 'etf_513050', secid: '1.513050', market: 'ETF', name: '中概互联网ETF' },
    { key: 'etf_159792', secid: '0.159792', market: 'ETF', name: '港股通互联网ETF' },
    { key: 'etf_513530', secid: '1.513530', market: 'ETF', name: '港股通红利ETF' },
    { key: 'etf_513120', secid: '1.513120', market: 'ETF', name: '港股创新药ETF' },
    { key: 'etf_512170', secid: '1.512170', market: 'ETF', name: '医疗ETF' },
    { key: 'etf_159992', secid: '0.159992', market: 'ETF', name: '创新药ETF' },
    { key: 'etf_512690', secid: '1.512690', market: 'ETF', name: '酒ETF' },
    { key: 'etf_159766', secid: '0.159766', market: 'ETF', name: '旅游ETF' },
    { key: 'etf_512880', secid: '1.512880', market: 'ETF', name: '证券ETF' },
    { key: 'etf_512800', secid: '1.512800', market: 'ETF', name: '银行ETF' },
    { key: 'etf_515220', secid: '1.515220', market: 'ETF', name: '煤炭ETF' },
    { key: 'etf_512400', secid: '1.512400', market: 'ETF', name: '有色金属ETF' },
    { key: 'etf_516150', secid: '1.516150', market: 'ETF', name: '稀土ETF' },
    { key: 'etf_512660', secid: '1.512660', market: 'ETF', name: '军工ETF' },
    { key: 'etf_560280', secid: '1.560280', market: 'ETF', name: '工程机械ETF' },
    { key: 'etf_159755', secid: '0.159755', market: 'ETF', name: '电池ETF' },
    { key: 'etf_515790', secid: '1.515790', market: 'ETF', name: '光伏ETF' },
    { key: 'etf_159611', secid: '0.159611', market: 'ETF', name: '电力ETF' },
    { key: 'etf_159865', secid: '0.159865', market: 'ETF', name: '养殖ETF' },
    { key: 'etf_512200', secid: '1.512200', market: 'ETF', name: '房地产ETF' },
    { key: 'etf_159869', secid: '0.159869', market: 'ETF', name: '游戏ETF' },
    { key: 'etf_512890', secid: '1.512890', market: 'ETF', name: '红利低波ETF' },
    { key: 'etf_159201', secid: '0.159201', market: 'ETF', name: '自由现金流ETF' },
    { key: 'etf_518880', secid: '1.518880', market: 'ETF', name: '黄金ETF' },
    { key: 'etf_511990', secid: '1.511990', market: 'ETF', name: '华宝添益ETF' },
    // 1Y 国债收益率：全站只有中债「逐日收益率曲线」这一个源
    //   ⇒ 没有东财 secid、也没有腾讯代码，**K线只能走本地预生成文件**
    //   data/kline/cgb_1y.json（采集器每天追加一根）。
    { key: 'cgb_1y', secid: null, market: 'CN', name: '1Y国债收益率' },
  ];
  const byKey = new Map(META.map((m) => [m.key, m]));

  // 周期 → 东财 klt（1/5/15/30/60 分钟；101 日 / 102 周 / 103 月）
  const KLT = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1d': 101, '1w': 102, '1M': 103 };

  // 腾讯代码（备用源）；仅日/周/月可用
  // ⚠ 腾讯 K 线主机用 ifzq.gtimg.cn（不带 web. 前缀）：
  //   本机 DNS 解析不了 web.ifzq.gtimg.cn（ENOTFOUND），而 ifzq.gtimg.cn 正常。
  //   之前写成 web.ifzq.gtimg.cn 会让「腾讯兜底 K 线」整条路径静默失效。
  const TX_CODE = {
    sh_comp: 'sh000001', sz_comp: 'sz399001', chinext: 'sz399006', star50: 'sh000688',
    bse50: 'bj899050', csi300: 'sh000300', csi500: 'sh000905', csi1000: 'sh000852',
    hsi: 'hkHSI', hs_tech: 'hkHSTECH',
    dji: 'usDJI', ixic: 'usIXIC', spx: 'usINX',
    // ---- 场内 ETF 的腾讯代码（备用源：东财限流时用）----
    etf_563360: 'sh563360',
    etf_159819: 'sz159819',
    etf_159530: 'sz159530',
    etf_588200: 'sh588200',
    etf_159516: 'sz159516',
    etf_158050: 'sz158050',
    etf_159732: 'sz159732',
    etf_513050: 'sh513050',
    etf_159792: 'sz159792',
    etf_513530: 'sh513530',
    etf_513120: 'sh513120',
    etf_512170: 'sh512170',
    etf_159992: 'sz159992',
    etf_512690: 'sh512690',
    etf_159766: 'sz159766',
    etf_512880: 'sh512880',
    etf_512800: 'sh512800',
    etf_515220: 'sh515220',
    etf_512400: 'sh512400',
    etf_516150: 'sh516150',
    etf_512660: 'sh512660',
    etf_560280: 'sh560280',
    etf_159755: 'sz159755',
    etf_515790: 'sh515790',
    etf_159611: 'sz159611',
    etf_159865: 'sz159865',
    etf_512200: 'sh512200',
    etf_159869: 'sz159869',
    etf_512890: 'sh512890',
    etf_159201: 'sz159201',
    etf_518880: 'sh518880',
    etf_511990: 'sh511990',
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
    const secids = META.filter((m) => m.secid).map((m) => m.secid).join(',');
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
    if (!m.secid) throw new Error('东财无该标的（只有本地预生成）');
    if (!klt) throw new Error('不支持的周期 ' + period);
    const path =
      `/api/qt/stock/kline/get?secid=${m.secid}&klt=${klt}&fqt=1&lmt=${limit || 250}` +
      `&end=20500101&fields1=${KLINE_FIELDS1}&fields2=${KLINE_FIELDS2}`;
    const kl = await viaHosts(
      'kline',
      KLINE_HOSTS,
      (h) => h + path,
      6000,
      (j) => (j && j.data && j.data.klines && j.data.klines.length ? j.data.klines : null)
    );
    // 东财字段顺序：日期, 开, 收, 高, 低, 量, 额
    return kl.map((row) => {
      const p = String(row).split(',');
      return { t: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5] };
    });
  }

  // ---- K线备源：新浪（仅 CN 指数；JSONP 绕过 CORS，一次拿全量历史）----
  //
  // ⚠ 新浪的 CN_MarketData.getKLineData **datalen 给多少给多少**（2026-10-29 实测）：
  //   3000 → 3000 根（2014-06-26 起）、8000 → 8000 根（1993-11-30 起）、
  //   10000 → **8752 根（1990-12-19 起，36 年全量）**、20000 → 同 8752 根（给超了也是全量）。
  //   ⇒ 想拿多少就给多少，这是全站**唯一没有根数上限**的日K源。
  // ⚠ 普通 json_v2.php **不带 CORS 头**，浏览器 fetch 不了；
  //   但 jsonp_v2.php 的 JSONP 变体可以用 <script> 加载（不受同源策略限制）。
  const SINA_CODE = {
    sh_comp: 'sh000001', sz_comp: 'sz399001', chinext: 'sz399006',
    star50: 'sh000688', bse50: 'bj899050', csi300: 'sh000300',
    csi500: 'sh000905', csi1000: 'sh000852',
  };
  const SINA_SCALE = { '1d': 240, '1w': 1200, '1M': 7200 };

  // 新浪 JSONP 的回调名写在**路径**里（`/var%20_xxx=/`），**每个请求必须唯一**：
  // 固定名字时，快速切换标的两条请求会同时在飞 → 后到的把回调值覆盖，
  // 先到的 onload 读到**别的标的的数据**（串台）。
  // 实测新浪接受任意回调名（`var%20_kline_t1=` 可用）。
  let sinaCbSeq = 0;
  function sinaJsonp(url, cbName, timeoutMs) {
    return new Promise((resolve, reject) => {
      const G = cbName;
      const script = document.createElement('script');
      let timer = null;
      const done = (fn, arg) => {
        if (timer) clearTimeout(timer);
        script.remove();
        try { delete window[G]; } catch (e) { window[G] = undefined; }
        fn(arg);
      };
      timer = setTimeout(() => done(reject, new Error('新浪 JSONP 超时')), timeoutMs || 15000);
      script.onerror = () => done(reject, new Error('新浪 JSONP 加载失败'));
      script.onload = () => {
        const raw = window[G];
        if (!Array.isArray(raw) || !raw.length) return done(reject, new Error('新浪 JSONP 返回空'));
        done(resolve, raw);
      };
      script.src = url;
      document.head.appendChild(script);
    });
  }

  async function fetchKlineSina(key, period) {
    const code = SINA_CODE[key];
    const scale = SINA_SCALE[period];
    if (!code || !scale) throw new Error('新浪无该指数/周期');
    const cb = '_kline_' + (++sinaCbSeq);
    const url =
      'https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/var%20' + cb + '=' +
      `/CN_MarketData.getKLineData?symbol=${code}&scale=${scale}&ma=no&datalen=20000`;
    const raw = await sinaJsonp(url, cb);
    return raw.map((b) => ({
      t: String(b.day).slice(0, 10), o: +b.open, c: +b.close,
      h: +b.high, l: +b.low, v: +b.volume,
    }));
  }

  // ---- K线备源：腾讯（仅日/周/月） ----
  async function fetchKlineTX(key, period, limit) {
    const code = TX_CODE[key];
    const p = TX_PERIOD[period];
    if (!code || !p) throw new Error('腾讯无该指数/周期');
    // ⚠ 腾讯日/周/月在 n>1000 时**直接返回空**（实测 2026-10-29：n=1000 正常，n=3000 空），
    //   而东财 lmt 可以给到 3000 —— 所以备源必须自己 clamp，
    //   否则东财一被限流、备源就整条失效（只剩本地兜底）。
    const n = Math.min(limit || 250, 1000);
    const ep = /^us/.test(code)
      ? 'https://ifzq.gtimg.cn/appstock/app/usfqkline/get'
      : 'https://ifzq.gtimg.cn/appstock/app/fqkline/get';
    const j = await req(`${ep}?param=${code},${p},,,${n},qfq`, 8000);
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
    const j = await req(`https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`, 10000);
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

  // 最近一次 K 线取数实际命中的层级（给界面上的「来源」标注用，避免把兜底数据显示成实时）
  let lastKlineSource = '';
  const getKlineSource = () => lastKlineSource;

  // ---- 取数编排（2026-10-30 重排：串行 fallback → **并发赛马**）----
  //
  //   直连通道 fetchKlineRemote()：东财 / 新浪(JSONP) / 腾讯 **同时发**，谁先回先用
  //   本地通道 localKline() / localFullKline()：采集器预生成的文件（走 GitHub Pages）
  //
  // ⚠ 为什么必须并发（2026-10-30 本机实测，这是「加载要好几秒」的真正根因）：
  //   · 东财 push2his 在本机是 **socket 级拒绝**（连接被重置，0.3 秒失败）；
  //     在能连上的机器上它一旦被限流就会**挂到超时**。
  //   · 串行链下用户必须先等东财那 6~10 秒超时，才轮得到新浪 —— 白等。
  //   · 新浪 JSONP 在浏览器里是 **gzip 传输**（浏览器对 <script> 也会发 Accept-Encoding），
  //     实测 8000 根只要 **226KB / 0.8 秒**；
  //     ⚠ 之前测到的「918KB / 21 秒」是没发 Accept-Encoding 的 curl 假象，别被它误导。
  //   ⇒ 并发后：新浪 ~0.8 秒出图，腾讯 ~1.4 秒兜底，东财挂不挂都不影响。
  //
  // 为什么本地兜底不放在直连链里：直连源走**外网**，本地文件走 **GitHub Pages**，
  // 两者带宽互不争抢，可以并发；而同一个文件绝不能被两条链各下载一遍（白耗带宽）。
  //
  // 各源能给多少根（实测）：
  //   · 东财 lmt 无上限（8000 根到手）；但对消费级 IP **按接口**限流很凶
  //   · 新浪 datalen 无上限（**8752 根 / 36 年全量**），**只覆盖 CN 的 8 个指数**
  //     （实测 hkHSI / usDJI / usIXIC / usINX / hkHSTECH 全部返回 null）；
  //     普通 json_v2.php 不带 CORS 头 ⇒ 必须走 jsonp_v2.php 的 JSONP 变体
  //   · 腾讯 n>1000 直接返回空 ⇒ 必须 clamp 到 1000
  //   · 本地预生成：日K 1000 根（4 年）；服务端另有全量文件 <key>_full.json
  async function fetchKlineRemote(key, period, limit, onData) {
    const jobs = [];
    const add = (name, fn) => {
      jobs.push(
        Promise.resolve()
          .then(fn)
          .then((bars) => {
            if (!bars || !bars.length) throw new Error(name + ' 返回空');
            // 每个源到货都通知一次：后来的**根数更多**才覆盖（判断在 app.js 的 apply 里）
            if (typeof onData === 'function') {
              try { onData(bars, name); } catch (e) { /* 回调异常不影响取数 */ }
            }
            return { name, bars };
          })
          .catch((e) => {
            console.warn(`[market] ${name} 不可用：`, e && e.message);
            throw e;
          })
      );
    };

    add('东财直连', () => fetchKlineEM(key, period, limit));
    if (SINA_CODE[key] && SINA_SCALE[period]) {
      add('新浪直连（全量历史）', () => fetchKlineSina(key, period));
    }
    add('腾讯兜底', () =>
      TX_PERIOD[period]
        ? fetchKlineTX(key, period, limit)
        : fetchKlineTXMinute(key, period));

    // 首个成功即返回；其余源**继续在跑**，到货会通过 onData 追加更全的数据
    let left = jobs.length;
    let firstErr = null;
    return new Promise((resolve, reject) => {
      jobs.forEach((j) =>
        j.then(
          (r) => { lastKlineSource = r.name; resolve(r.bars); },
          (e) => {
            if (!firstErr) firstErr = e;
            if (--left === 0) reject(firstErr || new Error('所有直连源均不可用'));
          }
        )
      );
    });
  }

  // 兼容入口：直连失败时回退本地预生成（保留原有语义）
  async function fetchKline(key, period, limit, onData) {
    try {
      return await fetchKlineRemote(key, period, limit, onData);
    } catch (e) {
      console.warn('[market] 直连K线不可用，转本地预生成：', e && e.message);
      const v = await localKline(key, period);
      lastKlineSource = period === '1d' ? '本地日K快照' : '本地' + (period === '1w' ? '周K' : '月K');
      return v;
    }
  }

  // ---- 本地兜底：采集器预生成的日K；周/月由日K聚合（零网络，必可用） ----
  //
  // ⚠ 本地文件的**内存缓存**：同一页面会话内，把「日K」切到「周K / 月K」时会再次读
  //   同一个日K 文件。1Y 国债的日K 文件有 **500KB** —— 线上按本机实测 5~30 KB/s 的带宽
  //   重下一次要 20~100 秒，用户点一下周K 得干等。
  //   ⇒ 缓存住已取回的文件（同一会话内只下一次）；取失败的不进缓存，允许重试。

  // 本地 K 线文件：URL 带**按天版本号** ⇒ 同一天内重复打开命中浏览器缓存（秒开），
  // 跨天自动失效（数据每天更新）。
  // ⚠ 之前用 `cache: 'no-store'`，浏览器缓存**完全失效** ⇒ 反复点同一标的每次都重下。
  // ⚠ 必须带超时：实测 Pages 偶发「传到一半就卡住」（HTTP 仍是 200），
  //   没有 AbortController 的话 fetch 会**无限期挂起**，用户只看到一句「加载中…」。
  const localFileCache = new Map();
  const DATA_STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  function fetchLocalFile(path, timeoutMs = 15000) {
    if (!localFileCache.has(path)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      localFileCache.set(
        path,
        fetch(`${path}?v=${DATA_STAMP}`, { signal: ctrl.signal, cache: 'default' })
          .then((r) => {
            if (!r.ok) throw new Error('本地文件不存在 ' + path);
            return r.json();
          })
          .catch((e) => {
            localFileCache.delete(path);
            throw e;
          })
          .finally(() => clearTimeout(timer))
      );
    }
    return localFileCache.get(path);
  }

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


  // ---- 服务端预生成的**全量**日K（紧凑数组格式）----
  //
  // 现有 data/kline/<key>.json 只有 **1000 根（4 年）**，而「尽可能多」需要 8752 根（36 年）。
  // 后端每天生成一份 <key>_full.json，bars 是**数组行** [t,o,c,h,l,v]：
  // 8752 根约 110KB（gzip 后约 41KB）—— 比新浪原始 JSON 的 977KB 小一个量级，
  // 而且**不依赖第三方源的可用性**（东财限流时它照样能出图）。
  async function localFullKline(key, period) {
    if (period !== '1d') throw new Error('全量文件只有日K');
    // ⚠ 超时给到 30s：全量文件 gzip 后约 166KB，按本机实测 7~20 KB/s 要 8~24 秒，
    //   用 15s 会让「正在下载中」被误判成「没有这个文件」。
    const j = await fetchLocalFile(`data/kline/${key}_full.json`, 30000);
    const bars = (j.bars || []).map((b) => (Array.isArray(b)
      ? { t: b[0], o: +b[1], c: +b[2], h: +b[3], l: +b[4], v: +b[5] }
      : { t: b.t, o: +b.o, c: +b.c, h: +b.h, l: +b.l, v: +b.v }));
    if (!bars.length) throw new Error('全量文件为空');
    return bars;
  }

  async function localKline(key, period) {
    if (!byKey.has(key)) throw new Error('未知指数 ' + key);
    // 周/月优先读采集器预生成的对应周期文件 —— 历史比「日K 聚合」更全：
    //   周K 1821 根（1990 起 35.8 年）、月K ~431 根（36 年全量）。
    // 文件不存在时再回退到「日K 聚合」（零网络，必可用）。
    if (period === '1w' || period === '1M') {
      const suffix = period === '1w' ? '_1w' : '_1M';
      try {
        const j = await fetchLocalFile(`data/kline/${key}${suffix}.json`);
        const bars = j.bars;
        if (Array.isArray(bars) && bars.length) return bars;
      } catch (e) { /* 没有该周期文件 → 落到下面的日K聚合 */ }
    }
    const j = await fetchLocalFile(`data/kline/${key}.json`);
    const daily = j.bars;
    if (!Array.isArray(daily) || !daily.length) throw new Error('本地日K为空');
    if (period === '1d') return daily;
    if (period === '1w') return aggregateDaily(daily, 'week');
    if (period === '1M') return aggregateDaily(daily, 'month');
    throw new Error('本地无该周期');
  }


  window.MarketData = { META, KLT, fetchQuotes, fetchKline, fetchKlineRemote, localKline, localFullKline, getKlineSource };
})();
