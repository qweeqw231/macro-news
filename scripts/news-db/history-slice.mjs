// scripts/news-db/history-slice.mjs
// 历史新闻切片的纯函数：选条目、压字段、建索引（不碰磁盘、不碰数据库，便于离线测试）。
//
// 设计文档：docs/superpowers/specs/2026-11-02-history-news-design.md
//
// 为什么要压字段：单日文件是主要体积来源（365 天 × 几百条）。1 字母键 + 省略空字段，
// 实测把单日均值从 64 KB 压到 60 KB 以内；仍然保留可读性，出问题能直接打开看。

export const HISTORY_VERSION = 2;

// 来源权重：官方发布 > 一线财经 > 门户。只用于同日去重与封顶时的取舍，不改展示顺序。
const SOURCE_W = {
  中国人民银行: 7,
  美联储: 7,
  欧洲央行: 7,
  国家统计局: 7,
  华尔街见闻: 5,
  东方财富: 4,
  新浪财经: 3,
  中新网: 3,
};

const BJ_SECONDS = 8 * 3600;
const BJ_MS = BJ_SECONDS * 1000;
const DAY_MS = 86400000;

/** epoch 秒 → 北京日期 'YYYY-MM-DD'（不依赖运行机器的时区） */
export function beijingDay(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  // ⚠ 单位：入参是**秒**，先把 8 小时（秒）加进去再乘 1000，不能加 BJ_MS（毫秒）
  return new Date((n + BJ_SECONDS) * 1000).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 加减天数（按 UTC 日历算，避免夏令时/时区影响） */
export function addDays(day, n) {
  const t = Date.parse(`${day}T00:00:00Z`) + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/** 北京今天（可注入 now 便于测试） */
export function beijingToday(now = Date.now()) {
  return new Date(now + BJ_MS).toISOString().slice(0, 10);
}

/**
 * 计算导出窗口。
 * 默认「到昨天为止的 N 天」：历史切片不含今天（今天还在增长，由 archive 负责）。
 * @returns {{from:string, to:string, days:number}}
 */
export function dayWindow({ days = 365, from = null, to = null, now = Date.now() } = {}) {
  const end = to || addDays(beijingToday(now), -1);
  const start = from || addDays(end, -(Math.max(1, Number(days) || 365) - 1));
  if (start > end) throw new Error(`窗口非法：from ${start} 晚于 to ${end}`);
  const n = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / DAY_MS) + 1;
  return { from: start, to: end, days: n };
}

/** 同日去重/封顶用的优先级分（不改展示顺序） */
export function scoreItem(row) {
  return (
    (SOURCE_W[row.source] || 0) * 10 +
    (row.content_status === 'full' ? 5 : row.content_status === 'summary' ? 3 : 0) +
    (row.kind === 'official' ? 5 : 0)
  );
}

/** 压成单日文件里的条目；空字段直接省略 */
export function packItem(row, summaryChars = 160) {
  const o = { i: row.id, t: String(row.title || '').replace(/\s+/g, ' ').trim() };
  const s = String(row.summary || '').replace(/\s+/g, ' ').trim().slice(0, summaryChars);
  if (s) o.s = s;
  if (row.url) o.u = row.url;
  if (row.channel) o.c = row.channel;
  if (row.source) o.o = row.source;
  if (row.kind === 'official') o.k = 'official';
  if (Number(row.published_ts) > 0) o.p = Number(row.published_ts);
  return o;
}

/**
 * 同一天的选取：先去重（同 hash 留优先级最高的一条），再按优先级封顶，最后按时间降序。
 * @param {Array} rows 同一天的全部条目
 * @returns {Array} 选中的原始行（未压缩）
 */
export function selectDayItems(rows, { limit = 400 } = {}) {
  const best = new Map();
  for (const r of rows) {
    if (!r || !(Number(r.published_ts) > 0)) continue;
    const key = r.hash || String(r.title || '').replace(/\s+/g, '').toLowerCase();
    if (!key) continue;
    const cand = { row: r, score: scoreItem(r), ts: Number(r.published_ts) };
    const prev = best.get(key);
    if (!prev || cand.score > prev.score || (cand.score === prev.score && cand.ts > prev.ts)) {
      best.set(key, cand);
    }
  }
  const picked = [...best.values()]
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
    .slice(0, Math.max(1, Number(limit) || 400))
    .map((x) => x.row);
  return picked.sort((a, b) => Number(b.published_ts) - Number(a.published_ts));
}

/** 生成单日文件对象（不含 JSON 文本，便于先算体积） */
export function buildDayDoc(day, rows, { limit = 400, summaryChars = 160, generatedAt = '' } = {}) {
  const picked = selectDayItems(rows, { limit });
  const doc = {
    v: HISTORY_VERSION,
    d: day,
    n: picked.length,
  };
  if (generatedAt) doc.gen = generatedAt;
  doc.items = picked.map((r) => packItem(r, summaryChars));
  return doc;
}

/**
 * 索引对象。days 传 [{d, n, b}]（b = 文件字节数），按日期降序。
 */
export function buildIndex(days, { generatedAt = '' } = {}) {
  const list = [...days]
    .filter((x) => x && x.d)
    .sort((a, b) => (a.d < b.d ? 1 : -1))
    .map((x) => {
      const o = {
        d: x.d,
        n: Number(x.n) || 0,
        b: Number(x.b) || 0,
        // 与 archive 的 index.json 同口径：默认 false；有早报才写 briefLine（≤80 字）
        hasBriefing: !!x.hasBriefing,
      };
      const line = String(x.briefLine || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (o.hasBriefing && line) o.briefLine = line;
      return o;
    });
  const doc = { v: HISTORY_VERSION };
  if (generatedAt) doc.generatedAt = generatedAt;
  if (list.length) {
    doc.from = list[list.length - 1].d;
    doc.to = list[0].d;
    doc.total = list.reduce((a, x) => a + x.n, 0);
  } else {
    doc.from = '';
    doc.to = '';
    doc.total = 0;
  }
  doc.days = list;
  return doc;
}

/** 输出目录里的天文件名 → 日期（忽略 index.json 等） */
export function dayFromFilename(name) {
  const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(String(name || ''));
  return m ? m[1] : '';
}
