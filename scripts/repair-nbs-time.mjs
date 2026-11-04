// scripts/repair-nbs-time.mjs
// 2.4.8：回填国家统计局被云端 UTC runner 多加 8 小时的历史条目。
//
// 判定必须精确：抓取统计局原文页的 <meta name="PubDate" content="YYYY/MM/DD HH:MM">
// （北京时间），与归档里的 ts 比较；只有「归档比原文晚整整 +480 分钟」才修，
// 其它差异（例如 -720 分钟）原因不明，一律不动。
//
//   node scripts/repair-nbs-time.mjs            # 只报告，不写盘
//   node scripts/repair-nbs-time.mjs --apply    # 写回归档并重建派生文件（幂等）
//
// 不联网修改其它任何来源；不改 index 计数（条数不变）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rebuildDerived } from './repair-archive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = path.join(ROOT, 'data', 'archive');
const APPLY = process.argv.includes('--apply');
const SHIFT_MS = 480 * 60 * 1000;
// 原文页 PubDate 只到分钟，RSS 的秒可能是 :01/:06 ⇒ 允许 ±2 分钟
const SHIFT_TOL_MS = 2 * 60 * 1000;

/** 原文页发布时间（北京时间）→ UTC 毫秒 */
export function parseNbsPubDate(html) {
  const m = /<meta\s+name="PubDate"\s+content="(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})"/i.exec(String(html || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5]);
}

/** 只有「约 +480 分钟」（原文页精确到分钟，允许 ±2 分钟）才修 */
export function nbsFixMs(storedMs, actualMs) {
  if (!Number.isFinite(storedMs) || !Number.isFinite(actualMs)) return null;
  if (Math.abs((storedMs - actualMs) - SHIFT_MS) > SHIFT_TOL_MS) return null;
  return storedMs - SHIFT_MS;
}

async function fetchPubDate(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseNbsPubDate(await r.text());
}

async function main() {
  const docs = [];
  const targets = [];
  for (const f of fs.readdirSync(ARCHIVE).filter((x) => x.endsWith('.json')).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(ARCHIVE, f), 'utf8'));
    docs.push({ f, doc });
    for (const it of doc.items || []) {
      if (it.source === '国家统计局' && it.url) targets.push({ f, doc, it });
    }
  }

  let i = 0;
  const fixed = [];
  const skipped = [];
  const failed = [];
  async function worker() {
    while (i < targets.length) {
      const t = targets[i++];
      try {
        const actualMs = await fetchPubDate(t.it.url);
        const fixMs = nbsFixMs(t.it.ts * 1000, actualMs);
        if (fixMs != null) {
          fixed.push({ ...t, actualMs, fixMs });
          if (APPLY) {
            t.it.ts = Math.floor(fixMs / 1000);
            t.it.time = new Date(fixMs).toISOString();
          }
        } else {
          skipped.push({ ...t, actualMs });
        }
      } catch (e) {
        failed.push({ ...t, error: e.message.slice(0, 60) });
      }
    }
  }
  await Promise.all([0, 1, 2, 3, 4, 5].map(worker));

  for (const t of fixed) {
    console.log(`  ${t.it.id} ${t.it.time} → ${new Date(t.fixMs).toISOString()}  ${t.it.title.slice(0, 40)}`);
  }

  let changedFiles = 0;
  if (APPLY && fixed.length) {
    const touched = new Set(fixed.map((x) => x.f));
    for (const { f, doc } of docs) {
      if (!touched.has(f)) continue;
      fs.writeFileSync(path.join(ARCHIVE, f), JSON.stringify(doc, null, 2), 'utf8');
      changedFiles++;
    }
  }

  console.log(`[nbs-time] 扫描 ${targets.length} 条；可精确回填 +480 分钟：${fixed.length}；`
    + `跳过（差异非 +480）：${skipped.length}；抓取失败：${failed.length}`
    + (APPLY ? `；改写 ${changedFiles} 个归档` : '；dry-run，未写盘'));
  for (const x of failed.slice(0, 5)) console.log(`  ERR ${x.it.id} ${x.error}`);

  if (APPLY) {
    await rebuildDerived(docs.map((x) => x.doc), path.join(ROOT, 'data'));
    console.log('[nbs-time] 已重建 index/latest/search');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error('[nbs-time] 失败', e); process.exit(1); });
