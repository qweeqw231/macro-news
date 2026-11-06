// scripts/check-pm-gate.mjs
// 只读校验：data/snapshots/<date>_pm.json 能否被下游「收盘复盘」当作当日收盘基准。
// 门禁：capturedAt >= 16:10、date = 当日、isTradingDay = true，且关键 key 的 asOf 是当日。
//
// 用法：
//   node scripts/check-pm-gate.mjs                 # 今天
//   node scripts/check-pm-gate.mjs --date 2026-11-06
//   node scripts/check-pm-gate.mjs --file path.json
// 退出码：0 = 通过；1 = 不通过（JSON 里给出 reasons）。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPmGate, checkPmKeys } from '../src/pm-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};

const bjToday = () => {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};

const date = arg('--date', bjToday());
const file = arg('--file', path.join(ROOT, 'data', 'snapshots', `${date}_pm.json`));

let doc;
try {
  doc = JSON.parse(await readFile(file, 'utf8'));
} catch (err) {
  console.log(JSON.stringify({ ok: false, file, reasons: ['file-missing-or-invalid'], error: String(err.message) }, null, 2));
  process.exit(1);
}

const gate = checkPmGate(doc, { today: date });
const keys = checkPmKeys(doc, ['csi300', 'hsi', 'hs_tech', 'sge_au9999']);
const out = {
  ok: gate.ok && keys.length === 0,
  file,
  date: doc.date,
  capturedAt: doc.capturedAt,
  isTradingDay: doc.isTradingDay,
  coverage: doc.coverage,
  reasons: gate.reasons,
  keyIssues: keys,
};
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
