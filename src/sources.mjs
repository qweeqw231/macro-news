// src/sources.mjs
// 全球宏观资讯 · 数据源适配器
// 每个适配器返回统一 schema 的条目数组；单个源失败不影响整体采集。

import { ETFS, etfTxCode } from './etf.mjs';
import { fetchBatchQuotes } from './quotes.mjs';
import { emGetJSON, KLINE_HOSTS } from './em.mjs';

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

// 摘要：**优先在句末断开**，避免「…有数百名客户的个人信息遭到泄露…」这种半句话。
// 长度从 140 放宽到 220 —— 列表里能多看一句，读者的正文另走归档全文。
const SUMMARY_LEN = 220;
function summarize(s, n = SUMMARY_LEN) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const head = t.slice(0, n);
  // 只在窗口后半段找句末标点：太靠前的句子会截掉太多内容
  const min = Math.floor(n * 0.45);
  for (let i = head.length - 1; i >= min; i--) {
    if ('。！？；!?;'.includes(head[i])) return head.slice(0, i + 1) + '…';
  }
  return head + '…';
}

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
        summary: rawTitle ? summarize(text) : '',
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
        summary: summarize(stripTags(it.summary)),
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
        summary: summarize(stripTags(it.intro)),
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

/**
 * RSS/Atom 源适配器。
 *
 * 为什么要「备选入口」：2026-10-29 排查中新网采集失败（_last-run 里记的 fetch failed）时实测，
 * 主入口 https://www.chinanews.com.cn/rss/finance.xml 本身**完全可达**（200 / 16.5KB / 0.39 秒），
 * 那次失败是**瞬时网络抖动**；而原实现 retries 默认 0 ⇒ 一次抖动就记失败，源被白白判死。
 *
 * ⇒ 两处加固：
 *   ① retries ≥ 1，给瞬时失败留重试窗口；
 *   ② urls 备选入口，主入口彻底不可用时依次降级，而不是整个源判死。
 * 解析成功但**一条标题都取不到**也算这个入口不可用（继续试下一个），
 * 否则会悄悄采到一个 0 条的源还标成「成功」。
 */
function rssSource({ name, channel, url, urls, limit = 30, tag = '', timeout = 15000, retries = 0 }) {
  const candidates = urls && urls.length ? urls : [url];
  return async () => {
    const errors = [];
    for (const u of candidates) {
      try {
        const xml = await get(u, { timeout, retries });
        const items = parseFeed(xml).filter((i) => i.title);
        if (!items.length) {
          errors.push(`${shortUrl(u)} 无可解析条目`);
          continue;
        }
        return items.slice(0, limit).map((i) => {
          const d = new Date(i.date);
          const ts = Number.isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
          return {
            id: stableId('rss', name, i.link || i.title),
            ts,
            time: i.date ? isoFromDate(i.date) : new Date().toISOString(),
            source: name,
            channel,
            title: i.title,
            summary: summarize(stripTags(i.description)),
            content: clip(stripTags(i.description), 4000),
            url: i.link || u,
            kind: 'official',
            tags: tag ? [tag] : [],
          };
        });
      } catch (err) {
        errors.push(`${shortUrl(u)} → ${String(err.message).slice(0, 60)}`);
      }
    }
    throw new Error(`RSS 全部入口失败：${errors.join('；')}`);
  };
}

// 报错信息里只保留路径，完整 URL 过长会淹没真正的错误
function shortUrl(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return String(u).slice(0, 60);
  }
}

// ---------- 宏观仪表盘行情（东方财富 push2，全部经本机实测） ----------
// market 用于判断是否处于交易时段（决定前端是否需要高频刷新）
// kline 列为该指数的日 K 代码；null 表示当前可用数据源取不到（见 README）
// tx 为腾讯备用源的代码（东财限流时用于 K 线 / 行情的冗余）；null = 腾讯无对应代码
export const INDICES = [
  // A股
  { key: 'sh_comp',   name: '上证指数',   market: 'CN', secid: '1.000001', sina: 'sh000001', tx: 'sh000001' },
  { key: 'sz_comp',   name: '深证成指',   market: 'CN', secid: '0.399001', sina: 'sz399001', tx: 'sz399001' },
  { key: 'chinext',   name: '创业板指',   market: 'CN', secid: '0.399006', sina: 'sz399006', tx: 'sz399006' },
  { key: 'star50',    name: '科创50',     market: 'CN', secid: '1.000688', sina: 'sh000688', tx: 'sh000688' },
  { key: 'bse50',     name: '北证50',     market: 'CN', secid: '0.899050', sina: 'bj899050', tx: 'bj899050' },
  { key: 'csi300',    name: '沪深300',    market: 'CN', secid: '1.000300', sina: 'sh000300', tx: 'sh000300' },
  { key: 'csi500',    name: '中证500',    market: 'CN', secid: '1.000905', sina: 'sh000905', tx: 'sh000905' },
  { key: 'csi1000',   name: '中证1000',   market: 'CN', secid: '1.000852', sina: 'sh000852', tx: 'sh000852' },
  // 港股
  // ⚠ 新浪**只有 CN 的 8 个指数**可用（2026-10-30 实测）：
  //   hkHSI / hkHSTECH / usDJI / usIXIC / usINX 的 json_v2 与 jsonp_v2 都返回 **null**。
  //   ⇒ 这几个标的的新浪字段一律置 null，别写一个"看起来有"其实取不到的值。
  { key: 'hsi',       name: '恒生指数',   market: 'HK', secid: '100.HSI',   sina: null,    tx: 'hkHSI' },
  { key: 'hs_tech',   name: '恒生科技',   market: 'HK', secid: '124.HSTECH', sina: null,    tx: 'hkHSTECH' },
  // 美股
  { key: 'dji',       name: '道琼斯',     market: 'US', secid: '100.DJIA',  sina: null,    tx: 'usDJI' },
  { key: 'ixic',      name: '纳斯达克',   market: 'US', secid: '100.NDX',   sina: null,    tx: 'usIXIC' },
  { key: 'spx',       name: '标普500',    market: 'US', secid: '100.SPX',   sina: null,    tx: 'usINX' },
  // 其他（腾讯无对应代码 → 只能走东财）
  { key: 'n225',      name: '日经225',    market: 'JP', secid: '100.N225',  sina: null, tx: null },
  { key: 'dax',       name: '德国DAX',    market: 'EU', secid: '100.GDAXI', sina: null, tx: null },
  // 法国CAC40：东财 secid 100.FCHI（name=法国CAC40）—— 由东财搜索接口
  //   `searchapi.eastmoney.com/api/suggest/get?input=法国CAC40` 反查得到
  { key: 'cac40',     name: '法国CAC40',  market: 'EU', secid: '100.FCHI',  sina: null, tx: null },
  { key: 'ukx',       name: '英国富时100', market: 'UK', secid: '100.FTSE',  sina: null, tx: null },
  { key: 'kospi',     name: '韩国KOSPI',  market: 'KR', secid: '100.KS11',  sina: null, tx: null },
];

// ── 组合标的的 K 线（纳指100 / 伦敦金 / 上海金 / 人民币中间价）──
//
// 为什么单独一张表：这 4 个 key 的**实时价**来自各自的专业源（腾讯 / 上金所 / 中国货币网），
// **历史日线**则分散在多个源里。口径差异在 klineNote 里**如实标注**，
// 前端会把它显示在 K 线注记上，不藏着。
//
// ⚠ 口径逐个实测（2026-10-30）：
//   · 纳指100：东财 100.NDX100（name=纳斯达克100），末根收盘 29402.51 与腾讯 usNDX **完全一致** ⇒ 同品种 ✓
//   · 伦敦金：**新浪外盘 XAU**（5186 根 / 2006-10-30 起）——实测其末根
//     开 4023.79 / 高 4026.24 / 低 3987.40 与新浪实时 hf_XAU 的今开/最高/最低**逐个吻合**
//     ⇒ 它就是**现货伦敦金**，与报价源腾讯 hf_XAU 同品种 ✓（不再需要 COMEX 代理）
//   · 上海金：东财 118.AU9999（name=黄金9999，2004 起 5552 根）与上金所官网
//     `/graph/Dailyhq`（2016-12-19 起 2391 根）**都是上金所 Au99.99** ⇒ 同品种 ✓
//     （上金所的字段序实测为 [日期, 开, 收, 低, 高] —— 用新浪实时 SGE_AU9999 的昨收
//       865.26 与 Dailyhq 2026-10-29 的「收」列交叉验证确认）
//   · 人民币中间价：中国货币网只有当天接口，**没有历史**（历史接口全部 404）⇒ 只能用
//     离岸价 133.USDCNH 作**代理**（CNH 离岸 ≠ 官方中间价，实测差约 0.8%）⇒ klineNote 标注
export const PORTFOLIO_KLINE = [
  {
    key: 'ndx', name: '纳指100', market: 'US', secid: '100.NDX100', sina: null, tx: 'usNDX',
    klineNote: '',
  },
  {
    // 伦敦金：唯一历史源 = 新浪外盘（现货）。**刻意不挂东财 101.GC00Y** ——
    // 那是 COMEX 黄金期货（主力连续），与现货有基差，挂上会让同一张图忽而是现货忽而是期货。
    key: 'xau', name: '伦敦金', market: 'CMDTY', secid: null, sina: null, tx: null,
    sinaGlobal: 'XAU', klineNote: '',
  },
  {
    key: 'sge_au9999', name: '上海金Au99.99', market: 'SGE', secid: '118.AU9999', sina: null,
    tx: null, sge: 'Au99.99', klineNote: '',
  },
  {
    // 伦敦银：新浪外盘 XAG（现货白银/美元，与腾讯 hf_XAG 实时价同一条线）
    //   实测 5187 根（2006-10-30 起），末根 close 与腾讯 hf_XAG 实时价吻合
    //   ⚠ 腾讯的 hf_SI 是**纽约白银（COMEX 期货）**，不能拿来当伦敦银
    //   东财 122.XAG「白银/美元」实测与新浪**同一条线**（末根差 0.03~0.12，年均差 <0.7%）
    //   ⇒ 可以作第二源，且它的历史更长（8950 根 / 1992 起）
    key: 'xag', name: '伦敦银', market: 'CMDTY', secid: '122.XAG', sina: null,
    tx: null, sinaGlobal: 'XAG', klineNote: '',
  },
  {
    // 布伦特原油：新浪外盘 OIL（ICE 布伦特连续，与腾讯 hf_OIL 实时价同一条线）
    //   实测 2587 根（2016-10-31 起）
    // ⚠ **刻意不接东财 112.B00Y**：实测两条线在**换月时基差会跳到 6%**
    //   （2026-04-24：东财 105.88 vs 新浪 99.78；2016 年平均差 3.52%）——
    //   东财是「当月连续结算价」、新浪是「连续合约收盘价」⇒ 口径不同，混用会串。
    //   而报价卡片用的是腾讯 hf_OIL（= 新浪那条线）⇒ K 线必须跟着它走。
    key: 'brent', name: '布伦特原油', market: 'CMDTY', secid: null, sina: null,
    tx: null, sinaGlobal: 'OIL', klineNote: '',
  },
  {
    key: 'usdcny', name: '人民币中间价', market: 'FX', secid: '133.USDCNH', sina: null, tx: null,
    klineNote: '历史为离岸价 CNH，与官方中间价有基差（实测约 0.8%）',
  },
];

/** 按 key 找 K 线取数目标：先 17 个指数，再组合标的。 */
export function klineTarget(key) {
  return INDICES.find((i) => i.key === key) || PORTFOLIO_KLINE.find((i) => i.key === key) || null;
}

// 行情失败原因（由 fetchQuotes 写入，供采集器记录到 _last-run.json）
let quoteError = '';
export function getQuoteError() { return quoteError; }

/**
 * 采集全部行情：17 个指数 + 32 只场内 ETF + 纳指100。
 *
 * ⚠ 纳指100（ndx）虽属组合标的，但它是**只在美股时段交易的股指**：
 *   组合采集每天 16:30（美股开盘前）才跑一次 ⇒ 卡片会停在上一交易日，
 *   而 100.NDX100 的 K 线早已更新（2026-10-31 实测：K 线 10-30 收盘，卡片还是 10-29）。
 *   放进这里之后，卡片与 K 线同源（东财 100.NDX100）、同频（15 分钟）。
 *
 * ⚠ 走**批量**端点（东财 ulist.np），不是逐只 stock/get：
 *   · 批量一次拿完 50 个标的，请求数从 50 降到 1；
 *   · 东财的限流是**按接口**的 —— 实测打密之后 stock/get 与 kline 端点会被
 *     socket 级拒绝，而 ulist 仍然正常，所以批量端点同时也是更抗限流的选择。
 *   · 详见 src/quotes.mjs 的口径说明（含「ulist 对 ETF 也有效」这条更正）。
 */
export async function fetchQuotes() {
  const targets = [
    ...INDICES.map((i) => ({
      key: i.key, name: i.name, market: i.market, secid: i.secid, tx: i.tx,
    })),
    ...ETFS.map((e) => ({
      key: e.key, name: e.name, market: 'ETF', secid: e.secid,
      tx: etfTxCode(e.secid), theme: e.theme, region: e.region || 'CN',
    })),
    { key: 'ndx', name: '纳指100', market: 'US', secid: '100.NDX100', tx: null },
  ];
  const { quotes, fail } = await fetchBatchQuotes(targets);
  const failCount = Object.keys(fail).length;
  if (failCount) {
    const reasons = [...new Set(Object.values(fail))].slice(0, 2).join('；');
    quoteError = `${failCount}/${targets.length} 失败：${reasons}`;
  } else {
    quoteError = '';
  }
  return quotes;
}


// ── K 线取数：东财（主源）→ 新浪 / 腾讯（备源）──
//
// 为什么主源换成东财（2026-10-29 本机实测）：
//   · 东财 lmt 给多少给多少：日K 3000 根（12.3 年）、周K 1821 根（35.8 年）、月K 431 根（36 年）；
//   · 腾讯在 n>1000 时**直接返回空** —— 拿它当主源，港股/美股的长历史根本取不到
//     （道指周K 最多到 2007 年，东财能到 1896 年）；
//   · 新浪 datalen 也能给 3000，但只覆盖 CN 的 8 个指数。
// ⇒ 与前端直连保持同一口径（东财 → 腾讯 → 本地）。
//
// sina / tx 来自 INDICES：新浪只覆盖 CN 8 个，腾讯覆盖港股 + 美股，都是备源。
// ⚠ 2026-10-30 补 1m / 15m：前端周期表有 1分/5分/15分/30分/60分，
//   而服务端原先只有 5m/30m/60m ⇒ 服务端预生成分钟K 时 1m/15m 会直接被跳过。
const EM_KLT = { '1d': 101, '1w': 102, '1M': 103, '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60 };
const KL_FIELDS = 'fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
// 周期 → 新浪 scale（分钟数）；周=1200 月=7200
const SINA_SCALE = { '1d': 240, '1w': 1200, '1M': 7200, '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60 };
// 周期 → 腾讯 period
const TX_PERIOD = { '1d': 'day', '1w': 'week', '1M': 'month' };

export function klineAvailable(key) {
  // 东财按 secid 能取到全部 17 个指数（含恒生科技 / 日经 / DAX / 富时 / KOSPI）；
  // 组合标的中 xau **没有**东财 secid（东财无现货伦敦金），走新浪外盘；
  // sge_au9999 有东财 secid 也有上金所官网。
  const t = klineTarget(key);
  if (!t) return false;
  return !!(t.secid || t.sina || t.tx || t.sinaGlobal || t.sge);
}

export const KLINE_PERIODS = ['1d', '1w', '1M', '1m', '5m', '15m', '30m', '60m'];

// 本次 fetchKline 实际命中的源（供采集器写进文件、前端显示口径）
let klineSource = '';
export function getKlineSource() { return klineSource; }

/**
 * 日K → 周K / 月K 聚合（与前端 assets/market.js 的 aggregateDaily 同口径）。
 * 只给「只有日线」的源用（新浪外盘、上金所）。
 */
export function aggregateBars(daily, unit) {
  const weekKey = (t) => {
    const d = new Date(String(t).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d.getTime())) return String(t);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // 该周周一
    return d.toISOString().slice(0, 10);
  };
  const out = [];
  let cur = null;
  let curKey = '';
  daily.forEach((b) => {
    const k = unit === 'month' ? String(b.t).slice(0, 7) : weekKey(b.t);
    if (!cur || k !== curKey) {
      cur = { t: b.t, o: b.o, c: b.c, h: b.h, l: b.l, v: b.v || 0 };
      curKey = k;
      out.push(cur);
    } else {
      cur.c = b.c;
      cur.t = b.t;
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.v += b.v || 0;
    }
  });
  return out;
}

/**
 * OHLC 自洽兜底：把 high/low 撑开到必定包含 open/close。
 *
 * ⚠ 为什么需要（2026-10-30 实测）：
 *   · 新浪外盘 XAU 日线 5186 根里有 **132 根**「最高 < 开盘」或「最低 > 收盘」的坏行，
 *     集中在 **2012~2017**（2020 年以后只剩 1/1767）—— 是新浪自己的历史数据损坏，不是字段序错
 *     （同一接口 2006-2008 的行完全自洽，且末根与新浪实时 hf_XAU 的开/高/低逐个吻合）。
 *   · 上金所 Au99.99 2391 根里有 **17 根**同类噪声（偏差多在 0.01~0.6）。
 *   ⇒ 直接画会得到「上影线穿过实体」的畸形蜡烛。这里只动 high/low，
 *     **不改 open/close**（那才是收盘价语义），并保持与前端同一套修正。
 */
export function fixOhlc(bars) {
  return bars.map((b) => ({
    ...b,
    h: Math.max(b.h, b.o, b.c),
    l: Math.min(b.l, b.o, b.c),
  }));
}

/**
 * 新浪外盘日线（现货伦敦金 XAU 等）。
 *
 * 接口：https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_data=/
 *        GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=XAU
 * ⚠ 实测（2026-10-30）：
 *   · 返回 5186 根（2006-10-30 起），字段 date/open/high/low/close/volume/position/s
 *   · **只有日线**（getGlobalFuturesWeeklyKLine / getGlobalFuturesMinKLine 都报 __ERROR）
 *   · symbol 必须**去掉 hf_ 前缀**（symbol=hf_XAU 返回 null）
 *   · Node 侧直接 fetch 文本即可（不带 Referer 也能通），但响应**没有 CORS 头**
 *     ⇒ 浏览器端必须走 JSONP（<script> 加载）
 */
export async function sinaGlobalDaily(symbol) {
  const url = 'https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_data=/' +
    `GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${symbol}`;
  const txt = await get(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
  const m = txt.match(/\[[\s\S]*\]/);
  if (!m) throw new Error('新浪外盘返回非数组');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr) || !arr.length) throw new Error('新浪外盘返回空数据');
  return fixOhlc(arr.map((b) => ({
    t: String(b.date).slice(0, 10), o: +b.open, c: +b.close,
    h: +b.high, l: +b.low, v: +b.volume || 0,
  })));
}

/**
 * 上海黄金交易所日线（Au99.99 等）。
 *
 * 接口：https://www.sge.com.cn/graph/Dailyhq?instid=Au99.99
 * ⚠ 实测（2026-10-30）：
 *   · 返回 {"time":[[日期,开,收,低,高], ...]}，2391 根（2016-12-19 起）
 *   · **startdate / enddate 参数被忽略**（传不同区间返回完全相同的 97859 字节）⇒ 固定全量
 *   · 字段序 [日期, 开, 收, 低, 高] —— 用新浪实时 SGE_AU9999 的昨收 865.26 与
 *     Dailyhq 2026-10-29 的「收」列交叉验证确认
 *   · **没有 CORS 头** ⇒ 浏览器端不能用 fetch，只能服务端预生成 + 本地文件兜底
 */
async function sgeDaily(instid) {
  const url = `https://www.sge.com.cn/graph/Dailyhq?instid=${instid}`;
  const j = await get(url, { json: true, headers: { Referer: 'https://www.sge.com.cn/sjzx/mrhq' } });
  const rows = j?.time;
  if (!Array.isArray(rows) || !rows.length) throw new Error('上金所返回空数据');
  return fixOhlc(rows.map((r) => ({ t: r[0], o: +r[1], c: +r[2], l: +r[3], h: +r[4], v: 0 })));
}

/**
 * 该标的在指定周期上的候选取数源（**按优先级排序**）。
 *
 * ⚠ 顺序不是全局统一的，而是**按品种**定的：
 *   · 组合大宗（伦敦金/银/布伦特）：**新浪外盘优先**（实测 XAG 5187 根 / XAU 5186 根 /
 *     OIL 2587 根，都从 2006~2016 起），东财（122.XAG / 112.B00Y / 101.GC00Y）次之；
 *   · 上海金：东财优先（`118.AU9999` 2004 起 5552 根）→ 上金所官网（2016 起 2391 根）；
 *   · 指数：东财优先（lmt 无上限）→ 新浪 CN（仅 8 个 CN 指数）→ 腾讯（封顶 1000 根）。
 *
 * @returns {{name:string, run:() => Promise<object[]>}[]}
 */
function klineProviders(idx, period, limit) {
  const P = [];
  const klt = EM_KLT[period];

  const pushSinaGlobal = () => P.push({
    name: '新浪外盘',
    run: async () => {
      const daily = await sinaGlobalDaily(idx.sinaGlobal);
      if (period === '1d') return daily.slice(-limit);
      if (period === '1w') return aggregateBars(daily, 'week').slice(-limit);
      if (period === '1M') return aggregateBars(daily, 'month').slice(-limit);
      // ⚠ 新浪外盘**只有日线**（Weekly/Min 接口都返回 __ERROR）⇒ 分钟周期明确不支持，
      //   绝不能拿日线糊弄成分钟K（前端 2026-10-30 就踩过这个坑：把月K 当 5 分钟画出来）。
      throw new Error(`新浪外盘不支持周期 ${period}`);
    },
  });

  const pushSge = () => P.push({
    name: '上金所官网',
    run: async () => {
      const daily = await sgeDaily(idx.sge);
      if (period === '1d') return daily.slice(-limit);
      if (period === '1w') return aggregateBars(daily, 'week').slice(-limit);
      if (period === '1M') return aggregateBars(daily, 'month').slice(-limit);
      throw new Error(`上金所不支持周期 ${period}`);
    },
  });

  const pushEm = () => P.push({
    name: '东方财富',
    run: async () => {
      if (!idx.secid) throw new Error('东财无该标的');
      if (!klt) throw new Error(`东财不支持周期 ${period}`);
      const j = await emGetJSON(
        `/api/qt/stock/kline/get?secid=${idx.secid}&klt=${klt}&fqt=1&lmt=${limit}&end=20500101&${KL_FIELDS}`,
        { hosts: KLINE_HOSTS, cacheTtlMs: 3 * 3600 * 1000, cacheTag: `k${klt}`, timeout: 15000 }
      );
      const rows = j?.data?.klines || [];
      if (!rows.length) throw new Error('东财返回空');
      // 东财行：日期,开,收,高,低,量,额,振幅
      return rows.map((r) => {
        const p = String(r).split(',');
        return { t: p[0], o: +p[1], c: +p[2], h: +p[3], l: +p[4], v: +p[5] };
      });
    },
  });

  const pushSina = () => P.push({
    name: '新浪财经',
    run: async () => {
      if (!idx.sina) throw new Error('新浪无该标的');
      const scale = SINA_SCALE[period];
      if (!scale) throw new Error(`新浪不支持周期 ${period}`);
      const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/` +
        `CN_MarketData.getKLineData?symbol=${idx.sina}&scale=${scale}&ma=no&datalen=${limit}`;
      const d = await get(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
      const arr = JSON.parse(d);
      if (!Array.isArray(arr) || !arr.length) throw new Error('新浪返回空数据');
      return arr.map((b) => ({
        t: b.day, o: +b.open, h: +b.high, l: +b.low, c: +b.close, v: +b.volume,
      }));
    },
  });

  const pushTx = () => P.push({
    name: '腾讯行情',
    run: async () => {
      // ⚠ idx.tx 可能为 null（组合标的里没腾讯代码的）⇒ 必须先判空，
      //   否则 `idx.tx.startsWith` 会抛 TypeError，把真正的失败原因盖掉。
      if (!idx.tx) throw new Error('腾讯无该标的');
      // ⚠ 腾讯在 n>1000 时**直接返回空**（实测 2026-10-29）→ 必须 clamp，
      //   否则周K 要 1821 根时腾讯整条路径返回空。
      const n = Math.min(limit, 1000);
      // ⚠ 主机用 ifzq.gtimg.cn（不带 web. 前缀，与前端一致）
      const ep = idx.tx.startsWith('us')
        ? 'https://ifzq.gtimg.cn/appstock/app/usfqkline/get'
        : 'https://ifzq.gtimg.cn/appstock/app/fqkline/get';
      const url = `${ep}?param=${idx.tx},${TX_PERIOD[period]},,,${n},qfq`;
      const j = JSON.parse(await get(url, { headers: { Referer: 'https://gu.qq.com/' } }));
      const d = j?.data?.[idx.tx];
      // ⚠ 周/月不能写死 qfqday||day —— 实测腾讯的键是 week / month（不带 qfq 前缀），
      //   写死会导致周K/月K 取不到数据。
      const arr = d?.['qfq' + TX_PERIOD[period]] || d?.[TX_PERIOD[period]];
      if (!Array.isArray(arr) || !arr.length) throw new Error('腾讯返回空数据');
      // 腾讯字段顺序：日期, 开盘, 收盘, 最高, 最低, 成交量
      return arr.map((b) => ({
        t: b[0], o: +b[1], c: +b[2], h: +b[3], l: +b[4], v: +b[5],
      }));
    },
  });

  if (idx.sinaGlobal) { pushSinaGlobal(); pushEm(); }
  else if (idx.sge) { pushEm(); pushSge(); }
  else { pushEm(); pushSina(); pushTx(); }
  return P;
}

/**
 * 取单个指数的 K 线，归一化为 {t,o,h,l,c,v}
 * @param {string} key   指数 key
 * @param {string} period 1d/1w/1M/5m/30m/60m
 * @param {number} limit 根数
 * @param {object} [opts]
 * @param {boolean} [opts.longest]  true = **所有源都跑，取根数最多的那份**；
 *        用于「全量日K」文件（要的是尽可能长的历史，不是第一个能返回的源）。
 *        ⚠ 默认（false）保持**顺序链、先成功先返回**：日常采集每天要跑 21×3 次请求，
 *        每个源都试一遍会明显加重限流压力。
 */
export async function fetchKline(key, period = '1d', limit = 250, opts = {}) {
  const idx = klineTarget(key);
  if (!idx || !klineAvailable(key)) throw new Error(`${key} 暂无可用 K 线数据源`);
  const providers = klineProviders(idx, period, limit);
  if (!providers.length) throw new Error(`${key} 暂无可用 K 线数据源`);

  if (opts.longest) {
    const settled = await Promise.allSettled(providers.map((p) => p.run()));
    let best = null;
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled' || !r.value || !r.value.length) return;
      if (!best || r.value.length > best.bars.length) {
        best = { name: providers[i].name, bars: r.value };
      }
    });
    if (!best) {
      const why = settled.map((r, i) =>
        `${providers[i].name}(${r.status === 'rejected' ? String(r.reason?.message || r.reason).slice(0, 60) : '空'})`
      ).join('；');
      throw new Error(`K线不可得：${why}`);
    }
    klineSource = best.name;
    return best.bars;
  }

  const errors = [];
  for (const p of providers) {
    try {
      const bars = await p.run();
      if (!bars || !bars.length) throw new Error('返回空');
      klineSource = p.name;
      return bars;
    } catch (err) {
      errors.push(`${p.name}失败(${String(err.message).slice(0, 80)})`);
    }
  }
  throw new Error(`K线不可得：${errors.join('；')}`);
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
      // 备选入口按序降级：finance.xml（财经）→ scroll-news.xml（滚动）→ importnews.xml（要闻）
      // 三个入口 2026-10-29 本机实测全部 200（16.5KB / 16.5KB / 14.8KB）
      urls: [
        'https://www.chinanews.com.cn/rss/finance.xml',
        'https://www.chinanews.com.cn/rss/scroll-news.xml',
        'https://www.chinanews.com.cn/rss/importnews.xml',
      ],
      limit: 30,
      tag: '国内',
      // 之前 retries=0：一次瞬时网络抖动就记 fetch failed，源被判死
      retries: 2,
      timeout: 20000,
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
      retries: 1,
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
      retries: 1,
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
