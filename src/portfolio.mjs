// src/portfolio.mjs
// 组合行情与宏观指标适配器（按《采集规格.md》§2/§3/§4/§5）
//
// 与 sources.mjs 的分工：
//   sources.mjs  → 新闻 + 17 个指数行情（站点主数据）
//   portfolio.mjs→ 组合分析所需的 5 个新增行情 key + 5 个宏观指标
//
// 所有字段索引均经本机实测验证（2026-10-28/29），未采信规格书里的示例值。
// 规格书与实测不一致处，已在对应代码处注明原因。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const TIMEOUT_MS = 20000;

/** 带超时的请求；可选重试。gbk=true 时按 GBK 解码（腾讯行情返回 GBK）。 */
async function get(url, { json = false, headers = {}, timeout = TIMEOUT_MS, retries = 0, gbk = false } = {}) {
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
      if (json) return await res.json();
      const buf = Buffer.from(await res.arrayBuffer());
      // 腾讯行情（qt.gtimg.cn）是 GBK；Node 内置 ICU 支持 gbk 解码器
      if (gbk) {
        try { return new TextDecoder('gbk').decode(buf); }
        catch { return buf.toString('utf8'); }
      }
      return buf.toString('utf8');
    } catch (err) {
      lastErr = err;
      // ⚠ 429（限流）**不要在内部重试** —— 立刻再打一次只会让限流更严重。
      //   直接上抛，让调用方（回补脚本）按自己的退避序列处理。
      if (/HTTP 429/.test(String(err && err.message))) throw err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 北京时间（UTC+8）的 ISO 串，规格书 §4.1 要求 updatedAt 带 +08:00 */
function isoCN(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`;
}

/** "2026-10-28 12:20:20"（北京时间）→ ISO(+08:00) */
function isoFromCNDateTime(s) {
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return isoCN();
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`;
}

const stripTags = (s = '') =>
  String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const num = (v) => {
  if (v === undefined || v === null || v === '' || v === '-' || v === '—') return null;
  const n = Number(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ============================================================================
// §5 数据校验（写入前必做）
// ============================================================================

/**
 * 单条行情校验。
 * @returns {string|null} null 表示通过；否则为丢弃原因
 */
export function validateQuote(q) {
  if (!q || q.price === null || q.price === undefined || !(q.price > 0)) {
    return `价格非法(${q && q.price})`;
  }
  // 涨跌幅范围（指数/黄金）：−20% ~ +20%
  if (q.changePct !== null && q.changePct !== undefined) {
    if (q.changePct < -20 || q.changePct > 20) {
      return `涨跌幅越界(${q.changePct}%)`;
    }
  }
  // 分品种价格区间
  if (q.key === 'sge_au9999' && (q.price < 500 || q.price > 1500)) {
    return `上海金超出区间(${q.price})`;
  }
  if (q.key === 'usdcny' && (q.price < 5.0 || q.price > 9.0)) {
    return `中间价超出区间(${q.price})`;
  }
  // 伦敦银（美元/盎司）：正常 10~200；布伦特原油（美元/桶）：正常 10~300
  if (q.key === 'xag' && (q.price < 5 || q.price > 300)) {
    return `伦敦银超出区间(${q.price})`;
  }
  if (q.key === 'brent' && (q.price < 5 || q.price > 400)) {
    return `布伦特原油超出区间(${q.price})`;
  }
  if (q.key === 'xau' && (q.price < 500 || q.price > 10000)) {
    return `伦敦金超出区间(${q.price})`;
  }
  return null;
}

/** 时间新鲜度：updatedAt 距今 ≥3 天 → 标记 stale */
function markStale(q) {
  const t = Date.parse(q.updatedAt);
  if (!Number.isFinite(t)) return q;
  const ageDays = (Date.now() - t) / 86400000;
  if (ageDays >= 3) q.note = q.note ? `${q.note},stale` : 'stale';
  return q;
}

// ============================================================================
// §3.1 纳指100（ndx）—— 腾讯行情 usNDX
// ============================================================================
// 实测响应：v_usNDX="200~纳斯达克100~.NDX~29693.84~29651.44~29732.04~...~
//            2026-10-28 12:20:20~42.40~0.14~29798.66~29618.42~USD~..."
// 索引（实测）：[3]价 [4]昨收 [5]开盘 [30]时间 [31]涨跌额 [32]涨跌幅% [33]高 [34]低
async function fetchNdx() {
  const text = await get('https://qt.gtimg.cn/q=usNDX', {
    gbk: true, headers: { Referer: 'https://gu.qq.com/' },
  });
  const m = text.match(/="([^"]+)"/);
  if (!m) throw new Error('腾讯 usNDX 返回格式异常');
  const f = m[1].split('~');
  if (f.length < 35) throw new Error(`腾讯 usNDX 字段不足(${f.length})`);
  const price = num(f[3]);
  const prevClose = num(f[4]);
  const changePct = num(f[32]);
  return {
    key: 'ndx',
    name: '纳指100',
    market: 'US',
    price,
    open: num(f[5]),
    high: num(f[33]),
    low: num(f[34]),
    prevClose,
    changePct,
    updatedAt: isoFromCNDateTime(f[30]),
    note: '',
  };
}

// ============================================================================
// §3.2 伦敦金（xau）/ 伦敦银（xag）/ 布伦特原油（brent）—— 腾讯行情 hf_*
// ============================================================================
// 实测响应（hf_XAU，hf_XAG / hf_OIL 字段结构完全一致）：
//   v_hf_XAU="4002.80,-0.46,4002.80,4003.15,4026.24,3987.40,13:41:00,4021.23,
//             4023.79,0,0,0,2026-10-30,伦敦金（现货黄金）"
// 索引（实测，逗号分隔）：
//   [0]现价 [1]涨跌幅% [2]买价 [3]卖价 [4]最高 [5]最低 [6]时间
//   [7]昨收 [8]开盘 [12]日期 [13]名称
// ⚠ 规格书把 [2] 标为「开盘价」、把 [8] 漏掉了。实测 [2] 与 [0] 同为现价（买一价），
//   真正的昨收/开盘分别是 [7]/[8]。按规格书写会导致 prevClose 恒等于 price、
//   涨跌额恒为 0，故此处按实测口径取值。
//
// ⚠ 品种核对（2026-10-30 实测，腾讯与新浪两边同名同价）：
//   · hf_XAU = 伦敦金（现货黄金）  · hf_XAG = 伦敦银（现货白银）
//   · hf_OIL = 布伦特原油          · hf_SI  = 纽约白银（COMEX 期货，非伦敦银）
//   · hf_CL  = 纽约原油（WTI）
//   ⇒ **伦敦银必须用 hf_XAG**，用 hf_SI 会变成 COMEX 期货口径。
async function fetchXau() {
  return fetchHfQuote('hf_XAU', 'xau', '伦敦金', 'CMDTY');
}

/** §3.2b 伦敦银（xag）—— 腾讯 hf_XAG（伦敦银·现货白银） */
async function fetchXag() {
  return fetchHfQuote('hf_XAG', 'xag', '伦敦银', 'CMDTY');
}

/** §3.2c 布伦特原油（brent）—— 腾讯 hf_OIL（ICE 布伦特，美元/桶） */
async function fetchBrent() {
  return fetchHfQuote('hf_OIL', 'brent', '布伦特原油', 'CMDTY');
}

/**
 * 腾讯 hf_* 外盘品种实时行情（伦敦金/伦敦银/布伦特原油/纽约原油…共用一套字段口径）。
 * @param {string} code  腾讯代码（hf_XAU / hf_XAG / hf_OIL …）
 * @param {string} key   站内 key
 * @param {string} name  显示名
 * @param {string} market 分组
 */
async function fetchHfQuote(code, key, name, market) {
  const text = await get(`https://qt.gtimg.cn/q=${code}`, {
    gbk: true, headers: { Referer: 'https://gu.qq.com/' },
  });
  const m = text.match(/="([^"]+)"/);
  if (!m) throw new Error(`腾讯 ${code} 返回格式异常`);
  const f = m[1].split(',');
  if (f.length < 14) throw new Error(`腾讯 ${code} 字段不足(${f.length})`);
  const price = num(f[0]);
  const prevClose = num(f[7]);
  const date = f[12];
  return {
    key,
    name,
    market,
    price,
    open: num(f[8]),
    high: num(f[4]),
    low: num(f[5]),
    prevClose,
    changePct: num(f[1]),
    // 外盘连续交易，[6] 是北京时间 HH:mm:ss，配合 [12] 的日期
    updatedAt: /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? `${date}T${(f[6] || '00:00:00').padEnd(8, '0').slice(0, 8)}+08:00`
      : isoCN(),
    note: '',
  };
}

// ============================================================================
// §3.3 上海金 Au99.99（sge_au9999）—— 上海黄金交易所官网
// ============================================================================
// 页面是服务端渲染的 HTML 表格，实测可直接解析（无需 JS 渲染）。
// ⚠ 必须带 start_date/end_date，否则页面为空。
// 表格列：日期|合约|开盘价|最高价|最低价|收盘价|涨跌（元）|涨跌幅|加权平均价|成交量...
// 注意：涨跌幅带 % 号；「-」表示该合约当日无成交。
async function fetchSgeAu9999() {
  // 休市/节假日：当天无数据 → 回退到上一交易日（最多回溯 7 天）
  let lastErr = null;
  for (let back = 0; back <= 7; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const day = ymd(d);
    try {
      const html = await get(
        `https://www.sge.com.cn/sjzx/quotation_daily_new?start_date=${day}&end_date=${day}`,
        { headers: { Referer: 'https://www.sge.com.cn/sjzx/mrhq' }, retries: 1 }
      );
      const row = this_parseSgeRow(html);
      if (row) {
        const note = back > 0 ? 'carried' : '';
        return {
          key: 'sge_au9999',
          name: '上海金Au99.99',
          market: 'SGE',
          price: row.close,
          open: row.open,
          high: row.high,
          low: row.low,
          prevClose: row.prevClose,
          changePct: row.changePct,
          updatedAt: `${row.date}T15:30:00+08:00`, // 收盘后发布
          note,
        };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('上海金：最近 8 个自然日均无 Au99.99 数据');
}

/** 从 SGE 每日行情 HTML 中解析 Au99.99 行 */
function this_parseSgeRow(html) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      stripTags(c[1])
    )
  );
  for (const r of rows) {
    // 形如 ["2","2026-10-28","Au99.99","862.50","873.00","860.20","868.99","8.68","1.01%",...]
    // 契约列可能是 "Au99.99" 或前面带序号的组合，按「精确等于 Au99.99」定位，
    // 避免误匹配 "iAu99.99"（递延合约）。
    const i = r.findIndex((c) => c === 'Au99.99');
    if (i < 0) continue;
    const date = r[i - 1];
    const open = num(r[i + 1]);
    const high = num(r[i + 2]);
    const low = num(r[i + 3]);
    const close = num(r[i + 4]);
    const chg = num(r[i + 5]);
    const pct = num(r[i + 6]);
    if (close === null) continue;
    return {
      date,
      open, high, low, close,
      changePct: pct,
      // 昨收由「收盘价 − 涨跌额」反推
      prevClose: chg === null ? null : Number((close - chg).toFixed(4)),
    };
  }
  return null;
}

// ============================================================================
// §3.4 人民币中间价（usdcny）—— 中国货币网
// ============================================================================
// 规格书假设该页是 JS 渲染的 HTML。实测页面确实是 JS 渲染，但站方同时提供了
// 公开 JSON 接口，直接可用，更稳（无需解析 DOM）：
//   https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json
// 结构：{ data:{lastDate}, records:[{vrtEName:'USD/CNY', price:'6.7165', bpDouble:-6}] }
// ⚠ 规格书的备用源 secid=133.USDCNY 实测返回 data:null（该 secid 不存在）。
//   可用的离岸价 secid 是 133.USDCNH（美元兑离岸人民币），但那是 CNH 不是中间价，
//   仅作兜底并标注 note，不作为主源。
async function fetchUsdcny() {
  // ---- 主源：中国货币网公开 JSON ----
  let primaryErr = null;
  try {
    const j = await get(
      'https://www.chinamoney.com.cn/r/cms/www/chinamoney/data/fx/ccpr.json',
      { json: true, headers: { Referer: 'https://www.chinamoney.com.cn/chinese/bkccpr/' }, retries: 1 }
    );
    const rec = (j?.records || []).find((r) => r.vrtEName === 'USD/CNY');
    if (!rec) throw new Error('中国货币网未返回 USD/CNY');
    const price = num(rec.price);
    if (price === null) throw new Error(`中国货币网 price 非法(${rec.price})`);
    // bpDouble 为基点变化（1bp = 0.0001），据此反推昨收
    const bp = Number(rec.bpDouble);
    const prevClose = Number.isFinite(bp) ? Number((price - bp / 10000).toFixed(4)) : null;
    const lastDate = j?.data?.lastDate || '';
    const dt = String(lastDate).match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
    return {
      key: 'usdcny',
      name: '人民币中间价',
      market: 'FX',
      price,
      prevClose,
      changePct: prevClose ? Number((((price - prevClose) / prevClose) * 100).toFixed(4)) : null,
      updatedAt: dt ? `${dt[1]}T${dt[2].padStart(5, '0')}:00+08:00` : isoCN(),
      note: '',
    };
  } catch (err) {
    primaryErr = err;
  }

  // ---- 备用源：东方财富 ----
  // ⚠ 规格书写的 secid=133.USDCNY 实测 data:null（该 secid 不存在）；
  //   实际可用的是 133.USDCNH（美元兑离岸人民币 CNH）。
  //   CNH 离岸价 ≠ 在岸中间价（实测 6.6634 vs 中间价 6.7165，差约 0.8%），
  //   故按规格要求在 note 上标记，只作兜底不作主源。
  try {
    const j = await get(
      'https://push2.eastmoney.com/api/qt/stock/get?secid=133.USDCNH&fields=f43,f44,f45,f46,f60,f169,f170',
      { json: true, headers: { Referer: 'https://quote.eastmoney.com/' } }
    );
    const d = j?.data;
    if (!d || !d.f43) throw new Error(`东方财富无数据(rc=${j?.rc})`);
    const price = Number(d.f43) / 10000;
    const prevClose = Number(d.f60) / 10000;
    return {
      key: 'usdcny',
      name: '人民币中间价',
      market: 'FX',
      price,
      prevClose,
      changePct: d.f170 !== undefined ? Number(d.f170) : null,
      updatedAt: isoCN(),
      note: 'estimated', // 备用源是 CNH 离岸价，非官方中间价
    };
  } catch (err) {
    throw new Error(`主源失败(${primaryErr?.message})；备用源失败(${err.message})`);
  }
}

// ============================================================================
// §3.5 1Y 国债收益率（cgb_1y）—— 中债收益率曲线
// ============================================================================
// 接口：https://yield.chinabond.com.cn/cbweb-cbrc-web/cbrc/queryGjqxInfo?workTime=YYYY-MM-DD
// 表格结构（实测）：
//   表头：["2026-10-28(%)","隔夜 隔夜","3月","6月","1年","3年","5年","7年","10年","30年"]
//   行：  ["中债国债收益率曲线","0.9306","1.1634","1.1648","1.1693",...]
// 即：第 0 列是曲线名，其后依次为隔夜/3月/6月/1年/3年/5年/7年/10年/30年，
// 「1年」= 第 4 列。
// ⚠ 休市日（或当天曲线尚未发布）该接口只返回表头、没有数据行 → 需回退到上一交易日。
//
// 抽出成独立函数：日更（portfolio-collect）与历史回补（scripts/backfill-cgb1y.mjs）共用。
/**
 * 取中债国债收益率曲线的「1 年期」值。
 * @param {string} day YYYY-MM-DD
 * @returns {Promise<{srcDate: string, oneY: number}|null>} 该日没有曲线时返回 null
 */
export async function fetchCgbCurveOneY(day) {
  const html = await get(
    `https://yield.chinabond.com.cn/cbweb-cbrc-web/cbrc/queryGjqxInfo?workTime=${day}&locale=zh_CN`,
    { headers: { Referer: 'https://yield.chinabond.com.cn/' }, retries: 1 }
  );
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]))
  );
  const cgb = rows.find((r) => r[0] && r[0].includes('中债国债收益率曲线'));
  if (!cgb) return null;
  const oneY = num(cgb[4]);
  if (oneY === null) return null;
  // 表头首格形如 "2026-10-28(%)"，取其中的日期（可能是回退到的上一交易日）
  const hdr = rows[0]?.[0] || '';
  const dm = hdr.match(/(\d{4}-\d{2}-\d{2})/);
  return { srcDate: dm ? dm[1] : day, oneY };
}

async function fetchCgb1y() {
  let lastErr = null;
  for (let back = 0; back <= 7; back++) {
    const d = new Date(Date.now() - back * 86400000);
    const day = ymd(d);
    try {
      const c = await fetchCgbCurveOneY(day);
      if (!c) { lastErr = new Error(`中债 ${day} 无国债收益率曲线`); continue; }
      const { srcDate, oneY } = c;
      return {
        key: 'cgb_1y',
        name: '1Y国债收益率',
        market: 'CN',
        price: oneY,
        // 收益率没有「昨收」，用上一交易日的同口径值；此处先留空，由调用方补
        prevClose: null,
        changePct: null,
        updatedAt: `${srcDate}T17:00:00+08:00`,
        note: back > 0 ? 'carried' : '',
        // 内部用：实际命中的数据日期，供 fetchPrevCgb1y 从「该日的前一天」起算
        _srcDate: srcDate,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('中债：最近 8 个自然日均无国债收益率曲线');
}

// ============================================================================
// 5 个新增行情 key
// ============================================================================

export const PORTFOLIO_QUOTES = [
  { key: 'ndx', label: '纳指100', run: fetchNdx },
  { key: 'xau', label: '伦敦金', run: fetchXau },
  { key: 'xag', label: '伦敦银', run: fetchXag },
  { key: 'brent', label: '布伦特原油', run: fetchBrent },
  { key: 'sge_au9999', label: '上海金Au99.99', run: fetchSgeAu9999 },
  { key: 'usdcny', label: '人民币中间价', run: fetchUsdcny },
  { key: 'cgb_1y', label: '1Y国债收益率', run: fetchCgb1y },
];

/**
 * 取 cgb_1y 的「上一交易日」同口径值（用于算日环比）。
 * ⚠ fromDate 必须是**实际命中的数据日期**，而不是「今天」。
 *   之前固定从「今天往前 1 天」起算，当今天尚未发布曲线（回退到前一交易日命中）时，
 *   会把命中日自己当成 prevClose → changePct 恒为 0。
 * @param {string} fromDate 实际命中的数据日期 YYYY-MM-DD
 */
async function fetchPrevCgb1y(fromDate) {
  const base = Date.parse(`${fromDate}T00:00:00Z`);
  if (Number.isNaN(base)) return null;
  for (let back = 1; back <= 7; back++) {
    const day = ymd(new Date(base - back * 86400000));
    let html;
    try {
      html = await get(
        `https://yield.chinabond.com.cn/cbweb-cbrc-web/cbrc/queryGjqxInfo?workTime=${day}&locale=zh_CN`,
        { headers: { Referer: 'https://yield.chinabond.com.cn/' } }
      );
    } catch {
      continue; // 单日取不到就继续往前
    }
    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
      [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]))
    );
    const cgb = rows.find((r) => r[0] && r[0].includes('中债国债收益率曲线'));
    if (cgb) {
      const v = num(cgb[4]);
      if (v !== null) return v;
    }
  }
  return null;
}

/**
 * 采集 5 个新增行情 key。
 * 每个源独立容错（单源失败不影响其他源）；失败原因按 §6 记录。
 * @param {object[]} prevQuotes 上一次已写入的行情（用于 §3.3 的 estimated 回退）
 * @returns {Promise<{quotes: object[], ok: string[], fail: object}>}
 */
export async function fetchPortfolioQuotes(prevQuotes = []) {
  const settled = await Promise.allSettled(
    PORTFOLIO_QUOTES.map(async (s) => {
      const q = await s.run();
      const bad = validateQuote(q);
      if (bad) throw new Error(`${s.label}：${bad}`);
      return q;
    })
  );

  const quotes = [];
  const ok = [];
  const fail = {};
  let cgbSrcDate = null;
  settled.forEach((r, i) => {
    const s = PORTFOLIO_QUOTES[i];
    if (r.status === 'fulfilled' && r.value) {
      const q = { ...r.value };
      if (q._srcDate) { cgbSrcDate = q._srcDate; delete q._srcDate; }
      quotes.push(q);
      ok.push(s.key);
    } else {
      fail[s.key] = String(r.reason?.message || r.reason).slice(0, 200);
    }
  });

  // cgb_1y 补上一交易日的同口径值 → 算出涨跌幅（收益率按 bp 变化更直观，
  // 这里给百分比变化，与其余 key 的 changePct 口径保持一致）
  const cgb = quotes.find((q) => q.key === 'cgb_1y');
  if (cgb && cgb.prevClose === null && cgbSrcDate) {
    try {
      const prev = await fetchPrevCgb1y(cgbSrcDate);
      if (prev !== null && prev > 0) {
        cgb.prevClose = prev;
        cgb.changePct = Number((((cgb.price - prev) / prev) * 100).toFixed(4));
      }
    } catch { /* 拿不到就留空，不影响其他 key */ }
  }

  // ---- §3.3 上海金的 estimated 回退 ----
  // 规格：页面解析失败时，用「伦敦金涨跌幅 ± 汇率调整」估算，并在 note 标 estimated。
  // 基准价取上一次已写入的上海金收盘价（同一解析器此时已不可用，只能取存量值）。
  //   估算式：SGE ≈ 上次收盘 × (1 + 伦敦金涨跌幅%) × (中间价现价 / 中间价昨收)
  //   后一项是汇率调整：人民币走弱时，人民币计价金价相对美元金价上涨。
  if (!quotes.some((q) => q.key === 'sge_au9999')) {
    const est = estimateSgeAu9999(quotes, prevQuotes);
    if (est) {
      const bad = validateQuote(est);
      if (bad) {
        fail.sge_au9999 = `估算值未通过校验：${bad}（原失败原因：${fail.sge_au9999}）`;
      } else {
        quotes.push(est);
        ok.push('sge_au9999');
        delete fail.sge_au9999;
      }
    }
  }

  return { quotes: quotes.map(markStale), ok, fail };
}

// ============================================================================
// §3.5 高频（15 分钟）版组合行情
// ============================================================================
// 背景（2026-10-31）：组合行情原先只由每天 16:30 的 portfolio-collect 采一次，
// 对美股指数 / 24 小时贵金属就意味着「收盘后要等第二天才有新值」。
// 现在并入 Actions 的 15 分钟采集，但不是所有 key 都值得每 15 分钟抓一遍：
//   · 正在交易（ndx 已并入指数批量；xau/xag/brent 24 小时）→ 每轮取；
//   · 一天只发布一次（上海金 15:30 / 中间价 09:15 / 1Y国债 17:00）
//     → 过了发布时刻且存量不是今天的，才重取。
const DAILY_PUBLISH = { sge_au9999: '15:30', usdcny: '09:15', cgb_1y: '17:00' };

/** 北京时间的 日期 / 时刻 / 星期（0=周日） */
function beijingNowParts(d = new Date()) {
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return {
    date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`,
    hm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    wd: t.getUTCDay(),
  };
}

function dueInFastFetch(key, prevQ, now) {
  const publish = DAILY_PUBLISH[key];
  if (!publish) return true;                        // 交易中的品种：每轮都取
  if (now.wd === 0 || now.wd === 6) return false;   // 日频源周末不发布
  if (now.hm < publish) return false;               // 还没到发布时刻
  const d = String(prevQ?.updatedAt || '').slice(0, 10);
  return !d || d < now.date;                        // 存量不是今天的 → 重取
}

/**
 * 高频采集（collect.mjs 每 15 分钟调用）：只取「该取」的组合行情。
 * 没到的 key 不返回，由调用方保留 quotes.json 里的存量值。
 * @param {object[]} prevQuotes 上一份 quotes.json 的 quotes
 */
export async function fetchPortfolioQuotesFast(prevQuotes = []) {
  const now = beijingNowParts();
  const prev = new Map(prevQuotes.map((q) => [q.key, q]));
  const due = PORTFOLIO_QUOTES.filter(
    (s) => s.key !== 'ndx' && dueInFastFetch(s.key, prev.get(s.key), now)
  );
  const settled = await Promise.allSettled(
    due.map(async (s) => {
      const q = await s.run();
      const bad = validateQuote(q);
      if (bad) throw new Error(`${s.label}：${bad}`);
      return q;
    })
  );
  const quotes = [];
  const ok = [];
  const fail = {};
  let cgbSrcDate = null;
  settled.forEach((r, i) => {
    const s = due[i];
    if (r.status === 'fulfilled' && r.value) {
      const q = { ...r.value };
      if (q._srcDate) { cgbSrcDate = q._srcDate; delete q._srcDate; }
      quotes.push(q);
      ok.push(s.key);
    } else {
      fail[s.key] = String(r.reason?.message || r.reason).slice(0, 200);
    }
  });
  const cgb = quotes.find((q) => q.key === 'cgb_1y');
  if (cgb && cgb.prevClose === null && cgbSrcDate) {
    try {
      const p = await fetchPrevCgb1y(cgbSrcDate);
      if (p !== null && p > 0) {
        cgb.prevClose = p;
        cgb.changePct = Number((((cgb.price - p) / p) * 100).toFixed(4));
      }
    } catch { /* 拿不到就留空 */ }
  }
  return { quotes: quotes.map(markStale), ok, fail };
}

/**
 * §3.3 的估算回退：拿不到 SGE 实时行情时，用伦敦金涨跌幅 + 汇率调整估算上海金。
 * @returns {object|null} 无法估算时返回 null
 */
function estimateSgeAu9999(quotes, prevQuotes) {
  const ref = (prevQuotes || []).find((q) => q.key === 'sge_au9999');
  const xau = quotes.find((q) => q.key === 'xau');
  const fx = quotes.find((q) => q.key === 'usdcny');
  if (!ref || !(ref.price > 0)) return null;
  if (!xau || xau.changePct === null || xau.changePct === undefined) return null;

  const fxFactor = fx && fx.price > 0 && fx.prevClose > 0 ? fx.price / fx.prevClose : 1;
  const price = Number((ref.price * (1 + xau.changePct / 100) * fxFactor).toFixed(4));
  return {
    key: 'sge_au9999',
    name: '上海金Au99.99',
    market: 'SGE',
    price,
    open: null,
    high: null,
    low: null,
    prevClose: ref.price,
    changePct: Number((((price - ref.price) / ref.price) * 100).toFixed(4)),
    updatedAt: isoCN(),
    note: 'estimated',
  };
}

// ============================================================================
// §4.2 宏观指标（data/macro/daily.json）
// ============================================================================
// 规格书 §8 把这一组放在「第二阶段（按月）」，但 §0 的说明又要求每天写入。
// 这里按「能取到就取，取不到就跳过该条」实现，不因单项缺失而整轮失败。

/** 两融余额：沪深两市融资余额合计（亿元） */
async function fetchMargin() {
  // 上交所：融资余额（元）
  const sse = await get(
    'https://query.sse.com.cn/marketdata/tradedata/queryMargin.do' +
      '?isPagination=true&tradeDate=&pageHelp.pageSize=3&pageHelp.pageNo=1' +
      '&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1',
    { json: true, headers: { Referer: 'https://www.sse.com.cn/' }, retries: 1 }
  );
  const d0 = sse?.pageHelp?.data?.[0];
  const sseRzye = Number(d0?.rzye);
  if (!Number.isFinite(sseRzye)) throw new Error('上交所两融数据缺失');

  // 深交所：融资余额（亿元），接口需要显式日期，取上交所返回的交易日
  const opDate = String(d0?.opDate || '');
  const day = opDate.length === 8
    ? `${opDate.slice(0, 4)}-${opDate.slice(4, 6)}-${opDate.slice(6, 8)}`
    : ymd(new Date());
  const szse = await get(
    `https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1837_xxpl` +
      `&TABKEY=tab1&txtDate=${day}&random=0.3`,
    { json: true, headers: { Referer: 'https://www.szse.cn/market/stock/financing/index.html' }, retries: 1 }
  );
  const sd = Array.isArray(szse) ? szse[0]?.data?.[0] : null;
  const szseRzye = num(sd?.jrrzye);
  if (szseRzye === null) throw new Error('深交所两融数据缺失');

  return {
    key: 'margin',
    name: '两融余额',
    value: Number((sseRzye / 1e8 + szseRzye).toFixed(2)),
    unit: '亿元',
    source: '上交所+深交所',
  };
}

/** 10Y 美债收益率（%）：FRED DGS10 */
async function fetchUs10y() {
  const csv = await get(
    'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=' + ymd(new Date(Date.now() - 30 * 86400000)),
    { headers: { Referer: 'https://fred.stlouisfed.org/' }, retries: 1 }
  );
  const lines = csv.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const [date, v] = lines[i].split(',');
    const val = num(v);
    if (val !== null && val > 0) {
      return { key: 'us10y', name: '10Y美债', value: val, unit: '%', source: 'FRED', note: date };
    }
  }
  throw new Error('FRED DGS10 无有效值');
}

/** 社会融资规模增量（亿元）：人民银行「社会融资规模增量统计表」 */
async function fetchSocialFinancing() {
  // 索引页 → 找最新的「社会融资规模增量统计表」htm 附件
  const idx = await get(
    'https://www.pbc.gov.cn/diaochatongjisi/116219/116319/2026ntjsj/shrzgm/index.html',
    { headers: { Referer: 'https://www.pbc.gov.cn/' }, retries: 1 }
  );
  const m = idx.match(/href="(\/diaochatongjisi\/attachDir\/\d{4}\/\d{2}\/\d+\.htm)"[^>]*>\s*htm/);
  // 上面的正则可能匹配到「存量」表，需要确认标题
  let href = null;
  for (const mm of idx.matchAll(/href="(\/diaochatongjisi\/attachDir\/\d{4}\/\d{2}\/\d+\.htm)"[^>]*>\s*htm/g)) {
    const around = idx.slice(Math.max(0, mm.index - 400), mm.index);
    if (around.includes('增量统计表')) { href = mm[1]; break; }
    if (!href) href = mm[1];
  }
  if (!href) throw new Error('人民银行：未找到社会融资规模增量表链接');
  const html = await get('https://www.pbc.gov.cn' + href, {
    headers: { Referer: 'https://www.pbc.gov.cn/' }, gbk: true, retries: 1,
  });
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((mm) =>
    [...mm[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(c[1]))
  );
  // 数据行首列形如 "2026.09"，第二列是当月社融增量（亿元）
  let best = null;
  for (const r of rows) {
    const mm = String(r[0] || '').match(/^(\d{4})\.(\d{2})$/);
    if (!mm) continue;
    const v = num(r[1]);
    if (v === null) continue;
    const ym = `${mm[1]}-${mm[2]}`;
    if (!best || ym > best.ym) best = { ym, v };
  }
  if (!best) throw new Error('人民银行：未解析到社融增量数值');
  return { key: 'social_financing', name: '社融增量', value: best.v, unit: '亿元', source: '人民银行', note: best.ym };
}

/** CPI 同比（%）：东方财富宏观数据 */
async function fetchCpi() {
  const j = await get(
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_CPI' +
      '&columns=ALL&pageNumber=1&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB',
    { json: true, headers: { Referer: 'https://data.eastmoney.com/' }, retries: 1 }
  );
  const rec = j?.result?.data?.[0];
  const v = num(rec?.NATIONAL_SAME);
  if (v === null) throw new Error('CPI 同比缺失');
  return { key: 'cpi', name: 'CPI同比', value: v, unit: '%', source: '国家统计局', note: rec?.TIME || '' };
}

/** 制造业 PMI：东方财富宏观数据 */
async function fetchPmi() {
  const j = await get(
    'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_ECONOMY_PMI' +
      '&columns=ALL&pageNumber=1&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB',
    { json: true, headers: { Referer: 'https://data.eastmoney.com/' }, retries: 1 }
  );
  const rec = j?.result?.data?.[0];
  const v = num(rec?.MAKE_INDEX);
  if (v === null) throw new Error('制造业 PMI 缺失');
  return { key: 'pmi', name: '制造业PMI', value: v, unit: '', source: '国家统计局', note: rec?.TIME || '' };
}

export const MACRO_INDICATORS = [
  { key: 'margin', label: '两融余额', run: fetchMargin },
  { key: 'us10y', label: '10Y美债', run: fetchUs10y },
  { key: 'social_financing', label: '社融增量', run: fetchSocialFinancing },
  { key: 'cpi', label: 'CPI同比', run: fetchCpi },
  { key: 'pmi', label: '制造业PMI', run: fetchPmi },
];

/**
 * 采集 5 个宏观指标（单条失败只跳过该条）。
 * @returns {Promise<{items: object[], ok: string[], fail: object}>}
 */
export async function fetchMacroIndicators() {
  const settled = await Promise.allSettled(MACRO_INDICATORS.map(async (s) => s.run()));
  const items = [];
  const ok = [];
  const fail = {};
  settled.forEach((r, i) => {
    const s = MACRO_INDICATORS[i];
    if (r.status === 'fulfilled' && r.value) {
      items.push(r.value);
      ok.push(s.key);
    } else {
      fail[s.key] = String(r.reason?.message || r.reason).slice(0, 200);
    }
  });
  return { items, ok, fail };
}
