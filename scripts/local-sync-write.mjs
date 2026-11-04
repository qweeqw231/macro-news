// scripts/local-sync-write.mjs
// 2.4.17：把本机同步结果写入 data/_last-run.json 的 localSync 子对象。
// 只改 localSync，云端采集器写入的字段原样保留。
//
// 用法（由 scripts/collect-and-push.ps1 调用）：
//   node scripts/local-sync-write.mjs --root <repo> --result skipped:fetch-failed
//   node scripts/local-sync-write.mjs --root <repo> --result ff-only

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LS = require('../assets/local-sync.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const root = arg('root', path.resolve(__dirname, '..'));
const result = arg('result', '');
const at = arg('at', new Date().toISOString());

if (!LS.RESULTS.includes(result)) {
  console.error(`localSync: 未知 result「${result}」；允许值：${LS.RESULTS.join(', ')}`);
  process.exit(2);
}

const file = path.join(root, 'data', '_last-run.json');
let doc = {};
try {
  doc = JSON.parse(await readFile(file, 'utf8')) || {};
} catch {
  /* 文件不存在/损坏：只创建一个带 localSync 的最小文档，不伪造云端字段 */
}

const sync = LS.nextLocalSync(doc.localSync, result, at);
const next = LS.mergeLocalSync(doc, sync);
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
console.log(`localSync: result=${sync.result} consecutiveSkips=${sync.consecutiveSkips} at=${sync.at}`);
