// src/etf.mjs
// 场内 ETF 清单与适配器
//
// ── 考察方法（2026-10-29 本机实测，非推测）──
//   1) 东财 clist 端点 fs=b:MK0021..MK0024 拉全市场 **1655 只**场内 ETF
//      （含 f13 市场前缀、f6 成交额、f20 规模）；分页拉全，1655/1655 到位。
//   2) 按主题关键词聚类，每个主题按「成交额 + 规模」排序取最优的一只作代表，
//      避免同质化堆砌（例：机器人主题有 17 只，取易方达 159530）。
//   3) 逐只走**单只** stock/get 验证：32/32 全部可用，字段口径与指数完全一致
//      （f43 价 / f60 昨收 / f170 涨跌幅 / f86 源时间戳 / f58 名称）。
//   ⚠ 东财 ulist.np 批量端点对 ETF 一律返回 "-"（指数可用），所以 ETF 必须单只取。
//
// ── 为什么跟踪「场内 ETF」而不是「ETF 联接基金」──
//   联接基金是**场外**开放式基金：只有每日净值，没有盘中价，也没有分钟 K 线。
//   场内 ETF 有实时价 + 5 分钟 K 线（能回溯到 11:30 / 15:00 的时点价）。
//   联接基金跟踪的正是这些场内 ETF（跟踪自家 ETF 的基金同理），
//   所以跟踪场内 ETF 即可覆盖联接基金所反映的那一份价格。
//
// ── 清单取舍原则 ──
//   · 宽基（沪深300 / 中证500 / 中证1000 / 创业板 / 科创50…）都有现成指数，
//     指数口径更标准，**不重复收 ETF**；只留「没有对应指数」的中证A500。
//   · 行业 / 主题类（机器人、中概互联网、创新药…）没有便捷指数，
//     必须用场内 ETF 作代理 —— 这正是本次考察的重点。
//   · 跨境主题 ETF（中概互联、港股通互联网、港股通红利、港股创新药）同理，
//     它们跟踪的指数在东财没有可直接取的行情入口。
//   · 黄金 ETF 与伦敦金/上海金重复度较高，保留 1 只作「场内可交易价」视角。
//
// key 规则：etf_<6 位代码>，与指数 key（sh_comp 等）不冲突。


/**
 * @typedef {object} EtfDef
 * @property {string} key       行情 key（etf_<代码>）
 * @property {string} name      简称（东财 f58 为全称，抓取时以 f58 为准）
 * @property {string} secid     东财 secid（1.=沪市 0.=深市）
 * @property {string} theme     主题分组
 * @property {string} [region]  标的所属市场（CN=A股场内；HK/US=跨境）
 * @property {string} [note]    入选说明
 */

/** @type {EtfDef[]} */
export const ETFS = [
  // ---- 宽基（仅收没有对应指数的中证A500）----
  { key: 'etf_563360', name: '中证A500ETF', secid: '1.563360', theme: '宽基', note: '中证A500 无对应指数入口' },

  // ---- 科技 / AI ----
  { key: 'etf_159819', name: '人工智能ETF', secid: '0.159819', theme: '科技AI' },
  { key: 'etf_159530', name: '机器人ETF', secid: '0.159530', theme: '科技AI', note: '用户点名：机器人行业无便捷指数' },
  { key: 'etf_588200', name: '科创芯片ETF', secid: '1.588200', theme: '科技AI' },
  { key: 'etf_159516', name: '半导体设备ETF', secid: '0.159516', theme: '科技AI' },
  { key: 'etf_158050', name: '创业板算力ETF', secid: '0.158050', theme: '科技AI' },
  { key: 'etf_159732', name: '消费电子ETF', secid: '0.159732', theme: '科技AI' },

  // ---- 互联网 / 中概 ----
  { key: 'etf_513050', name: '中概互联网ETF', secid: '1.513050', theme: '互联网', region: 'US', note: '用户点名：中概互联无便捷指数' },
  { key: 'etf_159792', name: '港股通互联网ETF', secid: '0.159792', theme: '互联网', region: 'HK' },

  // ---- 港股 ----
  { key: 'etf_513530', name: '港股通红利ETF', secid: '1.513530', theme: '港股', region: 'HK' },
  { key: 'etf_513120', name: '港股创新药ETF', secid: '1.513120', theme: '港股', region: 'HK' },

  // ---- 医药 ----
  { key: 'etf_512170', name: '医疗ETF', secid: '1.512170', theme: '医药' },
  { key: 'etf_159992', name: '创新药ETF', secid: '0.159992', theme: '医药' },

  // ---- 消费 ----
  { key: 'etf_512690', name: '酒ETF', secid: '1.512690', theme: '消费' },
  { key: 'etf_159766', name: '旅游ETF', secid: '0.159766', theme: '消费' },

  // ---- 金融 ----
  { key: 'etf_512880', name: '证券ETF', secid: '1.512880', theme: '金融' },
  { key: 'etf_512800', name: '银行ETF', secid: '1.512800', theme: '金融' },

  // ---- 资源 / 周期 ----
  { key: 'etf_515220', name: '煤炭ETF', secid: '1.515220', theme: '资源' },
  { key: 'etf_512400', name: '有色金属ETF', secid: '1.512400', theme: '资源' },
  { key: 'etf_516150', name: '稀土ETF', secid: '1.516150', theme: '资源' },

  // ---- 军工 / 制造 ----
  { key: 'etf_512660', name: '军工ETF', secid: '1.512660', theme: '军工制造' },
  { key: 'etf_560280', name: '工程机械ETF', secid: '1.560280', theme: '军工制造' },

  // ---- 新能源 ----
  { key: 'etf_159755', name: '电池ETF', secid: '0.159755', theme: '新能源' },
  { key: 'etf_515790', name: '光伏ETF', secid: '1.515790', theme: '新能源' },

  // ---- 公用 / 农业 / 地产 ----
  { key: 'etf_159611', name: '电力ETF', secid: '0.159611', theme: '公用农业地产' },
  { key: 'etf_159865', name: '养殖ETF', secid: '0.159865', theme: '公用农业地产' },
  { key: 'etf_512200', name: '房地产ETF', secid: '1.512200', theme: '公用农业地产' },

  // ---- 传媒 ----
  { key: 'etf_159869', name: '游戏ETF', secid: '0.159869', theme: '传媒' },

  // ---- 红利 / 风格 ----
  { key: 'etf_512890', name: '红利低波ETF', secid: '1.512890', theme: '红利风格' },
  { key: 'etf_159201', name: '自由现金流ETF', secid: '0.159201', theme: '红利风格' },

  // ---- 跨资产 ----
  { key: 'etf_518880', name: '黄金ETF', secid: '1.518880', theme: '跨资产' },
  { key: 'etf_511990', name: '华宝添益ETF', secid: '1.511990', theme: '跨资产', note: '货币 ETF，现金/流动性代理' },
];

export const ETF_THEMES = [...new Set(ETFS.map((e) => e.theme))];

/**
 * 东财 secid → 腾讯代码（用于 K 线 / 行情的备用源）。
 * 沪市 5xx/58x → sh；深市 0/1xx → sz；北交所 8xx → bj。
 */
export function etfTxCode(secid) {
  const [mkt, code] = String(secid).split('.');
  if (!code) return null;
  if (code.startsWith('899')) return 'bj' + code;
  return mkt === '1' ? 'sh' + code : 'sz' + code;
}

// 实时价缓存 10 分钟：ETF 价格在盘中每分钟都在动，但采集链路是小时级的，
// 缓存只是为了**别把东财打到限流**（实测连打 100+ 请求会被 IP 级反爬）。
const TTL_QUOTE = 10 * 60 * 1000;

const num = (v) => {
  if (v === undefined || v === null || v === '' || v === '-' || v === '—') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const pad = (n) => String(n).padStart(2, '0');

/** epoch 秒 → 北京时间 ISO(+08:00) */
export function isoCNFromEpoch(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  const t = new Date(n * 1000 + 8 * 3600 * 1000);
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`
  );
}
