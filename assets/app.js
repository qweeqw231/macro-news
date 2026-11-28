// site/assets/app.js
// 宏观资讯台 · 前端逻辑
// 零框架，直接 fetch data/*.json 渲染。
// 搜索用 Fuse.js（延迟建索引，不阻塞首屏）。

(function () {
  'use strict';

  const DATA = 'data';   // 与 index.html 同级（GitHub Pages 从仓库根发布）
  const PAGE = 40;

  // 2.4.1：交易所假日表（assets/market-calendar.json）。
  // 只用于“休市/已收盘”判定；加载失败或超出覆盖范围时按交易时段降级，绝不猜假日。
  let MARKET_CAL = null;
  let calendarPromise = null;
  function ensureCalendar() {
    if (!calendarPromise) {
      calendarPromise = fetch('assets/market-calendar.json', { cache: 'default' })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { MARKET_CAL = j; return j; })
        .catch(() => null);
    }
    return calendarPromise;
  }

  const S = {
    view: 'feed',
    filter: 'all',
    q: '',
    items: [],
    searchIdx: null,
    searchTotal: 0,    // 62 天窗口内的去重总条数（search.json.total，非热段条数）
    searchHotDays: 0,  // 热段天数（search.json.hotDays）
    fuse: null,
    shown: PAGE,
    archive: null,
    hist: null,       // 近一年历史切片索引（归档页打开时才加载）
    periodic: null,   // 周期报告索引（周报/月报/年报，归档页打开时才加载）
    total: 0,        // 库内总条数（用于标注当前列表的母集）
  };

  // 页面级数据健康：页脚总灯不能只看「采集运行状态」，
  // 还要反映当前页面真正依赖的 latest.json / quotes.json 是否可用。
  let feedLoadOk = true;
  let quotesLoadOk = true;

  const $ = (s) => document.querySelector(s);
  const el = (t, c, txt) => {
    const n = document.createElement(t);
    if (c) n.className = c;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
    );

  // ---------- 刷新前后保持页面状态 ----------
  // 只存 sessionStorage：同一标签页刷新有效，新窗口/次日不会突然弹出旧阅读器。
  const UI_KEY = 'macroNewsUI.v1';
  let uiState = null;
  try { uiState = JSON.parse(sessionStorage.getItem(UI_KEY) || 'null'); } catch { uiState = null; }

  // ---------- 归档时间轴（3.0.0） ----------
  // 纯函数在 assets/archive-time.js（ISO 周 / 月 / 路由语法），这里只放页面状态。
  const AT = window.MacroArchiveTime;
  let archRoute = null;       // 当前归档层路由（year / month / week / day / all）
  let archCtx = null;         // 归档数据分组（天 / 月 / 周 / 年 + 报告）
  let archRendered = false;
  let archAllShown = 3;       // 「全部日期」已展开的月数（按月分页，不一次渲染 387 张）
  let archToken = 0;          // 异步渲染令牌：连续改 hash 时丢弃旧结果
  let archRestoring = false;  // 归档层正在渲染/恢复：此期间的 saveUI 不得覆盖已存的滚动位置
  // 3.0.0：刷新恢复从「单一滚动位置」扩展为「按路由保存」，旧 key（y/briefOpen/periodicOpen）保留兼容。
  let routeStates = (uiState && uiState.routes && typeof uiState.routes === 'object') ? uiState.routes : {};
  const archKey = (r) => (r ? AT.routeKey(r) : '');

  function saveUI() {
    try {
      // 归档层渲染/恢复途中，报告卡自动展开会派发 toggle → 这里的 scrollY 还是 0，
      // 写回去会把刷新前存的滚动位置覆盖掉。等 restoreArchiveState 落位后再存。
      if (archRestoring) return;
      const readerOpen = $('#readerModal') && !$('#readerModal').hidden;
      const rdBox = $('#readerModal')?.querySelector('.rd-box');
      const list = S.visible || S.items;
      const it = readerOpen && readerIdx >= 0 ? list[readerIdx] : null;
      const klineOpen = $('#klineModal') && !$('#klineModal').hidden;
      const macroOpen = $('#macroModal') && !$('#macroModal').hidden;
      // 归档页早报折叠块的展开状态：并入同一份 sessionStorage，刷新后还在
      const briefOpen = (() => {
        try {
          return [...document.querySelectorAll('#view-archive .day.has-brief.expanded')]
            .map((x) => x.dataset.day)
            .filter(Boolean);
        } catch { return []; }
      })();
      // 3.0.0：周期报告（周报/月报/年报）的展开状态，按 `type=id` 记录。
      //   报告卡可能同时出现在顶部入口与本层，用 Set 去重。
      const periodicOpen = (() => {
        try {
          return [...new Set(
            [...document.querySelectorAll('#view-archive details.pr-card[open]')]
              .map((x) => x.dataset.key)
              .filter(Boolean)
          )];
        } catch { return []; }
      })();
      const scrollY = window.scrollY || 0;
      // 3.0.0：按路由存滚动与展开；旧 key 仍写一份，混用版本时不至于报错。
      if (S.view === 'archive' && archRoute) {
        const key = archKey(archRoute);
        if (key) {
          routeStates[key] = { y: scrollY, briefOpen: briefOpen.slice(), periodicOpen: periodicOpen.slice() };
          const keys = Object.keys(routeStates);
          if (keys.length > 24) delete routeStates[keys[0]];
        }
      }
      sessionStorage.setItem(UI_KEY, JSON.stringify({
        v: 1,
        view: S.view,
        filter: S.filter,
        shown: S.shown,
        y: scrollY,
        routes: routeStates,
        reader: it ? {
          id: it.id || '',
          url: it.url || '',
          day: String(it.time || '').slice(0, 10),
          y: rdBox ? rdBox.scrollTop : 0,
        } : null,
        kline: klineOpen && klineKey ? {
          key: klineKey,
          period: klinePeriod,
          // 2.7.1：名称/现价一起存。刷新时行情还没回来也能先把弹窗头部画对，
          //   否则会先显示 key 或空价格，等 quotes.json 到了再改（又是一次跳动）。
          name: ($('#kmName') || {}).textContent || '',
          price: ($('#kmPrice') || {}).textContent || '',
          // 2.4.12：恢复途中（图表还没落图）优先沿用待恢复视图，别把 reset() 的 90 根默认值写回
          ...((pendingKlineView && pendingKlineView.key === klineKey && pendingKlineView.period === klinePeriod)
            ? { barsShown: pendingKlineView.barsShown, offset: pendingKlineView.offset }
            : (kChart && kChart.getView ? kChart.getView() : {})),
        } : null,
        // 2.36.0：宏观图抽屉（key + 区间），刷新后原样恢复
        macro: macroOpen && macroKey ? { key: macroKey, range: macroRange } : null,
        // 2.4.12：归档页打开的某一天（刷新后仍在原位，不回到最新要闻流）
        day: S.view === 'feed' && openedDay ? { day: openedDay.day, kind: openedDay.kind } : null,
        briefOpen,
        periodicOpen,
        // 3.4.0：周期报告整块折叠入口的展开状态（默认收起），刷新后原样恢复
        periodicPanel: !!($('#periodicPanel') && $('#periodicPanel').open),
      }));
    } catch { /* 隐私模式/配额满：不影响页面 */ }
  }

  async function jget(name, cache) {
    // 缓存策略按「新鲜度 vs 重复下载」逐项决定（见各调用点）：
    //   no-store（默认）：latest / quotes / 今天的归档天 —— 首屏与 15s 轮询必须拿最新；
    //   default：search / index / _last-run / 历史归档天 —— 交给 Pages 的 max-age=600，
    //            刷新页面或重开某天时省掉一次 0.7~16s 的 TTFB。
    const r = await fetch(`${DATA}/${name}`, { cache: cache || 'no-store' });
    if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
    return r.json();
  }

  // ---------- 时间显示 ----------
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const p = (n) => String(n).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return sameDay ? `今天 ${hm}` : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  }

  // ---------- 渲染：行情仪表盘 ----------
  // CMDTY / SGE / FX 是组合行情链路的三个新市场（快照回退时才会出现）
  // ETF 是场内 ETF 的独立分组（32 只，market='ETF'）
  const MARKET_LABEL = {
    CN: 'A股', HK: '港股', US: '美股', JP: '日本', EU: '欧洲', UK: '英国', KR: '韩国',
    IN: '印度', VN: '越南',
    CMDTY: '大宗商品', SGE: '上海金', FX: '外汇', ETF: '场内ETF',
  };

  // 行情分组顺序（2.8.1 按实际关注顺序重排）：
  //   A股 → 场内ETF → 港股 → 美股 → 欧洲 → 英国 → 大宗商品 → 上海金 → 外汇
  //   → 日本 → 韩国 → 印度 → 越南
  // 不在此表里的市场排到最后：原先用 ORDER.indexOf 直接相减，未收录的市场得到 -1，
  // 会被静默顶到最前面（2.8.0 的印度 / 越南就是这样跑到 CN 上面的）。
  const MARKET_ORDER = ['CN', 'ETF', 'HK', 'US', 'EU', 'UK', 'CMDTY', 'SGE', 'FX', 'JP', 'KR', 'IN', 'VN'];
  const marketRank = (mk) => {
    const i = MARKET_ORDER.indexOf(mk);
    return i < 0 ? MARKET_ORDER.length : i;
  };

  // FX 组内的关注优先级（用户 2026-11-13 指定）。未收录的排最后，不抢已定顺序。
  const FX_ORDER = [
    'dxy', 'usdcny', 'usdcny_mid',
    'eurusd', 'gbpusd', 'usdjpy', 'usdkrw', 'audusd', 'usdcad', 'usdchf',
    'eurcny', 'gbpcny', 'jpycny', 'krwcny', 'audcny',
  ];
  const fxRank = (key) => {
    const i = FX_ORDER.indexOf(key);
    return i < 0 ? FX_ORDER.length : i;
  };

  // 行情搜索：62 个标的靠肉眼滚太慢。按中文名 / key（含 ETF 代码）/ 英文缩写筛选，
  // 别名只补「名字里不含、但大家会搜」的少数词（黄金 / 原油 / 汇率 / 纳指…），不做拼音。
  // 分组名（港股 / 美股 / 大宗商品…）也进匹配，输入即筛整组。
  const MKT_ALIAS = {
    ndx: '纳指 nasdaq',
    xau: '黄金 金价 gold',
    xag: '白银 银价 silver',
    brent: '原油 油价 布油 oil',
    sge_au9999: '黄金 金价 au9999',
    usdcny: '汇率 人民币 cny 离岸 cnh',
    usdcny_mid: '汇率 人民币 中间价 cny 央行',
    dxy: '美元指数 美元 dxy dollar',
    eurcny: '欧元 汇率 人民币 eur',
    gbpcny: '英镑 汇率 人民币 gbp',
    jpycny: '日元 汇率 人民币 jpy 100日元',
    krwcny: '韩元 汇率 人民币 krw 100韩元',
    audcny: '澳元 汇率 人民币 aud',
    cgb_1y: '国债 收益率 债券 bond',
    hsi: '恒指 恒生 hang seng',
    hs_tech: '恒科',
    sh_comp: '上证 沪指',
    sse50: '上证50 上证 蓝筹 sse50 sse 50',
    a500: '中证A500 A500 中证 a500 宽基',
    a100: '中证A100 A100 中证 a100 宽基',
    eurusd: '欧元 美元 eurusd euro usd 美元兑欧元',
    gbpusd: '英镑 美元 gbpusd cable 美元兑英镑',
    usdjpy: '美元 日元 usdjpy 美元兑日元 日元汇率',
    usdkrw: '美元 韩元 usdkrw 美元兑韩元 韩元汇率',
    audusd: '澳元 美元 audusd 美元兑澳元 澳元汇率',
    usdcad: '美元 加元 usdcad 美元兑加元 加元汇率',
    usdchf: '美元 瑞郎 usdchf 美元兑瑞郎 瑞郎汇率',
    sensex: '印度 孟买 印度指数 bse sensex 孟买30',
    vnindex: '越南 胡志明 hose vn vnindex',
    sox: '费城 半导体 芯片 费半 phlx semiconductor sox',
  };
  // 行情卡片要显示「能搜索到的代码」：A股指数 000001、ETF 563360、恒指 HSI…
  const CODE_MAP = {
    sh_comp: '000001', sz_comp: '399001', chinext: '399006', star50: '000688',
    bse50: '899050', csi300: '000300', sse50: '000016', a500: '000510', a100: '000903', csi500: '000905', csi1000: '000852',
    hsi: 'HSI', hs_tech: 'HSTECH',
    dji: 'DJI', ixic: 'IXIC', spx: 'SPX', sox: 'SOX', n225: 'N225',
    dax: 'DAX', cac40: 'CAC40', ukx: 'FTSE',
    sensex: 'SENSEX', vnindex: 'VNINDEX',
    ndx: 'NDX', xau: 'XAU', xag: 'XAG', brent: 'BRENT',
    sge_au9999: 'AU9999', usdcny: 'USDCNH', usdcny_mid: 'CNY', dxy: 'DXY', cgb_1y: 'CGB1Y',
    eurcny: 'EURCNY', gbpcny: 'GBPCNY', jpycny: 'JPYCNY', krwcny: 'KRWCNY', audcny: 'AUDCNY',
    eurusd: 'EURUSD', gbpusd: 'GBPUSD', usdjpy: 'USDJPY', usdkrw: 'USDKRW',
    audusd: 'AUDUSD', usdcad: 'USDCAD', usdchf: 'USDCHF',
  };
  const codeOf = (q) => {
    if (q.code) return String(q.code);
    if (CODE_MAP[q.key]) return CODE_MAP[q.key];
    const k = String(q.key || '');
    if (k.startsWith('etf_')) return k.slice(4);
    return k.toUpperCase();
  };
  let mktQ = '';
  const quoteSearchText = (q) =>
    [q.name, q.key, codeOf(q), MKT_ALIAS[q.key], MARKET_LABEL[q.market]]
      .filter(Boolean).join(' ').toLowerCase();

  function applyQuoteFilter() {
    const box = $('#quotes');
    if (!box) return;
    const tokens = mktQ.toLowerCase().split(/\s+/).filter(Boolean);
    let total = 0;
    let shown = 0;
    box.querySelectorAll('.mkt').forEach((g) => {
      let any = false;
      g.querySelectorAll('.q').forEach((card) => {
        total++;
        const hit = !tokens.length ||
          tokens.every((t) => (card.dataset.search || '').includes(t));
        card.hidden = !hit;
        if (hit) { any = true; shown++; }
      });
      g.hidden = !any;
    });
    const meta = $('#mqMeta');
    if (!meta) return;
    if (!total) { meta.textContent = ''; return; }
    meta.textContent = tokens.length
      ? (shown ? `命中 ${shown} / ${total} 个标的` : `没有匹配「${mktQ.trim()}」的标的`)
      : `共 ${total} 个标的`;
  }

  // 交易时段判断（北京时间；小时可 >24 表示跨零点，如美股 21:30–次日 04:00）
  function inRange(h, a, b) {
    return b <= 24 ? (h >= a && h < b) : (h >= a || h < b - 24);
  }
  function isTrading(market, now = new Date()) {
    // 2.4.1：优先用 IANA 时区 + 假日表的统一时段模型（否则日本文化の日会显示“交易中”）
    const QSx = window.MacroQuoteStatus;
    // 2026-11-18：不再要求「假日表已加载」才用统一模型 —— 否则 MARKET_CAL 缺失时
    // 分组标题会退回下面的本地窗口表，而卡片状态仍走 sessionAt/classifySession，
    // 两处判定分裂（CMDTY 曾因此显示「休市」而卡片是「实时」）。
    // sessionAt 对 calendar 为空是安全的（holidaySet → calendar || {}），
    // 只是这期间不识别假日，与旧降级表的能力一致。
    if (QSx && QSx.sessionAt) {
      const info = QSx.sessionAt(market, now.getTime(), MARKET_CAL);
      if (info.known) return info.phase === 'open';
    }
    const wd = now.getDay();
    const h = now.getHours() + now.getMinutes() / 60;
    if (wd === 0) return false;                          // 周日休市
    // 有夜盘/准连续品种：周六凌晨仍算前一交易日的尾巴
    if (wd === 6) {
      if (market === 'SGE' && h < 2.5) return true;      // 上海金夜盘到次日 02:30
      if (market === 'CMDTY' && h < 5) return true;      // 24h 商品到周六 05:00
      return false;
    }
    // 24h 商品：周五 05:00 收完到周一 06:00 之间没有行情
    if (market === 'CMDTY' && wd === 1 && h < 6) return false;
    const win = {
      CN: [9.5, 11.5, 13, 15],
      ETF: [9.5, 11.5, 13, 15],                          // 场内 ETF 与 A 股同时段
      HK: [9.5, 12, 13, 16],
      JP: [8.5, 11.3, 12.5, 15],
      KR: [8.5, 11.3, 12.5, 15.3],
      // 印度 BSE：09:15-15:30 IST ⇒ 北京 11:45-18:00
      IN: [11.75, 18],
      // 越南 HOSE：09:00-11:30 / 13:00-14:45 ICT ⇒ 北京 10:00-12:30 / 14:00-15:45
      VN: [10, 12.5, 14, 15.75],
      SG: [9, 12, 13, 17],
      EU: [15, 23.5],                                   // 夏令时约 15:00-23:30
      UK: [14.5, 23],
      US: [21.5, 28],                                  // 含夏令时，覆盖 21:30-次日 4:00
      // 24h 商品（伦敦金/银、布伦特）：06:00-次日 05:00，05:00-06:00 休市
      CMDTY: [6, 29],
      // 上海金：09:00-11:30 / 13:30-15:30 / 20:00-次日 02:30（夜盘归属下一交易日）
      SGE: [9, 15.5, 20, 26.5],
    }[market];
    if (!win) return false;
    if (win.length === 4) {
      return inRange(h, win[0], win[1]) || inRange(h, win[2], win[3]);
    }
    return inRange(h, win[0], win[1]);
  }

  // 2.15.0：显示精度按标的走（源精度分级），默认 2 位；
  // 外汇 / 官方中间价 / 1Y 国债为 4 位。涨跌幅**不随**这个改，仍是全站 2 位。
  const decOf = (key) => {
    const M = window.MarketData;
    return M && M.getDecimals ? M.getDecimals(key) : 2;
  };

  // 2.35.0：量能单位按标的市场走。A 股与港股采集侧都统一为「股」，
  // 浮窗里必须带后缀 —— 成交量副图没有坐标轴，裸数字分不清股数还是金额。
  const volUnitOf = (key) => {
    const M = window.MarketData;
    const meta = M && M.META ? M.META.find((x) => x.key === key) : null;
    return meta && (meta.market === 'CN' || meta.market === 'HK') ? '股' : '';
  };

  function fmtNum(v, d = 2) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  // 2.4.12：15s 轮询时原地更新，不整块 replaceChildren。
  // 整块重建会把卡片节点全部换掉：焦点丢失、过渡动画重启、滚动锚点抖动，
  // 而且每次都要重新创建 60+ 个 DOM 节点。这里按 data-key 对齐后只改真正变化的字段。
  // 卡片集合/顺序变了（标的新增或消失）才返回 false，由调用方回退整块重建。
  function patchQuotes(quotes, statusOf) {
    const box = $('#quotes');
    if (!box) return false;
    const groups = new Map();
    quotes.forEach((q) => {
      if (!groups.has(q.market)) groups.set(q.market, []);
      groups.get(q.market).push(q);
    });
    const mks = [...groups.keys()].sort((a, b) => marketRank(a) - marketRank(b));
    const groupEls = [...box.querySelectorAll('.mkt')];
    if (groupEls.length !== mks.length) return false;

    for (let gi = 0; gi < mks.length; gi++) {
      const mk = mks[gi];
      const g = groupEls[gi];
      const list = groups.get(mk);
      const cards = [...g.querySelectorAll('.q')];
      if (cards.length !== list.length) return false;
      const nameEl = g.querySelector('.mkt-hd .mkt-name');
      const stateEl = g.querySelector('.mkt-hd .mkt-state');
      if (!nameEl || !stateEl) return false;
      if (nameEl.textContent !== (MARKET_LABEL[mk] || mk)) return false;
      // 交易中/休市随开盘收盘切换，但分组结构不动
      const open = list.some((q) => isTrading(q.calendarMarket || q.market));
      const stateTxt = open ? '交易中' : '休市';
      if (stateEl.textContent !== stateTxt) stateEl.textContent = stateTxt;
      stateEl.classList.toggle('open', open);

      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const q = list[i];
        if (card.dataset.key !== q.key) return false;
        const px = card.querySelector('.q-px');
        const chg = card.querySelector('.q-chg');
        const tm = card.querySelector('.q-time');
        if (!px || !chg || !tm) return false;
        const spans = chg.querySelectorAll('span');
        if (spans.length < 2) return false;

        const up = (q.changePct || 0) >= 0;
        const pxTxt = fmtNum(q.price, decOf(q.key));
        if (px.textContent !== pxTxt) px.textContent = pxTxt;
        px.classList.toggle('up', up);
        px.classList.toggle('down', !up);

        const amt = (q.price || 0) - (q.prevClose || 0);
        const t1 = `${up ? '▲' : '▼'} ${fmtNum(Math.abs(amt), decOf(q.key))}`;
        const t2 = `  ${Math.abs(q.changePct || 0).toFixed(2)}%`;
        if (spans[0].textContent !== t1) spans[0].textContent = t1;
        if (spans[1].textContent !== t2) spans[1].textContent = t2;
        const cls = up ? 'up' : 'down';
        if (spans[0].className !== cls) spans[0].className = cls;
        if (spans[1].className !== cls) spans[1].className = cls;

        const st = statusOf(q);
        if (tm.textContent !== st.card) tm.textContent = st.card;
        const ok = st.state === 'realtime';
        const local = st.state === 'local' || st.state === 'closed' || st.state === 'holiday';
        tm.classList.toggle('state-ok', ok);
        tm.classList.toggle('state-local', local);
        tm.classList.toggle('state-warn', !ok && !local);

        const search = quoteSearchText(q);
        if (card.dataset.search !== search) card.dataset.search = search;
      }
    }
    return true;
  }

  let lastQuoteSig = '';

  /**
   * 把行情数组渲染成 `.mkt` 分组 + `.q` 卡片的 fragment。
   * 两处复用：首次/结构变化的整体重建，以及刷新后用缓存快照「原样长回来」（2.7.1）。
   */
  function buildQuotes(quotes, statusOf, openMap) {
    const frag = document.createDocumentFragment();
    const groups = new Map();
    quotes.forEach((q) => {
      if (!groups.has(q.market)) groups.set(q.market, []);
      groups.get(q.market).push(q);
    });

    [...groups.keys()]
      .sort((a, b) => marketRank(a) - marketRank(b))
      .forEach((mk) => {
        const list = groups.get(mk);
        // FX 组内按关注优先级排：美元指数 → 离岸人民币 → 中间价 → 7 个美元对 → 人民币交叉盘。
        // 其余分组保持服务端返回顺序（INDICES/ETF 的自然顺序）。
        if (mk === 'FX') list.sort((a, b) => fxRank(a.key) - fxRank(b.key));
        // openMap：刷新时假日表还没加载完（首帧同步回填），直接用快照里的开盘状态，
        // 否则会先按本地时区降级判断、再被 patch 改回来——又是一次文案跳动。
        const open = openMap ? !!openMap[mk] : list.some((q) => isTrading(q.calendarMarket || q.market));
        const g = el('div', 'mkt');
        const h = el('div', 'mkt-hd');
        h.appendChild(el('span', 'mkt-name', MARKET_LABEL[mk] || mk));
        h.appendChild(el('span', `mkt-state${open ? ' open' : ''}`, open ? '交易中' : '休市'));
        g.appendChild(h);

        const grid = el('div', 'mkt-grid');
        list.forEach((q) => {
          const up = (q.changePct || 0) >= 0;
          const card = el('a', 'q');
          card.href = '#';
          card.dataset.key = q.key;
          card.dataset.search = quoteSearchText(q);
          card.title = '查看 K 线图';
          const head = el('div', 'q-hd');
          const nameBox = el('div', 'q-name-box');
          nameBox.appendChild(el('span', 'q-name', q.name));
          nameBox.appendChild(el('span', 'q-code', codeOf(q)));
          head.appendChild(nameBox);
          const px = el('span', `q-px ${up ? 'up' : 'down'}`, fmtNum(q.price, decOf(q.key)));
          head.appendChild(px);
          card.appendChild(head);
          const chg = el('div', 'q-chg');
          const amt = (q.price || 0) - (q.prevClose || 0);
          chg.appendChild(el('span', up ? 'up' : 'down', `${up ? '▲' : '▼'} ${fmtNum(Math.abs(amt), decOf(q.key))}`));
          chg.appendChild(el('span', up ? 'up' : 'down', `  ${Math.abs(q.changePct || 0).toFixed(2)}%`));
          card.appendChild(chg);
          const st = statusOf(q);
          const tm = el('div', 'q-time', st.card);
          tm.classList.add(st.state === 'realtime' ? 'state-ok'
            : (st.state === 'local' || st.state === 'closed' || st.state === 'holiday')
              ? 'state-local' : 'state-warn');
          card.appendChild(tm);
          grid.appendChild(card);
        });
        g.appendChild(grid);
        frag.appendChild(g);
      });
    return frag;
  }

  async function renderQuotes() {
    const box = $('#quotes');
    const now = Date.now();
    const QS = window.MacroQuoteStatus || {};
    let quotes = null;
    let live = null;
    let localQuotes = null;
    let localGeneratedAt = null;

    // 优先直连东方财富/腾讯实时行情（预算 2s），失败再回退本地采集快照
    if (window.MarketData) {
      try {
        const l = await window.MarketData.fetchQuotes();
        if (l && l.length) {
          live = l.map((q) => ({ ...q, __fromLocal: false }));
        }
      } catch (e) { /* 直连失败，走本地快照 */ }
    }
    // 本地快照始终读一次：直连行情只覆盖指数+ETF，
    // 组合行情（ndx/xau/sge/usdcny/cgb）与「云端补采的 ETF」都在 quotes.json 里。
    try {
      const d = await jget('quotes.json');
      if (d && Array.isArray(d.quotes)) {
        localQuotes = d.quotes;
        localGeneratedAt = d.generatedAt || null;
      }
    } catch (e) { /* 本地快照不可用 */ }

    if (!live) {
      if (!localQuotes) {
        quotesLoadOk = false;
        box.innerHTML = '<div class="skeleton">行情载入失败：实时源与本地快照均不可用，请稍后刷新重试</div>';
        return;
      }
      quotes = localQuotes.map((q) => ({ ...q, __fromLocal: true }));
    } else {
      // 2.9.1：收盘定稿优先于直连的滞后源时间。
      // 印度收盘后东财 f124 仍停在 17:45（价格其实已是收盘价），
      // 若直接用 live，卡片会一直标「盘中值」。本机 quotes.json 里的 dailyK
      // 定稿 asOf 更晚时用它覆盖价格与状态。
      const localMap = new Map((localQuotes || []).map((q) => [q.key, q]));
      quotes = live.map((q) => {
        const loc = localMap.get(q.key);
        if (loc && loc.priceSource === 'dailyK') {
          const lt = Date.parse(loc.updatedAt || '');
          const rt = Date.parse(q.updatedAt || '');
          if (Number.isFinite(lt) && (!Number.isFinite(rt) || lt > rt)) {
            return {
              ...q,
              price: loc.price,
              asOf: loc.asOf,
              updatedAt: loc.updatedAt,
              priceSource: 'dailyK',
              closeDate: loc.closeDate,
              note: loc.note || 'close-daily',
              __fromLocal: false,
            };
          }
        }
        return q;
      });
      if (localQuotes) {
        const seen = new Set(quotes.map((q) => q.key));
        const extra = localQuotes
          .filter((q) => !seen.has(q.key))
          .map((q) => ({ ...q, __fromLocal: true }));
        if (extra.length) quotes = [...quotes, ...extra];
      }
    }

    quotesLoadOk = true;
    const statusOf = (q) => {
      if (!QS.quoteStatus) {
        return {
          state: q.__fromLocal ? 'local' : 'delayed',
          card: q.__fromLocal ? '本地快照' : '延迟（无源时间）',
          summary: q.__fromLocal ? '本地快照' : '数据时间未知 · 延迟',
          footer: q.__fromLocal ? '行情 本地快照' : '行情 延迟（无源时间）',
        };
      }
      return QS.quoteStatus({
        sourceTime: q.updatedAt,
        now,
        fromLocal: !!q.__fromLocal,
        market: q.calendarMarket || q.market,
        calendar: MARKET_CAL,
        priceSource: q.priceSource,
      });
    };

    // 全局状态只看直连主数据；组合类的本地快照按卡片单独标，不把全局拉成“本地”。
    let globalStatus;
    if (live && QS.aggregateStatus) {
      // 2.4.1：按市场交易时段/假日聚合，不再用“跨市场最旧时间”拖垮全局标题
      globalStatus = QS.aggregateStatus(
        live.map((q) => ({ state: statusOf(q).state, sourceTime: q.updatedAt })),
        now
      );
    } else if (live) {
      const liveTimes = live.map((q) => q.updatedAt).filter(Boolean);
      const allHaveTime = liveTimes.length === live.length;
      const states = live.map((q) => statusOf(q).state);
      const worst = QS.worstState ? QS.worstState(states) : (states.includes('delayed') ? 'delayed' : 'realtime');
      // 全局取“最差”那一档：延迟时用最旧源时间，避免 max(源时间) 把全局误判成实时
      const msList = liveTimes.map((t) => Date.parse(t)).filter(Number.isFinite);
      const sourceTime = allHaveTime && msList.length
        ? new Date(worst === 'delayed' ? Math.min(...msList) : Math.max(...msList)).toISOString()
        : null;
      globalStatus = QS.quoteStatus
        ? QS.quoteStatus({ sourceTime, now, fromLocal: worst === 'local' })
        : { state: worst, summary: '行情 ' + worst, footer: '行情 ' + worst };
      if (worst === 'delayed' && !allHaveTime) {
        globalStatus = QS.quoteStatus({ sourceTime: null, now, fromLocal: false });
      }
    } else {
      const localTimes = quotes.map((q) => q.updatedAt).filter(Boolean);
      const msList = localTimes.map((t) => Date.parse(t)).filter(Number.isFinite);
      // ⚠ 必须回成 ISO 字符串：quoteStatus/ageMs 用 Date.parse(sourceTime)，
      //   直接传毫秒数会被当成非法字符串 ⇒ 汇总退化成「数据时间未知」。
      const sourceTime = msList.length
        ? new Date(Math.max(...msList)).toISOString()
        : localGeneratedAt;
      globalStatus = QS.quoteStatus
        ? QS.quoteStatus({ sourceTime, now, fromLocal: true })
        : { state: 'local', summary: '本地快照', footer: '行情 本地快照' };
    }

    S.quotes = quotes;
    S.quoteState = globalStatus.state;
    S.quoteStatusText = globalStatus.summary;
    S.quoteUpdatedAt = globalStatus.state === 'local' ? (globalStatus.sourceTime || null) : null;
    const qt = $('#quoteTime');
    if (qt) qt.textContent = globalStatus.summary;

    // 行情没变就不重绘；按分钟分桶，保证“延迟/陈旧度”文案会随时间更新
    const sig = quotes.map((q) => q.key + q.price + (q.updatedAt || '')).join('|') +
      '|' + globalStatus.state + '|' + Math.floor(now / 60000);
    if (sig === lastQuoteSig) return;
    lastQuoteSig = sig;
    // 2.7.1：把这一份「已渲染」的卡片状态存进 sessionStorage，
    //   刷新后首帧就能按原样长回来，随后 renderQuotes 只 patch 数值（见 paintQuotesFromCache）。
    saveQuoteCache(quotes, statusOf, globalStatus.summary);

    // 2.4.12：结构不变时只改数值/颜色/时间，静态外框与卡片节点原样保留。
    if (patchQuotes(quotes, statusOf)) {
      applyQuoteFilter();
      return;
    }

    // 用 fragment 一次性替换：`innerHTML=''` 再逐个 append 会让仪表盘在渲染过程中
    // 高度塌成 0（既闪一下，又把「视口对齐」的基准位置弄乱）
    box.replaceChildren(buildQuotes(quotes, statusOf));
    applyQuoteFilter();   // 轮询重绘后保持当前筛选结果
  }

  // ---------- 行情快照缓存（2.7.1） ----------
  // 为什么要它：浏览器刷新会清空 DOM，行情靠 fetch 回来再画，于是用户看到
  //   行情页先是一屏空白 → 卡片弹出 → K 线弹窗再晚一步出现（「闪一下，窗口重现」）。
  // 现在把上一次**已经渲染过的**卡片状态（含状态文案）存 sessionStorage，
  //   boot 时同步画回来（首帧就是离开时的样子），新数据到达后由 patchQuotes 只改数值。
  const QUOTE_CACHE_KEY = 'macroNewsQuotes.v1';

  function saveQuoteCache(quotes, statusOf, summary) {
    try {
      const list = quotes.map((q) => {
        const st = statusOf(q);
        return { ...q, __state: st.state, __card: st.card };
      });
      // 分组的「交易中/休市」也一起存：首帧回填时假日表还没到，没有它就只能用
      // 本地时区降级判断，先画错再改回来。
      const groups = {};
      quotes.forEach((q) => {
        const mk = q.market;
        if (!(mk in groups)) groups[mk] = false;
        if (isTrading(q.calendarMarket || q.market)) groups[mk] = true;
      });
      sessionStorage.setItem(QUOTE_CACHE_KEY, JSON.stringify({ at: Date.now(), summary, groups, quotes: list }));
    } catch { /* 隐私模式 / 配额满：跳过，不影响页面 */ }
  }

  /** 用缓存快照把行情网格「原样」画回来；没有缓存或不在行情页则跳过。 */
  function paintQuotesFromCache() {
    if (S.view !== 'market') return false;
    let snap = null;
    try { snap = JSON.parse(sessionStorage.getItem(QUOTE_CACHE_KEY) || 'null'); } catch { snap = null; }
    if (!snap || !Array.isArray(snap.quotes) || !snap.quotes.length) return false;
    const box = $('#quotes');
    if (!box) return false;
    // S.quotes 先顶上：K 线弹窗恢复时用它取名称/现价，别等实时行情回来
    S.quotes = snap.quotes;
    const statusOf = (q) => ({ state: q.__state || 'local', card: q.__card || '本地快照' });
    box.replaceChildren(buildQuotes(snap.quotes, statusOf, snap.groups));
    const qt = $('#quoteTime');
    if (qt && snap.summary) qt.textContent = snap.summary;
    lastQuoteSig = '';        // 强制下一次 renderQuotes 走 patch（结构一致时不会重建）
    applyQuoteFilter();
    return true;
  }

  // 交易时段内加快轮询，其余时间放慢
  function startQuotePolling() {
    const anyOpen = () =>
      (S.quotes || []).some((q) => isTrading(q.market));
    setInterval(async () => {
      if (anyOpen()) {
        await renderQuotes();
      }
    }, (CFG.POLL_SECONDS || 15) * 1000);
  }

  // ---------- 渲染：条目 ----------
  // 条目身份：id 优先（搜索/历史切片都有），其次 url。
  // 2.7.2：刷新回填与「顶部补插新条目」都靠它对齐旧节点，所以下标改成点击时算。
  const itemKey = (it) => String((it && (it.id || it.url)) || '');
  const idxOfItem = (it) => {
    const list = S.visible || S.items || [];
    const k = itemKey(it);
    return k ? list.findIndex((x) => itemKey(x) === k) : -1;
  };

  function itemNode(it) {
    const a = el('article', 'item');
    a.dataset.id = itemKey(it);
    a.dataset.dups = (it._dups || []).map(itemKey).join(',');
    a.tabIndex = 0;
    a.setAttribute('role', 'button');
    a.setAttribute('aria-label', `阅读：${it.title || ''}`);
    a.onclick = (e) => {
      if (e.target && e.target.closest && e.target.closest('button, a')) return;
      openReader(idxOfItem(it));
    };
    a.onkeydown = (e) => {
      if (e.target && e.target.closest && e.target.closest('button, a')) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReader(idxOfItem(it)); }
    };
    const hd = el('div', 'item-hd');
    hd.appendChild(el('span', 'item-time', fmtTime(it.time)));
    hd.appendChild(el('span', `item-src${it.kind === 'official' ? ' official' : ''}`, it.source));
    hd.appendChild(el('span', 'item-time', it.channel || ''));
    if (it.h) hd.appendChild(el('span', 'item-src hist', '历史'));
    a.appendChild(hd);
    a.appendChild(el('div', 'item-title', it.title));
    // RSS 源的 description 常与标题完全相同，重复显示没有意义
    const sum = (it.summary || '').trim();
    if (sum && sum !== it.title.trim()) a.appendChild(el('div', 'item-sum clamp', sum));

    // 同题转载折叠（纯展示层）：主条目后面标「另有 N 家报道」，点开就地列出其它来源。
    // 数据层 S.items 不合并，阅读器/搜索/归档仍能看到每一条原始记录。
    const dups = it._dups || [];
    if (dups.length) {
      const list = el('div', 'item-dups');
      list.hidden = true;
      dups.forEach((d) => {
        const row = d.url ? el('a', 'item-dup') : el('div', 'item-dup');
        if (d.url) {
          row.href = d.url;
          row.target = '_blank';
          row.rel = 'noopener noreferrer';
          row.onclick = (e) => e.stopPropagation();
        }
        row.appendChild(el('span', 'item-dup-src', d.source || '其他来源'));
        row.appendChild(el('span', 'item-dup-time', fmtTime(d.time)));
        list.appendChild(row);
      });
      const btn = el('button', 'item-dup-toggle', `另有 ${dups.length} 家报道`);
      btn.type = 'button';
      btn.setAttribute('aria-expanded', 'false');
      btn.onclick = (e) => {
        e.stopPropagation();
        const open = list.hidden;
        list.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.classList.toggle('on', open);
      };
      a.appendChild(btn);
      a.appendChild(list);
    }
    return a;
  }

  function renderFeed() {
    const box = $('#feed');
    box.innerHTML = '';
    // ⚠ 必须在这里应用频道筛选。之前 applyFilter() 的返回值被直接丢掉，
    //   点「全球」只是把 chip 高亮，列表纹丝不动。
    const visible = applyFilter();
    S.visible = visible;   // 阅读器的上下条也走这份顺序，否则筛选后下标会错位
    const list = visible.slice(0, S.shown);
    if (!list.length) {
      const msg = S.q ? '没有匹配的条目'
        : (S.filter === 'all' ? '暂无数据，请先运行采集脚本' : '该频道暂无条目');
      box.appendChild(el('div', 'empty', msg));
      $('#moreBtn').hidden = true;
      return;
    }
    list.forEach((it) => box.appendChild(itemNode(it)));
    $('#moreBtn').hidden = S.shown >= visible.length;
    saveFeedCache();
  }

  // ---------- 要闻流快照缓存（2.7.2） ----------
  // 与行情快照同一个思路：浏览器刷新会清空 DOM，而 latest.json 要等网络
  // （Pages TTFB 0.7~16s），于是「要闻载入中…」骨架 → 整列表弹出 → 再滚回原位，
  // 看起来就是闪一下再重现。这里把已渲染的列表存进 sessionStorage，
  // boot 时同步画回来（列表 + 滚动位置），新数据到达后只补插顶部新增条目。
  const FEED_CACHE_KEY = 'macroNewsFeed.v1';
  // 只存渲染需要的字段；正文只保留下方「当前可见」的那批（阅读器打开时直接有全文）
  const FEED_FIELDS = ['id', 'time', 'source', 'channel', 'title', 'summary', 'kind', 'url'];

  // 要闻流的母集说明：空搜索时列表是「最新快照」，检索却覆盖全库 —— 不写清楚，
  // 同一个分类会出现「带关键词的条数 > 不带的条数」这种看起来自相矛盾的数字。
  const feedMetaText = () => {
    const raw = (S.base || []).length;
    const shown = feedFoldActive() ? foldFeedItems(S.base || []).length : raw;
    const fold = raw > shown ? `（原始 ${raw} 条，同题合并 ${raw - shown} 条）` : '';
    return `最新快照 ${shown} 条${fold}` +
      (S.total ? ` · 库内共 ${S.total} 条（输入关键词可检索全库）` : '');
  };

  function saveFeedCache() {
    try {
      // 搜索结果与归档某天不进缓存：刷新后应回到最新要闻流。
      // （归档某天只换 S.items，S.base 仍是最新快照 —— 用这条判断更稳，
      //   不然「今天」这种当天归档会被当成最新流存下来，刷新后分类条数对不上。）
      if (S.q || openedDay || !S.items || !S.items.length || S.items !== S.base) return;
      // 整份 S.items（最新快照 200 条）都存：只存当前显示的 40 条的话，
      // 刷新后分类条的计数会变成「全部 40」，与新数据的 200 条对不上。
      const items = S.items.map((it, i) => {
        const o = {};
        FEED_FIELDS.forEach((k) => { if (it[k] != null) o[k] = it[k]; });
        if (i < S.shown && it.content) o.content = it.content;   // 正文只留当前可见那批
        return o;
      });
      sessionStorage.setItem(FEED_CACHE_KEY, JSON.stringify({
        at: Date.now(),
        total: S.total,
        qMeta: feedMetaText(),
        items,
      }));
    } catch { /* 隐私模式 / 配额满：跳过，不影响页面 */ }
  }

  /** 用缓存把要闻流「原样」画回来（含滚动位置）；没有缓存或不在要闻流则跳过。 */
  let feedPainted = false;
  function paintFeedFromCache() {
    if (S.view !== 'feed') return false;
    if (uiState && uiState.day) return false;      // 归档某天由 restoreFeedUI 重开
    let snap = null;
    try { snap = JSON.parse(sessionStorage.getItem(FEED_CACHE_KEY) || 'null'); } catch { snap = null; }
    if (!snap || !Array.isArray(snap.items) || !snap.items.length) return false;
    const box = $('#feed');
    if (!box) return false;

    S.base = snap.items;
    S.items = snap.items;
    S.total = snap.total || snap.items.length;
    // 筛选与「已显示条数」一并恢复到刷新前：否则会先画 40 条、再改成 120 条（又一次重绘）
    if (uiState) {
      const f = uiState.filter;
      if (f && (f === 'all' || snap.items.some((i) => (i.channel || '其他') === f))) S.filter = f;
      S.shown = Math.max(PAGE, Number(uiState.shown) || PAGE);
    }
    renderFilters();
    renderFeed();
    const qm = $('#qMeta');
    if (qm) qm.textContent = snap.qMeta || feedMetaText();
    // 列表已经在 DOM 里、高度是真的 —— 滚动位置可以同步定位，首帧就是离开时的位置
    if (uiState && Number.isFinite(uiState.y)) {
      if (alignState) alignState.userMoved = true;
      window.scrollTo({ top: uiState.y, behavior: 'auto' });
    }
    // 阅读器也要在首帧就打开：它原来挂在 latest.json 之后，晚 0.5~16s 才出现，
    // 用户看到的就是「先列表、再弹窗」的一次重绘。
    restoreReaderUI();
    feedPainted = true;
    return true;
  }

  /**
   * 新快照到达后与已渲染的列表对齐：
   *   · 完全一致 → 一个节点都不碰（刷新后最常见）；
   *   · 顶部多了新条目 → 只插入新节点，旧的卡片原样保留，滚动位置按插入高度补偿；
   *   · 对不上（条目被删改 / 换了筛选）→ 返回 false，由 runSearch('') 整块重建兜底。
   */
  function patchFeed() {
    const box = $('#feed');
    if (!box || S.q) return false;
    const visible = applyFilter();
    const list = visible.slice(0, S.shown);
    const nodes = [...box.querySelectorAll('.item')];
    if (!nodes.length || !list.length) return false;

    // 新条目只会从顶部进来：先定位旧列表在目标列表里的起点
    const firstId = nodes[0].dataset.id;
    let off = -1;
    for (let o = 0; o < list.length; o++) {
      if (itemKey(list[o]) === firstId) { off = o; break; }
    }
    if (off < 0) return false;
    for (let i = 0; i < nodes.length && off + i < list.length; i++) {
      const t = list[off + i];
      if (nodes[i].dataset.id !== itemKey(t)) return false;
      // 同题转载组发生变化（新增/减少来源、主条目换人）时直接整块重建，
      // 否则卡片上的「另有 N 家报道」会停在旧数字上。
      if ((nodes[i].dataset.dups || '') !== (t._dups || []).map(itemKey).join(',')) return false;
    }
    if (nodes.length + off < list.length) return false;   // 旧列表比目标短：交给整块重建

    S.visible = visible;
    syncReader();          // 补插后下标整体后移，阅读器的上/下一条要跟着对齐
    renderFilters();       // 分类条数可能变（有计数签名，没变就不重建）
    const meta = $('#qMeta');
    if (meta) meta.textContent = feedMetaText();
    $('#moreBtn').hidden = S.shown >= visible.length;

    const drop = nodes.length + off - list.length;        // 被新条目挤出下限的旧节点
    if (!off && !drop) return true;

    const h0 = box.offsetHeight;
    const y0 = window.scrollY;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < off; i++) frag.appendChild(itemNode(list[i]));
    if (off) box.insertBefore(frag, box.firstChild);
    for (let i = nodes.length - drop; i < nodes.length; i++) nodes[i].remove();
    // 顶部插入会把下面整体下推：把阅读位置补回来，视口里的内容保持不动
    const added = box.offsetHeight - h0;
    if (y0 > 0 && added > 0) window.scrollTo({ top: y0 + added, behavior: 'auto' });
    saveFeedCache();
    return true;
  }

  // ---------- 站内阅读器 ----------
  let readerIdx = -1;
  let readerKey = '';        // 打开时那条的 id：列表增量补插后用它重新定位（下标记会变）
  let readerScroll = null;   // null = 保留当前滚动位置（异步补全文重绘时）；数字 = 本次打开的目标位置

  function fmtFullTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('zh-CN', { hour12: false });
  }

  function openReader(idx, restoreScroll = 0) {
    const list = S.visible || S.items;
    if (idx < 0 || idx >= list.length) return;
    readerIdx = idx;
    readerKey = itemKey(list[idx]);
    readerScroll = Number(restoreScroll) || 0;
    // ⚠ 必须先显示 modal 再 render：隐藏状态下 .rd-box 没有布局高度，
    //   直接设 scrollTop 会被浏览器钳成 0（刷新恢复阅读器视口时实测）。
    $('#readerModal').hidden = false;
    document.body.style.overflow = 'hidden';
    renderReader();
    saveUI();
  }

  function closeReader() {
    readerIdx = -1;
    readerKey = '';
    readerScroll = null;
    $('#readerModal').hidden = true;
    document.body.style.overflow = '';
    saveUI();
  }

  // 搜索结果来自 search.json —— 只有 title/source/time/url，**没有正文也没有摘要**；
  // 完整正文存在按天的归档文件里（content 最多 4000 字）。
  // 所以打开一条没有正文的条目时，按日期去 data/archive/YYYY-MM-DD.json 取全文。
  //
  // 归档页打开某天也用同一个缓存：一天上限 1800 条（2.12.0 起；2.11.0 起 1600；此前 800）/ ~2MB，切走再点不用重下。
  // 最多留 3 天（防内存膨胀）；今天的文件还在增长，5 分钟后失效重取。
  const DAY_CACHE_MAX = 3;
  const DAY_FRESH_MS = 5 * 60 * 1000;
  const dayCache = new Map();
  // 2.4.19：新闻日 = 北京 08:00 起算（等价 UTC 日期），与归档文件名一致
  const newsDay = (d = new Date()) =>
    window.MacroNewsDay ? window.MacroNewsDay.newsDay(d) : new Date(d).toISOString().slice(0, 10);

  async function getDay(day, kind = 'live') {
    const today = kind === 'live' && day === newsDay();
    const key = kind + ':' + day;
    const hit = dayCache.get(key);
    if (hit && (!today || Date.now() - hit.at < DAY_FRESH_MS)) return hit.data;
    // 历史天不会变 → 交给 Pages 的 max-age=600；今天还在增长 → 必须拿最新。
    // 历史切片（history/）永远是过去日期，因此一律走浏览器缓存。
    const file = kind === 'hist' ? `history/${day}.json` : `archive/${day}.json`;
    const raw = await jget(file, today ? 'no-store' : 'default');
    const data = kind === 'hist' ? normalizeHistDoc(raw) : raw;
    if (hit) dayCache.delete(key);        // 重新插入到队尾（LRU）
    dayCache.set(key, { at: Date.now(), data });
    if (dayCache.size > DAY_CACHE_MAX) dayCache.delete(dayCache.keys().next().value);
    return data;
  }

  /**
   * 历史切片是压过的 1 字母键（i/t/s/u/c/o/k/p），这里还原成与 archive 相同的形状，
   * 上层的列表 / 筛选 / 阅读器都不用改。历史条目没有正文，打 _hist 标记：
   * 阅读器不会再按天回读 archive 补全文（那天本来就只有标题/摘要）。
   */
  function histTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    return new Date((n + 8 * 3600) * 1000).toISOString().slice(0, 19) + '+08:00';
  }

  function normalizeHistDoc(doc) {
    if (!doc || !Array.isArray(doc.items)) return { items: [] };
    return {
      ...doc,
      src: 'history',
      items: doc.items.map((x) => ({
        id: x.i || '',
        title: x.t || '',
        summary: x.s || '',
        url: x.u || '',
        channel: x.c || '',
        source: x.o || '',
        kind: x.k || 'news',
        content: '',
        time: histTime(x.p),
        _hist: 1,
      })),
    };
  }

  async function fetchFullItem(it) {
    if (!it) return it;
    // 历史切片只有摘要：同一天再读一次也是同一份摘要，不做无意义的请求
    if (it._hist) return it;
    if ((it.content || '').trim()) return it;
    const day = String(it.time || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return it;
    try {
      const d = await getDay(day);
      const full = (d.items || []).find((x) => x.id === it.id);
      return full || it;
    } catch (e) {
      return it;
    }
  }

  function renderReader() {
    const list = S.visible || S.items;
    const it = list[readerIdx];
    if (!it) return;
    $('#rdSource').textContent = it.source || '';
    $('#rdTime').textContent = fmtFullTime(it.time);
    $('#rdChannel').textContent = it.channel || '';
    $('#rdTitle').textContent = it.title || '';

    const body = $('#rdBody');
    body.innerHTML = '';
    const text = (it.content || it.summary || '').trim();
    if (text) {
      text.split(/\r?\n+/).map((p) => p.trim()).filter(Boolean)
        .forEach((p) => body.appendChild(el('p', null, p)));
    } else {
      body.appendChild(el('p', 'rd-empty', '本条仅有标题，暂无正文内容，可点击「阅读原文」查看。'));
    }

    // 同题转载的其它来源：主条目正文之后列出可点原文，保证折叠后仍可追溯
    const dups = it._dups || [];
    if (dups.length) {
      const sec = el('div', 'rd-dups');
      sec.appendChild(el('div', 'rd-dups-hd', `另有 ${dups.length} 家报道`));
      dups.forEach((d) => {
        const row = d.url ? el('a', 'rd-dup') : el('div', 'rd-dup');
        if (d.url) {
          row.href = d.url;
          row.target = '_blank';
          row.rel = 'noopener noreferrer';
        }
        row.appendChild(el('span', 'rd-dup-src', d.source || '其他来源'));
        row.appendChild(el('span', 'rd-dup-time', fmtFullTime(d.time)));
        sec.appendChild(row);
      });
      body.appendChild(sec);
    }

    // 缺正文（多半是搜索命中）→ 异步从归档补齐后重绘
    if (!(it.content || '').trim()) {
      const cur = readerIdx;
      const key = itemKey(it);
      fetchFullItem(it).then((full) => {
        if (readerIdx !== cur || full === it) return;
        const curIt = (S.visible || S.items || [])[readerIdx];
        if (!curIt || itemKey(curIt) !== key) return;
        // 折叠后的主条目是 S.items 里的原始对象，但不是同一下标：
        // 必须原地补全（保留 _dups），再按 id 同步回数据列表。
        Object.assign(it, full);
        const i = (S.items || []).findIndex((x) => itemKey(x) === key);
        if (i >= 0) S.items[i] = it;
        renderReader();
      });
    }

    const link = $('#rdLink');
    if (it.url) { link.href = it.url; link.hidden = false; } else { link.hidden = true; }
    $('#rdPrev').disabled = readerIdx <= 0;
    $('#rdNext').disabled = readerIdx >= list.length - 1;
    const rdBox = $('#readerModal').querySelector('.rd-box');
    const keep = readerScroll == null ? rdBox.scrollTop : readerScroll;
    body.scrollTop = 0;
    rdBox.scrollTop = keep;     // 刷新恢复 / 异步补全文时都保留视口
    readerScroll = null;
  }

  function stepReader(d) {
    const list = S.visible || S.items;
    const n = readerIdx + d;
    if (n < 0 || n >= list.length) return;
    readerScroll = 0;           // 切换上/下一条时从顶部开始
    readerIdx = n;
    readerKey = itemKey(list[n]);
    renderReader();
    saveUI();
  }

  // 列表增量补插后下标会整体后移：按打开时那条的 id 重新定位，
  // 否则阅读器「上一条 / 下一条」会跳到别的新闻上。
  function syncReader() {
    if (readerIdx < 0 || !readerKey) return;
    const list = S.visible || S.items || [];
    if (itemKey(list[readerIdx]) === readerKey) return;
    const i = list.findIndex((x) => itemKey(x) === readerKey);
    if (i >= 0) readerIdx = i;
  }

  // 刷新恢复阅读器：按 id 优先、url 兜底在当前可见列表里定位，连滚动位置一起还原。
  // 返回 false 表示这次没法恢复（没有快照 / 那条已不在列表里）。
  function restoreReaderUI() {
    if (!uiState || !uiState.reader || !$('#readerModal').hidden) return false;
    const list = S.visible || S.items || [];
    const { id, url } = uiState.reader;
    const idx = list.findIndex((i) => (id && i.id === id) || (url && i.url === url));
    if (idx < 0) return false;
    openReader(idx, Number(uiState.reader.y) || 0);
    return true;
  }

  // 分类条的计数签名：刷新后新快照到达时大多只多一两条，条数没变就不必重建这一排按钮
  let filtersSig = '';
  function renderFilters() {
    const box = $('#filters');
    // 最新流先按标题全局折叠，再按主条目所属分类计数/过滤：
    // 这样「全部」= 各分类之和，且每个分类点进去的条数与 chip 数字一致。
    // 若先按分类过滤再折叠，跨分类的同题组会在每个分类各算一次，合计会大于「全部」。
    const items = feedFoldActive() ? foldFeedItems(S.items) : S.items;
    const counts = new Map();
    items.forEach((i) => {
      const k = i.channel || '其他';
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    const sig = S.filter + '|' + [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}:${n}`).join(',');
    if (sig === filtersSig) return;
    filtersSig = sig;
    box.innerHTML = '';
    const mk = (label, key, n) => {
      const b = el('button', `fchip${S.filter === key ? ' on' : ''}`, `${label} ${n}`);
      b.onclick = () => { S.filter = key; S.shown = PAGE; renderFilters(); renderFeed(); };
      return b;
    };
    box.appendChild(mk('全部', 'all', items.length));
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, n]) => box.appendChild(mk(k, k, n)));
  }

  // ---------- 同题转载折叠（纯展示层）----------
  // 只对「最新快照」生效；搜索/归档仍按原始条目展示，保证每条都能追溯。
  function feedFoldActive() {
    return !S.q && !openedDay && S.items === S.base;
  }

  /**
   * 按标题**精确匹配**分组，每组只输出一条主条目。
   * 主条目取「最完整」的：正文 > 摘要 > 带链接；都相同时取时间更新的一条。
   * 其它来源挂在 `_dups` 上，由卡片上的「另有 N 家报道」展开，数据本身不删除。
   */
  function foldFeedItems(list) {
    if (!Array.isArray(list) || !list.length) return list || [];
    const order = [];
    const byTitle = new Map();
    list.forEach((it) => {
      if (!it) return;
      // 每次重算都先清掉上一次的折叠标记，避免条目不再重复时残留旧来源
      if (it._dups) delete it._dups;
      const title = String(it.title || '').trim();
      if (!title) { order.push({ single: it }); return; }   // 空标题不参与折叠
      let g = byTitle.get(title);
      if (!g) { g = { items: [] }; byTitle.set(title, g); order.push(g); }
      g.items.push(it);
    });
    const score = (x) =>
      (String(x.content || '').length * 1000) +
      (String(x.summary || '').length * 10) +
      (x.url ? 1 : 0);
    const ts = (x) => Date.parse(x.time || '') || 0;
    return order.map((g) => {
      if (g.single) return g.single;
      if (g.items.length === 1) return g.items[0];
      let main = g.items[0];
      for (const it of g.items) {
        const s = score(it), sm = score(main);
        if (s > sm || (s === sm && ts(it) > ts(main))) main = it;
      }
      main._dups = g.items.filter((x) => x !== main);
      return main;
    });
  }

  function applyFilter() {
    if (feedFoldActive()) {
      // 先全局折叠、再按主条目的分类过滤；与 renderFilters 的计数口径完全一致
      const folded = foldFeedItems(S.items);
      return S.filter === 'all'
        ? folded
        : folded.filter((i) => (i.channel || '其他') === S.filter);
    }
    const list = S.filter === 'all'
      ? S.items
      : S.items.filter((i) => (i.channel || '其他') === S.filter);
    // 搜索/归档不做折叠：清掉上一次留下的 _dups，
    // 否则搜索结果里的原始条目会带着「另有 N 家报道」这种只属于最新流的标记。
    (S.items || []).forEach((it) => { if (it && it._dups) delete it._dups; });
    return list;
  }

  // ---------- 搜索 ----------
  let searchTimer = null;
  function onSearchInput(v) {
    clearTimeout(searchTimer);
    $('#qClear').hidden = !v;
    searchTimer = setTimeout(() => runSearch(v), 220);
  }

  // 检索索引 `data/search.json` 只有最近 62 天（2.11.1 实测 62 个新闻日、60 天有文件：
  // 10.7MB / gzip 2.35MB；2.12.0 上限 1800 后会略增），
  // 从 GitHub Pages 拉一次要**几十秒**（本机实测带宽 5~30 KB/s）。
  // ⇒ **用户碰搜索框（focus）或开始输入时才预取**：首屏、归档、行情都不跟它抢带宽。
  //   还没下完时 qMeta 会显示「检索索引载入中…」。
  //
  // 2.29.0：18 MB 的索引在 12.5 KB/s 下要 5~6 分钟，原先只有一句「请稍候」，
  //   用户无法判断是卡死还是在下载。改用 XHR 拿 onprogress：显示「已下载 / 总大小 · 百分比」，
  //   并给一个「取消」按钮（abort 后保留会话，重新输入关键词即重试）。
  //   注意 onprogress 的字节数是**压缩后**的传输量，与 Pages 实际下发的 gzip 一致。
  let searchIdxPromise = null;
  let searchXhr = null;
  let searchProgress = null; // { loaded, total }

  const fmtMB = (n) => `${(n / 1048576).toFixed(n >= 1048576 * 10 ? 0 : 1)} MB`;

  function renderSearchProgress() {
    const meta = $('#qMeta');
    if (!meta) return;
    const p = searchProgress;
    let txt = '检索索引载入中…（首次检索要下载索引）';
    if (p && p.total > 0) {
      const pct = Math.min(100, Math.round((p.loaded / p.total) * 100));
      txt = `检索索引载入中… ${fmtMB(p.loaded)} / ${fmtMB(p.total)} · ${pct}%`;
    } else if (p && p.loaded > 0) {
      txt = `检索索引载入中… 已下载 ${fmtMB(p.loaded)}`;
    }
    meta.textContent = txt;
    if (!searchXhr) return;
    const b = el('button', 'sb-cancel', '取消');
    b.type = 'button';
    b.onclick = () => { if (searchXhr) searchXhr.abort(); };
    meta.appendChild(b);
  }

  function loadSearchIndex() {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      searchXhr = xhr;
      searchProgress = { loaded: 0, total: 0 };
      xhr.open('GET', `${DATA}/search.json`, true);
      xhr.responseType = 'json';
      const clear = () => { if (searchXhr === xhr) searchXhr = null; searchProgress = null; };
      xhr.onprogress = (e) => {
        if (!searchXhr) return;
        searchProgress.loaded = e.loaded || 0;
        if (e.lengthComputable) searchProgress.total = e.total || 0;
        if (S.q) renderSearchProgress();
      };
      xhr.onload = () => {
        clear();
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response) resolve(xhr.response);
        else reject(new Error(`search.json HTTP ${xhr.status}`));
      };
      xhr.onerror = () => { clear(); reject(new Error('search.json 网络错误')); };
      xhr.onabort = () => {
        clear();
        const e = new Error('已取消载入索引');
        e.aborted = true;
        reject(e);
      };
      renderSearchProgress();
      xhr.send();
    });
  }

  function ensureSearchIndex() {
    if (S.searchIdx) return Promise.resolve(S.searchIdx);
    if (!searchIdxPromise) {
      searchIdxPromise = loadSearchIndex()
        .then((d) => {
          S.searchIdx = d.items || [];
          // 2.30.0：search.json 只装热段（最近 7 个新闻日），total 仍是 62 天窗口内的
          //   去重总条数 ——「全库 N 条」口径不变，不能退化成热段条数（7k）。
          S.searchTotal = Number(d.total) || S.searchIdx.length;
          S.searchHotDays = Number(d.hotDays) || 0;
          S.fuse = new window.Fuse(S.searchIdx, {
            includeScore: true, ignoreLocation: true,
            minMatchCharLength: 2, threshold: 0.4, distance: 100,
            keys: [
              { name: 'title', weight: 0.8 },
              { name: 'source', weight: 0.2 },
            ],
          });
          return S.searchIdx;
        })
        .catch((e) => { searchIdxPromise = null; throw e; });
    }
    return searchIdxPromise;
  }

  async function runSearch(q) {
    S.q = q.trim();
    closeReader();
    // 换关键词就作废正在进行的历史扫描（避免旧结果落到新查询上）
    HIST.token++;
    HIST.hits = [];
    HIST.more = [];
    $('#qHistMeta').textContent = '';
    $('#qHistMore').hidden = true;
    if (!S.q) {
      S.items = S.base || [];
      S.shown = PAGE;
      S.recentHits = null;
      $('#qHist').hidden = true;
      hideRelatedReports();
      renderFilters();
      renderFeed();
      $('#qMeta').textContent = feedMetaText();
      return;
    }
    if (!S.searchIdx) {
      renderSearchProgress();
      try {
        // ⚠ 别用 requestIdleCallback：用户已经在等搜索结果了，等「空闲」反而更慢
        //   （而且 requestIdleCallback 在后台标签页里可能迟迟不触发 → 搜索看起来「没反应」）
        await ensureSearchIndex();
        doSearch();
      } catch (e) {
        $('#qMeta').textContent = e.aborted
          ? '已取消载入索引（重新输入关键词可再试）'
          : '索引载入失败：' + e.message;
        return;
      }
    } else {
      doSearch();
    }
  }

  // ---------- 搜索结果：相关报告带（3.0.0） ----------
  // 搜索结果仍是条目级排序；这里只在列表顶部加一条「相关报告」，
  // 命中词在报告标题/摘要里出现时才显示，按周报/月报/年报各列最多 3 条。
  // 数据直接读 data/periodic/index.json（很小），不新增索引，也不改 search.json 口径。
  function periodicRoute(r) {
    if (r.type === 'week') {
      const m = /^(\d{4})-W(\d{2})$/.exec(r.id);
      return m ? { level: 'week', year: m[1], week: m[2] } : null;
    }
    if (r.type === 'month') {
      const m = /^(\d{4})-(\d{2})$/.exec(r.id);
      return m ? { level: 'month', year: m[1], month: m[2] } : null;
    }
    if (r.type === 'year') return { level: 'year', year: r.id };
    return null;
  }

  function hideRelatedReports() {
    const box = $('#relReports');
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
  }

  async function renderRelatedReports(q) {
    const box = $('#relReports');
    if (!box) return;
    if (!q) { hideRelatedReports(); return; }
    let idx;
    try { idx = await loadPeriodicIndex(); } catch { return; }
    if (S.q !== q) return;   // 关键词已变，丢弃旧结果
    const reps = (idx && Array.isArray(idx.reports) ? idx.reports : []).map(normPeriodic).filter(Boolean);
    const groups = AT.relatedReports(reps, q, 3);
    box.innerHTML = '';
    if (!groups.length) { box.hidden = true; return; }
    box.appendChild(el('div', 'rr-hd', '相关报告'));
    groups.forEach((g) => {
      const row = el('div', 'rr-row');
      row.appendChild(el('span', 'rr-type', PERIODIC_LABEL[g.type]));
      g.list.forEach((r) => {
        const route = periodicRoute(r);
        const a = el('a', 'rr-item', r.title);
        if (route) a.href = AT.archiveHash(route);
        row.appendChild(a);
      });
      box.appendChild(row);
    });
    box.hidden = false;
  }

  function doSearch() {
    if (!S.fuse) return;
    closeReader();
    // ⚠ **不要设 limit**：以前写死 `limit: 120` 会把结果**静默截断**，
    //   于是「命中 120 条」其实是「至多 120 条」—— 真实命中更多时这个数字是假的
    //   （「加息」实测真实命中 185 条，界面却显示 120）。
    const res = S.fuse.search(S.q);
    S.recentHits = res.map((r) => r.item);
    S.items = S.recentHits;
    S.shown = PAGE;
    renderFilters();
    renderFeed();
    // 2.30.0：search.json 只装热段，命中数只代表「近期」；不点明范围会被读成
    //   「58k 条里只有这 7 条」。total 仍是 62 天窗口口径，历史检索是另一段。
    const scopeHint = S.searchHotDays ? `（当前仅搜近 ${S.searchHotDays} 天，更早请用历史检索）` : '';
    $('#qMeta').textContent = `全库 ${S.searchTotal} 条中命中 ${res.length} 条${scopeHint}`;
    renderRelatedReports(S.q);
    syncHistBar();
  }

  // ---------- 全部历史检索（2.22.0，按月分片；显式按钮触发） ----------
  //
  // 为什么不是把 337 天塞进 search.json：实测单文件 gzip 7.83MB、Fuse 查询 705ms/次，
  // 会同时拖慢首搜与低端机输入。这里按 12 个月分片，只有用户显式触发才拉，
  // 最多 3 并发；已拉月份内存缓存并交给 Pages 的 max-age=600 复用。
  // 近期结果始终在前，历史结果追加在后，现有命中顺序不受影响。
  //
  // 2.22.1：外源补录后 history 涨到 168,913 条 / 12 片 / gzip 13.02 MB / raw 43.85 MB，
  //   一次全扫要下 43 MB（实测吞吐折算约 3.5 分钟）。默认只扫最近 3 个月（gzip ~4.4 MB），
  //   更早的月份交给「继续扫描更早 N 个月」二次触发；下拉里显式选「全部月份」仍一次扫全量。
  const HIST = {
    manifest: null, manifestPromise: null, chunks: new Map(), fuses: new Map(),
    token: 0, hits: [], more: [],
  };
  const HIST_ALL = '__all';
  const HIST_RECENT = '__recent';
  const HIST_RECENT_N = 3;

  function histLib() { return window.MacroSearchHistory; }

  function ensureHistManifest() {
    if (HIST.manifest) return Promise.resolve(HIST.manifest);
    if (!HIST.manifestPromise) {
      HIST.manifestPromise = jget('search-history/manifest.json', 'default')
        .then((m) => { HIST.manifest = m; return m; })
        .catch((e) => { HIST.manifestPromise = null; throw e; });
    }
    return HIST.manifestPromise;
  }

  function syncHistBar() {
    const on = !!(S.q && S.recentHits);
    $('#qHist').hidden = !on;
    if (!on) return;
    const btn = $('#qHistBtn');
    btn.textContent = HIST.manifest
      ? `在历史中搜索（${HIST.manifest.total.toLocaleString()} 条）`
      : '在历史中搜索';
    // manifest 只有 ~1KB，但也不在首屏拉：等用户真的搜索了再取
    if (!HIST.manifest) ensureHistManifest().then(syncHistBar).catch(() => {});
    const sel = $('#qHistMonth');
    if (HIST.manifest && sel.options.length === 0) {
      const recent = el('option', '', `最近 ${HIST_RECENT_N} 个月`);
      recent.value = HIST_RECENT;
      recent.selected = true;
      sel.appendChild(recent);
      const all = el('option', '', `全部月份（${HIST.manifest.months} 个月）`);
      all.value = HIST_ALL;
      sel.appendChild(all);
      histLib().monthsDesc(HIST.manifest).forEach((m) => {
        const o = el('option', '', m);
        o.value = m;
        sel.appendChild(o);
      });
    }
  }

  async function loadHistMonth(m) {
    if (HIST.chunks.has(m)) return HIST.chunks.get(m);
    const doc = await jget(histLib().chunkUrl(m), 'default');
    const items = (doc.items || []).map(histLib().toItem);
    HIST.chunks.set(m, items);
    return items;
  }

  function histFuse(m, items) {
    if (HIST.fuses.has(m)) return HIST.fuses.get(m);
    const f = new window.Fuse(items, {
      includeScore: true, ignoreLocation: true, minMatchCharLength: 2, threshold: 0.4, distance: 100,
      keys: [
        { name: 'title', weight: 0.8 },
        { name: 'source', weight: 0.2 },
      ],
    });
    HIST.fuses.set(m, f);
    return f;
  }

  async function runHistorySearch(scope) {
    if (!S.q) return;
    const token = ++HIST.token;
    const meta = $('#qHistMeta');
    meta.textContent = '历史索引载入中…';
    $('#qHistMore').hidden = true;
    HIST.hits = [];
    HIST.more = [];
    let manifest;
    try {
      manifest = await ensureHistManifest();
    } catch (e) {
      meta.textContent = '历史索引载入失败：' + e.message;
      return;
    }
    if (token !== HIST.token) return;
    syncHistBar();
    const all = histLib().monthsDesc(manifest);
    const months = scope === HIST_ALL ? all
      : scope === HIST_RECENT ? all.slice(0, HIST_RECENT_N)
      : [scope];
    // 默认档只扫最近几个月，剩下的交给「继续扫描更早 N 个月」；显式选「全部月份」时不留尾
    HIST.more = scope === HIST_RECENT ? all.slice(HIST_RECENT_N) : [];
    await scanHistMonths(months, token);
  }

  // 逐月拉取 + 检索 + 追加渲染。token 变化（换关键词/新一次检索）时立即停手。
  async function scanHistMonths(months, token) {
    const meta = $('#qHistMeta');
    const queue = months.slice();
    let done = 0;
    let added = 0;
    const paint = () => {
      S.items = histLib().mergeResults(S.recentHits || [], HIST.hits);
      added = S.items.length - (S.recentHits || []).length;
      // 历史结果追加在末尾：一次性展开，否则用户要点十几次「加载更早」才看得到
      S.shown = S.items.length;
      renderFilters();
      renderFeed();
      $('#qMeta').textContent =
        `全库 ${S.searchTotal} 条中命中 ${(S.recentHits || []).length} 条 · 历史追加 ${added} 条（列表末尾，标「历史」）`;
    };
    const worker = async () => {
      while (queue.length) {
        if (token !== HIST.token) return;
        const m = queue.shift();
        try {
          const items = await loadHistMonth(m);
          if (token !== HIST.token) return;
          HIST.hits = HIST.hits.concat(histFuse(m, items).search(S.q).map((r) => r.item));
          done++;
          meta.textContent = `历史检索：已扫 ${done}/${months.length} 个月（${m}）· 命中 ${HIST.hits.length} 条`;
          paint();
        } catch (e) {
          done++;
          meta.textContent = `历史检索：${m} 载入失败（${e.message}）· 已扫 ${done}/${months.length} 个月`;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, months.length) }, worker));
    if (token !== HIST.token) return;
    const more = HIST.more.length;
    const moreBtn = $('#qHistMore');
    moreBtn.hidden = !more;
    if (more) moreBtn.textContent = `继续扫描更早 ${more} 个月`;
    meta.textContent =
      `历史检索完成：已扫 ${months.length} 个月 · 命中 ${HIST.hits.length} 条（去重后追加 ${added} 条）` +
      (more ? ` · 更早 ${more} 个月未扫` : '');
    // 历史结果在几百条近期结果之后：跳过去一次，避免用户以为「没搜到」
    const firstHist = S.items.findIndex((x) => x && x.h);
    const node = firstHist >= 0 ? $('#feed').children[firstHist] : null;
    if (node) node.scrollIntoView({ block: 'center' });
  }

  // ---------- 视图切换 ----------
  // 视图与 URL 的 hash 一一对应（#view-feed / #view-market / #view-archive / #view-sources）：
  //   · 页签是真链接，点一下 URL 就变 —— 有即时反馈，也能收藏/分享某个视图；
  //   · 即使 app.js 还没加载完，点下去也会跳到对应区块，而不是毫无反应。
  const VIEWS = ['feed', 'market', 'macro', 'archive', 'sources'];

  // ---------- 视图切换后的视口对齐 ----------
  //
  // ⚠ 为什么不能「算一次位置就滚」：
  //   页面总高度是**异步变化**的。宏观仪表盘的行情卡要等
  //   「东财直连 + 本地 quotes.json」都回来才渲染（实测 5~10 秒都可能），
  //   渲染完会把下面所有区块整体往下推 ⇒ 切换瞬间算好的目标位置当场失效。
  //   实测症状：**第一次**点「归档」停在仪表盘中段（差了 588px），
  //   等行情渲染完再点第二次才对。
  //
  // ⚠ 而且切换瞬间**页面可能还不够高**（板块还是空的、文档比视口还矮），
  //   这时 `scrollTo` 会被浏览器钳到 0 —— 只能等页面长出来之后再对齐。
  //
  // 对策：用 `ResizeObserver` **常驻**盯着 body 尺寸，
  //   尺寸一变就重新对齐（**不设时间窗**：行情渲染快则 1 秒、慢则 10 秒，
  //   任何固定窗口都会漏）。用户自己滚了就停手，不抢方向盘。
  let alignRO = null;
  let alignState = null;

  function initAlign() {
    // 用户自己滚了 → 本次视图的自动纠偏停手（否则布局一变就把人拽回去）
    const onUser = () => { if (alignState) alignState.userMoved = true; };
    window.addEventListener('wheel', onUser, { passive: true });
    window.addEventListener('touchmove', onUser, { passive: true });
    window.addEventListener('keydown', onUser);

    alignRO = new ResizeObserver(() => {
      const st = alignState;
      if (!st || st.userMoved) return;
      const y = Math.max(0, st.sec.getBoundingClientRect().top + window.scrollY - 72);
      if (Math.abs(y - st.last) < 4) return;
      st.last = y;
      // 用瞬时定位而不是 smooth：smooth 会和正在进行的动画互相打架
      window.scrollTo({ top: y, behavior: 'auto' });
    });
    alignRO.observe(document.body);
  }

  function alignToView(v, instant) {
    const sec = $('#view-' + v);
    if (!sec) return;
    // 目标 = 该区块的绝对位置 - sticky 顶栏高度
    const target = () => Math.max(0, sec.getBoundingClientRect().top + window.scrollY - 72);
    alignState = { sec, userMoved: false, last: target() };
    window.scrollTo({ top: target(), behavior: instant ? 'auto' : 'smooth' });
  }

  // ---------- 归档页：sticky 时间尺的滚动补偿（3.4.0） ----------
  // 归档页有两层 sticky：站点顶栏（top:0）+ 时间尺（top:56 / 手机 48）。
  // 补偿值不再写死：从时间尺的计算样式 top 与实测高度派生（审计 P1-7：写死 72/136，
  // 而实测时间尺 113 / 157，手机端整个分组标题被盖住）。
  function archBarOffset() {
    const bar = $('#archBar');
    if (!bar) return 72;
    const top = parseFloat(getComputedStyle(bar).top) || 0;
    return top + bar.offsetHeight + 8;
  }

  function syncStickyOffset() {
    document.documentElement.style.setProperty('--arch-sticky', Math.round(archBarOffset()) + 'px');
  }

  // 滚到某个归档内的节点，扣掉时间尺高度
  function scrollUnderSticky(node) {
    if (!node) return;
    const y = node.getBoundingClientRect().top + window.scrollY - archBarOffset();
    if (alignState) alignState.userMoved = true;   // 别让 ResizeObserver 把页面拽回区块顶部
    window.scrollTo({ top: Math.max(0, y), behavior: 'auto' });
  }

  // 切层后的落点 = 新层的层头（不是归档视图顶部）
  function scrollToLayerHead() {
    const box = $('#days');
    const hd = box && box.querySelector('.arch-layer-hd');
    if (!hd) { alignToView('archive', true); return; }
    scrollUnderSticky(hd);
  }

  function viewFromHash() {
    const m = String(location.hash || '').match(/^#view-(feed|market|macro|archive|sources)$/);
    if (m) return m[1];
    // 3.0.0：归档层级 hash（#archive/2026/11 等）同样属于「归档」视图
    if (/^#archive(\/|$)/.test(String(location.hash || ''))) return 'archive';
    return null;
  }

  function showView(v, instant) {
    const was = S.view;
    S.view = v;
    if (v === 'feed') openedDay = null;   // 切回要闻流才清；openDay 在 showView 之后重新设置
    closeReader();
    document.querySelectorAll('.tab, .mnav-item').forEach((t) => {
      const on = t.dataset.view === v;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    VIEWS.forEach((k) => {
      $('#view-' + k).hidden = k !== v;
    });
    // ⚠ 必须滚到**该视图的区块**，不能 `scrollTo(0,0)`：
    //   宏观仪表盘是常驻在页面顶部的，四个视图的内容都在它下面。
    //   滚回顶部 ⇒ 切换后画面还是仪表盘 ⇒ 用户看到「四个页签一模一样」、
    //   「点了没反应」。这里滚到区块顶部（避开 sticky 顶栏高度）。
    alignToView(v, instant);
    // 归档视图的 URL 由层级路由接管（renderArchive 会写 #archive/...）：
    //   已在归档页时再点「归档」页签 = 回默认月。
    if (v === 'archive') {
      const fromHash = was === v ? null : AT.parseArchiveHash(location.hash);
      renderArchive(fromHash && fromHash.level !== 'default' ? fromHash : null, { instant });
      return;
    }
    // URL 与视图保持同步（replaceState 不会触发 hashchange，不会造成循环）
    if (viewFromHash() !== v) history.replaceState(null, '', '#view-' + v);
    // 需要数据的视图在切过去时才去取（懒加载）
    if (v === 'sources') renderSources();
    if (v === 'macro') renderMacroList();
  }

  // ---------- 归档 ----------
  // 归档索引只拉一次：页脚（loadRunMeta）与归档页（renderArchive）共用同一个 Promise。
  // 之前两处各发一次请求，在 Pages 冷缓存下等于多赌一次 0.7~16s 的 TTFB。
  let indexPromise = null;
  let indexAt = 0;
  // 2.20.0：索引不再在标签页生命周期内永久记忆。
  //   实测问题（2026-11-15）：补写早报发布后，用户停在归档页的旧渲染里刷新不到新状态 ——
  //   S.archive 一旦缓存就再也不取，只有整页重载才会更新。改为 60 秒内复用、过期重新校验。
  //   走 no-cache（条件请求）而不是绕过缓存：Pages 回 304 时只多一次 RTT，不会重复下 20 KB。
  function loadIndex() {
    if (S.archive && Date.now() - indexAt < 60 * 1000) return Promise.resolve(S.archive);
    if (!indexPromise) {
      indexPromise = jget('index.json', 'no-cache')
        .then((d) => { S.archive = d; indexAt = Date.now(); return d; })
        .catch((e) => {
          indexPromise = null;
          if (S.archive) return S.archive;   // 重新校验失败：沿用旧索引，不把归档页弄挂
          throw e;
        });
    }
    return indexPromise;
  }

  // 近一年历史切片的索引：只在归档页打开时加载；缺失（还没导出）按空处理，
  // 不能因为 404 让整个归档页挂掉。
  let histPromise = null;
  function loadHistoryIndex() {
    if (S.hist) return Promise.resolve(S.hist);
    if (!histPromise) {
      histPromise = jget('history/index.json', 'default')
        .then((d) => { S.hist = d || { days: [] }; return S.hist; })
        .catch(() => { S.hist = { days: [] }; histPromise = null; return S.hist; });
    }
    return histPromise;
  }

  // 3.0.0：周期报告索引（周报 / 月报 / 年报）。缺失或损坏时返回空列表、**不缓存失败**，
  //   这样报告刚发布、下一次进归档页就能看到；页面本身不受影响（区块隐藏）。
  let periodicPromise = null;
  function loadPeriodicIndex() {
    if (S.periodic) return Promise.resolve(S.periodic);
    if (!periodicPromise) {
      periodicPromise = jget('periodic/index.json', 'default')
        .then((d) => {
          S.periodic = d && Array.isArray(d.reports) ? d : { reports: [] };
          return S.periodic;
        })
        .catch(() => {
          periodicPromise = null;
          return { reports: [] };
        });
    }
    return periodicPromise;
  }

  // 日期跳转用：day → {day, count, kind, hasBriefing}
  let dayIndex = new Map();
  // 2.19.0：早报制度起点 = 最早一份早报的日子（由索引推导，与服务端 briefEraStart 同口径）。
  // 用它区分「制度前没有早报属正常」和「制度后该有却没有」。
  let briefEraDay = '';

  function renderHistPanel(hist, list) {
    const panel = $('#histPanel');
    if (!panel) return;
    const hasHist = hist && Array.isArray(hist.days) && hist.days.length > 0;
    panel.hidden = !hasHist;
    if (!hasHist) return;
    const sub = $('#histSub');
    if (sub) {
      sub.textContent = window.MacroHistorySummary
        ? window.MacroHistorySummary.summary(hist, list)
        : `归档前历史 ${hist.days.length} 天 · ${hist.from} ~ ${hist.to} · ` +
          `${(hist.total || 0).toLocaleString('zh-CN')} 条 · 仅标题/来源/时间，不含正文；` +
          `${hist.to} 之后在下方归档卡片（带全文）`;
    }
    const inp = $('#histDate');
    if (inp && list.length) {
      inp.min = list[list.length - 1].day;
      inp.max = list[0].day;
      if (!inp.value) inp.value = list[0].day;
    }
    const hint = $('#histHint');
    if (hint) hint.textContent = '';
  }

  // ---------- 周期报告（周报 / 月报 / 年报） ----------
  // 3.0.0：与日报**同构**，只是时间粒度不同。正文沿用日报字段：
  //   overview / items[]（rank,title,summary,why,source,publishedAt,url,refs）/ watch，
  //   条目直接复用 renderBriefItems，不另设一套条目结构或文体。
  //   契约见 docs/periodic-report.md；缺索引/坏条目/缺正文都不允许拖垮归档页。
  const PERIODIC_LABEL = { week: '周报', month: '月报', year: '年报' };
  const PERIODIC_NOTE = { week: 'ISO 周 · 周一至周日', month: '自然月', year: '自然年' };
  const PERIODIC_ID_RE = {
    week: /^\d{4}-W\d{2}$/,
    month: /^\d{4}-\d{2}$/,
    year: /^\d{4}$/,
  };
  const PERIODIC_GROUPS = ['week', 'month', 'year'];
  // 三类共用一套 key：`week=2026-W47` / `month=2026-11` / `year=2026`
  const periodicKey = (r) => `${r.type}=${r.id}`;
  let periodicById = new Map();

  // 补写时间兼容三种写法：索引布尔 + backfillAt、日报式 backfill:{kind,at,note}、字符串
  function periodicBackfill(rep) {
    const bf = rep && rep.backfill;
    if (bf && typeof bf === 'object') return { on: true, at: bf.at || '' };
    if (bf === true) return { on: true, at: (rep && rep.backfillAt) || '' };
    if (typeof bf === 'string') return { on: true, at: bf };
    return { on: false, at: '' };
  }

  function normPeriodic(rep) {
    if (!rep || typeof rep !== 'object') return null;
    const type = rep.type;
    if (!PERIODIC_LABEL[type] || !PERIODIC_ID_RE[type].test(String(rep.id || ''))) return null;
    const w = rep.window || {};
    const start = /^\d{4}-\d{2}-\d{2}$/.test(w.from || '') ? w.from : '';
    const end = /^\d{4}-\d{2}-\d{2}$/.test(w.to || '') ? w.to : '';
    if (!start || !end || start > end) return null;
    let days = Number(w.days) > 0 ? Math.floor(Number(w.days)) : 0;
    if (!days) {
      days = Math.round(
        (Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000
      ) + 1;
    }
    if (!(days > 0)) return null;
    const bf = periodicBackfill(rep);
    return {
      type,
      id: String(rep.id),
      title: String(rep.title || `${PERIODIC_LABEL[type]} ${rep.id}`),
      summary: String(rep.summary || ''),
      window: {
        start, end, days,
        startAt: typeof w.fromAt === 'string' ? w.fromAt : '',
        endAt: typeof w.toAt === 'string' ? w.toAt : '',
      },
      generatedAt: rep.generatedAt || '',
      backfill: bf.on,
      backfillAt: bf.at,
    };
  }

  // 北京墙钟「YYYY-MM-DD HH:MM」。复用时区工具，避免跟着读者本地时区漂。
  const bjFull = (iso) => {
    const w = window.MacroBriefTiming && window.MacroBriefTiming.bjWall
      ? window.MacroBriefTiming.bjWall(iso)
      : null;
    return w ? `${w.day} ${w.hm}` : '';
  };
  function periodicWindowText(w) {
    if (w.fromAt && w.toAt) {
      const a = bjFull(w.fromAt);
      const z = bjFull(w.toAt);
      if (a && z) return `${a} – ${z}`;
    }
    return `${w.from} 08:00 – ${w.to} 次日 08:00`;
  }

  // 3.4.0：整块默认收起，只留一行汇总（周期报告 N 期 · 周报 x · 月报 y · 年报 z）。
  //   此前 187 期全量铺在日期层之上：桌面 10,392px、手机 20,632px，日期被推到 12 / 25 屏之外
  //   （见 2026-11-28 归档页体验审计 P0-1）。展开后按类型分组、组内再按年份分区。
  function renderPeriodicPanel(idx) {
    const panel = $('#periodicPanel');
    const listBox = $('#periodicList');
    if (!panel || !listBox) return;
    const reps = (idx && Array.isArray(idx.reports) ? idx.reports : [])
      .map(normPeriodic)
      .filter(Boolean)
      .sort((a, b) => {
        if (a.window.end !== b.window.end) return a.window.end < b.window.end ? 1 : -1;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    periodicById = new Map(reps.map((r) => [periodicKey(r), r]));
    listBox.innerHTML = '';
    // 三类都空：整块隐藏；部分为空：该类型分组不出现；三类齐全：三组依次排列
    panel.hidden = reps.length === 0;
    if (!reps.length) return;
    const stat = $('#periodicStat');
    if (stat) {
      const parts = PERIODIC_GROUPS
        .map((t) => [t, reps.filter((r) => r.type === t).length])
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${PERIODIC_LABEL[t]} ${n}`);
      stat.textContent = `${reps.length} 期 · ${parts.join(' · ')}`;
    }
    // 组内默认展开哪一年：当前层所在年 > 最新年（187 期跨三年连排，一条通道到底无法扫描）
    const curYear = archRoute && archRoute.year ? String(archRoute.year) : '';
    PERIODIC_GROUPS.forEach((type) => {
      const group = reps.filter((r) => r.type === type);
      if (!group.length) return;
      const sec = el('section', 'pr-group');
      sec.id = `periodic-${type}`;
      sec.dataset.type = type;
      const hd = el('div', 'pr-group-hd');
      hd.appendChild(el('span', 'pr-type', PERIODIC_LABEL[type]));
      hd.appendChild(el('span', 'pr-group-n', `${group.length} 期`));
      hd.appendChild(el('span', 'pr-group-note', PERIODIC_NOTE[type]));
      // 全是补写时只在组头说一次：187/187 都打「补写」等于零信息（审计 P1-4）
      if (group.every((r) => r.backfill)) hd.appendChild(el('span', 'pr-group-note', '均为补写'));
      sec.appendChild(hd);
      const years = [...new Set(group.map((r) => r.window.end.slice(0, 4)))].sort().reverse();
      const openYear = years.includes(curYear) ? curYear : years[0];
      years.forEach((y) => {
        const mine = group.filter((r) => r.window.end.slice(0, 4) === y);
        const sub = el('details', 'pr-year');
        sub.dataset.year = y;
        sub.open = y === openYear;
        const sm = el('summary', 'pr-year-hd');
        sm.appendChild(el('span', 'pr-year-t', y + ' 年'));
        sm.appendChild(el('span', 'pr-year-n', `${mine.length} 期`));
        sub.appendChild(sm);
        const wrap = el('div', 'pr-group-list');
        mine.forEach((r) => wrap.appendChild(periodicCard(r)));
        sub.appendChild(wrap);
        sec.appendChild(sub);
      });
      listBox.appendChild(sec);
    });
    // 顶部三类入口：改成按钮而不是 `#periodic-week` 锚点链接 —— 锚点会把归档层级
    //   （#archive/2024/01）从 URL 里冲掉，刷新就掉回默认月（审计 P2-8）。
    const jumps = $('#periodicJumps');
    if (jumps) {
      jumps.innerHTML = '';
      PERIODIC_GROUPS.forEach((type) => {
        const n = reps.filter((r) => r.type === type).length;
        if (!n) return;
        const b = el('button', 'fchip', `${PERIODIC_LABEL[type]} ${n}`);
        b.type = 'button';
        b.onclick = () => focusPeriodicGroup(type);
        jumps.appendChild(b);
      });
      jumps.hidden = !jumps.children.length;
    }
  }

  // 展开面板并滚到某一类型分组；补偿值取时间尺实际高度（审计 P1-7：写死 72/136 会被遮住 96/134px）
  function focusPeriodicGroup(type) {
    const panel = $('#periodicPanel');
    const sec = document.getElementById('periodic-' + type);
    if (!panel || !sec) return;
    panel.open = true;
    syncPeriodicCaret();
    scrollUnderSticky(sec);
    saveUI();
  }

  function syncPeriodicCaret() {
    const panel = $('#periodicPanel');
    const caret = $('#periodicCaret');
    if (panel && caret) caret.textContent = panel.open ? '收起' : '全部期次';
  }

  function periodicCard(r) {
    const det = el('details', 'pr-card');
    det.dataset.key = periodicKey(r);
    det.dataset.id = r.id;
    det.dataset.type = r.type;
    const sum = el('summary', 'pr-head');
    sum.appendChild(el('span', 'pr-type', PERIODIC_LABEL[r.type]));
    sum.appendChild(el('span', 'pr-title', r.title));
    sum.appendChild(el('span', 'pr-range',
      `${r.window.start} ~ ${r.window.end} · 覆盖 ${r.window.days} 天`));
    const caret = el('span', 'pr-caret', '展开');
    sum.appendChild(caret);
    // 3.4.0：渲染索引里的 40~90 字摘要。此前 187 张卡只有「类型 + 标题 + 区间」，
    //   索引里现成的 summary 完全没被用上，长列表无法扫描（审计 P1-4）。
    //   同时去掉逐行的「补写」标签：187/187 都是补写，标签没有区分度，改在组头统一说明。
    if (r.summary) sum.appendChild(el('span', 'pr-sum', r.summary));
    det.appendChild(sum);

    const body = el('div', 'pr-body');
    det.appendChild(body);
    det.addEventListener('toggle', () => {
      caret.textContent = det.open ? '收起' : '展开';
      if (det.open) loadPeriodicReport(r, body);
      saveUI();
    });
    return det;
  }

  // 报告正文只在展开时取；同一 id 缓存一次（周期结束后内容稳定，纠错另发补写版）
  const periodicCache = new Map();
  const periodicInflight = new Map();
  function getPeriodicReport(id) {
    if (periodicCache.has(id)) return Promise.resolve(periodicCache.get(id));
    if (!periodicInflight.has(id)) {
      const p = jget(`periodic/${id}.json`, 'default')
        .then((d) => { periodicCache.set(id, d); periodicInflight.delete(id); return d; })
        .catch((e) => { periodicInflight.delete(id); throw e; });
      periodicInflight.set(id, p);
    }
    return periodicInflight.get(id);
  }

  function renderPeriodicBody(body, d, r) {
    body.innerHTML = '';
    // 正文 window 用日报字段名 from/to/fromAt/toAt；索引侧已归一成 start/end/startAt/endAt
    const raw = (d && d.window) || {};
    const w = {
      from: raw.from || r.window.start,
      to: raw.to || r.window.end,
      fromAt: raw.fromAt || r.window.startAt,
      toAt: raw.toAt || r.window.endAt,
      days: raw.days || r.window.days,
    };
    const bits = [`覆盖 ${periodicWindowText(w)}（${w.days} 天）`];
    const gen = bjFull(d && d.generatedAt) || bjFull(r.generatedAt);
    if (gen) bits.push(`生成 ${gen}`);
    const bfAt = periodicBackfill(d).at || r.backfillAt;
    if (bfAt) bits.push(`补写于 ${bjFull(bfAt) || bfAt}`);
    body.appendChild(el('div', 'pr-meta-full', bits.join(' · ')));

    if (d && d.overview) body.appendChild(el('p', 'brief-overview', d.overview));
    // 与日报完全同一套条目渲染（标题 / 概述 / 为什么重要 / 来源 / 时间 / refs）
    const items = (Array.isArray(d && d.items) ? d.items.filter(Boolean) : [])
      .map((it) => ({
        ...it,
        // 契约时间带 +08:00；展示沿用北京墙钟，避免把 ISO 偏移直接铺在卡片上
        publishedAt: bjFull(it.publishedAt) || it.publishedAt,
      }));
    if (items.length) renderBriefItems(body, items);
    else if (d && d.overview) body.appendChild(el('p', 'pr-note', '本期无重点条目'));
    const watch = Array.isArray(d && d.watch) ? d.watch.filter(Boolean) : [];
    if (watch.length) {
      body.appendChild(el('div', 'brief-watch-hd', '下期观察'));
      const ul = el('ul', 'brief-watch');
      watch.forEach((t) => ul.appendChild(el('li', null, String(t))));
      body.appendChild(ul);
    }
    if (!d || (!d.overview && !items.length)) {
      body.appendChild(el('p', 'brief-overview', '该报告正文缺失（只有标题与摘要）'));
      if (r.summary) body.appendChild(el('p', 'brief-overview', r.summary));
    }
  }

  async function loadPeriodicReport(r, body) {
    if (!body || body.dataset.loaded || body.dataset.loading) return;
    body.dataset.loading = '1';
    body.innerHTML = '<div class="skeleton">报告载入中…</div>';
    try {
      const d = await getPeriodicReport(r.id);
      renderPeriodicBody(body, d, r);
      body.dataset.loaded = '1';
    } catch (e) {
      delete body.dataset.loaded;
      body.innerHTML = '';
      body.appendChild(el('div', 'skeleton',
        `报告正文载入失败：${e && e.message ? e.message : e}`));
      const retry = el('button', 'mchip', '重试');
      retry.type = 'button';
      retry.onclick = () => {
        delete body.dataset.loaded;
        loadPeriodicReport(r, body);
      };
      body.appendChild(retry);
    } finally {
      delete body.dataset.loading;
    }
  }

  // 刷新后恢复展开的周期报告（与早报分开记录，避免两套 id 混在一起）
  //   3.4.0：报告卡只存在于顶部折叠面板里（层内改成一行入口），
  //   面板本身收起时只恢复 open 标记，不预取正文 —— 否则一进归档页就白下几十份报告。
  function restorePeriodicOpen() {
    const st = archiveRouteState();
    const open = st && Array.isArray(st.periodicOpen) ? st.periodicOpen : [];
    if (!open.length) return Promise.resolve();
    const panel = $('#periodicPanel');
    const panelOpen = !!(panel && panel.open);
    const jobs = [];
    document.querySelectorAll('#view-archive details.pr-card').forEach((det) => {
      if (!open.includes(det.dataset.key)) return;
      det.open = true;
      const caret = det.querySelector('.pr-caret');
      if (caret) caret.textContent = '收起';
      if (!panelOpen) return;
      const r = periodicById.get(det.dataset.key);
      if (r) jobs.push(loadPeriodicReport(r, det.querySelector('.pr-body')));
    });
    return Promise.all(jobs);
  }

  function dayCard(d, opts) {
    // 3.4.0：日卡先进入归档「日」层（保留层级与 URL），日层里再显式「打开当日要闻流」。
    //   此前日卡一律 openDay → 直接跳到要闻流，四层钻取在「日」断路，日期跳转也把人带离归档页
    //   （审计 P1-5 / P1-6）。日层自己被渲染时传 { toLayer: false }，那一次点击就是「打开」。
    const toLayer = !(opts && opts.toLayer === false);
    const href = toLayer ? AT.archiveHash(dayRoute(d.day)) : '#';
    const open = (e) => {
      e.preventDefault();
      if (toLayer) navigateArchive(dayRoute(d.day));
      else openDay(d.day, d.kind);
    };
    // 2.12.0：归档按**新闻日**分文件（北京 08:00 ~ 次日 08:00，等价 UTC 日期）。
    // 卡片必须默认可见地标出来，否则「11-10 · 1,233 条」会被误读成自然日 00:00–24:00 的量。
    const dayHint = (day) => `${day} 新闻日 · 北京时间 ${day} 08:00 ~ 次日 08:00`;
    const withTag = (day) => {
      const dd = el('div', 'day-d', day);
      dd.appendChild(el('span', 'day-nd', '新闻日'));
      return dd;
    };
    // 2.20.1：条数与状态标签同一行、标签右对齐（「397 条 ………… 跨日」）。
    //   旧版每个标签独占一行，网格拉平高度后把虚线与摘要往下推，同行卡片参差。
    const metaRow = (count, tags) => {
      const row = el('div', 'day-meta');
      row.appendChild(el('span', 'day-n', count + ' 条'));
      if (tags.length) {
        const slot = el('span', 'day-tags');
        for (const t of tags) slot.appendChild(t);
        row.appendChild(slot);
      }
      return row;
    };
    if (!d.hasBriefing) {
      const a = el('a', 'day');
      a.href = href;
      a.title = d.reason ? `${dayHint(d.day)}；${d.reason}` : dayHint(d.day);
      const tags = [];
      // 2.19.0：制度起点之后、有新闻却没有早报 —— 这一天是「该有却没有」，必须显形。
      // 制度之前（起点为空或早于起点）不标，避免把历史常态说成缺失。
      if (briefEraDay && d.day >= briefEraDay && d.day < newsDay() && d.count > 0) {
        tags.push(el('span', 'day-tag backfill', '缺早报'));
      }
      const head = el('div', 'day-head');
      head.appendChild(withTag(d.day));
      head.appendChild(metaRow(d.count, tags));
      a.appendChild(head);
      // 2.20.1：没有早报的日子也保留底部虚线块（空槽）——只剩有摘要的卡片有虚线，
      //   是同行卡片错位的第二层原因。
      a.appendChild(el('div', 'day-blank'));
      a.onclick = open;
      return a;
    }
    // 有早报的天：卡片里多一个折叠块。默认一行主线摘要，点开才取完整早报（观察项），
    // 避免归档页为了 365 张卡片预取 365 份早报正文。
    const box = el('div', 'day has-brief');
    box.dataset.day = d.day;
    const a = el('a', 'day-open');
    a.href = href;
    a.title = d.reason ? `${dayHint(d.day)}；${d.reason}` : dayHint(d.day);
    a.appendChild(withTag(d.day));
    const tags = [];
    if (d.source === 'rule') tags.push(el('span', 'day-tag', '自动摘要'));
    else if (d.source === 'draft') tags.push(el('span', 'day-tag', '事实清单'));
    // 2.19.0：补写过的日子带「补写」标签，与当天自然生成区分（来源仍是 ai/rule/draft，不改语义）
    if (d.briefBackfill) tags.push(el('span', 'day-tag backfill', '补写'));
    // 2.20.0：非当日生成的日子必须显形。跨日（如 11-14 的早报在 11-15 00:12 才出）
    // 与同日明显晚到分开标：两者都和「补写」不是一回事，补写是事后追认，不在这两档里。
    const tm = briefTiming(d.day, d.briefAt, d.briefBackfill);
    if (tm && (tm.kind === 'late-same' || tm.kind === 'late-cross')) {
      const tag = el('span', 'day-tag late', tm.kind === 'late-cross' ? '跨日' : '晚到');
      tag.title = tm.text;
      tags.push(tag);
    }
    a.appendChild(metaRow(d.count, tags));
    a.onclick = open;
    box.appendChild(a);

    const det = el('details', 'day-brief');
    const briefLine = d.briefLine || '当日早报';
    det.dataset.brief = briefLine;
    const sum = el('summary', 'brief-line', briefLine);
    if (d.briefLine) sum.title = d.briefLine;
    det.appendChild(sum);
    const body = el('div', 'brief-body');
    det.appendChild(body);
    det.addEventListener('toggle', () => {
      box.classList.toggle('expanded', det.open);
      if (det.open) {
        loadBriefing(d.day, body);
      } else {
        // 收起时恢复摘要；展开后摘要会被替换成中性信息行，避免与 overview 重复
        sum.textContent = det.dataset.brief || '当日早报';
        sum.title = sum.textContent;
        det.classList.remove('brief-loaded');
      }
      saveUI();
    });
    box.appendChild(det);
    return box;
  }

  // 早报正文只在折叠块展开时取；同一天缓存一次（历史日不可变，今天按 no-store 取最新）
  const briefCache = new Map();
  const briefInflight = new Map();
  function getBriefing(day) {
    if (briefCache.has(day)) return Promise.resolve(briefCache.get(day));
    if (!briefInflight.has(day)) {
      const today = day === newsDay();
      const p = jget(`briefings/${day}.json`, today ? 'no-store' : 'default')
        .then((b) => { briefCache.set(day, b); briefInflight.delete(day); return b; })
        .catch((e) => { briefInflight.delete(day); throw e; });
      briefInflight.set(day, p);
    }
    return briefInflight.get(day);
  }

  // 2.20.0：生成时点分档（按时 / 同日明显晚到 / 跨日 / 补写）见 assets/brief-timing.js。
  //   纯函数放在独立文件里，Node 测试可以逐档验证；这里只做绑定，不重复实现阈值。
  const BT = window.MacroBriefTiming || {};
  const briefTiming = (day, at, bf) => (BT.briefTiming ? BT.briefTiming(day, at, bf) : null);
  const bjStamp = (iso) => (BT.bjStamp ? BT.bjStamp(iso) : '');
  // 2.13.0：早报覆盖区间。早报 JSON 的 window.fromAt/toAt 是北京墙钟字面量（…+08:00），
  // 直接按字面量切片，避免浏览器本地时区把 08:00 显示成别的时间。历史早报没有 window 时间戳，
  // 不凭空补，保持原样——只有 2.13.0 之后生成的早报才会显示这段说明。
  function briefRange(b) {
    const w = (b && b.window) || {};
    const pick = (iso) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ''));
      return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : '';
    };
    const a = pick(w.fromAt);
    const z = pick(w.toAt);
    return a && z ? `${a} – ${z}` : '';
  }
  function briefMetaText(b) {
    const n = Array.isArray(b && b.items) ? b.items.length : 0;
    const tm = briefTiming(b && b.date, b && (b.endedAt || b.generatedAt), !!(b && b.backfill));
    const range = briefRange(b);
    return `当日早报${n ? ' · ' + n + ' 条' : ''}${tm ? ' · ' + tm.text : ''}` +
      `${range ? ' · 覆盖 ' + range : ''}`;
  }
  function renderBriefItems(body, items) {
    const list = el('ol', 'brief-items');
    items.forEach((it, i) => {
      const li = el('li', 'brief-item');
      const hd = el('div', 'brief-item-hd');
      hd.appendChild(el('span', 'brief-rank', String(it.rank || i + 1)));
      const title = it.title || '';
      if (it.url) {
        const a = el('a', 'brief-item-title', title);
        a.href = it.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        hd.appendChild(a);
      } else {
        hd.appendChild(el('div', 'brief-item-title', title));
      }
      li.appendChild(hd);
      if (it.summary) li.appendChild(el('p', 'brief-item-summary', it.summary));
      if (it.why) li.appendChild(el('p', 'brief-why', `为什么重要：${it.why}`));
      const meta = [it.source, it.publishedAt].filter(Boolean).join(' · ');
      if (meta) li.appendChild(el('div', 'brief-item-meta', meta));
      if (Array.isArray(it.refs) && it.refs.length) {
        const refs = el('div', 'brief-refs');
        refs.appendChild(el('span', null, '参考：'));
        it.refs.forEach((u, k) => {
          const a = el('a', null, `[${k + 1}]`);
          a.href = u;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          refs.appendChild(a);
        });
        li.appendChild(refs);
      }
      list.appendChild(li);
    });
    body.appendChild(list);
  }
  async function loadBriefing(day, body) {
    if (!body || body.dataset.loaded || body.dataset.loading) return;
    body.dataset.loading = '1';
    body.innerHTML = '<div class="skeleton">早报载入中…</div>';
    const det = body.closest('details');
    const sum = det ? det.querySelector('summary') : null;
    try {
      const b = await getBriefing(day);
      const items = Array.isArray(b.items) ? b.items.filter(Boolean) : [];
      const watch = Array.isArray(b.watch) ? b.watch.filter(Boolean) : [];
      body.innerHTML = '';
      // 2.13.0：展开后第一行给出覆盖区间（与 summary 同一口径），避免读者把早报当成「自然日整天」。
      const range = briefRange(b);
      if (range) body.appendChild(el('div', 'brief-item-meta', `早报覆盖 ${range}`));
      if (b.overview) body.appendChild(el('p', 'brief-overview', b.overview));
      if (items.length) renderBriefItems(body, items);
      if (watch.length) {
        body.appendChild(el('div', 'brief-watch-hd', '观察项'));
        const ul = el('ul', 'brief-watch');
        watch.forEach((t) => ul.appendChild(el('li', null, t)));
        body.appendChild(ul);
      }
      if (!b.overview && !items.length) {
        // 缺字段降级：不伪造正文，保留折叠摘要并说明
        const msg = el('p', 'brief-overview', '该日早报正文缺失（只有摘要）');
        body.appendChild(msg);
        if (det && det.dataset.brief) body.appendChild(el('p', 'brief-overview', det.dataset.brief));
      }
      // 展开后把摘要行换成中性信息，消除与 overview 同句重复
      if (sum && (b.overview || items.length || watch.length)) {
        const meta = briefMetaText(b);
        sum.textContent = meta;
        sum.title = meta;
        // 2.20.0：晚到 / 跨日要在摘要行本身就可辨（棕色），按时生成保持中性不噪音
        const tm = briefTiming(b && b.date, b && (b.endedAt || b.generatedAt), !!(b && b.backfill));
        if (tm && (tm.kind === 'late-same' || tm.kind === 'late-cross')) {
          sum.classList.add('brief-late');
          sum.title = `该日早报未在 09:00 按时生成：${meta}`;
        }
        if (det) det.classList.add('brief-loaded');
      }
      body.dataset.loaded = '1';
    } catch (e) {
      delete body.dataset.loaded;
      body.innerHTML = '';
      body.appendChild(el('div', 'skeleton', `早报载入失败：${e && e.message ? e.message : e}`));
      const retry = el('button', 'mchip', '重试');
      retry.type = 'button';
      retry.onclick = () => {
        delete body.dataset.loaded;
        loadBriefing(day, body);
      };
      body.appendChild(retry);
    } finally {
      delete body.dataset.loading;
    }
  }

  function restoreBriefOpen() {
    const st = archiveRouteState();
    const open = st && Array.isArray(st.briefOpen) ? st.briefOpen : [];
    if (!open.length) return Promise.resolve();
    const jobs = [];
    document.querySelectorAll('#view-archive .day.has-brief').forEach((box) => {
      if (!open.includes(box.dataset.day)) return;
      const det = box.querySelector('details');
      if (!det) return;
      det.open = true;
      // 不依赖 toggle 事件：它是异步派发的，恢复时可能还没触发（实测刷新后块开了、内容没加载）
      box.classList.add('expanded');
      jobs.push(loadBriefing(box.dataset.day, box.querySelector('.brief-body')));
    });
    return Promise.all(jobs);
  }

  // 3.0.0：刷新恢复从「单一滚动位置」扩展为「按路由保存」。
  //   routeStates['archive/2026/11'] = { y, briefOpen, periodicOpen }
  //   旧版本只写顶层 y / briefOpen / periodicOpen：仅当本会话还没有任何按路由记录时兜底使用。
  let legacyScrollUsed = false;
  function archiveRouteState(route) {
    const key = archKey(route || archRoute);
    if (key && routeStates[key]) return routeStates[key];
    if (!Object.keys(routeStates).length && uiState && uiState.view === 'archive') {
      return { y: uiState.y, briefOpen: uiState.briefOpen, periodicOpen: uiState.periodicOpen };
    }
    return null;
  }

  // 早报 / 报告正文是异步到达的，页面会先矮后高：等全部落位后再对齐一次。
  //   focusLayer：本次渲染是「切层」（点周组 / 点日期 / 前后层级跳转），
  //   没有历史滚动位置时要落到新层层头，而不是归档视图顶部（3.4.0 修审计 P0-2）。
  let archFocusLayer = false;
  function restoreArchiveState(route) {
    if (!archRendered) return;
    const st = archiveRouteState(route);
    let y = st && Number.isFinite(st.y) ? st.y : null;
    if (y == null && !legacyScrollUsed && uiState && uiState.view === 'archive' && Number.isFinite(uiState.y)) {
      y = uiState.y;
      legacyScrollUsed = true;
    }
    const focusLayer = archFocusLayer;
    archFocusLayer = false;
    if (y != null) {
      if (alignState) alignState.userMoved = true;   // 别让 ResizeObserver 把页面拽回区块顶部
      window.scrollTo({ top: y, behavior: 'auto' });
    } else if (focusLayer) {
      scrollToLayerHead();
    } else {
      alignToView('archive', true);
    }
  }

  // ---------- 归档：数据分组（天 → 月 / ISO 周 / 年） ----------
  // 2.4.10：同一天用 archive 还是 history，由显式规则决定（assets/day-source.js）。
  function collectArchiveDays(idx, hist) {
    const map = new Map();
    const archMap = new Map((idx.days || []).map((d) => [d.day, d]));
    const histMap = new Map((hist.days || []).filter((d) => d && d.d).map((d) => [d.d, d]));
    const allDays = new Set([...archMap.keys(), ...histMap.keys()]);

    const decide = (a, h) => {
      if (window.MacroDaySource) {
        return window.MacroDaySource.decideDaySource({ archiveCount: a, historyCount: h });
      }
      if (a <= 0 && h <= 0) return { kind: 'none', count: 0, reason: '该日无归档与历史数据' };
      // 2.21.0：与 assets/day-source.js 保持同一顺序——切片更全时优先切片
      if (h > a) return {
        kind: 'history', count: h,
        reason: a < 20
          ? `该日归档仅 ${a} 条，已改用历史切片 ${h} 条（仅标题/来源/时间，正文请点原文）`
          : `该日归档 ${a} 条，少于历史切片 ${h} 条，已改用历史切片（仅标题/来源/时间，正文请点原文）`,
      };
      if (a >= 20) return { kind: 'archive', count: a, reason: '归档全文' };
      if (h > 0) return {
        kind: 'history', count: h,
        reason: `该日归档仅 ${a} 条，已改用历史切片 ${h} 条（仅标题/来源/时间，正文请点原文）`,
      };
      return { kind: 'archive', count: a, reason: '归档全文（该日无历史切片可补）' };
    };

    for (const day of allDays) {
      const a = archMap.get(day);
      const h = histMap.get(day);
      const dec = decide(a ? a.count || 0 : 0, h ? h.n || 0 : 0);
      if (dec.kind === 'none') continue;
      // 2.20.0：条数可以取历史切片，但早报元数据一律以主索引 data/index.json 为准。
      //   history/index.json 里的 hasBriefing/briefLine 是 export-history 导出那一刻的快照
      //   （见 scripts/export-history.mjs），而 publish/补写只更新主索引。归档条数 < 20 的天
      //   会走 history 分支，若沿用旧快照，补写出来的早报会整块隐形（卡片既无摘要也无展开）。
      const bm = a || h;
      map.set(day, {
        day,
        count: dec.count,
        kind: dec.kind === 'history' ? 'hist' : 'live',
        reason: dec.reason,
        hasBriefing: !!bm.hasBriefing,
        briefLine: bm.briefLine || '',
        // 2.19.0：补写来源（服务端 publish 时写入索引），卡片据此打标签
        briefBackfill: !!bm.briefBackfill,
        // 2.20.0：实际生成时刻（索引派生字段），卡片据此判「晚到 / 跨日」
        briefAt: bm.briefAt || '',
        source: bm.hasBriefing ? (bm.source === 'rule' || bm.source === 'draft' ? bm.source : 'ai') : '',
      });
    }
    const list = [...map.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
    // 2.20.0：制度起点只看**未补写**的最早一份。补写是事后追认，若把它算作起点，
    //   10-30 一补，起点就落到 10-30，10-31 立刻变成假的「制度后缺失」（实测已发生）。
    briefEraDay = list.filter((x) => x.hasBriefing && !x.briefBackfill).map((x) => x.day).sort()[0] || '';
    dayIndex = map;
    return list;
  }

  function sumCount(days) {
    return days.reduce((n, d) => n + (d.count || 0), 0);
  }

  function buildArchiveCtx(list) {
    const byDay = new Map();
    const byMonth = new Map();
    const byWeek = new Map();
    list.forEach((d) => {
      byDay.set(d.day, d);
      const m = AT.monthKeyOf(d.day);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(d);
      const w = AT.isoWeek(d.day);
      if (!w) return;
      if (!byWeek.has(w.key)) {
        const r = AT.weekRange(w.year, w.week);
        byWeek.set(w.key, { key: w.key, year: w.year, week: w.week, start: r.start, end: r.end, days: [] });
      }
      byWeek.get(w.key).days.push(d);
    });
    const months = [...byMonth.keys()].sort().reverse();
    const weeks = [...byWeek.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
    const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort().reverse();
    return {
      days: list, byDay, byMonth, byWeek, months, weeks, years,
      weekKeys: weeks.map((w) => w.key),
      reports: [],
    };
  }

  function groupDaysByWeek(days) {
    const map = new Map();
    days.forEach((d) => {
      const w = AT.isoWeek(d.day);
      if (!w) return;
      if (!map.has(w.key)) {
        const r = AT.weekRange(w.year, w.week);
        map.set(w.key, { key: w.key, year: w.year, week: w.week, start: r.start, end: r.end, days: [] });
      }
      map.get(w.key).days.push(d);
    });
    return [...map.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
  }

  const monthRoute = (key) => ({ level: 'month', year: key.slice(0, 4), month: key.slice(5, 7) });
  const weekRoute = (key) => {
    const p = String(key).split('-W');
    return { level: 'week', year: p[0], week: p[1] };
  };
  const dayRoute = (day) => ({
    level: 'day', year: day.slice(0, 4), month: day.slice(5, 7), day: day.slice(8, 10),
  });

  // 倒序列表里「严格小于 / 严格大于」目标的前后项。
  function prevInDesc(listDesc, key) {
    for (const k of listDesc) if (k < key) return k;
    return '';
  }
  function nextInDesc(listDesc, key) {
    for (let i = listDesc.length - 1; i >= 0; i--) if (listDesc[i] > key) return listDesc[i];
    return '';
  }

  function reportFor(type, id) {
    if (!archCtx) return null;
    return (archCtx.reports || []).find((r) => r.type === type && r.id === id) || null;
  }

  // ---------- 归档：时间尺（面包屑 / 年份 / 最近入口） ----------
  function isRoute(a, b) {
    return !!a && !!b && AT.routeKey(a) === AT.routeKey(b);
  }

  function renderArchiveChrome() {
    const crumb = $('#archCrumb');
    const years = $('#archYears');
    const quick = $('#archQuick');
    if (!crumb || !archCtx) return;

    crumb.innerHTML = '';
    const sep = () => crumb.appendChild(el('span', 'ac-sep', '›'));
    const link = (text, route) => {
      const a = el('a', 'ac-link', text);
      a.href = AT.archiveHash(route);
      crumb.appendChild(a);
    };
    const cur = (text) => crumb.appendChild(el('span', 'ac-cur', text));

    const r = archRoute;
    // 面包屑：归档 › 2026 年 › 11 月 › 第 47 周 › 11-22（祖先都可点）
    const root = () => {
      const a = el('a', 'ac-link', '归档');
      a.href = AT.archiveHash(monthRoute(AT.pickDefaultMonth(archCtx.months, newsDay())));
      crumb.appendChild(a);
    };
    if (r.level === 'all') {
      root();
      sep();
      cur('全部日期');
    } else if (r.level === 'year') {
      root();
      sep();
      cur(r.year + ' 年');
    } else if (r.level === 'month') {
      root();
      sep();
      link(r.year + ' 年', { level: 'year', year: r.year });
      sep();
      cur(Number(r.month) + ' 月');
    } else if (r.level === 'week') {
      const mk = AT.weekMidMonth(r.year, r.week);
      root();
      sep();
      link(mk.slice(0, 4) + ' 年', { level: 'year', year: mk.slice(0, 4) });
      sep();
      link(Number(mk.slice(5, 7)) + ' 月', monthRoute(mk));
      sep();
      cur('第 ' + Number(r.week) + ' 周');
    } else if (r.level === 'day') {
      const w = AT.isoWeek(r.year + '-' + r.month + '-' + r.day);
      root();
      sep();
      link(r.year + ' 年', { level: 'year', year: r.year });
      sep();
      link(Number(r.month) + ' 月', monthRoute(r.year + '-' + r.month));
      if (w) {
        sep();
        link('第 ' + Number(w.week) + ' 周', weekRoute(w.key));
      }
      sep();
      cur(r.month + '-' + r.day);
    }

    if (years) {
      years.innerHTML = '';
      (archCtx.years || []).forEach((y) => {
        const a = el('a', 'yr' + (r.year === y ? ' on' : ''), y);
        a.href = AT.archiveHash({ level: 'year', year: y });
        years.appendChild(a);
      });
      years.hidden = !archCtx.years.length;
    }

    if (quick) {
      quick.innerHTML = '';
      const today = newsDay();
      const month = AT.monthKeyOf(today);
      const thisWeek = AT.isoWeek(today);
      const lastWeek = AT.isoWeek(AT.addDays(AT.weekStart(today), -7));
      const picks = [
        ['本周', AT.nearestWeek(archCtx.weekKeys, thisWeek && thisWeek.key), weekRoute],
        ['上周', AT.nearestWeek(archCtx.weekKeys, lastWeek && lastWeek.key), weekRoute],
        ['本月', AT.nearestMonth(archCtx.months, month), monthRoute],
        ['上月', AT.nearestMonth(archCtx.months, AT.addMonths(month, -1)), monthRoute],
        ['今年', AT.nearestYear(archCtx.years, today.slice(0, 4)), (y) => ({ level: 'year', year: y })],
      ];
      picks.forEach(([label, key, make]) => {
        if (!key) return;
        const route = make(key);
        const a = el('a', 'fchip' + (isRoute(route, r) ? ' on' : ''), label);
        a.href = AT.archiveHash(route);
        quick.appendChild(a);
      });
      const all = el('a', 'fchip all-dates' + (r.level === 'all' ? ' on' : ''), '全部日期');
      all.href = '#archive/all';
      quick.appendChild(all);
    }
  }

  // ---------- 归档：逐层渲染 ----------
  function layerHead(box, title, meta, actions) {
    const hd = el('div', 'arch-layer-hd');
    const t = el('div', 'al-title');
    t.appendChild(el('h2', null, title));
    if (meta) t.appendChild(el('span', 'al-meta', meta));
    hd.appendChild(t);
    if (actions && actions.length) {
      const nav = el('div', 'al-nav');
      actions.forEach((a) => nav.appendChild(a));
      hd.appendChild(nav);
    }
    box.appendChild(hd);
  }

  function navLink(text, route) {
    const a = el('a', 'fchip', text);
    a.href = AT.archiveHash(route);
    return a;
  }

  // 层内同期报告：一行入口，点开才展开正文（默认收起）。
  //   3.4.0 之前是 openNow=true 直接展开：月层层头 → 首张日卡之间隔着 2,048px（手机 3,015px）
  //   的报告正文，同一期报告在页面上还出现两份展开内容（审计 P0-3）。
  function periodicEntry(box, type, id) {
    const r = reportFor(type, id);
    if (!r) {
      const ph = el('div', 'arch-empty-rep');
      ph.appendChild(el('span', 'pr-type', PERIODIC_LABEL[type]));
      ph.appendChild(el('span', null, `${id} 待生成`));
      box.appendChild(ph);
      return;
    }
    const wrap = el('div', 'arch-rep');
    const row = el('button', 'arch-rep-hd');
    row.type = 'button';
    row.appendChild(el('span', 'pr-type', PERIODIC_LABEL[type]));
    row.appendChild(el('span', 'ar-title', r.title));
    row.appendChild(el('span', 'ar-range', `${r.window.start} ~ ${r.window.end}`));
    const caret = el('span', 'ar-caret', '展开');
    row.appendChild(caret);
    const body = el('div', 'pr-body');
    body.hidden = true;
    row.onclick = () => {
      const show = body.hidden;
      body.hidden = !show;
      caret.textContent = show ? '收起' : '展开';
      if (show) loadPeriodicReport(r, body);
      saveUI();
    };
    wrap.appendChild(row);
    wrap.appendChild(body);
    box.appendChild(wrap);
  }

  function dayGrid(days) {
    const grid = el('div', 'days');
    days.forEach((d) => grid.appendChild(dayCard(d)));
    return grid;
  }

  function renderMonthLayer(box, route) {
    const key = route.year + '-' + route.month;
    const days = archCtx.byMonth.get(key) || [];
    const prev = prevInDesc(archCtx.months, key);
    const next = nextInDesc(archCtx.months, key);
    const acts = [];
    if (prev) acts.push(navLink('← 上一月', monthRoute(prev)));
    if (next) acts.push(navLink('下一月 →', monthRoute(next)));
    layerHead(box, AT.monthLabel(key), `${days.length} 天 · ${sumCount(days).toLocaleString('zh-CN')} 条`, acts);
    periodicEntry(box, 'month', key);
    if (!days.length) {
      box.appendChild(el('div', 'empty', '本月暂无归档'));
      return;
    }
    groupDaysByWeek(days).forEach((g) => {
      const sec = el('section', 'arch-week');
      const hd = el('div', 'aw-hd');
      const a = el('a', 'aw-title', '第 ' + Number(g.week) + ' 周');
      a.href = AT.archiveHash(weekRoute(g.key));
      hd.appendChild(a);
      hd.appendChild(el('span', 'aw-range', `${g.start.slice(5)} ~ ${g.end.slice(5)}`));
      hd.appendChild(el('span', 'aw-meta', `${g.days.length} 天 · ${sumCount(g.days).toLocaleString('zh-CN')} 条`));
      if (reportFor('week', g.key)) {
        const chip = el('a', 'aw-rep', '周报');
        chip.href = AT.archiveHash(weekRoute(g.key));
        hd.appendChild(chip);
      } else {
        hd.appendChild(el('span', 'aw-rep off', '周报待生成'));
      }
      sec.appendChild(hd);
      sec.appendChild(dayGrid(g.days));
      box.appendChild(sec);
    });
  }

  function renderWeekLayer(box, route) {
    const key = route.year + '-W' + route.week;
    const g = archCtx.byWeek.get(key) || (() => {
      const r = AT.weekRange(route.year, route.week);
      return { key, year: route.year, week: route.week, start: r.start, end: r.end, days: [] };
    })();
    const mk = AT.weekMidMonth(g.year, g.week);
    const prevW = AT.isoWeek(AT.addDays(g.start, -7));
    const nextW = AT.isoWeek(AT.addDays(g.start, 7));
    const acts = [navLink('← 返回 ' + AT.monthLabel(mk), monthRoute(mk))];
    if (prevW) acts.push(navLink('← 上一周', weekRoute(prevW.key)));
    if (nextW) acts.push(navLink('下一周 →', weekRoute(nextW.key)));
    layerHead(box, '第 ' + Number(g.week) + ' 周',
      `${g.start} ~ ${g.end} · ${g.days.length} 天 · ${sumCount(g.days).toLocaleString('zh-CN')} 条`, acts);
    periodicEntry(box, 'week', key);
    if (!g.days.length) {
      box.appendChild(el('div', 'empty', '本周暂无归档'));
      return;
    }
    box.appendChild(dayGrid(g.days));
  }

  function renderDayLayer(box, route) {
    const day = route.year + '-' + route.month + '-' + route.day;
    const d = archCtx.byDay.get(day);
    const w = AT.isoWeek(day);
    const acts = [];
    // 「打开当日要闻流」是日层唯一的出口，放进层头动作区（此前埋在层尾的一句话里，
    //   日卡自己又直接跳要闻流 ⇒ 日层既进不来、进来也没有明确出口，审计 P1-6）
    if (d) {
      const go = el('button', 'fchip on', '打开当日要闻流');
      go.type = 'button';
      go.onclick = () => openDay(d.day, d.kind);
      acts.push(go);
    }
    if (w) acts.push(navLink('← 返回第 ' + Number(w.week) + ' 周', weekRoute(w.key)));
    acts.push(navLink('← 前一天', dayRoute(AT.addDays(day, -1))));
    acts.push(navLink('后一天 →', dayRoute(AT.addDays(day, 1))));
    layerHead(box, route.month + '-' + route.day + ' 新闻日',
      d ? `${d.count} 条` : '该日暂无归档', acts);
    if (!d) {
      box.appendChild(el('div', 'empty', '该日暂无归档'));
      return;
    }
    const grid = el('div', 'days days-one');
    grid.appendChild(dayCard(d, { toLayer: false }));
    box.appendChild(grid);
    box.appendChild(el('p', 'arch-day-note',
      '当日条目在要闻流里读：点日卡或层头的「打开当日要闻流」。'));
  }

  function renderYearLayer(box, route) {
    const y = route.year;
    const months = archCtx.months.filter((m) => m.slice(0, 4) === y);
    const allDays = months.reduce((acc, m) => acc.concat(archCtx.byMonth.get(m) || []), []);
    const prev = prevInDesc(archCtx.years, y);
    const next = nextInDesc(archCtx.years, y);
    const acts = [];
    if (prev) acts.push(navLink('← ' + prev + ' 年', { level: 'year', year: prev }));
    if (next) acts.push(navLink(next + ' 年 →', { level: 'year', year: next }));
    layerHead(box, y + ' 年',
      `${months.length} 个月 · ${allDays.length} 天 · ${sumCount(allDays).toLocaleString('zh-CN')} 条`, acts);
    periodicEntry(box, 'year', y);
    if (!months.length) {
      box.appendChild(el('div', 'empty', '该年暂无归档'));
      return;
    }
    const wrap = el('div', 'arch-months');
    months.forEach((m) => {
      const days = archCtx.byMonth.get(m) || [];
      const sec = el('section', 'arch-month');
      const hd = el('div', 'am-hd');
      const a = el('a', 'am-title', AT.monthLabel(m));
      a.href = AT.archiveHash(monthRoute(m));
      hd.appendChild(a);
      hd.appendChild(el('span', 'am-meta', `${days.length} 天 · ${sumCount(days).toLocaleString('zh-CN')} 条`));
      if (reportFor('month', m)) {
        const chip = el('a', 'am-rep', '月报');
        chip.href = AT.archiveHash(monthRoute(m));
        hd.appendChild(chip);
      } else {
        hd.appendChild(el('span', 'am-rep off', '月报待生成'));
      }
      sec.appendChild(hd);
      const weeks = el('div', 'am-weeks');
      const groups = groupDaysByWeek(days);
      groups.forEach((g) => {
        const c = el('a', 'wk-chip', '第 ' + Number(g.week) + ' 周');
        c.href = AT.archiveHash(weekRoute(g.key));
        c.title = `${g.start} ~ ${g.end} · ${g.days.length} 天`;
        weeks.appendChild(c);
      });
      if (!groups.length) weeks.appendChild(el('span', 'am-none', '无归档'));
      sec.appendChild(weeks);
      wrap.appendChild(sec);
    });
    box.appendChild(wrap);
  }

  // 迁移期兜底入口：仍可平铺全部日期，但按月分页（3 个月/页），不一次画 387 张。
  function renderAllLayer(box) {
    const months = archCtx.months;
    layerHead(box, '全部日期', `按自然月分页 · 共 ${months.length} 个月`);
    if (!months.length) {
      box.appendChild(el('div', 'empty', '暂无归档'));
      return;
    }
    months.slice(0, archAllShown).forEach((m) => {
      const days = archCtx.byMonth.get(m) || [];
      const sec = el('section', 'arch-month');
      const hd = el('div', 'am-hd');
      const a = el('a', 'am-title', AT.monthLabel(m));
      a.href = AT.archiveHash(monthRoute(m));
      hd.appendChild(a);
      hd.appendChild(el('span', 'am-meta', `${days.length} 天 · ${sumCount(days).toLocaleString('zh-CN')} 条`));
      sec.appendChild(hd);
      sec.appendChild(dayGrid(days));
      box.appendChild(sec);
    });
    if (months.length > archAllShown) {
      const b = el('button', 'more', `加载更早的 3 个月（还有 ${months.length - archAllShown} 个月）`);
      b.type = 'button';
      b.onclick = () => {
        archAllShown += 3;
        archRestoring = true;
        renderArchiveLayer(archRoute);
        const done = () => { archRestoring = false; };
        Promise.all([restoreBriefOpen(), restorePeriodicOpen()]).then(done, done);
      };
      box.appendChild(b);
    }
  }

  function renderArchiveLayer(route) {
    const box = $('#days');
    if (!box) return;
    box.innerHTML = '';
    if (route.level === 'year') return renderYearLayer(box, route);
    if (route.level === 'week') return renderWeekLayer(box, route);
    if (route.level === 'day') return renderDayLayer(box, route);
    if (route.level === 'all') return renderAllLayer(box);
    return renderMonthLayer(box, route);
  }

  // 默认落层只决定「没指定层级」时去哪：当前月 → 无数据则最近有数据的月。
  function resolveArchiveRoute(route) {
    if (route && route.level && route.level !== 'default') return route;
    const mk = AT.pickDefaultMonth(archCtx.months, newsDay());
    return monthRoute(mk);
  }

  function setArchHash(route) {
    const h = AT.archiveHash(route);
    if (location.hash !== h) history.replaceState(null, '', h);
  }

  // 归档内跳转统一入口：改 hash 交给 hashchange 渲染（同一层则直接重渲染）。
  //   用真实的 hash 跳转而不是 replaceState，浏览器前进/后退才能回到上一层。
  function navigateArchive(route) {
    const h = AT.archiveHash(route);
    if (location.hash === h) renderArchive(route, { nav: true });
    else location.hash = h;
  }

  async function renderArchive(route, opts) {
    opts = opts || {};
    const token = ++archToken;
    const box = $('#days');
    if (!archCtx && box) box.innerHTML = '<div class="skeleton">载入中…</div>';
    try {
      // 三个索引并行取：archive（带全文）+ history（归档前缺口）+ periodic（周报/月报/年报）
      const [idx, hist, per] = await Promise.all([loadIndex(), loadHistoryIndex(), loadPeriodicIndex()]);
      if (token !== archToken) return;
      const list = collectArchiveDays(idx, hist);
      archCtx = buildArchiveCtx(list);

      const prevLevel = archRoute ? archRoute.level : '';
      const r = resolveArchiveRoute(route);
      if (r.level === 'all' && prevLevel !== 'all') archAllShown = 3;
      // 先落路由：周期报告组内默认展开哪一年，按当前层所在年决定
      archRoute = r;
      archRendered = true;
      // 周期报告渲染失败不能拖垮按日归档：单独兜住
      try { renderPeriodicPanel(per); } catch { /* 保持区块隐藏 */ }
      archCtx.reports = periodicById ? [...periodicById.values()] : [];
      // 3.4.0：整块默认收起；刷新前展开过就恢复展开（只恢复开关，不预取正文）
      const pnl = $('#periodicPanel');
      if (pnl) pnl.open = !!(uiState && uiState.periodicPanel);
      syncPeriodicCaret();
      renderHistPanel(hist, list);
      setArchHash(r);
      renderArchiveChrome();
      syncStickyOffset();   // 时间尺高度随面包屑换行变化：锚点补偿要跟着更新
      // 渲染 + 恢复期间先别让 toggle 触发的 saveUI 写回（见 saveUI 顶部注释）
      archRestoring = true;
      renderArchiveLayer(r);
      const done = () => {
        archRestoring = false;
        archFocusLayer = !!opts.nav;
        restoreArchiveState(r);
      };
      Promise.all([restoreBriefOpen(), restorePeriodicOpen()]).then(done, done);
    } catch (e) {
      archRestoring = false;
      if (token !== archToken) return;
      if (box) box.innerHTML = `<div class="skeleton">载入失败：${esc(e.message)}</div>`;
    }
  }

  // 打开过的「天」放内存（见 getDay）：切走再点不用重下。
  async function openDay(day, kind = 'live') {
    closeReader();
    showView('feed');
    const box = $('#feed');
    box.innerHTML = '<div class="skeleton">载入中…</div>';
    try {
      const d = await getDay(day, kind);
      S.items = d.items;
      S.filter = 'all';
      S.q = '';
      $('#q').value = '';
      $('#qClear').hidden = true;
      S.shown = PAGE;
      openedDay = { day, kind };   // 2.4.12：刷新后仍停在这一天
      hideRelatedReports();
      renderFilters();
      renderFeed();
      const info = dayIndex.get(day);
      const reason = info && info.reason ? ' · ' + info.reason : '';
      $('#qMeta').textContent =
        kind === 'hist'
          ? `历史：${day} · ${d.items.length} 条${reason || ' · 仅标题/来源/时间，正文请点原文'}`
          : `归档：${day} · ${d.items.length} 条${reason}`;
    } catch (e) {
      box.innerHTML = `<div class="skeleton">载入失败：${esc(e.message)}</div>`;
    }
  }

  // ---------- 来源 + 页脚概况 ----------
  // ⚠ 这两处共用同一份数据（`_last-run.json` + `index.json`），但**必须分别填各自的容器**：
  //   以前两个区块都写进了 `#sources`，而 `#status` 从来没被写过
  //   ⇒ 点「运行状态」永远是空白一片（看起来像"点了没反应"）。
  //   现在「运行状态」页签已取消，概况直接渲染到页脚（见 renderFoot）。
  let runMeta = null;
  async function loadRunMeta() {
    if (!runMeta) {
      const [last, idx] = await Promise.all([jget('_last-run.json', 'default'), loadIndex()]);
      let total = 0;
      (idx.days || []).forEach((d) => { total += d.count || 0; });
      runMeta = { last: last || {}, total, days: (idx.days || []).length, dayList: idx.days || [] };
    }
    return runMeta;
  }

  // 早报状态（data/_briefing-status.json，2.2.1 起）：页脚用来显示「早报 09:02 / 补跑中 / 失败 / 今日未生成」。
  // 单文件、一天写 1~3 次；读不到（还没接入）按空处理，不影响页脚其它信息。
  //
  // 2.13.1：**不吃 HTTP 缓存**。这个文件的更新时机就是「早报跑完」，
  //   而 Pages 给 data/ 的默认缓存是 max-age=600 —— 用 'default' 时，
  //   09:00 打开过页面、09:10 刷新的人会拿到补跑前的旧副本，页脚一直停在「今日未生成」，
  //   看起来像补跑没生效。文件只有 3 KB、一天变 1~3 次，直接 no-store 最省事。
  //   页面内仍保留 60s 记忆：一次启动里 renderFoot 会被调用两次，没必要打两枪。
  const BRIEF_STATUS_TTL = 60 * 1000;
  let briefStatus = null;
  let briefStatusAt = 0;
  let briefPromise = null;
  function loadBriefStatus() {
    if (briefStatus && Date.now() - briefStatusAt < BRIEF_STATUS_TTL) return Promise.resolve(briefStatus);
    if (!briefPromise) {
      briefPromise = jget('_briefing-status.json')
        .then((d) => {
          briefStatus = d || { days: {} };
          briefStatusAt = Date.now();
          briefPromise = null;
          return briefStatus;
        })
        .catch(() => {
          // 读不到就按「没有状态记录」处理，但不缓存失败结果，下次调用还会重试
          briefPromise = null;
          return { days: {} };
        });
    }
    return briefPromise;
  }

  // K 线新鲜度心跳（2026-11-19 哨兵）
  //
  // ⚠ 这是本文件里唯一「新增的状态文件」。原本（见 renderFoot 顶上的注释）特意不新增，
  //   但这次的事故证明「运行 success」不能当判据：22:48 那次结论 success、push 却静默
  //   放弃，main 上没有任何变化。心跳文件由 K 线 workflow 在**推送之前**写入、与数据
  //   同一笔提交 ⇒ 它只会在真正推成功时前进，正好就是「最后一次 kline 数据提交时间」。
  //   体积约 100 字节，且本来每次运行就会有一笔 kline 提交。
  const KLINE_HB_TTL = 60 * 1000;
  let klineHb = null;
  let klineHbAt = 0;
  let klineHbPromise = null;
  function loadKlineHeartbeat() {
    if (klineHb && Date.now() - klineHbAt < KLINE_HB_TTL) return Promise.resolve(klineHb);
    if (!klineHbPromise) {
      klineHbPromise = jget('kline/_heartbeat.json')
        .then((d) => {
          klineHb = d || null;
          klineHbAt = Date.now();
          klineHbPromise = null;
          return klineHb;
        })
        .catch(() => {
          klineHbPromise = null;
          return null;
        });
    }
    return klineHbPromise;
  }

  async function renderSources() {
    const box = $('#sources');
    box.innerHTML = '<div class="skeleton">载入中…</div>';
    try {
      const { last } = await loadRunMeta();
      const srcs = last.sources || [];
      let rows = '';
      srcs.forEach((s) => {
        rows += `<tr>
          <td>${esc(s.label)}</td>
          <td class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '正常' : '失败'}</td>
          <td class="num">${s.count}</td>
          <td class="num">${s.ms} ms</td>
          <td style="color:var(--ink-mute);font-size:.85rem">${esc(s.error || '')}</td>
        </tr>`;
      });

      box.innerHTML = `
        <h2 style="font-size:1.2rem;margin:1.5rem 0 .5rem">数据源</h2>
        ${srcs.length ? `<div class="tbl-wrap"><table>
          <thead><tr><th>来源</th><th>状态</th><th class="num">本次条数</th><th class="num">耗时</th><th>错误</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : '<div class="note">没有可用的来源状态记录。</div>'}

        <div class="note">
          共 ${srcs.length} 个新闻源，每个源独立 try/catch —— <strong>单个源失败不影响其他源</strong>，
          失败原因见上表。状态与耗时是最近一次采集时的现场值，随当次网络状况波动。
        </div>`;
    } catch (e) {
      box.innerHTML = `<div class="skeleton">载入失败：${esc(e.message)}</div>`;
    }
  }

  // ---------- 页脚：链路健康 ----------
  //
  // ⚠ 这里原本是一个独立的「运行状态」页签，但它的内容就是页脚那一行 ⇒ 页签冗余，
  //   已按用户意见取消这个导航项（2026-10-29）。概况改为直接渲染到页脚，任何视图下都看得到。
  //
  // 健康摘要只读**现有**三份数据（`_last-run.json` / `latest.json` / `quotes.json`），
  // 不新增心跳文件：采集每 15 分钟就可能提交一次 data/，再加一份状态文件只会让仓库继续膨胀。
  // 注意「最近一次采集」是采集器自己记录的开始时间，而采集器**内容没变时不重写文件**（省 git），
  // 所以安静时段这个时间会偏旧 —— 真正的新鲜度看「最新一条新闻」的相对时间。
  const agoMin = (iso) => {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? Math.round((Date.now() - t) / 60000) : null;
  };
  const agoText = (min) => {
    if (min == null) return '—';
    if (min <= 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.round(min / 60);
    return h < 48 ? `${h} 小时前` : `${Math.round(h / 24)} 天前`;
  };

  async function renderFoot() {
    const box = $('#ftMeta');
    try {
      // 早报状态与采集概况并行取：前者是单独的小文件，失败不影响整行
      const [{ last, total, days, dayList }, brief, hb] = await Promise.all([
        loadRunMeta(), loadBriefStatus(), loadKlineHeartbeat(),
      ]);
      // 字段形状要按实际产物校验：`macroOk` 是数组，而 `macroFail` 在无失败时写的是 `{}`，
      // 直接 forEach 会抛「is not a function」，把整行页脚变成错误信息。
      const srcs = Array.isArray(last.sources) ? last.sources : [];
      const srcBad = srcs.filter((s) => !s.ok);
      const macroOk = Array.isArray(last.macroOk) ? last.macroOk : [];
      const macroFail = Array.isArray(last.macroFail) ? last.macroFail : Object.keys(last.macroFail || {});
      const runMin = agoMin(last.startedAt);
      const news = (S.items || [])[0] || null;
      const newsMin = news ? agoMin(news.time) : null;

      // 状态灯：源失败、采集停摆优先于「新闻暂时没有新的」
      let level = 'ok';
      let state = '链路正常';
      // 页面自身的数据文件失败优先级最高：此时列表/行情已经不可用，
      // 再显示绿色「链路正常」会直接误导用户。
      if (!feedLoadOk) { level = 'bad'; state = '要闻数据缺失（latest.json）'; }
      else if (!quotesLoadOk) { level = 'bad'; state = '行情数据缺失（quotes.json）'; }
      if (level !== 'bad' && runMin != null && runMin > 24 * 60) { level = 'bad'; state = '采集可能停摆'; }
      else if (level !== 'bad' && runMin != null && runMin > 180) { level = 'warn'; state = '采集滞后'; }
      if (srcBad.length && level !== 'bad') {
        level = 'warn';
        state = `${srcs.length - srcBad.length}/${srcs.length} 源正常`;
      }
      // 2.12.0：归档触顶（本轮发生了配额淘汰）。这是「数据被丢」而不是「源故障」，
      // 优先级低于停摆/失败，但必须比"一切正常"更显眼——上次丢早盘条目就是因为只看 +N。
      const newsMeta = last.news || {};
      const capped = newsMeta.capped === true;
      if (capped && level !== 'bad') {
        level = 'warn';
        state = `归档触顶 · 淘汰 ${Number(newsMeta.evicted) || 0} 条`;
      }

      // K 线新鲜度哨兵（2026-11-19）：判据是心跳时间戳，而不是「运行是否 success」。
      //   心跳由 K 线 workflow 在推送前写入、与数据同一笔提交 ⇒ 推不上去就不会前进。
      //   阈值默认 90 分钟（心跳文件可覆盖）：cron 每 30 分钟一轮、单轮约 6 分钟，
      //   正常最长约 36 分钟；丢一轮约 66 分钟；90 分钟留出一轮完整余量。
      // 2026-11-22：日 K 末根盘中更新改为每天 4 轮（北京 02/08/14/20），但本哨兵衡量的是
      //   **K 线 workflow 还活着**（分钟 K 仍每小时跑），所以阈值保持 90 分钟、文案改叫
      //   「K线任务」——不能让它看起来像「日 K 数据 20 分钟前更新过」。
      //   日 K 本身的新鲜度由 K 线抽屉的「收盘 / 盘中值·未定稿 / 本地快照」标注表达。
      const KL = window.MacroQuoteStatus || {};
      const kf = typeof KL.klineFreshness === 'function'
        ? KL.klineFreshness(hb, Date.now())
        : { level: 'none', ageMin: null, thresholdMin: 90 };
      if (kf.level === 'bad') {
        level = 'bad';
        state = `K线任务停摆 ${agoText(kf.ageMin)}`;
      }

      const bits = [];
      if (!feedLoadOk) bits.push('要闻载入失败 latest.json');
      if (!quotesLoadOk) bits.push('行情载入失败 quotes.json');
      if (last.runner === 'cloud') bits.push('云端');
      else if (last.runner === 'local') bits.push('本机');
      if (runMin != null) bits.push('采集 ' + agoText(runMin));
      if (srcs.length) bits.push(`源 ${srcs.length - srcBad.length}/${srcs.length}`);
      if (capped) bits.push(`归档上限 ${newsMeta.cap || '?'}`);
      if (newsMin != null) bits.push('最新新闻 ' + agoText(newsMin));
      if (kf.level !== 'none') bits.push(`K线任务 ${agoText(kf.ageMin)}`);
      // 与 #quoteTime 共用同一段三态文案，避免一处实时一处快照
      bits.push(S.quoteStatusText || '行情 未记录');
      if (macroOk.length || macroFail.length) bits.push(`宏观 ${macroOk.length}/${macroOk.length + macroFail.length}`);
      bits.push(`库 ${total.toLocaleString('zh-CN')} 条 / ${days} 天`);

      box.textContent = '';
      box.appendChild(el('span', `ft-state ${level}`, '● ' + state));
      box.appendChild(document.createTextNode(' · ' + bits.join(' · ')));

      // 早报状态：独立 token，不改变上面的总灯（避免早报问题把行情/新闻的正常状态染红）
      //
      // 2.13.1：按「时间 × 状态」分层判定。D 日 09:00 之前本来就没有 D 日早报
      //   （cron 是 `0 9 * * *`，见 README §2.6；D 的早报在 D 09:00 才生成），
      //   所以那段时间必须是**中性提示**，不能写成"未记录/未生成"这种缺失语气，也不着色。
      //   判定用的 `today` 是新闻日（北京 08:00 起算），与早报的日期键同一把尺子：
      //   08:00 之前仍属于 D-1 的窗口，那时 D-1 的早报早已生成，走 done 分支。
      const bj = new Date(Date.now() + 8 * 3600 * 1000);
      const today = newsDay();
      const nowMin = bj.getUTCHours() * 60 + bj.getUTCMinutes();
      const rec = (brief.days || {})[today];
      // 产物证据：归档索引里当天 hasBriefing。状态文件与 index.json 由同一次 publish 提交，
      // 但读取缓存/推送顺序可能让两者短暂不一致 —— 只要有一处证明早报存在，
      // 就不该在页脚说"未生成"（补跑一次就该看得见）。
      const artDay = (dayList || []).find((d) => d && d.day === today);
      const hasArtifact = !!(artDay && artDay.hasBriefing);
      // 早报运行时刻 09:00（北京），与 cron `0 9 * * *` 对齐
      const BRIEF_AT = 9 * 60;
      // 2.13.2：整点触发 ≠ 整点落盘。cron 在 09:00 派发，从排队、跑管道到写
      //   `_briefing-status.json` 通常几十秒到几分钟，期间"无记录 + 无产物"是
      //   正常的中间态。若这里直接判缺失，每天 09:00–09:03 都会闪一次告警色
      //   （2.13.1 上线后已被观察到）。所以给 10 分钟宽限：这段时间仍算中性，
      //   过了宽限还什么都没有，才是真的没生成。
      const BRIEF_GRACE_MIN = 10;
      const BRIEF_LATE_AT = BRIEF_AT + BRIEF_GRACE_MIN;
      let bTxt = '';
      let bLvl = '';
      let bTitle = '';
      if (rec && rec.status === 'done') {
        const when = rec.endedAt || rec.startedAt || '';
        // 2.20.0：生成时间统一走 briefTiming。旧写法用 fmtTime 得到「今天 00:12」，
        //   11-14 的早报（实际 11-15 00:12 生成）因此被读成当日凌晨，且跨日迟到完全静默。
        const tm = briefTiming(today, when, !!rec.backfill);
        const stamp = tm ? tm.text : '完成';
        const late = !!tm && (tm.kind === 'late-same' || tm.kind === 'late-cross');
        if (rec.pushed === false) {
          // 2.4.2：published 成功但 git 推送失败 —— 站点文件已写，仓库/线上还没有
          bTxt = '早报 已发布未入库';
          bLvl = 'warn';
        } else if (rec.source === 'rule') {
          // 兜底产物要能一眼看出来（不等于链路故障，所以用暖棕而不是红）
          bTxt = '早报 自动 ' + stamp;
          bLvl = 'warn';
        } else if (rec.source === 'draft') {
          // 2.3.0：LLM 定稿不可用时的确定性事实清单，同样必须可辨别
          bTxt = '早报 事实清单 ' + stamp;
          bLvl = 'warn';
        } else {
          bTxt = '早报 ' + stamp;
          bLvl = late ? 'warn' : 'ok';
        }
        if (late) bTitle = `该早报未在 ${today} 09:00 按时生成：${tm.text}`;
      } else if (rec && rec.status === 'awaiting') {
        // prepare 已完成、LLM 还没定稿：独立提示，不改变链路健康总灯
        bTxt = rec.stage === 'awaiting-publish' ? '早报 待发布' : '早报 待写作';
        bLvl = 'warn';
      } else if (rec && rec.status === 'running') {
        bTxt = '早报 补跑中';
        bLvl = 'warn';
      } else if (rec && (rec.status === 'failed' || rec.status === 'timeout')) {
        bTxt = '早报 失败';
        bLvl = 'bad';
      } else if (hasArtifact) {
        // 有产物但没有 done 记录（状态文件写失败/未推送/被旧缓存读到）：按"已生成"展示
        bTxt = '早报 已生成';
        bLvl = 'ok';
      } else if (nowMin < BRIEF_AT) {
        // 09:00 前：今日早报还没到生成时刻，属于正常等待，不是缺失
        bTxt = '早报 今日 09:00 后生成';
        bLvl = 'mute';
      } else if (nowMin < BRIEF_LATE_AT) {
        // 09:00–09:10：cron 已派发但状态/产物可能还没落盘，属生成中的中间态，
        // 用中性灰；不写"未生成"这种判断性措辞，避免每天准点闪一次告警色
        bTxt = '早报 生成中';
        bLvl = 'mute';
      } else {
        // 过了宽限仍既无状态记录、也没有产物：今天这期确实没生成
        bTxt = '早报 今日未生成';
        bLvl = 'warn';
      }
      if (bTxt) {
        box.appendChild(document.createTextNode(' · '));
        const sp = el('span', `ft-state ${bLvl}`, bTxt);
        if (bTitle) sp.title = bTitle;
        else if (rec && (rec.pushError || rec.reason)) sp.title = rec.pushError || rec.reason;
        box.appendChild(sp);
      }

      // 2.19.0：上一条缺口 —— 历史日「该有却没有」的状态，与今天的 token 分开展示。
      // 判据与后端 scanGaps 同口径：>= 制度起点、< 今天、有新闻、无早报。
      // 三种态：补写中（棕）/ 缺失（棕）/ 已补写（绿，只报 48 小时内，避免长期噪音）。
      const dayRec = (d) => (brief.days || {})[d] || {};
      // 制度起点优先用归档面板算好的；面板还没渲染时用索引现推，避免依赖调用顺序
      // 2.20.0：补写产物不算起点（与归档面板、后端 briefEraStart 同口径）
      const eraDay = briefEraDay
        || (dayList || []).filter((d) => d && d.hasBriefing && !d.briefBackfill)
          .map((d) => d.day).sort()[0]
        || '';
      const gapDay = (dayList || [])
        .filter((d) => d && d.day && d.day < today && d.day >= eraDay
          && Number(d.count) > 0 && !d.hasBriefing)
        .map((d) => d.day)
        .sort()
        .pop() || '';
      // 最近一次补写完成（产物已存在且带补写标记），只有状态窗口内才拿得到时刻
      let doneBackfill = null;
      for (const d of dayList || []) {
        if (!d || !d.briefBackfill || !d.hasBriefing || !d.day || d.day >= today) continue;
        const r = dayRec(d.day);
        const at = r.backfilledAt || r.endedAt || '';
        const ageMin = at ? agoMin(at) : null;
        if (ageMin == null || ageMin > 48 * 60) continue;
        if (!doneBackfill || d.day > doneBackfill.day) doneBackfill = { day: d.day, at };
      }
      let gTxt = '';
      let gLvl = '';
      let gTitle = '';
      if (gapDay && (!doneBackfill || gapDay >= doneBackfill.day)) {
        const gr = dayRec(gapDay);
        if (gr.backfill && (gr.status === 'awaiting' || gr.status === 'running')) {
          gTxt = `早报 ${gapDay} 补写中`;
          gLvl = 'warn';
          gTitle = gr.reason || '输入快照已准备，等待定稿';
        } else {
          gTxt = `早报 ${gapDay} 缺失`;
          gLvl = 'warn';
          gTitle = `该日有新闻但没有早报；可补写：ensure --backfill-from ${gapDay} --backfill-to ${gapDay}`;
        }
      } else if (doneBackfill) {
        // 2.20.0：补写时刻带日期 —— 补写可能发生在很久以后，「今天 00:51」会误导成当日凌晨
        const stamp = bjStamp(doneBackfill.at) || fmtTime(doneBackfill.at);
        gTxt = `早报 ${doneBackfill.day} 已补写 ${stamp}`;
        gLvl = 'ok';
        gTitle = '该日早报为补写产物（按该日新闻切片重新生成）';
      }
      if (gTxt) {
        box.appendChild(document.createTextNode(' · '));
        const sp = el('span', `ft-state ${gLvl}`, gTxt);
        if (gTitle) sp.title = gTitle;
        box.appendChild(sp);
      }

      // 2.4.17：本机同步兜底 token —— 独立于总灯，不改变链路健康 level
      const lsView = window.MacroLocalSync && window.MacroLocalSync.localSyncView
        ? window.MacroLocalSync.localSyncView(last.localSync)
        : null;
      if (lsView && lsView.show) {
        box.appendChild(document.createTextNode(' · '));
        const sp = el('span', `ft-state ${lsView.level}`, lsView.text);
        sp.title = lsView.title;
        box.appendChild(sp);
      }

      // 失败细节放进 title：页脚只留一行，悬停才看长原因
      const why = [];
      srcBad.forEach((s) => why.push(`${s.label}${s.error ? '：' + s.error : ''}`));
      macroFail.forEach((m) => why.push('宏观失败：' + m));
      if (last.quoteError) why.push('行情：' + last.quoteError);
      box.title = why.length ? why.join('\n') : '最近一次采集：全部来源正常';
    } catch (e) {
      // 读不到运行状态就保留 boot 里先写下的快照信息，别把有信息的一行换成报错
      if (!box.textContent) box.textContent = '运行状态读取失败：' + (e && e.message ? e.message : e);
    }
  }

  // ---------- K线图 ----------
  const CFG = window.MACRO_CONFIG || { POLL_SECONDS: 15, REFRESH_SECONDS: 20, DEFAULT_PERIOD: '1d' };
  const PERIOD_LABEL = {
    '1m': '1分', '5m': '5分', '15m': '15分', '30m': '30分', '60m': '60分',
    '1d': '日K', '1w': '周K', '1M': '月K', '1y': '年K',
  };
  // 日频标的（1Y国债收益率）可用的周期
  const DAILY_PERIODS = ['1d', '1w', '1M', '1y'];
  // 均线：日/周/月/分钟用 5/10/20/30/60/120/250；年K 只用 5/10/20/30（单位是年），
  // 且数据长度不足 n 根时，MA_n 及更长的均线不绘制、对应按钮置灰。
  const YEAR_MA = [5, 10, 20, 30];
  const MA_LIST = [5, 10, 20, 30, 60, 120, 250];
  const MA_STORE = 'macro.maShown';
  const loadMA = () => {
    try {
      const v = JSON.parse(localStorage.getItem(MA_STORE) || 'null');
      if (Array.isArray(v)) return new Set(v.filter((n) => MA_LIST.includes(n)));
    } catch (e) { /* 忽略损坏的本地状态 */ }
    return new Set(MA_LIST);
  };
  const maShown = loadMA();
  let kChart = null;
  let klineTimer = null;
  let klineKey = '';
  let klinePeriod = '1d';
  let pendingKlineView = null;   // 2.4.12：刷新后待恢复的缩放/视窗
  let openedDay = null;          // 2.4.12：当前打开的归档日（feed 视图内）
  let maBars = 0;            // 当前周期数据的总根数：决定 MA_n 是否可画（0 = 数据还没到）
  // 请求令牌：每次取数 +1。
  // ⚠ 没有它会出两个 bug：
  //   ① 旧图残留 —— 图表是单例，切标的时画布还留着上一个标的的 K 线；
  //   ② 数据串台 —— 快速点 A→B 时，A 的响应后到会执行 setData(A的bars)，
  //      结果 **A 的 K 线显示在 B 的标题下**。
  // ⇒ 任何异步回来的结果，先校验令牌，过期的直接丢弃。
  let klineReqId = 0;

  // 「更全的结果到了」的等待器。
  // 直连链里各源到货时间不同（新浪 ~0.8s / 腾讯 ~1.4s / 东财可能挂到超时），
  // 在决定要不要去拉「服务端全量文件」之前，先给还在路上的源留一个宽限期，
  // 否则会在新浪还没到时就抢着去拉全量文件 —— 白耗 Pages 带宽（实测只有 7~20 KB/s）。
  let upgradeWaiters = [];
  const notifyUpgrade = () => {
    const w = upgradeWaiters;
    upgradeWaiters = [];
    w.forEach((fn) => fn());
  };
  const waitUpgrade = (ms) =>
    new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      upgradeWaiters.push(fin);
      setTimeout(fin, ms);
    });

  // 当前可用的均线 = （年K 只到 30）∩ 已开启 ∩ 数据根数足够
  const enabledMA = () =>
    (klinePeriod === '1y' ? YEAR_MA : MA_LIST)
      .filter((n) => maShown.has(n) && n <= maBars);

  function renderMA() {
    const box = $('#kmMA');
    if (!box) return;
    box.innerHTML = '';
    const isYear = klinePeriod === '1y';
    const list = isYear ? YEAR_MA : MA_LIST;
    list.forEach((n) => {
      const unavailable = n > maBars;
      const on = maShown.has(n) && !unavailable;
      const b = el('button', 'mchip' + (on ? ' on' : '') + (unavailable ? ' disabled' : ''), 'MA' + n);
      b.type = 'button';
      if (unavailable) {
        b.disabled = true;
        b.title = '当前数据只有 ' + maBars + ' 根，不足 ' + n + ' 根';
      } else {
        b.onclick = () => {
          if (maShown.has(n)) maShown.delete(n);
          else maShown.add(n);
          b.classList.toggle('on', maShown.has(n));
          try { localStorage.setItem(MA_STORE, JSON.stringify([...maShown])); } catch (e) { /* 忽略 */ }
          if (kChart) kChart.setMAEnabled(enabledMA());
        };
      }
      box.appendChild(b);
    });
    if (kChart) kChart.setMAEnabled(enabledMA());
  }

  /** 把当前周期 chip 滚进可视区：320px 下日K/周K 之后整块会落在屏外 */
  function revealPeriodChip() {
    const box = $('#kmPeriods');
    const on = box && box.querySelector('.pchip.on');
    if (!box || !on) return;
    const br = on.getBoundingClientRect();
    const cr = box.getBoundingClientRect();
    if (!cr.width) return;
    if (br.left < cr.left + 6) {
      box.scrollLeft = Math.max(0, box.scrollLeft - (cr.left + 6 - br.left));
    } else if (br.right > cr.right - 6) {
      box.scrollLeft = Math.min(box.scrollWidth, box.scrollLeft + (br.right - (cr.right - 6)));
    }
  }

  function openKline(key, period = CFG.DEFAULT_PERIOD || '1d') {
    const q = (S.quotes || []).find((x) => x.key === key);
    // 刷新恢复时行情可能还没到：先用 sessionStorage 里存下的名称/现价把头部画对，
    // 别先显示代码或空白再跳一次（2.7.1）。
    const saved = uiState && uiState.kline && uiState.kline.key === key ? uiState.kline : null;
    $('#klineModal').hidden = false;
    document.body.classList.add('kline-open');
    $('#kmName').textContent = q ? q.name : (saved && saved.name ? saved.name : key);
    $('#kmPrice').textContent = q ? fmtNum(q.price, decOf(key)) : (saved && saved.price ? saved.price : '');
    $('#kmPrice').className = 'km-price ' + ((q?.changePct || 0) >= 0 ? 'up' : 'down');

    const periods = $('#kmPeriods');
    periods.innerHTML = '';
    // 无历史序列的标的（官方中间价）：K 线**不可得**，不能画空图框、也不能拿别的序列顶替。
    // 直接把周期条/均线/画布收起，只留口径说明。
    const noHistory = !!(window.MarketData && window.MarketData.hasNoHistory
      && window.MarketData.hasNoHistory(key));
    const canvasBox = $('#kmCanvas');
    const maBox = $('#kmMA');
    if (noHistory) {
      periods.hidden = true;
      maBox.hidden = true;
      canvasBox.style.display = 'none';
      clearKlineLast();
      $('#kmMeta').textContent = '';
      $('#kmNote').textContent = window.MarketData.getKlineNote
        ? window.MarketData.getKlineNote(key)
        : '该标的没有历史序列';
      // 记住当前标的，刷新页面后仍能恢复这张「无历史」说明，而不是回到上一张图
      klineKey = key;
      klinePeriod = period;
      saveUI();
      return;
    }
    periods.hidden = false;
    maBox.hidden = false;
    canvasBox.style.display = '';

    // 1Y国债收益率是**逐日一条曲线**（中债只有日频），既没有分钟源也没有腾讯代码
    // ⇒ 分钟周期对它必然是空的，直接不渲染这几个页签，别让用户点了只得到一句「加载失败」
    const dailyOnly = key === 'cgb_1y';
    Object.keys(PERIOD_LABEL).forEach((p) => {
      if (dailyOnly && !DAILY_PERIODS.includes(p)) return;
      const b = el('button', 'pchip', PERIOD_LABEL[p]);
      b.dataset.period = p;
      b.onclick = () => loadKline(key, p);
      periods.appendChild(b);
    });

    if (!kChart) kChart = new window.KlineChart($('#kmCanvas'));
    else kChart.reset();              // ← 清掉上一个标的的图（残留 bug）
    // 精度按标的走：轴标签 / 十字线 OHLC / 均线图例都读这个值
    kChart.setDecimals(decOf(key));
    if (kChart.setVolumeUnit) kChart.setVolumeUnit(volUnitOf(key));
    renderMA();
    loadKline(key, period);
    scheduleKlineRefresh();
  }

  function closeKline() {
    clearTimeout(klineTimer);
    $('#klineModal').hidden = true;
    document.body.classList.remove('kline-open');
    saveUI();
  }

  // ---------- 宏观视图（2.36.0） ----------
  // 列表读 index.json（最新值/环比/所属期），点开才读 <key>.json（历史序列）——
  // 与「行情卡 → K 线」同一套分层，避免首屏把 780 KB 的 5 条序列全拉下来。
  let macroIndex = null;
  let macroKey = '';
  let macroRange = '5y';
  let mmChart = null;
  let macroReqId = 0;

  function macroCard(item) {
    const MD = window.MacroData;
    const card = el('button', 'macro-card' + (item.latest ? '' : ' is-empty'));
    card.type = 'button';
    card.dataset.key = item.key;
    if (!item.latest) {
      card.disabled = true;
      card.setAttribute('aria-disabled', 'true');
    }
    const hd = el('div', 'mc-hd');
    hd.appendChild(el('span', 'mc-name', item.name));
    hd.appendChild(el('span', 'mc-freq ' + (item.freq === 'D' ? 'day' : 'month'),
      item.freq === 'D' ? '日' : '月'));
    card.appendChild(hd);
    card.appendChild(el('div', 'mc-value',
      item.latest ? MD.fmtValue(item.latest.v, item) : '暂无数据'));
    const chg = MD.fmtChange(item);
    if (chg) card.appendChild(el('div', 'mc-chg ' + chg.dir, chg.text));
    const ft = el('div', 'mc-ft');
    ft.appendChild(el('span', 'mc-period',
      item.latest ? `所属期 ${MD.fmtPeriod(item.latest.t, item.freq)}` : ''));
    ft.appendChild(el('span', 'mc-more', item.latest ? '图表 ›' : ''));
    card.appendChild(ft);
    card.appendChild(el('div', 'mc-src', item.source || ''));
    return card;
  }

  async function renderMacroList(force) {
    const box = $('#macroList');
    if (!box || !window.MacroData) {
      if (box) box.innerHTML = '<div class="empty">宏观数据模块未加载。</div>';
      return;
    }
    try {
      const doc = await window.MacroData.loadIndex(force);
      macroIndex = doc;
      const items = Array.isArray(doc.items) ? doc.items : [];
      box.innerHTML = '';
      if (!items.length) {
        box.innerHTML = '<div class="empty">宏观数据尚未生成。</div>';
        return;
      }
      const grid = el('div', 'macro-grid');
      items.forEach((it) => grid.appendChild(macroCard(it)));
      box.appendChild(grid);
      const t = $('#macroTime');
      if (t) t.textContent = doc.generatedAt ? `数据更新于 ${fmtTime(doc.generatedAt)}` : '';
    } catch (e) {
      box.innerHTML = '<div class="empty">宏观数据载入失败：请稍后刷新重试。</div>';
    }
  }

  /** 历史跨度不足 5 年时默认「全部」，否则 5 年 */
  function macroDefaultRange(bars) {
    const MD = window.MacroData;
    if (!bars || bars.length < 2) return 'all';
    const years = (MD.tMs(bars[bars.length - 1].t) - MD.tMs(bars[0].t)) / 31557600000;
    return years >= 5 ? '5y' : 'all';
  }

  function renderMacroRanges(bars, item, cur) {
    const MD = window.MacroData;
    const box = $('#mmRanges');
    if (!box) return;
    box.innerHTML = '';
    MD.RANGES.forEach((r) => {
      const usable = bars && bars.length > 1 && MD.rangeUsable(bars, r.id);
      const b = el('button', 'pchip' + (r.id === cur ? ' on' : ''), r.label);
      b.type = 'button';
      b.dataset.range = r.id;
      if (!usable) b.disabled = true;
      b.onclick = () => {
        if (!usable) return;
        macroRange = r.id;
        renderMacroRanges(bars, item, r.id);
        drawMacro(bars, item, r.id);
        saveUI();
      };
      box.appendChild(b);
    });
  }

  function drawMacro(bars, item, range) {
    const MD = window.MacroData;
    if (!mmChart) return;
    const slice = MD.sliceRange(bars, range);
    if (slice.length < 2) {
      mmChart.setEmptyText('该区间数据不足');
      mmChart.setData({ bars: [], mode: 'line' });
      return;
    }
    mmChart.setEmptyText('暂无数据');
    mmChart.setData({
      bars: slice,
      mode: item.key === 'social_financing' ? 'bar' : 'line',
      unit: item.unit,
      decimals: item.decimals,
      freq: item.freq,
      name: item.name,
    });
    const note = $('#mmNote');
    if (note) {
      const span = range === 'all'
        ? `全部 ${slice.length} 个点`
        : `${MD.RANGES.find((r) => r.id === range).label}内 ${slice.length} 个点`;
      note.textContent = `${item.source || ''} · ${MD.noteOf(item)} · ${span}`;
    }
  }

  async function loadMacroSeries(key, range) {
    const MD = window.MacroData;
    const myId = ++macroReqId;
    const idxItem = (macroIndex && macroIndex.items || []).find((x) => x.key === key) || null;
    const note = $('#mmNote');
    if (note) note.textContent = '';
    if (mmChart) {
      mmChart.setEmptyText('加载中…');
      mmChart.setData({ bars: [], mode: key === 'social_financing' ? 'bar' : 'line' });
    }
    try {
      const doc = await MD.loadSeries(key);
      if (myId !== macroReqId) return;
      const item = {
        ...(idxItem || {}),
        key,
        name: (idxItem && idxItem.name) || doc.name || key,
        unit: doc.unit || (idxItem && idxItem.unit) || '',
        decimals: Number.isFinite(doc.decimals) ? doc.decimals : (idxItem && idxItem.decimals) || 2,
        freq: doc.freq || (idxItem && idxItem.freq) || 'D',
        source: doc.source || (idxItem && idxItem.source) || '',
      };
      const bars = Array.isArray(doc.bars) ? doc.bars : [];
      $('#mmName').textContent = item.name;
      const last = bars[bars.length - 1];
      $('#mmValue').textContent = last ? MD.fmtValue(last.v, item) : '';
      $('#mmAsOf').textContent = last ? `所属期 ${MD.fmtPeriod(last.t, item.freq)}` : '';
      if (bars.length < 2) {
        if (mmChart) {
          mmChart.setEmptyText('暂无数据');
          mmChart.setData({ bars: [] });
        }
        if (note) note.textContent = `${item.source || ''} · ${MD.noteOf(item)}`;
        return;
      }
      const use = (range && MD.rangeUsable(bars, range)) ? range : macroDefaultRange(bars);
      macroRange = use;
      renderMacroRanges(bars, item, use);
      drawMacro(bars, item, use);
    } catch (e) {
      if (myId !== macroReqId) return;
      if (mmChart) {
        mmChart.setEmptyText('暂无数据');
        mmChart.setData({ bars: [] });
      }
      if (note) note.textContent = '宏观数据由每日 16:30 采集生成，当前文件暂不可用。';
    }
  }

  function openMacro(key, range) {
    if (!window.MacroData || !window.MacroChart) return;
    const idxItem = (macroIndex && macroIndex.items || []).find((x) => x.key === key) || null;
    macroKey = key;
    $('#macroModal').hidden = false;
    document.body.classList.add('kline-open');
    $('#mmName').textContent = idxItem ? idxItem.name : key;
    $('#mmValue').textContent = idxItem && idxItem.latest
      ? window.MacroData.fmtValue(idxItem.latest.v, idxItem) : '';
    $('#mmAsOf').textContent = idxItem && idxItem.latest
      ? `所属期 ${window.MacroData.fmtPeriod(idxItem.latest.t, idxItem.freq)}` : '';
    $('#mmNote').textContent = '';
    $('#mmRanges').innerHTML = '';
    const box = $('#mmCanvas');
    // 与 K 线换标的一致：换指标先复位视图，避免把上一个指标的缩放/回看带过来
    if (!mmChart) mmChart = new window.MacroChart(box);
    else mmChart.reset();
    loadMacroSeries(key, range || macroRange);
    saveUI();
  }

  function closeMacro() {
    $('#macroModal').hidden = true;
    document.body.classList.remove('kline-open');
    saveUI();
  }

  function bindMacro() {
    $('#mmClose').onclick = closeMacro;
    $('#macroList').addEventListener('click', (e) => {
      const card = e.target.closest('.macro-card');
      if (card && card.dataset.key) openMacro(card.dataset.key);
    });
    document.addEventListener('keydown', (e) => {
      if ($('#macroModal').hidden) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.key === 'Escape') { closeMacro(); return; }
      // 2.36.2：键盘平移/缩放与 K 线同一套按键与幅度
      if (!mmChart) return;
      if (e.key === 'ArrowLeft') { mmChart.panBy(15); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { mmChart.panBy(-15); e.preventDefault(); }
      else if (e.key === '+' || e.key === '=') {
        mmChart.zoomBy(1 / 1.2, mmChart.offset === 0 ? 1 : 0.5);
        e.preventDefault();
      } else if (e.key === '-' || e.key === '_') {
        mmChart.zoomBy(1.2, mmChart.offset === 0 ? 1 : 0.5);
        e.preventDefault();
      }
    });
  }


  // ---- K线取数根数（按周期给到「源侧真实上限」，而不是一刀切 1000）----
  //   日K/周K/月K/年K → **20000**：东财 `lmt` **没有上限**，给多少给多少；新浪 `datalen` 同理。
  //   分钟级 → 2000：
  //     · 东财 5m 实测 1536 根、1m 只有当天 240 根；15/30/60m 也在千根量级
  //     · 新浪分钟固定 **1023 根**，但**指数和场内 ETF 都有**（东财对 ETF 只给最近一天）
  //     · 腾讯分钟 320 根
  //   ⇒ 给 2000，让每个源回到自己的上限，最后由 app.js 的 apply 取「最新且根数最多」的那条。
  const klineLimit = (period) =>
    (period === '1d' || period === '1w' || period === '1M' || period === '1y') ? 20000 : 2000;

  /** K线头部标记：来源 / 数据时间 / 相对陈旧度 / 三态；桌面长文、窄屏短文由 CSS 切换 */
  function renderKlineMeta(bars, src, period, key) {
    const box = $('#kmMeta');
    if (!box) return;
    const QS = window.MacroQuoteStatus;
    if (!QS || !QS.klineMarker) {
      box.textContent = src || '';
      return;
    }
    // 2.9.0：把市场与假日表传进去，让「当日未收盘的 bar」能标成盘中值
    const q = (S.quotes || []).find((x) => x.key === key);
    const m = QS.klineMarker({
      src, bars, period, now: Date.now(),
      market: q ? (q.calendarMarket || q.market) : '',
      calendar: MARKET_CAL,
      // 本地日K 的生成时刻：用于判断「收盘后但文件仍是收盘前生成的」
      dataAt: bars && bars.__generatedAt,
    });
    box.className = 'km-meta ' +
      (m.state === 'realtime' ? 'state-ok'
        : (m.state === 'local' || m.state === 'closed') ? 'state-local' : 'state-warn');
    box.innerHTML =
      `<span class="km-meta-full">${esc(m.full)}</span>` +
      `<span class="km-meta-short">${esc(m.short)}</span>`;
  }

  // 3.1.1：末根状态 + 两个涨跌幅并列展示。
  // 为什么必须并列：缩略的「今日涨跌」= 实时价 vs 上一交易日收盘；
  // K 线图上的「末两根」= 最近两根**已发布**日 K 的收盘之差。两者的基准日不同，
  // 5 个人民币交叉盘（新浪只发布已收盘的 bar）还会整整差一个交易日，不能互相加减。
  const CNY_CROSS_KEYS = ['eurcny', 'gbpcny', 'jpycny', 'krwcny', 'audcny'];
  const bjHm = (v) => {
    const t = typeof v === 'number' ? v : Date.parse(v || '');
    if (!Number.isFinite(t)) return '';
    const d = new Date(t + 8 * 3600 * 1000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  };
  function clearKlineLast() {
    const box = $('#kmLast');
    if (!box) return;
    box.hidden = true;
    box.innerHTML = '';
  }
  function renderKlineLast(bars, period, key, src, fetchedAt) {
    const box = $('#kmLast');
    if (!box) return;
    if (period !== '1d' || !bars || bars.length < 2) return clearKlineLast();
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const tLast = String(last.t || '').slice(0, 10);
    const tPrev = String(prev.t || '').slice(0, 10);
    const cLast = Number(last.c);
    const cPrev = Number(prev.c);
    const dec = decOf(key);
    const q = (S.quotes || []).find((x) => x.key === key);
    const QS = window.MacroQuoteStatus;
    const mk = QS && QS.klineMarker ? QS.klineMarker({
      src, bars, period, now: Date.now(),
      market: q ? (q.calendarMarket || q.market) : '',
      calendar: MARKET_CAL,
      dataAt: bars.__generatedAt,
    }) : null;
    const live = !!(mk && mk.partial);          // 在途·未定稿
    const closed = !!(mk && mk.closed);         // 已定稿的收盘根
    // 「这一根的取数时点」：本地文件 = 文件写入时刻；直连 = 本轮取数时刻
    const snapAt = bars.__generatedAt ? bjHm(bars.__generatedAt) : bjHm(fetchedAt || Date.now());
    const written = bars.__generatedAt ? bjHm(bars.__generatedAt) : '';
    let state;
    if (live) {
      state = `末根 ${tLast} · 在途·未定稿（快照 ${snapAt}，不是收盘价）`;
    } else if (closed) {
      state = `末根 ${tLast} · 收盘（日线）${written ? '· 数据写入 ' + written : ''}`;
    } else if (CNY_CROSS_KEYS.includes(key)) {
      state = `末根 ${tLast} = 上一交易日收盘（新浪只发布已收盘的日 K，当日那根要等次日 06:00 切日后才出现）`;
    } else {
      state = `末根 ${tLast} · 收盘${written ? '（快照 ' + written + '）' : ''}，源端尚无更新的 bar`;
    }

    const rows = [];
    const pctCell = (pct) => {
      const txt = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      return `<span class="kl-v ${pct >= 0 ? 'up' : 'down'}">${txt}</span>`;
    };
    // ① 今日涨跌 = 行情缩略口径：实时价 vs 上一交易日收盘
    if (q && Number.isFinite(q.price) && Number.isFinite(q.prevClose) && q.prevClose > 0) {
      const pct = (q.price / q.prevClose - 1) * 100;
      const at = q.updatedAt ? bjHm(q.updatedAt) : snapAt;
      rows.push(
        '<div class="kl-row"><span class="kl-k">今日涨跌</span>' + pctCell(pct) +
        `<span class="kl-b">实时 ${fmtNum(q.price, dec)} vs 上一交易日收盘 ${fmtNum(q.prevClose, dec)}` +
        `${at ? '（行情 ' + at + '）' : ''} · 与右侧缩略同口径</span></div>`
      );
    }
    // ② 末两根日 K = 最近两根已发布日 K 的收盘之差
    if (Number.isFinite(cLast) && Number.isFinite(cPrev) && cPrev > 0) {
      const pct = (cLast / cPrev - 1) * 100;
      rows.push(
        '<div class="kl-row"><span class="kl-k">末两根日K</span>' + pctCell(pct) +
        `<span class="kl-b">${tPrev} 收盘 ${fmtNum(cPrev, dec)} → ${tLast} 收盘 ${fmtNum(cLast, dec)}` +
        `${live ? '（末根在途，下一轮刷新后会变）' : ''}</span></div>`
      );
    }
    box.innerHTML =
      `<div class="kl-state${live ? ' is-live' : ''}">${esc(state)}</div>` + rows.join('');
    box.hidden = false;
  }

  // 分钟K 的实际覆盖起点：同一周期，不同标的的源端历史上限差很多
  // （dxy 60m 只有 120 根≈5 天，eurcny 60m 有 1102 根≈64 天）。
  // 只做提示、不做拦截，也不标警告色 —— 覆盖短是正常的源端上限，不是数据丢失。
  // 放在图下方说明区：320px 下不挤占标题、周期条与价格轴。
  function renderKlineCoverage(bars, period) {
    const box = $('#kmCoverage');
    if (!box) return;
    const isMinute = (window.MarketData.MINUTE_PERIODS || []).includes(period);
    if (!isMinute || !bars || !bars.length) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    const first = String(bars[0] && bars[0].t || '').slice(0, 16);
    if (!first) {
      box.hidden = true;
      box.textContent = '';
      return;
    }
    const n = bars.length;
    // 根数很少时点明根数，避免「覆盖短」被误读成数据丢了
    const countText = n < 200 ? `仅 ${n} 根` : `共 ${n} 根`;
    box.textContent = `覆盖自 ${first.slice(5)} · ${countText}`;
    box.hidden = false;
  }

  async function loadKline(key, period) {
    const myId = ++klineReqId;          // 请求令牌：过期响应一律丢弃
    const reqAt = Date.now();           // 本轮取数时刻（直连数据的「快照时间」）
    klineKey = key;
    klinePeriod = period;
    saveUI();                            // 刷新前记住当前标的与周期
    // 年K 是「月K 聚合」出来的派生周期：取数一律取月K，落图前再聚合
    const isYear = period === '1y';
    const fetchPeriod = isYear ? '1M' : period;
    // 年K 的均线单位是「年」：只保留 5/10/20/30，且数据没到之前全部置灰
    document.querySelectorAll('.pchip').forEach((b) => b.classList.toggle('on', b.dataset.period === period));
    // 切换周期后把当前 chip 滚进可视区（320px 下周期条是横向滚动的）
    requestAnimationFrame(revealPeriodChip);

    const note = $('#kmNote');
    const meta = $('#kmMeta');
    const cov = $('#kmCoverage');
    note.textContent = '';
    if (cov) { cov.hidden = true; cov.textContent = ''; }
    clearKlineLast();                    // 换标的/换周期 ⇒ 末根说明立即作废，避免张冠李戴
    if (meta) meta.textContent = '加载中…';
    // 画布与顶部必须同步：取数期间画布也写「加载中…」，不能先写「暂无数据」
    if (kChart.setEmptyText) kChart.setEmptyText('加载中…');
    kChart.setData([], period);          // ← 立刻清空画布，绝不留上一个标的的图
    maBars = 0;
    renderMA();

    // 落图入口。三个约束：
    //   ① 令牌过期 → 丢弃（修「A 的响应后到，盖在 B 的标题下」）；
    //   ② **根数变少的结果不覆盖已有的** —— 否则后到的 1000 根会把先到的 8000 根降级；
    //   ③ 根数相同时**直连优先于本地** —— 直连是刚抓的，本地是采集器的每日快照。
    let shown = 0;
    let shownRank = -1;                   // 0 = 本地，1 = 直连
    let shownLast = '';                   // 已落图的最后一根时间（分钟级按新鲜度比就靠它）
    const isMinute = () =>
      (window.MarketData.MINUTE_PERIODS || []).includes(period);
    const apply = (bars, src, rank) => {
      if (myId !== klineReqId) return false;
      if (!bars || !bars.length) return false;
      // ⚠ 分钟级的时间戳格式不统一：新浪是 `YYYY-MM-DD HH:MM:SS`，东财/腾讯是 `YYYY-MM-DD HH:MM`。
      //   直接字符串比较会出现「15:00:00 比 15:00 大」→ 先到的新浪数据反而挡住后到的东财。
      //   统一截到分钟再比。
      const last = isMinute()
        ? String(bars[bars.length - 1].t || '').slice(0, 16)
        : String(bars[bars.length - 1].t || '');
      if (isMinute()) {
        // ---- 分钟级：先比「最后一根时间」，再比根数 ----
        //   直连（东财）可能只有今天的几十根，本地快照有几百根但停在**上一次刷新**
        //   ⇒ 不能只按根数比，否则本地会把今天的实时数据盖掉。
        //   但多个直连源之间（东财 1536 / 新浪 1023 / 腾讯 320）最后一根时间通常一样，
        //   旧规则「同时间只看优先级」会让先到的腾讯 320 根赢掉新浪 1023 根 ⇒ 现在同时间比根数。
        if (shown && last < shownLast) return false;
        if (shown && last === shownLast) {
          if (bars.length < shown) return false;
          if (bars.length === shown && rank <= shownRank) return false;
        }
      } else {
        // ---- 日/周/月：按**根数**比（历史越长越好） ----
        if (bars.length < shown) return false;
        if (bars.length === shown && rank <= shownRank) return false;
      }
      shown = bars.length;
      shownRank = rank;
      shownLast = last;
      kChart.setData(bars, period);
      renderKlineCoverage(bars, period);
      // 2.4.12：首帧落图后恢复刷新前的缩放与视窗位置（只恢复一次）
      if (pendingKlineView && pendingKlineView.key === key && pendingKlineView.period === period) {
        const v = pendingKlineView;
        pendingKlineView = null;
        kChart.setView(v);
      }
      // 数据变长后，原本「根数不足」的均线会自动变为可用（按钮取消置灰、曲线开始绘制）
      maBars = bars.length;
      renderMA();
      // 口径说明（组合标的的代理品种）必须显示出来，不能让用户以为看到的就是报价源本身。
      // 来源/时间/根数/状态统一进 #kmMeta；图下只保留口径说明，避免两处口径冲突。
      const caliber = window.MarketData.getKlineNote ? window.MarketData.getKlineNote(key) : '';
      note.textContent = caliber || '';
      renderKlineMeta(bars, src, period, key);
      renderKlineLast(bars, period, key, src, reqAt);
      notifyUpgrade();
      return true;
    };

    // ---- 第 1 波：直连多源赛马（东财/新浪/腾讯 同时发）+ 本地快路径（走 Pages）----
    // 直连源走外网、本地文件走 GitHub Pages，两条路带宽互不争抢，谁先回先出图。
    // 本地那一路是**保险**：直连全挂时，它也能在 1~4 秒内给出一张图（近 4 年 / 1000 根）。
    // ⚠ 必须保留 promise：慢网下本地文件可能还在下载，直连先全部失败时不能据此判「无数据」。
    const localPromise = window.MarketData.localKline(key, period)
      .then((bars) => apply(
        bars,
        isYear
          ? '本地预生成（月K聚合）'
          : isMinute()
            ? '本地预生成（分钟快照·服务端每小时刷新）'
            : '本地预生成（近 4 年）',
        0
      ))
      .catch(() => false);

    await window.MarketData
      .fetchKlineRemote(key, fetchPeriod, klineLimit(fetchPeriod), (bars, src) => apply(
        isYear ? window.MarketData.aggregateYear(bars) : bars, src, 1
      ))
      .catch(() => false);
    if (myId !== klineReqId) return;      // 期间用户已经切到别的标的/周期了

    // 年K 兜底：月K 取不到（例如中债只有日频）就用日K 聚合
    if (isYear && shown === 0) {
      try {
        await window.MarketData.fetchKlineRemote(key, '1d', 20000, (bars, src) =>
          apply(window.MarketData.aggregateYear(bars), src, 1));
      } catch (e) { /* 日K 也没有 */ }
      if (myId !== klineReqId) return;
    }

    // ---- 第 2 波：直连没给够根数 ⇒ 拉服务端预生成的全量日K ----
    // 宽限 3 秒：给可能更慢但更全的源留窗口，避免在它还在路上时白耗 Pages 带宽。
    if (period === '1d' && shown < 2000) {
      await waitUpgrade(3000);
      if (myId !== klineReqId) return;
      if (shown < 2000) {
        try {
          const bars = await window.MarketData.localFullKline(key, period);
          apply(bars, '本地全量（服务端预生成）', 0);
        } catch (e) { /* 没有全量文件 */ }
      }
    }

    // 慢网下本地文件可能仍在下载：直连失败不能立刻判「无数据」，
    // 必须先等本地那一路落地（成功会走 apply 落图，失败才是真的两端都没有）。
    if (myId === klineReqId && shown === 0) {
      await localPromise;
      if (myId !== klineReqId) return;
    }

    if (myId === klineReqId && shown === 0) {
      const metaBox = $('#kmMeta');
      const covBox = $('#kmCoverage');
      if (covBox) { covBox.hidden = true; covBox.textContent = ''; }
      if (metaBox) metaBox.textContent = '无数据';
      if (kChart.setEmptyText) kChart.setEmptyText('暂无数据');
      // 分钟级若是「全网本来就没有同口径的分钟源」，要说清楚**为什么**，
      // 别让用户以为页面坏了（2026-10-30：伦敦金/布伦特原油属于这一类）。
      const minuteReason = isMinute() && window.MarketData.getMinuteUnavailableReason
        ? window.MarketData.getMinuteUnavailableReason(key)
        : '';
      if (minuteReason) {
        note.textContent = `无分钟级数据：${minuteReason}`;
      } else if (isMinute()) {
        // 有源、但直连被挡 + 本地快照还没生成（服务端每小时刷新，可能正在补齐）
        note.textContent =
          '加载失败：直连源此刻不可达，且本地分钟快照尚未生成（服务端每小时刷新，可能正在补齐）。';
      } else {
        // 文案必须与所请求的周期一致：用户点的就是周K/月K/年K，
        // 不能再写「本地仅有日/周/月」这种自相矛盾的话。
        const pLabel = period === '1w' ? '周K'
          : period === '1M' ? '月K'
            : period === '1y' ? '年K' : '日K';
        note.textContent = `加载失败：直连与本地${pLabel}均不可用，请稍后重试。`;
      }
    }
  }

  // 交易时段内自动刷新最新一根；只重设数据不重建图表，保留缩放位置
  function scheduleKlineRefresh() {
    clearTimeout(klineTimer);
    const q = (S.quotes || []).find((x) => x.key === klineKey);
    if (!q || !isTrading(q.market)) return;
    klineTimer = setTimeout(async () => {
      if ($('#klineModal').hidden) return;
      const myId = klineReqId;            // 期间是否换过标的/周期
      const isYear = klinePeriod === '1y';
      const fetchPeriod = isYear ? '1M' : klinePeriod;
      try {
        // ⚠ 用 onData 而不是等返回值：赛马链里**首个成功**只保证「有数据」，
        //   不保证是最全的（腾讯 1000 根可能先于新浪 8752 根到）。
        //   onData 让每个源到货都单独判断一次，谁根数多谁上。
        await window.MarketData.fetchKlineRemote(
          klineKey, fetchPeriod, klineLimit(fetchPeriod),
          (bars) => {
            if (myId !== klineReqId) return;   // 换过了，丢弃这次刷新
            const next = isYear ? window.MarketData.aggregateYear(bars) : bars;
            if (!next || !next.length) return;
            // ⚠ 只在「根数不减少」时覆盖：直连只给 1000 根时，不能把本地全量的 8752 根降级
            if (next.length >= kChart.bars.length) {
              kChart.setData(next, klinePeriod);
              renderKlineCoverage(next, klinePeriod);
              maBars = next.length;
              renderMA();
            }
          }
        );
      } catch (e) { /* 单次失败忽略，下一轮再试 */ }
      scheduleKlineRefresh();
    }, (CFG.REFRESH_SECONDS || 20) * 1000);
  }

  function bindKline() {
    $('#kmClose').onclick = closeKline;
    // 故意不绑定「点击阴影关闭」：拖动 K 线时鼠标很容易移到画布外松手，
    // 会被当作点击蒙层而误退出。关闭只保留右上角 × 与 Esc。
    document.addEventListener('keydown', (e) => {
      if ($('#klineModal').hidden) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return; // 别抢输入框的按键
      if (e.key === 'Escape') { closeKline(); return; }
      // ←/→ 平移（鼠标拖动之外的第二条通路）
      if (e.key === 'ArrowLeft') { kChart.panBy(15); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { kChart.panBy(-15); e.preventDefault(); }
      // Ctrl/⌘ + + / - 缩放（不带修饰键也可以）
      // ⚠ 看最新时不锚定中心：否则「缩小到全部 → 再放大」会把视图锚到历史中点，
      //   最后一根直接被推到屏幕外（实测 offset 变成 455）。看最新时锚在右边缘（1）。
      const zoomAnchor = kChart.offset === 0 ? 1 : 0.5;
      if (e.key === '+' || e.key === '=') { kChart.zoomBy(1 / 1.2, zoomAnchor); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { kChart.zoomBy(1.2, zoomAnchor); e.preventDefault(); }
    });
    // 指数卡片点击 → 打开K线（阻止 href="#" 默认跳回页首）
    $('#quotes').addEventListener('click', (e) => {
      const card = e.target.closest('.q');
      if (card && card.dataset.key) { e.preventDefault(); openKline(card.dataset.key); }
    });
  }

  // ---------- 启动 ----------
  function bindReader() {
    $('#rdClose').onclick = closeReader;
    $('#readerModal').onclick = (e) => { if (e.target.id === 'readerModal') closeReader(); };
    $('#rdPrev').onclick = () => stepReader(-1);
    $('#rdNext').onclick = () => stepReader(1);
    document.addEventListener('keydown', (e) => {
      if ($('#readerModal').hidden) return;
      if (e.key === 'Escape') closeReader();
      else if (e.key === 'ArrowLeft') stepReader(-1);
      else if (e.key === 'ArrowRight') stepReader(1);
    });
  }

  // 搜索框提示：手机上输入框只有 ~240px，长 placeholder 会被截断。
  // HTML 默认用短版（窄屏首帧就不会截断），桌面再换成完整提示。
  const Q_PLACEHOLDER_FULL = '全文检索：标题 / 摘要 / 来源（如：降息、CPI、黄金、原油）';
  const Q_PLACEHOLDER_SHORT = '搜索：降息、CPI、黄金…';
  const MQ_PLACEHOLDER_FULL = '搜标的：名称 / 代码 / 英文缩写（如：恒生、黄金、spx、563360）';
  const MQ_PLACEHOLDER_SHORT = '搜标的：恒生、黄金、563360…';
  const syncSearchPlaceholder = () => {
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    const q = $('#q');
    if (q) q.placeholder = narrow ? Q_PLACEHOLDER_SHORT : Q_PLACEHOLDER_FULL;
    const mq = $('#mq');
    if (mq) mq.placeholder = narrow ? MQ_PLACEHOLDER_SHORT : MQ_PLACEHOLDER_FULL;
  };

  // 刷新恢复：先恢复要闻流视口/阅读器，再等行情就绪后恢复 K 线弹窗。
  async function restoreFeedUI() {
    if (!uiState || S.view !== 'feed') return;
    const wantShown = Math.max(PAGE, Number(uiState.shown) || PAGE);
    // 2.4.12：刷新前停在归档页某一天 → 先按原样重开该天，不跳回最新要闻流。
    const savedDay = uiState.day;
    if (savedDay && savedDay.day) {
      await openDay(savedDay.day, savedDay.kind || 'live');
      if (wantShown > S.shown) {
        S.shown = wantShown;
        renderFeed();
      }
    } else {
      const filterChanged = uiState.filter && uiState.filter !== S.filter;
      if (filterChanged || wantShown > S.shown) {
        if (filterChanged) S.filter = uiState.filter;
        S.shown = Math.max(S.shown, wantShown);
        renderFilters();
        renderFeed();
      }
    }
    if (Number.isFinite(uiState.y) && !feedPainted) {
      const apply = () => {
        if (alignState) alignState.userMoved = true;  // 别让 ResizeObserver 把视口拽回区块顶部
        window.scrollTo({ top: uiState.y, behavior: 'auto' });
      };
      requestAnimationFrame(apply);
      setTimeout(apply, 250);   // 行情卡/列表异步长高后再对齐一次
    }
    // 阅读器：正常情况下在 paintFeedFromCache 里已经随首帧打开了；
    // 这里只是兜底（没有快照 / 打开的是归档某天）。
    restoreReaderUI();
  }

  function restoreKlineUI() {
    if (!uiState || !uiState.kline || S.view !== 'market') return;
    if (!$('#klineModal').hidden) return;
    pendingKlineView = uiState.kline;   // 2.4.12：连同 barsShown/offset 一起恢复
    openKline(uiState.kline.key, uiState.kline.period || (CFG.DEFAULT_PERIOD || '1d'));
  }

  function restoreMacroUI() {
    if (!uiState || !uiState.macro || S.view !== 'macro') return;
    if (!$('#macroModal').hidden) return;
    openMacro(uiState.macro.key, uiState.macro.range || '5y');
  }

  async function boot() {
    // file:// 下浏览器会拦截 fetch()，页面必然空白。
    // 与其让用户对着白屏发呆，不如直接说明原因和解决办法。
    if (location.protocol === 'file:') {
      document.body.innerHTML = `
        <div style="max-width:640px;margin:12vh auto;padding:2rem;font-family:system-ui,sans-serif;line-height:1.8">
          <h1 style="font-size:1.4rem;margin:0 0 1rem">需要通过本地服务器打开</h1>
          <p style="color:#555">本站通过 <code>fetch()</code> 读取 <code>data/</code> 目录下的数据文件，
          而浏览器在 <code>file://</code> 协议下会拦截 fetch（跨源安全限制），
          因此直接双击 <code>index.html</code> 必然是空白页 —— 这不是站点坏了。</p>
          <p style="color:#555">在项目根目录双击运行：</p>
          <pre style="background:#f5f3ec;padding:1rem;border-radius:6px;overflow-x:auto">start.cmd</pre>
          <p style="color:#555">或在命令行执行：</p>
          <pre style="background:#f5f3ec;padding:1rem;border-radius:6px;overflow-x:auto">node scripts\\serve.mjs</pre>
          <p style="color:#555">然后访问 <a href="http://127.0.0.1:8848/">http://127.0.0.1:8848/</a></p>
        </div>`;
      return;
    }

    bindKline();
    bindMacro();
    bindReader();

    // 常驻的视口对齐观察器（必须在第一次 showView 之前装好）
    initAlign();
    document.querySelectorAll('.tab, .mnav-item').forEach((t) => {
      t.onclick = (e) => {
        // 阻止浏览器默认的锚点跳转：滚动位置由 showView() 统一控制
        // （要滚到该视图的区块顶部，而不是浏览器默认的锚点位置）。
        // hash 仍然用 replaceState 同步（URL 变了 → 有即时反馈、可收藏/分享）。
        e.preventDefault();
        showView(t.dataset.view);
      };
    });
    // 手动改 hash / 前进后退时也要跟着切视图
    window.addEventListener('hashchange', () => {
      // 3.4.0：旧的 #periodic-week / #periodic-month / #periodic-year 锚点
      //   （此前由三类入口按钮写入）不再当作路由：展开面板滚到分组，再把归档层级写回 URL，
      //   否则刷新会掉回默认月（审计 P2-8）。
      const anch = String(location.hash || '').match(/^#periodic-(week|month|year)$/);
      if (anch) {
        if (S.view === 'archive') {
          focusPeriodicGroup(anch[1]);
          if (archRoute) history.replaceState(null, '', AT.archiveHash(archRoute));
        }
        return;
      }
      const v = viewFromHash();
      if (!v) return;
      if (v !== S.view) { showView(v); return; }
      // 已在归档页：只切层级，不重建阅读器；同一层不重复渲染。
      if (v === 'archive') {
        const r = AT.parseArchiveHash(location.hash);
        // 旧链接 #view-archive / 裸 #archive 视为「默认月」，同时把 URL 规范成 #archive/YYYY/MM
        if (!r || r.level === 'default') { renderArchive(null); return; }
        // nav: true ⇒ 新层没有历史滚动位置时落到「新层层头」，不是归档视图顶部
        if (AT.routeKey(r) !== archKey(archRoute)) renderArchive(r, { nav: true });
      }
    });
    // 带着 #view-xxx 打开时直接进对应视图（instant：首帧不要看到平滑滚动）
    // 没有 hash 时退回刷新前保存的视图；hash 优先，避免分享链接被本地状态覆盖。
    const initialView = viewFromHash() || (uiState && uiState.view) || null;
    if (initialView) showView(initialView, true);
    $('#moreBtn').onclick = () => { S.shown += PAGE; renderFeed(); };
    $('#q').addEventListener('input', (e) => onSearchInput(e.target.value));
    $('#qClear').onclick = () => { $('#q').value = ''; onSearchInput(''); };
    // 2.22.0：全部历史检索（显式触发；默认不拉任何分片）
    // 2.22.1：默认只扫最近 3 个月，更早的走「继续扫描更早 N 个月」；下拉选「全部月份」仍扫全量
    $('#qHistBtn').onclick = () => runHistorySearch($('#qHistMonth').value || HIST_RECENT);
    $('#qHistMonth').onchange = () => { if (S.q) runHistorySearch($('#qHistMonth').value || HIST_RECENT); };
    $('#qHistMore').onclick = () => {
      const months = HIST.more.slice();
      if (!months.length) return;
      HIST.more = [];
      $('#qHistMore').hidden = true;
      scanHistMonths(months, ++HIST.token);
    };
    // 检索索引改为「用户碰搜索框才预取」：首屏不再后台拉 2.7MB，避免和归档/某天详情抢带宽。
    // 输入本身也会触发（runSearch 里 await ensureSearchIndex），这里只是给打字留出提前量。
    $('#q').addEventListener('focus', () => { ensureSearchIndex().catch(() => {}); });
    // 行情搜索：无需防抖（57 张卡片），输入即筛
    $('#mq').addEventListener('input', (e) => {
      mktQ = e.target.value;
      $('#mqClear').hidden = !mktQ;
      applyQuoteFilter();
    });
    $('#mqClear').onclick = () => {
      $('#mq').value = '';
      mktQ = '';
      $('#mqClear').hidden = true;
      applyQuoteFilter();
    };
    // 归档页日期跳转：落到归档「日」层（保留层级与 URL），再由日层的出口进要闻流。
    //   此前直接 openDay ⇒ 用户本来在按日期导航，却被打发到要闻流并丢掉归档页（审计 P1-5）。
    const histForm = $('#histForm');
    if (histForm) {
      histForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const dateEl = $('#histDate') || {};
        const day = dateEl.value || '';
        const hint = $('#histHint');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          if (hint) hint.textContent = '请选择日期';
          return;
        }
        // 表单已加 novalidate：min/max 只做控件约束，不能让它静默拦下提交。
        // 越界日期必须给出明确的行内提示，否则用户点了「打开」毫无反馈。
        const min = String(dateEl.min || '').slice(0, 10);
        const max = String(dateEl.max || '').slice(0, 10);
        if ((min && day < min) || (max && day > max)) {
          if (hint) hint.textContent = `该日期不在归档范围（${min || '?'} ~ ${max || '?'}）`;
          return;
        }
        const hit = dayIndex.get(day);
        if (!hit) {
          if (hint) hint.textContent = '该日没有归档（仅保留近一年）';
          return;
        }
        if (hint) hint.textContent = '';
        navigateArchive(dayRoute(hit.day));
      });
    }
    // 3.4.0：周期报告整块是折叠入口，展开/收起要记住（刷新与切层后不回弹）
    const pnl = $('#periodicPanel');
    if (pnl) {
      pnl.addEventListener('toggle', () => {
        syncPeriodicCaret();
        saveUI();
      });
    }
    syncSearchPlaceholder();
    window.addEventListener('resize', syncSearchPlaceholder);
    window.addEventListener('resize', syncStickyOffset);

    // 行情加载完再刷一次页脚：健康摘要里的「行情」时点来自 quotes.json 各卡片的源时间，
    // 而 renderQuotes 与下面的 latest.json 是两个并发链，先到先得的顺序不固定。
    // 2.7.2：要闻流不依赖假日表，放在这里先画 —— 列表与滚动位置在首帧就到位，
    //   后面 await 出来的时间差不会再变成「骨架 → 列表弹出 → 跳回原位」。
    paintFeedFromCache();
    // 2.4.1：先加载假日表（本地小文件），首屏就能正确区分“已收盘/休市”。
    await ensureCalendar();
    // 2.7.1：刷新恢复分两步，都在取新数据之前完成——
    //   ① 行情网格用 sessionStorage 里的快照同步画回来（首帧就是离开时的样子）；
    //   ② K 线弹窗立刻打开（名称/现价取快照），不再挂在 renderQuotes 之后等 0.5~2s。
    //   新数据回来时由 patchQuotes 只改数值/状态文案，结构一点不动。
    paintQuotesFromCache();
    restoreKlineUI();
    restoreMacroUI();
    renderQuotes().then(startQuotePolling).catch(() => {}).then(() => renderFoot());
    try {
      const d = await jget('latest.json');
      S.base = d.items;
      S.items = d.items;
      S.total = d.total || (d.items || []).length;
      // 走一遍空搜索分支：首次加载就把「母集」说明写进 #qMeta
      // （空搜索 = 最新快照 200 条，带关键词 = 全库 17092 条），同时渲染筛选条与列表
      // 2.7.2：刷新时列表已经在首帧画好了 —— 新快照和它一致就一个节点都不动，
      //   只在顶部多出条目时补插；结构对不上（换了筛选 / 条目被删改）才整块重建。
      if (!patchFeed()) runSearch('');
      // ⚠ 不在这里预取 search.json：改为用户 focus / 输入搜索框时再拉（见 boot 里的搜索框绑定）
      // 页脚先放快照信息（兜底），随后由 renderFoot() 换成完整的采集概况
      $('#ftMeta').textContent = `库内 ${d.total} 条 · 快照生成于 ${new Date(d.generatedAt).toLocaleString('zh-CN', { hour12: false })}`;
      renderFoot();
    } catch (e) {
      feedLoadOk = false;
      $('#feed').innerHTML = '<div class="empty">数据载入失败：最新要闻尚未生成或暂时不可用，请稍后刷新重试。</div>';
      renderFoot();
    }
    restoreFeedUI();
  }

  window.addEventListener('pagehide', saveUI);
  window.addEventListener('beforeunload', saveUI);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
