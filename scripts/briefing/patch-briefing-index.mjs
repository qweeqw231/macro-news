// scripts/briefing/patch-briefing-index.mjs
// 把 data/briefings/ 下已存在的早报同步进两处索引的早报标记：
//   data/index.json（archive 天）与 data/history/index.json（历史天）
//
// 为什么需要它：早报补写是「一天一份」批量落盘的，逐日调用 publish.mjs 的
// patchIndexFiles() 太慢；而等全部补完再一次性补标记，又怕中途站点上
// 「早报已存在但索引没标记」的不一致（归档卡片会隐形，2.20.0 修过这个坑）。
//
// 用法：
//   node scripts/briefing/patch-briefing-index.mjs            # 补所有缺的
//   node scripts/briefing/patch-briefing-index.mjs --dry-run  # 只统计
//   node scripts/briefing/patch-briefing-index.mjs --from 2024-01-01 --to 2024-01-31
//
// 退出码：0 成功 / 1 写盘失败
//
// 口径与 patchIndexDoc() 一致：
//   briefLine = overview 折叠成一行、≤80 字；
//   source    = 产物 source；
//   backfill  = 产物带 backfill 章 ⇒ 记 briefBackfill + briefAt；
//   只改「已存在的那天」，不新增日期行。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { briefLineOf } from '../../src/brief-meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const flag = (name) => process.argv.includes('--' + name);

const DATA = path.join(ROOT, 'data');
const BRIEFS = path.join(DATA, 'briefings');
const DRY_RUN = flag('dry-run');
const FROM = arg('from', '');
const TO = arg('to', '');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8');

/** 索引里按日期键取行（index.json 用 day，history/index.json 用 d） */
function findDay(doc, date) {
  const days = doc.days || [];
  return days.find((d) => (d.day || d.d) === date) || null;
}

function main() {
  if (!fs.existsSync(BRIEFS)) {
    console.error('data/briefings 不存在');
    return 1;
  }
  const files = fs.readdirSync(BRIEFS).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const days = files
    .map((f) => f.replace(/\.json$/, ''))
    .filter((d) => (!FROM || d >= FROM) && (!TO || d <= TO));

  const targets = ['index.json', 'history/index.json'].map((r) => path.join(DATA, r))
    .filter((f) => fs.existsSync(f));

  let patchedDays = 0;
  let missing = 0;
  const missingList = [];

  for (const rel of ['index.json', 'history/index.json']) {
    const file = path.join(DATA, rel);
    if (!fs.existsSync(file)) continue;
    const doc = readJson(file);
    if (!Array.isArray(doc.days)) continue;

    let changed = 0;
    for (const d of days) {
      const row = findDay(doc, d);
      if (!row) {
        missing++;
        missingList.push(rel + ':' + d);
        continue;
      }
      const brief = readJson(path.join(BRIEFS, d + '.json'));
      const briefLine = briefLineOf(brief);
      if (!briefLine) continue;

      const before = JSON.stringify(row);
      row.hasBriefing = true;
      row.briefLine = briefLine;
      row.source = brief.source || 'ai';
      if (brief.backfill) {
        row.briefBackfill = true;
        row.briefAt = brief.backfill.at || brief.generatedAt || '';
      }
      if (JSON.stringify(row) !== before) changed++;
    }
    if (changed && !DRY_RUN) {
      doc.generatedAt = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00');
      writeJson(file, doc);
    }
    console.log(`${rel}：处理 ${days.length} 天，${changed} 天标记有变化${DRY_RUN ? '（dry-run，未写盘）' : ''}`);
    patchedDays += changed;
  }

  console.log(`\n合计标记更新 ${patchedDays} 天次`);
  if (missingList.length) {
    // 正常情况：历史天只在 history/index.json 有行，archive 天只在 index.json 有行，
    // 所以每个日期在其中一个索引里找不到是预期的，不算错。
    const perFile = {};
    for (const m of missingList) {
      const rel = m.split(':')[0];
      perFile[rel] = (perFile[rel] || 0) + 1;
    }
    console.log(`按索引统计「该索引里没有这一天的行」：${JSON.stringify(perFile)}`);
    console.log('（正常现象：历史天在 history/index.json，archive 天在 index.json，两者不重叠）');
  }
  return 0;
}

process.exitCode = main();
