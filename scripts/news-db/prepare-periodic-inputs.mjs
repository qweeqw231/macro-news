// scripts/news-db/prepare-periodic-inputs.mjs
// 为周期报告（周报/月报）准备写作输入：把本地库里某一期该读的新闻条目，
// 按「一期一组 TSV」导出到 .local/periodic-inputs/，让外部写作方（minimaxcode）
// 不必自己翻库、也不必读几十万条原始归档。
//
// 为什么放 .local/：这是派生中间产物，只在本机用，绝不进 git；
// 写作方只允许 `git add data/periodic/`，所以这里不会被提交。
//
// 2024 年的历史数据只有标题（content_status=title_only，date_precision=day，
// 时间统一是当日 12:00:00+08:00）。因此：
//   - 财经频道（cj）与政策监管条目全量保留；
//   - 国内/国际/华人频道按宏观关键词筛选，滤掉体育、娱乐、灾害等噪音；
//   - 同期同标题去重。
//
// 用法：
//   node scripts/news-db/prepare-periodic-inputs.mjs \
//     --ranges 2024-01-01:2024-02-29,2024-09-01:2024-10-31
//   node scripts/news-db/prepare-periodic-inputs.mjs --out .local/periodic-inputs --part-size 500

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_DB } from './db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};
const num = (name, dflt) => {
  const v = Number(arg(name, dflt));
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

const DB = path.resolve(ROOT, arg('db', DEFAULT_DB));
const OUT = path.resolve(ROOT, arg('out', '.local/periodic-inputs'));
const RANGES = String(arg('ranges', '2024-01-01:2024-02-29,2024-09-01:2024-10-31'))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const PART_SIZE = num('part-size', 500);

const DAY_MS = 86400000;
const d2t = (s) => Date.parse(`${s}T00:00:00Z`);
const t2d = (n) => new Date(n).toISOString().slice(0, 10);
const addDays = (s, n) => t2d(d2t(s) + n * DAY_MS);

/** ISO 周：周一为首日，含 1 月 4 日的那周为第 1 周 */
function isoWeekOf(day) {
  const t = new Date(`${day}T00:00:00Z`);
  const wd = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - wd);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return { id: `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`, year: t.getUTCFullYear() };
}
function mondayOf(day) {
  const t = new Date(`${day}T00:00:00Z`);
  const wd = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() - (wd - 1));
  return t2d(t.getTime());
}

function monthWindow(ym) {
  const [y, m] = ym.split('-').map(Number);
  const from = `${ym}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${ym}-${String(last).padStart(2, '0')}` };
}

/** 生成期次清单：周报取「周一落在窗口内」的 ISO 周；月报取整月落在窗口内的自然月 */
function buildIssues(ranges) {
  const issues = [];
  const seen = new Set();
  for (const r of ranges) {
    const [start, end] = r.split(':');
    if (!start || !end) throw new Error(`区间格式应为 from:to，实际 ${r}`);
    // 周报：只取「周一落在窗口内」的 ISO 周（周一在窗口前的残周归上一期，不重复计入）
    let m0 = mondayOf(start);
    if (m0 < start) m0 = addDays(m0, 7);
    for (let m = m0; m <= end; m = addDays(m, 7)) {
      const { id } = isoWeekOf(m);
      const to = addDays(m, 6);
      if (seen.has(id)) continue;
      seen.add(id);
      issues.push({ type: 'week', id, from: m, to, days: 7 });
    }
    // 月报：整月都在窗口内
    let cur = `${start.slice(0, 7)}-01`;
    while (cur <= end) {
      const ym = cur.slice(0, 7);
      const w = monthWindow(ym);
      if (w.from >= start && w.to <= end && !seen.has(ym)) {
        seen.add(ym);
        issues.push({ type: 'month', id: ym, from: w.from, to: w.to, days: Math.round((d2t(w.to) - d2t(w.from)) / DAY_MS) + 1 });
      }
      const [y, mo] = ym.split('-').map(Number);
      cur = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
    }
  }
  // 按 window.to 降序（与索引排序一致），便于写作方从新到旧推进
  return issues.sort((a, b) => (a.to < b.to ? 1 : a.to > b.to ? -1 : a.id < b.id ? 1 : -1));
}

const MACRO_RE = new RegExp(
  [
    '经济', '金融', '央行', '货币', '信贷', '贷款', '存款', '利率', '降息', '降准', 'LPR', 'MLF', '逆回购',
    '汇率', '人民币', '美元', '外汇', '储备', '黄金', '债券', '国债', '股市', 'A股', '沪指', '上证', '深证',
    '创业板', '科创板', '港股', '美股', '纳斯达克', '道琼斯', '标普', '期货', '原油', '油价', '楼市', '房地产',
    '房价', '房贷', '土地', '财政', '税', '专项债', '政策', '监管', '证监会', '金融监管', '发改委', '统计局',
    'CPI', 'PPI', 'PMI', 'GDP', '社融', 'M2', '进出口', '外贸', '关税', '贸易', '美联储', '欧洲央行', '日本央行',
    '加息', '通胀', '通缩', '就业', '非农', '失业', '制造业', '工业增加值', '社零', '消费', '投资', '基建',
    '债务', '城投', '违约', '市值', '上市', 'IPO', '并购', '回购', '分红', '减持', '增持', '基金', '保险',
    '银行', '券商', '信托', '理财', '私募', '公募', '比特币', '加密货币', '中欧班列', '自贸', '开放',
  ].join('|'),
  'i',
);
// 只在非财经频道生效的噪音过滤（灾害/文体/社会新闻）
const NOISE_RE = /(体育|足球|篮球|排球|网球|乒乓|奥运|亚运|明星|演员|歌手|电影|电视剧|综艺|演唱会|彩票|天气|台风|暴雨|洪水|泥石流|地震|海啸|火山|火灾|车祸|交通事故|犯罪|判刑|诈骗|毒品|疫情|流感|病毒|医院|学校|考试|高考)/;

const KEEP_CHANNELS = new Set(['cj', '政策监管']);

function relevant(row) {
  const t = String(row.title || '');
  if (!t) return false;
  if (KEEP_CHANNELS.has(row.channel)) return true;
  if (row.kind === 'official') return true;
  if (NOISE_RE.test(t)) return false;
  return MACRO_RE.test(t);
}

const esc = (s) => String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();

function main() {
  const issues = buildIssues(RANGES);
  fs.mkdirSync(OUT, { recursive: true });
  // 清掉上一轮留下的同名派生文件，避免过期期次残留
  for (const f of fs.readdirSync(OUT)) {
    if (/\.part\d+\.tsv$/.test(f) || /\.meta\.json$/.test(f) || f === 'manifest.json') {
      fs.unlinkSync(path.join(OUT, f));
    }
  }
  const db = openDb(DB);
  const q = db.prepare(`
    SELECT published_at, source, channel, title, url, kind
    FROM items
    WHERE published_at >= ? AND published_at < ?
    ORDER BY published_at ASC, title ASC
  `);

  const manifest = [];
  for (const it of issues) {
    const fromAt = `${it.from}T08:00:00+08:00`;
    const toAt = `${addDays(it.to, 1)}T08:00:00+08:00`;
    const rows = q.all(fromAt, toAt);
    const byDay = new Map();
    const seenTitle = new Set();
    const picked = [];
    for (const r of rows) {
      const day = String(r.published_at).slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      if (!relevant(r)) continue;
      const key = String(r.title).replace(/\s+/g, '');
      if (seenTitle.has(key)) continue;
      seenTitle.add(key);
      picked.push(r);
    }
    const allDays = [];
    for (let d = it.from; d <= it.to; d = addDays(d, 1)) allDays.push(d);
    const missingDays = allDays.filter((d) => !byDay.has(d));
    const archiveDays = allDays.length - missingDays.length;

    const parts = [];
    for (let i = 0; i < picked.length; i += PART_SIZE) {
      const chunk = picked.slice(i, i + PART_SIZE);
      const idx = parts.length + 1;
      const name = `${it.id}.part${String(idx).padStart(2, '0')}.tsv`;
      const lines = [
        `# ${it.id} | ${it.type} | ${it.from} ~ ${it.to} | 第 ${idx} 批 / 共 ${Math.ceil(picked.length / PART_SIZE)} 批`,
        '# 列：序号\t时间\t来源\t频道\t标题\t链接（标题-only 归档，时间只到日，统一 12:00:00+08:00）',
      ];
      chunk.forEach((r, j) => {
        lines.push([
          i + j + 1,
          esc(r.published_at),
          esc(r.source),
          esc(r.channel),
          esc(r.title),
          esc(r.url),
        ].join('\t'));
      });
      fs.writeFileSync(path.join(OUT, name), lines.join('\n') + '\n', 'utf8');
      parts.push({
        file: name,
        count: chunk.length,
        firstAt: chunk[0] ? chunk[0].published_at : '',
        lastAt: chunk[chunk.length - 1] ? chunk[chunk.length - 1].published_at : '',
      });
    }

    const meta = {
      id: it.id,
      type: it.type,
      window: { from: it.from, to: it.to, fromAt, toAt, days: it.days },
      // 直接抄进报告 coverage 的三个数
      coverage: { archiveDays, newsItems: picked.length, missingDays },
      rawItems: rows.length,
      parts,
      note: '2024 历史归档只有标题，无摘要与正文；summary/why 只能基于标题与可核实事实。',
    };
    fs.writeFileSync(path.join(OUT, `${it.id}.meta.json`), JSON.stringify(meta, null, 2) + '\n', 'utf8');

    manifest.push({
      id: it.id,
      type: it.type,
      window: meta.window,
      coverage: meta.coverage,
      rawItems: meta.rawItems,
      parts: parts.map((p) => p.file),
    });
    console.log(
      `${it.id}  ${it.from}~${it.to}  原始 ${rows.length} → 入选 ${picked.length}` +
        `  ${parts.length} 个文件  缺采 ${missingDays.length} 天`
    );
  }

  const doc = {
    schema: 'macro-news/periodic-inputs@1',
    generatedAt: new Date().toISOString(),
    ranges: RANGES,
    count: manifest.length,
    issues: manifest,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const bytes = manifest.reduce((a, m) => a + m.parts.length, 0);
  console.log(`\n共 ${manifest.length} 期 / ${bytes} 个输入文件 → ${path.relative(ROOT, OUT)}`);
  return 0;
}

process.exitCode = main();
