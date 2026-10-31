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
    // 法国CAC40：secid 由东财搜索接口反查（input=法国CAC40 → Code=FCHI, MktNum=100）
    { key: 'cac40',   secid: '100.FCHI', market: 'EU', name: '法国CAC40' },
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
    // ---- 组合标的（纳指100 / 伦敦金 / 上海金 / 人民币中间价）----
    // 除纳指100外，其余 key 的**实时价**来自各自的专业源（腾讯 hf_XAU / 上金所官网 /
    // 中国货币网），走 quotes.json 里的组合快照，
    // 其余 3 个**刻意不写 secid** —— 否则会被 fetchQuotesEM 的东财批量请求一起取回来，
    // 用「COMEX 期货价 / CNH 离岸价」顶掉「现货伦敦金 / 官方中间价」，口径就串了。
    // 它们的 K 线代码单独放 klineSecid / sinaGlobal，由 fetchKlineEM / fetchKlineSinaGlobal 取。
    // ⚠ 纳指100 例外：它是美股指数、只在美股时段交易，而组合采集每天 16:30（美股开盘前）
    //   才跑一次 ⇒ 卡片会一直停在上一交易日（2026-10-31 实测：K 线已到 10-30 收盘，
    //   卡片还是 10-29）。它与 100.NDX100 的 K 线是同一品种（收盘逐位一致），
    //   所以直接进东财实时批次，和 K 线同源同频。
    // ⚠ 口径差异必须如实标注（klineNote 会显示在 K 线注记上）：
    //   · 纳指100 → 100.NDX100：与腾讯 usNDX 末根收盘**完全一致**（29402.51）⇒ 同品种
    //   · 伦敦金 → 新浪外盘 XAU：其末根开/高/低与新浪实时 hf_XAU **逐个吻合**
    //     ⇒ 它就是**现货伦敦金**，与报价源同品种（东财没有现货 secid）
    //   · 上海金 → 118.AU9999：name=黄金9999，**就是上金所 Au99.99** ⇒ 同品种
    //   · 中间价 → 133.USDCNH：中国货币网只有当天接口、没有历史 ⇒ 用离岸价作代理
    { key: 'ndx',        secid: '100.NDX100', klineSecid: '100.NDX100', market: 'US', name: '纳指100', klineNote: '' },
    { key: 'xau',        sinaGlobal: 'XAU',        market: 'CMDTY', name: '伦敦金',        klineNote: '现货黄金（新浪外盘 XAU）：报价源在 04:55 冻结，官方 05:00 收盘，差约 1 美元（0.04%）' },
    { key: 'sge_au9999', klineSecid: '118.AU9999', market: 'SGE',   name: '上海金Au99.99', klineNote: '' },
    // 伦敦银：新浪外盘 XAG（现货白银/美元，5187 根 / 2006 起）；东财 122.XAG 同一条线
    //   （末根差 0.03~0.12、年均差 <0.7%）且历史更长（8950 根 / 1992 起）⇒ 可作第二源
    //   ⚠ 腾讯的 hf_SI 是「纽约白银」（COMEX 期货），不是伦敦银，别用错
    { key: 'xag',        klineSecid: '122.XAG', sinaGlobal: 'XAG', market: 'CMDTY', name: '伦敦银', klineNote: '现货白银（新浪外盘 XAG）：报价源在 04:55 冻结，与 05:00 官方收盘差通常 <0.1%' },
    // 布伦特原油：新浪外盘 OIL（ICE 布伦特连续，2587 根 / 2016 起）
    //   ⚠ 刻意不接东财 112.B00Y：实测两条线换月时基差跳到 6%（当月连续结算 vs 连续合约收盘）
    { key: 'brent',      sinaGlobal: 'OIL', market: 'CMDTY', name: '布伦特原油', klineNote: 'ICE 布伦特连续合约：与具体月份合约（如 12 月）存在约 4 美元基差，涨跌幅一致' },
    { key: 'usdcny',     klineSecid: '133.USDCNH', market: 'FX',    name: '人民币中间价',  klineNote: '历史为离岸价 CNH，与官方中间价有基差（实测约 0.8%）' },
    // 1Y 国债收益率：全站只有中债「逐日收益率曲线」这一个源
    //   ⇒ 没有东财 secid、也没有腾讯代码，**K线只能走本地预生成文件**
    //   data/kline/cgb_1y.json（采集器每天追加一根）。
    { key: 'cgb_1y', secid: null, market: 'CN', name: '1Y国债收益率' },
  ];
  const byKey = new Map(META.map((m) => [m.key, m]));

  /** 该标的的 K 线口径说明（组合标的有代理品种的差异，其余为空串）。 */
  const getKlineNote = (key) => (byKey.get(key) || {}).klineNote || '';

  // 某些标的**全网都没有同口径的分钟源** ⇒ 与其甩一句「加载失败」，
  // 不如说清楚**为什么没有**（用户看到的是事实，不是一个像 bug 的报错）。
  const NO_MINUTE_REASON = {
    xau: '新浪外盘只提供日线（MinKLine 接口一律 __ERROR），东财也没有现货黄金 secid ⇒ 全网无同口径分钟源',
    brent: '布伦特只有新浪外盘的日线；东财 112.B00Y 是「当月连续结算价」，与报价口径在换月时基差可达 6% ⇒ 刻意不混用',
  };
  const getMinuteUnavailableReason = (key) => NO_MINUTE_REASON[key] || '';

  // 周期 → 东财 klt（1/5/15/30/60 分钟；101 日 / 102 周 / 103 月）
  const KLT = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1d': 101, '1w': 102, '1M': 103 };

  // 分钟周期清单（与服务端预生成的分钟K文件名 <key>_<period>.json 一一对应）
  const MINUTE_PERIODS = ['1m', '5m', '15m', '30m', '60m'];

  // 腾讯代码（备用源）；仅日/周/月可用
  // ⚠ 腾讯 K 线主机用 ifzq.gtimg.cn（不带 web. 前缀）：
  //   本机 DNS 解析不了 web.ifzq.gtimg.cn（ENOTFOUND），而 ifzq.gtimg.cn 正常。
  //   之前写成 web.ifzq.gtimg.cn 会让「腾讯兜底 K 线」整条路径静默失效。
  const TX_CODE = {
    sh_comp: 'sh000001', sz_comp: 'sz399001', chinext: 'sz399006', star50: 'sh000688',
    bse50: 'bj899050', csi300: 'sh000300', csi500: 'sh000905', csi1000: 'sh000852',
    hsi: 'hkHSI', hs_tech: 'hkHSTECH',
    dji: 'usDJI', ixic: 'usIXIC', spx: 'usINX',
    // 纳指100：东财批量失败时靠腾讯补（与 100.NDX100 同品种，收盘逐位一致）
    ndx: 'usNDX',
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

  // K 线使用的腾讯代码（日/周/月）。
  //
  // ⚠ 组合标的的实时价归各自的专业源（腾讯 hf_XAU / 上金所 / 货币网），
  //   **除纳指100外**不要再往 TX_CODE 里加：混进报价批次会用错口径
  //   （例如 hf_SI 是 COMEX 期货白银、不是伦敦银）。
  //   纳指100 是例外——它与 usNDX / 东财 100.NDX100 同品种，实时报价也需要它做备源。
  const TX_KLINE_CODE = Object.assign({}, TX_CODE, {
    // 纳指100：腾讯 usfqkline 最多 1000 根（n>1000 直接返回空）
    ndx: 'usNDX',
  });

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
  // 失败主机冷却：已知不可达的主机在一段时间内不再重试，
  // 否则每次取数都会撞一遍全部镜像，控制台刷满 ERR_EMPTY_RESPONSE 且拖慢回退
  // ⚠ 冷却期别太长（2026-10-30 从 60s 收到 20s）：东财一旦被封，冷却期内
  //   **全站所有标的**都只剩腾讯兜底（欧日韩指数的分钟K直接归零）。
  //   20s 足以避开「立刻重试再被拒」，又不会让一次封禁废掉整整一分钟。
  const hostDown = new Map();
  const DOWN_MS = 20000;

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
    // ⚠ 并发别开满（2026-10-30 实测）：一次图表请求同时打 6 个镜像主机，
    //   很容易把东财打到 socket 级拒绝（实测：拉完 CAC40 9192 根日K 后，
    //   紧接着的 5 分钟请求就变成「All promises were rejected」）。
    //   ⇒ 改成**每组最多 2 个并发**，这一组全挂再试下一组。
    const rest = alive.filter((h) => h !== cached);
    let got = null;
    for (let i = 0; i < rest.length && !got; i += 2) {
      const chunk = rest.slice(i, i + 2);
      try {
        got = await Promise.any(chunk.map(async (h) => {
          try {
            const v = pick(await req(buildUrl(h), timeout));
            if (v == null) throw new Error('空数据');
            return { h, v };
          } catch (e) {
            hostDown.set(h, Date.now());
            throw e;
          }
        }));
      } catch (e) {
        // 这一组全挂 ⇒ 下一组继续试
      }
    }
    if (!got) throw new Error('所有镜像主机均失败');
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
    // ⚠ 组合标的的东财 secid 放在 klineSecid（不占 secid，否则会混进实时报价批次）
    const secid = m.klineSecid || m.secid;
    if (!secid) throw new Error('东财无该标的（只有本地预生成）');
    if (!klt) throw new Error('不支持的周期 ' + period);
    const path =
      `/api/qt/stock/kline/get?secid=${secid}&klt=${klt}&fqt=1&lmt=${limit || 250}` +
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
  // 分钟周期：新浪的 CN_MarketDataService 对**指数和场内 ETF 都有效**，
  // datalen 上限 1023（2026-10-31 实测：1023 → 1023 根；2000/5000 → 返回 null）。
  //   1m ≈ 4 个交易日 / 5m ≈ 21 天 / 15m ≈ 64 天 / 30m ≈ 128 天 / 60m ≈ 256 天。
  //   ⚠ 东财对 ETF 的分钟历史只给最近一天（用户实测「只有数根」），新浪这条腿正好补上。
  const SINA_MIN_SCALE = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60 };

  /** 新浪代码：指数用 SINA_CODE；ETF 由 secid 反推（1.xxx → shxxx / 0.xxx → szxxx） */
  function sinaCodeFor(key) {
    if (SINA_CODE[key]) return SINA_CODE[key];
    const m = byKey.get(key);
    if (!m || !m.secid) return '';
    const [mk, code] = String(m.secid).split('.');
    if (mk === '1') return 'sh' + code;
    if (mk === '0') return 'sz' + code;
    return '';
  }

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

  // ---- K线备源：新浪分钟（CN 指数 + 场内 ETF；JSONP）----
  // 1023 根封顶（实测），但比东财「ETF 只有当天」和腾讯 320 根都好。
  async function fetchKlineSinaMinute(key, period) {
    const code = sinaCodeFor(key);
    const scale = SINA_MIN_SCALE[period];
    if (!code || !scale) throw new Error('新浪无该标的/分钟周期');
    if (!/^(sh|sz)/.test(code)) throw new Error('新浪分钟只覆盖沪深标的');
    const cb = '_kline_' + (++sinaCbSeq);
    const url =
      'https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20' + cb + '=' +
      `/CN_MarketDataService.getKLineData?symbol=${code}&scale=${scale}&ma=no&datalen=1023`;
    const raw = await sinaJsonp(url, cb, 15000);
    return raw.map((b) => ({
      t: String(b.day), o: +b.open, c: +b.close, h: +b.high, l: +b.low,
      v: +b.volume || 0,
    }));
  }

  // ---- K线备源：新浪外盘（现货伦敦金/伦敦银/布伦特；JSONP 绕过 CORS）----
  //
  // ⚠ 实测（2026-10-30）：
  //   · XAU 5186 根（2006-10-30 起）/ XAG 5187 根 / OIL 2587 根（2016-10-31 起）
  //   · **只有日线**（getGlobalFuturesWeeklyKLine / getGlobalFuturesMinKLine 都返回 __ERROR）
  //     ⇒ 周/月由日K在本地聚合（口径与本地文件的聚合一致）
  //   · symbol 必须**去掉 hf_ 前缀**（symbol=hf_XAU 返回 null）
  //   · 回调名**可自定义**（实测 var%20_kline_1= 可用）⇒ 与 CN 指数共用 sinaJsonp
  const SINA_GLOBAL_CODE = { xau: 'XAU', xag: 'XAG', brent: 'OIL' };

  // OHLC 自洽兜底：把 high/low 撑开到必定包含 open/close。
  // ⚠ 新浪外盘 XAU 日线 5186 根里有 132 根「最高<开盘 / 最低>收盘」的坏行（集中在 2012~2017，
  //   是新浪自己的历史数据损坏，不是字段序错）；不修会画出「影线穿过实体」的畸形蜡烛。
  //   只动 high/low，不动 open/close（收盘价语义不能碰）。后端 src/sources.mjs 用同一套规则。
  function fixOhlc(bars) {
    return bars.map((b) => ({
      ...b,
      h: Math.max(b.h, b.o, b.c),
      l: Math.min(b.l, b.o, b.c),
    }));
  }

  async function fetchKlineSinaGlobal(key, period) {
    const symbol = SINA_GLOBAL_CODE[key];
    if (!symbol) throw new Error('新浪外盘无该标的');
    // ⚠ **只有日线**。分钟周期必须明确失败 —— 2026-10-30 的教训：
    //   这里原本写成「非 1d 一律按 month 聚合」，结果伦敦金的「5分钟」图
    //   画出来的是 **241 根月K**（2006-10-31 起），假数据比没数据更糟。
    if (period !== '1d' && period !== '1w' && period !== '1M') {
      throw new Error('新浪外盘只有日线，无分钟级数据');
    }
    const cb = '_kline_' + (++sinaCbSeq);
    const url =
      'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20' + cb + '=' +
      `/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${symbol}`;
    const raw = await sinaJsonp(url, cb);
    const daily = fixOhlc(raw.map((b) => ({
      t: String(b.date).slice(0, 10), o: +b.open, c: +b.close,
      h: +b.high, l: +b.low, v: +b.volume || 0,
    })));
    if (period === '1d') return daily;
    return aggregateDaily(daily, period === '1w' ? 'week' : 'month');
  }

  // ---- K线备源：腾讯（仅日/周/月） ----
  async function fetchKlineTX(key, period, limit) {
    const code = TX_KLINE_CODE[key];
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
    const code = TX_KLINE_CODE[key];
    const step = TX_MIN[period];
    if (!code || !step) throw new Error('腾讯无该指数/周期');
    // ⚠⚠ **美股必须走 usMinute 端点**（2026-10-30 实测）：
    //   通用端点 minute/query 对美股指数只返回 **1 个点**（等于当前价，不是分时序列）
    //   ⇒ 道指/纳指的「5分钟」图只剩 1 根蜡烛；
    //   usMinute/query 则给 **391 个分时点**（09:30 起，含量）。
    const url = code.startsWith('us')
      ? `https://ifzq.gtimg.cn/appstock/app/usMinute/query?code=${code}`
      : `https://ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`;
    const j = await req(url, 10000);
    const d = j && j.data && j.data[code] && j.data[code].data;
    const rows = d && d.data;
    if (!Array.isArray(rows) || !rows.length) throw new Error('腾讯分时返回空数据');
    // ⚠ 点数太少 = 这个源其实没有分时序列（美股走错端点时就是 1 点）。
    //   当成有效数据画出来会得到「只有 1 根蜡烛」的假图 ⇒ 直接判失败，让东财那条腿顶上。
    if (rows.length < 5) throw new Error(`腾讯分时只有 ${rows.length} 点，判定无分时序列`);

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
    if (SINA_MIN_SCALE[period]) {
      const sym = sinaCodeFor(key);
      if (sym && /^(sh|sz)/.test(sym)) {
        add('新浪分钟（1023 根）', () => fetchKlineSinaMinute(key, period));
      }
    }
    if (SINA_GLOBAL_CODE[key]) {
      add('新浪外盘（全量历史·现货）', () => fetchKlineSinaGlobal(key, period));
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
  // 分钟快照是**每小时**更新的 ⇒ 版本戳也按小时变。
  // ⚠ 为什么不能只用按天戳（2026-10-30 实测）：分钟文件是**逐步补齐**的
  //   （服务端每轮只补一部分），用户在「文件还不存在」时打开过一次，
  //   那个 404 会被浏览器/CDN 缓存住 ⇒ 文件后来补齐了，前端仍然一直报「尚未生成」。
  //   ⇒ 分钟路径（data/kline/min/）用「天+小时」戳，跨小时自动换 URL。
  const HOUR_STAMP = new Date().getUTCHours();
  function fetchLocalFile(path, timeoutMs = 15000) {
    if (!localFileCache.has(path)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const stamp = path.indexOf('/min/') >= 0 ? `${DATA_STAMP}h${HOUR_STAMP}` : DATA_STAMP;
      localFileCache.set(
        path,
        fetch(`${path}?v=${stamp}`, { signal: ctrl.signal, cache: 'default' })
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
      const k = unit === 'year' ? String(b.t).slice(0, 4)
        : unit === 'month' ? String(b.t).slice(0, 7) : weekKey(b.t);
      if (!cur || k !== curKey) {
        cur = {
          t: unit === 'year' ? k + '-01-01' : b.t,
          o: b.o, c: b.c, h: b.h, l: b.l, v: b.v,
        };
        curKey = k;
        out.push(cur);
      } else {
        cur.c = b.c;
        if (unit !== 'year') cur.t = b.t;
        if (b.h > cur.h) cur.h = b.h;
        if (b.l < cur.l) cur.l = b.l;
        cur.v += b.v;
      }
    });
    return out;
  }
  const aggregateYear = (bars) => aggregateDaily(bars, 'year');


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

    // ---- 分钟周期：读服务端预生成的分钟K快照 ----
    // ⚠ 欧日韩指数 / 上海金 / 伦敦银的分钟K **只有东财一个源**，
    //   而东财对客户端时不时 socket 级拒绝（实测：拉完 9192 根日K 后下一个请求就被全拒）
    //   ⇒ 客户端直连失败时，这里用服务端（Actions / 美国节点）预生成的快照兜底。
    //   文件名规则：data/kline/min/<key>_<period>.json（如 data/kline/min/dax_5m.json），
    //   由 scripts/update-kline-minute.mjs 生成，bars 是紧凑数组行 [t,o,c,h,l,v]。
    //   ⚠ 必须在 min/ 子目录：'<key>_1m.json'（1分钟）与 '<key>_1M.json'（月K）
    //     在 **Windows 上是同一个文件名**（大小写不敏感）⇒ 放同一目录会把月K 覆盖掉。
    if (MINUTE_PERIODS.includes(period)) {
      const j = await fetchLocalFile(`data/kline/min/${key}_${period}.json`);
      const bars = (j.bars || []).map((b) => (Array.isArray(b)
        ? { t: b[0], o: +b[1], c: +b[2], h: +b[3], l: +b[4], v: +b[5] }
        : { t: b.t, o: +b.o, c: +b.c, h: +b.h, l: +b.l, v: +b.v }));
      if (!bars.length) throw new Error('本地无该分钟周期');
      return bars;
    }

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
    if (period === '1y') {
      try {
        const j = await fetchLocalFile(`data/kline/${key}_1M.json`);
        const m = j.bars;
        if (Array.isArray(m) && m.length) return aggregateYear(m);
      } catch (e) { /* 没有月K文件 → 用日K聚合 */ }
    }
    const j = await fetchLocalFile(`data/kline/${key}.json`);
    const daily = j.bars;
    if (!Array.isArray(daily) || !daily.length) throw new Error('本地日K为空');
    if (period === '1d') return daily;
    if (period === '1y') return aggregateYear(daily);
    if (period === '1w') return aggregateDaily(daily, 'week');
    if (period === '1M') return aggregateDaily(daily, 'month');
    throw new Error('本地无该周期');
  }


  window.MarketData = { META, KLT, MINUTE_PERIODS, fetchQuotes, fetchKline, fetchKlineRemote, localKline, localFullKline, getKlineSource, getKlineNote, getMinuteUnavailableReason, aggregateYear };
})();
