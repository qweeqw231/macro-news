// scripts/periodic/build-index.mjs
// 周期报告索引重建：扫描 data/periodic/<id>.json 正文，按 docs/periodic-report.md 第 2 节
// 重建 data/periodic/index.json。
//
// 为什么要有这个脚本：索引此前靠手工追加，批次一多就容易漏期/漏 count/排序错位。
// 重建 = 单一真值（正文目录），杜绝手改漂移。
//
// 用法：
//   node scripts/periodic/build-index.mjs            # 重建并写盘
//   node scripts/periodic/build-index.mjs --dry-run  # 只比对差异，不写盘
//
// 退出码：0 一致或已重建 / 1 写盘失败
//
// 口径（与既有索引逐字对齐）：
//   - summary 取正文 overview 的前 80 字（既有 113 条里有 111 条恰好 80 字；
//     2025-W28 为 40 字，保留正文原值不动）；
//   - 排序：window.to 降序，同日按 id 降序；
//   - backfill / backfillAt 透传正文 backfill 章；
//   - 已存在期正文不重写（只重建索引）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PERIODIC = path.join(ROOT, 'data', 'periodic');
const IDX_FILE = path.join(PERIODIC, 'index.json');
const DRY_RUN = process.argv.includes('--dry-run');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const len = (s) => Array.from(String(s == null ? '' : s)).length;

function summaryOf(doc, prev) {
  // 既有索引里的 summary 已是人工确认过的版本：优先沿用，
  // 新增期次才从 overview 截前 80 字。
  if (prev && prev.summary) return prev.summary;
  const ov = String(doc.overview || '').replace(/\s+/g, ' ').trim();
  return ov.slice(0, 80);
}

function main() {
  if (!fs.existsSync(PERIODIC)) {
    console.error('data/periodic 不存在');
    return 1;
  }
  let prev = { reports: [] };
  if (fs.existsSync(IDX_FILE)) {
    try { prev = readJson(IDX_FILE); } catch { /* 重建 */ }
  }
  const prevById = new Map((prev.reports || []).map((r) => [r.id, r]));

  const files = fs
    .readdirSync(PERIODIC)
    .filter((f) => f.endsWith('.json') && /^\d{4}(-\d{2}|-W\d{2})$/.test(f.replace(/\.json$/, '')))
    .sort();

  const reports = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    const doc = readJson(path.join(PERIODIC, f));
    if (doc.date !== id) {
      console.error(`跳过 ${id}：正文 date=${doc.date}`);
      continue;
    }
    const p = prevById.get(id);
    reports.push({
      type: doc.type,
      id,
      title: doc.title,
      summary: summaryOf(doc, p),
      window: doc.window,
      generatedAt: doc.generatedAt,
      backfill: !!doc.backfill,
      backfillAt: doc.backfill ? doc.backfill.at : null,
      itemCount: Array.isArray(doc.items) ? doc.items.length : 0,
      file: `periodic/${id}.json`,
    });
  }

  // 排序：window.to 降序，同日按 id 降序
  reports.sort((a, b) => {
    const ta = String(a.window?.to || '');
    const tb = String(b.window?.to || '');
    if (ta !== tb) return ta < tb ? 1 : -1;
    return String(a.id) < String(b.id) ? 1 : -1;
  });

  const now = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
  const next = {
    schema: 'macro-news/periodic-index@1',
    generatedAt: now,
    count: reports.length,
    reports,
  };

  const text = JSON.stringify(next, null, 2) + '\n';
  const oldText = fs.existsSync(IDX_FILE) ? fs.readFileSync(IDX_FILE, 'utf8') : '';

  if (DRY_RUN) {
    const oldIds = (prev.reports || []).map((r) => r.id);
    const newIds = reports.map((r) => r.id);
    const added = newIds.filter((id) => !oldIds.includes(id));
    const removed = oldIds.filter((id) => !newIds.includes(id));
    console.log(`当前 ${oldIds.length} 条 → 重建后 ${newIds.length} 条`);
    console.log(`新增 ${added.length}: ${added.join(' ') || '(无)'}`);
    console.log(`移除 ${removed.length}: ${removed.join(' ') || '(无)'}`);
    const changed = reports.filter((r) => {
      const o = prevById.get(r.id);
      return o && JSON.stringify(o) !== JSON.stringify(r);
    }).map((r) => r.id);
    console.log(`字段变化 ${changed.length}: ${changed.join(' ') || '(无)'}`);
    return 0;
  }

  fs.writeFileSync(IDX_FILE, text, 'utf8');
  console.log(`已重建 ${IDX_FILE}：${reports.length} 条（原 ${(prev.reports || []).length} 条）`);
  return 0;
}

process.exitCode = main();
