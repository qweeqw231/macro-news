// src/sources.mjs
// 全球宏观资讯 · 数据源适配器
// 每个适配器返回统一 schema 的条目数组；单个源失败不影响整体采集。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const TIMEOUT_MS = 15000;

async function get(url, { json = false, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
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
      const title = stripTags(pick(it, ['title']));
      if (!title && !text) continue;
      const ts = Number(pick(it, ['display_time'], 0));
      const uri = pick(it, ['uri', 'url'], '');
      out.push({
        id: stableId('wscn', String(it.id ?? ts), title || text.slice(0, 30)),
        ts,
        time: ts ? isoFromUnix(ts) : new Date().toISOString(),
        source: '华尔街见闻',
        channel: label,
        title: title || text.slice(0, 40),
        summary: title ? text : '',
        url: uri ? `https://wallstreetcn.com${uri}` : 'https://wallstreetcn.com/live/global',
        kind: 'news',
      });
    }
  }
  return out;
}

function rssSource({ name, channel, url, limit = 30, tag = '' }) {
  return async () => {
    const xml = await get(url);
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
          summary: stripTags(i.description).slice(0, 300),
          url: i.link || url,
          kind: 'official',
          tags: tag ? [tag] : [],
        };
      });
  };
}

// ---------- 宏观仪表盘行情（东方财富，已实测） ----------
const QUOTES = [
  { key: 'sh_comp',   name: '上证指数',       secid: '1.000001' },
  { key: 'dxy',       name: '美元指数',       secid: '100.UDI' },
  { key: 'usdcnh',    name: '美元兑离岸人民币', secid: '133.USDCNH' },
  { key: 'gold',      name: 'COMEX黄金',      secid: '101.GC00Y' },
  { key: 'wti',       name: 'NYMEX原油',      secid: '102.CL00Y' },
];

export async function fetchQuotes() {
  const results = await Promise.allSettled(
    QUOTES.map(async (q) => {
      const j = await get(
        `https://push2.eastmoney.com/api/qt/stock/get?fltt=2&invt=2&secid=${q.secid}&fields=f57,f58,f43,f170`,
        { json: true }
      );
      const d = j?.data;
      if (!d?.f58) return null;
      return {
        key: q.key,
        name: d.f58 || q.name,
        price: Number(d.f43),
        changePct: Number(d.f170),
        updatedAt: new Date().toISOString(),
      };
    })
  );
  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter(Boolean);
}

// ---------- 导出源清单 ----------
export const SOURCES = [
  { id: 'wallstreetcn', label: '华尔街见闻', run: wallstreetcn },
  {
    id: 'fed',
    label: '美联储',
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
    run: rssSource({
      name: '国家统计局',
      channel: '官方数据',
      url: 'https://www.stats.gov.cn/sj/zxfb/rss.xml',
      limit: 25,
      tag: '中国宏观',
    }),
  },
];

export { stableId, stripTags };
