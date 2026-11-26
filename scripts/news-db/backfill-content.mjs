// scripts/news-db/backfill-content.mjs
// 正文回补：对本地库中 content_status=title_only 的历史条目，逐篇抓源站正文，
// 写回 items.content（content_status 升为 full）并同步 FTS。
//
// 数据源与正文容器（已实测）：
//   中新网         <div class="left_zw">...</div>
//   中国人民银行   <div id="UCAP-CONTENT">...</div>（兜底 <td class="content">）
//
// 只处理接入区间的 title_only 条目（默认 2024-01-01~2025-11-01，可调）。
// 正文只落本地库 .local/news.db（git 忽略），历史切片仍仅标题；R2 上传另用脚本。
// 续跑：重跑同一命令即可，已抓到正文（content_status=full）的条目自动跳过。
//
// 用法：
//   node scripts/news-db/backfill-content.mjs --limit 20                 # 先小批验证
//   node scripts/news-db/backfill-content.mjs                            # 全量
//   node scripts/news-db/backfill-content.mjs --source 中新网 --concurrency 8
//   node scripts/news-db/backfill-content.mjs --dry-run

import path from 'node:path';
import { openDb, updateContent, stats, DEFAULT_DB } from './db.mjs';

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
const flag = (name) => process.argv.includes('--' + name);

const DRY = flag('dry-run');
const DB = path.resolve(arg('db', DEFAULT_DB));
const FROM = arg('from', '2024-01-01');
const TO = arg('to', '2025-11-01'); // 不含当天
const SOURCES = arg('source', '中新网,中国人民银行').split(',').map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.min(num('concurrency', 6), 12);
const LIMIT = Number(arg('limit', '0')) || 0; // 0 = 不限
const TIMEOUT = num('timeout', 20000);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getText(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Referer: 'https://www.chinanews.com.cn/' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(1000 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
}

// 平衡匹配 <div ...> ... </div>：能正确处理正文里的嵌套 div
function sliceDiv(html, openRe) {
  const m = openRe.exec(html);
  if (!m) return '';
  const start = m.index;
  const tagRe = /<(\/?)div\b[^>]*>/gi;
  tagRe.lastIndex = start;
  let depth = 0;
  let tm;
  while ((tm = tagRe.exec(html))) {
    if (tm[1] === '/') {
      depth--;
      if (depth === 0) return html.slice(start, tm.index);
    } else {
      depth++;
    }
  }
  return html.slice(start);
}

const ENT = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&ldquo;': '\u201c', '&rdquo;': '\u201d',
  '&lsquo;': '\u2018', '&rsquo;': '\u2019', '&hellip;': '\u2026', '&mdash;': '\u2014',
  '&middot;': '\u00b7', '&times;': '\u00d7', '&bull;': '\u2022',
};

function cleanHtml(frag) {
  let s = String(frag || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos|ldquo|rdquo|lsquo|rsquo|hellip|mdash|middot|times|bull);/gi, (t) => ENT[t.toLowerCase()] || t)
    .replace(/&#(\d+);/g, (_, n) => {
      const c = Number(n);
      return c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

// 中新网正文：<div class="left_zw"> ... </div>
function extractChinanews(html) {
  const frag = sliceDiv(html, /<div[^>]*class=["']left_zw["'][^>]*>/i);
  return cleanHtml(frag);
}

// 央行正文：<div id="UCAP-CONTENT"> ... </div>；兜底 <td class="content"> / <div class="TRS_Editor">
function extractPbc(html) {
  let frag = sliceDiv(html, /<div[^>]*id=["']UCAP-CONTENT["'][^>]*>/i);
  if (!cleanHtml(frag)) frag = sliceDiv(html, /<div[^>]*class=["'][^"']*TRS_Editor[^"']*["'][^>]*>/i);
  if (!cleanHtml(frag)) frag = sliceDiv(html, /<td[^>]*class=["'][^"']*content[^"']*["'][^>]*>/i);
  return cleanHtml(frag);
}

const extract = (source, html) => (source === '中新网' ? extractChinanews(html) : extractPbc(html));

async function fetchOne(source, url) {
  const html = await getText(url);
  const content = extract(source, html);
  return content;
}

function main() {
  const db = openDb(DB);
  const srcList = SOURCES.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
  const sql = `
    SELECT id, source, url, title, published_at
    FROM items
    WHERE published_at >= ? AND published_at < ?
      AND source IN (${srcList})
      AND (content IS NULL OR content = '')
    ORDER BY published_ts ASC
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `;
  const rows = db.prepare(sql).all(FROM, TO);
  const total = rows.length;
  if (!total) {
    console.log('没有待抓正文的条目（区间内都已回补，或区间参数不对）');
    return 0;
  }
  console.log(`待抓正文：${total} 条（${FROM} ~ ${TO}，源：${SOURCES.join('、')}，并发 ${CONCURRENCY}）`);

  let done = 0;
  let ok = 0;
  let fail = 0;
  let empty = 0;
  const t0 = Date.now();
  const errors = new Map(); // source -> count

  // 简单并发池：每个 worker 拉取一个 URL，成功后攒批写回
  const queue = rows.slice();
  const pending = new Set();
  let running = true;

  const writer = (() => {
    let buffer = [];
    let flushTimer = null;
    const flush = () => {
      if (!buffer.length) return;
      const r = updateContent(db, buffer);
      ok += r.updated;
      empty += buffer.length - r.updated - r.missing;
      buffer = [];
    };
    return {
      push(row) {
        buffer.push(row);
        if (buffer.length >= 500) flush();
      },
      stop() {
        flush();
      },
    };
  })();

  async function worker() {
    while (running) {
      const row = queue.shift();
      if (!row) return;
      try {
        const content = await fetchOne(row.source, row.url);
        if (content) {
          writer.push({ url: row.url, content });
        } else {
          empty++;
        }
      } catch (e) {
        fail++;
        errors.set(row.source, (errors.get(row.source) || 0) + 1);
      }
      done++;
      if (done % 500 === 0 || done === total) {
        const rate = Math.round((done / ((Date.now() - t0) / 1000)) * 10) / 10;
        console.log(
          `进度 ${done}/${total}（${((done / total) * 100).toFixed(1)}%）` +
          ` · 成功 ${ok} · 空 ${empty} · 失败 ${fail} · ${rate} 条/s`
        );
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  Promise.all(workers).then(() => {
    running = false;
    writer.stop();
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `\n完成：${done} 条，成功写入正文 ${ok}，空 ${empty}，失败 ${fail}，耗时 ${secs}s`
    );
    if (errors.size) console.log('失败分布：', Object.fromEntries(errors));
    if (!DRY) console.log(stats(db, DB));
  });
  return 0;
}

if (DRY) {
  const db = openDb(DB);
  const srcList = SOURCES.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
  const n = db.prepare(`
    SELECT COUNT(*) AS n FROM items
    WHERE published_at >= ? AND published_at < ?
      AND source IN (${srcList}) AND (content IS NULL OR content = '')
  `).get(FROM, TO).n;
  console.log(`[dry-run] 待抓正文条目：${n} 条（${FROM} ~ ${TO}）`);
  process.exitCode = 0;
} else {
  process.exitCode = main();
}
