// src/sources.mjs
// 全球宏观资讯 · 数据源适配器
// 每个适配器返回统一 schema 的条目数组；单个源失败不影响整体采集。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const TIMEOUT_MS = 15000;

/** 带超时的请求；可选重试（GitHub 美国节点访问国内接口偶发超时） */
async function get(url, { json = false, headers = {}, timeout = TIMEOUT_MS, retries = 0 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*', ...headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---------- 工具 ----------

function stripTags(s = '') {
  return String(s)
    // 必须先取出 CDATA 内容：`<![CDATA[文字]]>` 会被下面的标签正则整段吞掉，
    // 导致国家统计局等使用 CDATA 的源标题变空、被静默丢弃。
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stableId(...parts) {
  const s = parts.join('|');
  let h1 = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
  }
  return h1.toString(36);
}

function isoFromUnix(sec) {
  return new Date((sec + 8 * 3600) * 1000).toISOString().replace('Z', '+08:00');
}

function isoFromDate(str) {
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// 正文/摘要统一截断，避免单条过长撑大 data 文件
const clip = (s, n) => {
  const t = String(s == null ? '' : s).trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
};

// 补全相对 URL。华尔街见闻的 uri 字段本身就是完整 URL，
// 之前无条件再拼一次域名，产生了 https://wallstreetcn.comhttps://... 的坏链接。
function absUrl(u, base) {
  if (!u) return base || '';
  if (/^https?:\/\//i.test(u)) return u;
  try { return new URL(u, base).href; } catch { return u; }
}

// "2026-10-05 00:18:50"（北京时间）→ 秒级时间戳
function tsFromCN(s) {
  const t = Date.parse(String(s).replace(' ', 'T') + '+08:00');
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

// 极简 RSS/Atom 解析：抽取 item/entry 块里的 title / link / date / description
function parseFeed(xml) {
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ];
  return blocks.map((b) => {
    const x = b[0];
    const pick = (tag) => {
      const m = x.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? stripTags(m[1]) : '';
    };
    let link = pick('link');
    if (!link) {
      const m = x.match(/<link[^>]*href="([^"]+)"/i);
      link = m ? m[1] : '';
    }
    return {
      title: pick('title'),
      link,
      date: pick('pubDate') || pick('updated') || pick('published') || pick('dc:date'),
      description: pick('description') || pick('summary') || pick('content'),
    };
  });
}

const pick = (obj, keys, fallback = '') => {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return fallback;
};

// ---------- 适配器 ----------

// 华尔街见闻 · 全球财经快讯（已实测 5 个频道全部可用）
const WALLSTREET_CHANNELS = [
  ['global-channel', '全球'],
  ['forex-channel', '外汇'],
  ['commodity-channel', '大宗'],
  ['us-stock-channel', '美股'],
  ['a-stock-channel', 'A股'],
];

async function wallstreetcn() {
  const out = [];
  for (const [ch, label] of WALLSTREET_CHANNELS) {
    const j = await get(
      `https://api-one.wallstcn.com/apiv1/content/lives?channel=${ch}&limit=50`,
      { json: true }
    );
    for (const it of j?.data?.items || []) {
      const text = stripTags(pick(it, ['content_text', 'content', 'body']));
      const rawTitle = stripTags(pick(it, ['title']));
      if (!rawTitle && !text) continue;
      const ts = Number(pick(it, ['display_time'], 0));
      const uri = pick(it, ['uri', 'url'], '');
      out.push({
        id: stableId('wscn', String(it.id ?? ts), rawTitle || text.slice(0, 30)),
        ts,
        time: ts ? isoFromUnix(ts) : new Date().toISOString(),
        source: '华尔街见闻',
        channel: label,
        // 快讯多数无独立标题：用正文首段当标题，正文完整存入 content
        title: rawTitle || text.slice(0, 40),
        summary: rawTitle ? clip(text, 140) : '',
        content: clip(text, 4000),
        url: absUrl(uri, 'https://wallstreetcn.com/livenews/global'),
        kind: 'news',
      });
    }
  }
  return out;
}

// 东方财富 · 财经新闻（国内）
async function eastmoneyNews() {
  const j = await get(
    'https://np-listapi.eastmoney.com/comm/web/getNewsByColumns' +
      '?client=web&biz=web_news_col&column=350&order=1&needInteractData=0' +
      '&page_index=1&page_size=50&req_trace=1',
    { json: true, headers: { Referer: 'https://finance.eastmoney.com/' } }
  );
  return (j?.data?.list || [])
    .map((it) => {
      const ts = tsFromCN(it.showTime);
      return {
        id: stableId('emnews', String(it.code), it.title),
        ts,
        time: ts ? isoFromUnix(ts) : new Date().toISOString(),
        source: '东方财富',
        channel: '国内财经',
        title: stripTags(it.title),
        summary: clip(stripTags(it.summary), 140),
        content: clip(stripTags(it.summary), 4000),
        url: absUrl(it.url || it.uniqueUrl, 'https://finance.eastmoney.com/'),
        kind: 'news',
      };
    })
    .filter((x) => x.title && x.url);
}

// 新浪财经 · 财经滚动（国内）
async function sinaFinance() {
  const j = await get(
    'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&k=&num=50&page=1',
    { json: true, headers: { Referer: 'https://finance.sina.com.cn/' } }
  );
  return (j?.result?.data || [])
    .map((it) => {
      const ts = Number(it.ctime) || 0;
      return {
        id: stableId('sina', String(it.docid || it.url || it.title)),
        ts,
        time: ts ? isoFromUnix(ts) : new Date().toISOString(),
        source: '新浪财经',
        channel: '国内财经',
        title: stripTags(it.title),
        summary: clip(stripTags(it.intro), 140),
        content: clip(stripTags(it.intro), 4000),
        url: absUrl(it.url, 'https://finance.sina.com.cn/'),
        kind: 'news',
      };
    })
    .filter((x) => x.title && x.url);
}

// 中国人民银行 · 新闻发布（该站无 RSS，解析列表页 HTML）
async function pbcNews() {
  const html = await get(
    'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html',
    { headers: { Referer: 'https://www.pbc.gov.cn/' }, timeout: 25000, retries: 1 }
  );
  const re =
    /<a\s+href="(\/goutongjiaoliu\/113456\/113469\/\d+\/index\.html)"([^>]*)>([\s\S]*?)<\/a>([\s\S]{0,240}?)<span class="hui12">(\d{4}-\d{2}-\d{2})<\/span>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const attr = m[2].match(/title="([^"]*)"/);
    const title = stripTags(attr ? attr[1] : m[3]);
    if (!title) continue;
    const ts = Math.floor(new Date(`${m[5]}T00:00:00+08:00`).getTime() / 1000);
    out.push({
      id: stableId('pbc', m[1]),
      ts,
      time: isoFromUnix(ts),
      source: '中国人民银行',
      channel: '政策/监管',
      title,
      summary: '',
      content: '',
      url: new URL(m[1], 'https://www.pbc.gov.cn').href,
      kind: 'official',
      tags: ['央行', '政策'],
    });
  }
  return out.slice(0, 30);
}

function rssSource({ name, channel, url, limit = 30, tag = '', timeout = 15000, retries = 0 }) {
  return async () => {
    const xml = await get(url, { timeout, retries });
    return parseFeed(xml)
      .filter((i) => i.title)
      .slice(0, limit)
      .map((i) => {
        const d = new Date(i.date);
        const ts = Number.isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
        return {
          id: stableId('rss', name, i.link || i.title),
          ts,
          time: i.date ? isoFromDate(i.date) : new Date().toISOString(),
          source: name,
          channel,
          title: i.title,
          summary: clip(stripTags(i.description), 140),
          content: clip(stripTags(i.description), 4000),
          url: i.link || url,
          kind: 'official',
          tags: tag ? [tag] : [],
        };
      });
  };
}

// ---------- 宏观仪表盘行情（东方财富 push2，全部经本机实测） ----------
// market 用于判断是否处于交易时段（决定前端是否需要高频刷新）
// kline 列为该指数的日 K 代码；null 表示当前可用数据源取不到（见 README）
export const INDICES = [
  // A股
  { key: 'sh_comp',   name: '上证指数',   market: 'CN', secid: '1.000001', sina: 'sh000001' },
  { key: 'sz_comp',   name: '深证成指',   market: 'CN', secid: '0.399001', sina: 'sz399001' },
  { key: 'chinext',   name: '创业板指',   market: 'CN', secid: '0.399006', sina: 'sz399006' },
  { key: 'star50',    name: '科创50',     market: 'CN', secid: '1.000688', sina: 'sh000688' },
  { key: 'bse50',     name: '北证50',     market: 'CN', secid: '0.899050', sina: null },
  { key: 'csi300',    name: '沪深300',    market: 'CN', secid: '1.000300', sina: 'sh000300' },
  { key: 'csi500',    name: '中证500',    market: 'CN', secid: '1.000905', sina: 'sh000905' },
  { key: 'csi1000',   name: '中证1000',   market: 'CN', secid: '1.000852', sina: 'sh000852' },
  // 港股
  { key: 'hsi',       name: '恒生指数',   market: 'HK', secid: '100.HSI',   sina: 'hkHSI' },
  { key: 'hs_tech',   name: '恒生科技',   market: 'HK', secid: '124.HSTECH', sina: null },
  // 美股
  { key: 'dji',       name: '道琼斯',     market: 'US', secid: '100.DJIA',  sina: 'usDJI' },
  { key: 'ixic',      name: '纳斯达克',   market: 'US', secid: '100.NDX',   sina: 'usIXIC' },
  { key: 'spx',       name: '标普500',    market: 'US', secid: '100.SPX',   sina: 'usINX' },
  // 其他
  { key: 'n225',      name: '日经225',    market: 'JP', secid: '100.N225',  sina: null },
  { key: 'dax',       name: '德国DAX',    market: 'EU', secid: '100.GDAXI', sina: null },
  { key: 'ukx',       name: '英国富时100', market: 'UK', secid: '100.FTSE',  sina: null },
  { key: 'kospi',     name: '韩国KOSPI',  market: 'KR', secid: '100.KS11',  sina: null },
];

// f43 最新 / f44 最高 / f45 最低 / f46 开盘 / f47 成交量 / f60 昨收 / f170 涨跌幅
const QUOTE_FIELDS = 'f43,f44,f45,f46,f47,f57,f58,f60,f170';

// 行情失败原因（由 fetchQuotes 写入，供采集器记录到 _last-run.json）
let quoteError = '';
export function getQuoteError() { return quoteError; }

export async function fetchQuotes() {
  // GitHub Actions 的美国节点访问国内行情接口明显更慢，
  // 原先 15 秒超时 + 无重试会导致 17 个指数全军覆没（quotes: 0）。
  // 这里放宽到 25 秒并各重试 1 次，并把失败原因回报给 _last-run.json，
  // 否则线上只能看到「0 条」而无从排查。
  const results = await Promise.allSettled(
    INDICES.map(async (q) => {
      const j = await get(
        `https://push2.eastmoney.com/api/qt/stock/get?fltt=2&invt=2&secid=${q.secid}&fields=${QUOTE_FIELDS}`,
        { json: true, timeout: 25000, retries: 1 }
      );
      const d = j?.data;
      if (!d?.f58) return null;
      const num = (v) => (v === undefined || v === null || v === '-' ? null : Number(v));
      return {
        key: q.key,
        name: d.f58 || q.name,
        market: q.market,
        price: num(d.f43),
        open: num(d.f46),
        high: num(d.f44),
        low: num(d.f45),
        prevClose: num(d.f60),
        volume: num(d.f47),
        changePct: num(d.f170),
        updatedAt: new Date().toISOString(),
      };
    })
  );
  const ok = results.filter((r) => r.status === 'fulfilled' && r.value);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    // 去重后只报 1-2 条原因，避免日志刷屏
    const reasons = [...new Set(failed.map((r) => String(r.reason?.message || r.reason)))].slice(0, 2);
    quoteError = `${failed.length}/${INDICES.length} 失败：${reasons.join('；')}`;
  } else {
    quoteError = '';
  }
  return ok.map((r) => r.value);
}


// K线代码（经本机逐个实测）
// sina: 新浪 CN_MarketData（国内指数，支持日/周/月/分钟）
// tx:  腾讯 fqkline（港股）/ usfqkline（美股，支持日/周/月）
// null = 当前可用源取不到历史数据，前端会显示「暂无数据」
const KLINE_MAP = {
  sh_comp: { sina: 'sh000001' },
  sz_comp: { sina: 'sz399001' },
  chinext: { sina: 'sz399006' },
  star50:  { sina: 'sh000688' },
  bse50:   { sina: 'bj899050' },
  csi300:  { sina: 'sh000300' },
  csi500:  { sina: 'sh000905' },
  csi1000: { sina: 'sh000852' },
  hsi:     { tx: 'hkHSI' },
  dji:     { tx: 'usDJI', us: true },
  ixic:    { tx: 'usIXIC', us: true },
  spx:     { tx: 'usINX', us: true },
  hs_tech: null,
  n225:    null,
  dax:     null,
  ukx:     null,
  kospi:   null,
};

// 周期 → 新浪 scale（分钟数）；周=1200 月=7200
const SINA_SCALE = { '1d': 240, '1w': 1200, '1M': 7200, '5m': 5, '30m': 30, '60m': 60 };
// 周期 → 腾讯 period
const TX_PERIOD = { '1d': 'day', '1w': 'week', '1M': 'month' };

export function klineAvailable(key) {
  return !!KLINE_MAP[key];
}

export const KLINE_PERIODS = ['1d', '1w', '1M', '5m', '30m', '60m'];

/**
 * 取单个指数的 K 线，归一化为 {t,o,h,l,c,v}
 * @param {string} key   指数 key
 * @param {string} period 1d/1w/1M/5m/30m/60m
 * @param {number} limit 根数
 */
export async function fetchKline(key, period = '1d', limit = 250) {
  const m = KLINE_MAP[key];
  if (!m) throw new Error(`${key} 暂无可用 K 线数据源`);

  if (m.sina) {
    const scale = SINA_SCALE[period];
    if (!scale) throw new Error(`新浪不支持周期 ${period}`);
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/` +
      `CN_MarketData.getKLineData?symbol=${m.sina}&scale=${scale}&ma=no&datalen=${limit}`;
    const d = await get(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
    const arr = JSON.parse(d);
    if (!Array.isArray(arr) || !arr.length) throw new Error('新浪返回空数据');
    return arr.map((b) => ({
      t: b.day, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume,
    }));
  }

  if (m.tx) {
    if (!TX_PERIOD[period]) throw new Error(`腾讯不支持周期 ${period}`);
    const ep = m.us
      ? 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get'
      : 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
    const url = `${ep}?param=${m.tx},${TX_PERIOD[period]},,,${limit},qfq`;
    const j = JSON.parse(await get(url, { headers: { Referer: 'https://gu.qq.com/' } }));
    const d = j?.data?.[m.tx];
    const arr = d?.qfqday || d?.day;
    if (!Array.isArray(arr) || !arr.length) throw new Error('腾讯返回空数据');
    // 腾讯字段顺序：日期, 开盘, 收盘, 最高, 最低, 成交量
    return arr.map((b) => ({
      t: b[0], o: +b[1], c: +b[2], h: +b[3], l: +b[4], v: +b[5],
    }));
  }

  throw new Error(`${key} 暂无可用 K 线数据源`);
}
export const SOURCES = [
  { id: 'wallstreetcn', label: '华尔街见闻', run: wallstreetcn },
  { id: 'eastmoney', label: '东方财富', run: eastmoneyNews },
  { id: 'sina', label: '新浪财经', run: sinaFinance },
  {
    id: 'chinanews',
    label: '中新网财经',
    run: rssSource({
      name: '中新网',
      channel: '国内财经',
      url: 'https://www.chinanews.com.cn/rss/finance.xml',
      limit: 30,
      tag: '国内',
    }),
  },
  { id: 'pbc', label: '中国人民银行', run: pbcNews, windowed: false },
  {
    id: 'fed',
    label: '美联储',
    windowed: false,
    run: rssSource({
      name: '美联储',
      channel: '政策/利率',
      url: 'https://www.federalreserve.gov/feeds/press_all.xml',
      limit: 30,
      tag: '央行',
    }),
  },
  {
    id: 'ecb',
    label: '欧洲央行',
    windowed: false,
    run: rssSource({
      name: '欧洲央行',
      channel: '政策/利率',
      url: 'https://www.ecb.europa.eu/rss/press.html',
      limit: 20,
      tag: '央行',
    }),
  },
  {
    id: 'stats',
    label: '国家统计局',
    windowed: false,
    // 该源在 GitHub 美国节点上常需 12-15 秒，本机只要 5-7 秒，
    // 原 15 秒超时在 Actions 上会被判定失败，这里放宽并允许重试
    run: rssSource({
      name: '国家统计局',
      channel: '官方数据',
      url: 'https://www.stats.gov.cn/sj/zxfb/rss.xml',
      limit: 25,
      tag: '中国宏观',
      timeout: 30000,
      retries: 1,
    }),
  },
];

export { stableId, stripTags };
