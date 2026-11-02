// .trae/skills/add-market-instrument/scripts/verify-instrument.mjs
// 只读验收：新增行情标的的配置 / Worker / K线 / quotes / 当日 pm 快照。
//
// 用法：
//   node .trae/skills/add-market-instrument/scripts/verify-instrument.mjs --key a500 --date 2026-11-02
//   node ... --key a500 --date 2026-11-02 --skip-snapshot
//
// 退出码：0 全通过；1 有失败。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { INDICES } from '../../../../src/sources.mjs';
import { ETFS } from '../../../../src/etf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};
const KEY = arg('key', '');
const DATE = arg('date', '');
const SKIP_SNAPSHOT = process.argv.includes('--skip-snapshot');

if (!KEY) {
  console.error('用法：--key <key> [--date YYYY-MM-DD] [--skip-snapshot]');
  process.exit(1);
}

const idx = INDICES.find((x) => x.key === KEY);
const etf = ETFS.find((x) => x.key === KEY);
const target = idx || etf;
if (!target) {
  console.error(`FAIL 未知标的 ${KEY}（INDICES/ETFS 都没有）`);
  process.exit(1);
}
const isIndex = !!idx;
const name = target.name;
const secid = target.secid || '';
const results = [];
const check = (ok, label, detail = '') => {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

check(true, '标的', `${KEY} / ${name} / ${secid}`);

// 1. 配置
const sources = read('src/sources.mjs');
check(isIndex ? sources.includes(`key: '${KEY}'`) : read('src/etf.mjs').includes(`key: '${KEY}'`),
  '真值文件包含 key');
check(secid ? sources.includes(`secid: '${secid}'`) || read('src/etf.mjs').includes(`secid: '${secid}'`) : true,
  '真值文件包含 secid', secid);

const market = read('assets/market.js');
check(market.includes(`key: '${KEY}'`) && (!secid || market.includes(`secid: '${secid}'`)),
  'assets/market.js META 对齐');

const app = read('assets/app.js');
if (isIndex) {
  const code = /^\d{6}$/.test(String(secid).split('.')[1] || '') ? String(secid).split('.')[1] : '';
  check(code ? app.includes(`'${code}'`) || app.includes(`${KEY}: '${code}'`) : true,
    'assets/app.js CODE_MAP 含代码', code);
  check(app.includes(`${KEY}:`) || app.includes(`'${KEY}'`), 'assets/app.js 搜索别名含 key');
}

// 2. Worker
if (isIndex) {
  const wsrc = read('worker/worker.js');
  const m = wsrc.match(/const INDICES = \{([\s\S]*?)\n\};/);
  if (!m) check(false, 'Worker INDICES 可解析');
  else {
    const w = vm.runInNewContext('({' + m[1] + '})');
    const same = w[KEY] && ['secid', 'sina', 'tx', 'market']
      .every((f) => (w[KEY][f] ?? null) === (target[f] ?? null));
    check(same, 'Worker 映射逐项一致',
      same ? '' : `repo=${JSON.stringify({ secid: target.secid, sina: target.sina, tx: target.tx, market: target.market })} worker=${JSON.stringify(w[KEY])}`);
  }
}

// 3. K 线
for (const [suffix, label, required] of [
  ['', '日K', true],
  ['_1w', '周K', true],
  ['_1M', '月K', true],
  ['_full', '全量日K', isIndex],
]) {
  const file = `data/kline/${KEY}${suffix}.json`;
  if (!fs.existsSync(path.join(ROOT, file))) {
    check(!required, label, required ? '文件不存在' : '文件不存在（ETF 可跳过）');
    continue;
  }
  const j = json(file);
  check(j.name === name && Array.isArray(j.bars) && j.bars.length > 0, label,
    `${j.name} / ${j.bars?.length || 0} 根`);
}

// 4. quotes
const qdoc = json('data/quotes.json');
const q = (qdoc.quotes || []).find((x) => x.key === KEY);
check(!!q, 'quotes.json 含标的');
if (q) {
  check(q.name === name, 'quotes 名称一致', q.name);
  check(Number(q.price) > 0, 'quotes 有价', String(q.price));
}

// 5. 当日 pm 快照（历史不回填：新增日之前允许缺口）
if (!SKIP_SNAPSHOT && DATE) {
  const snap = `data/snapshots/${DATE}_pm.json`;
  if (!fs.existsSync(path.join(ROOT, snap))) {
    check(false, '当日 pm 快照存在', snap);
  } else {
    const s = json(snap).quotes?.[KEY];
    check(!!s, '当日 pm 含标的', s ? `${s.price} / ${s.asOf} / ${s.priceSource}` : '缺口（新增日之前允许保留）');
    if (s) {
      check(Number(s.price) > 0, 'pm 有价', String(s.price));
      check(!['CN', 'ETF', 'HK'].includes(s.market) || s.priceSource === 'dailyK' || s.kind === 'portfolio',
        'pm 价格口径', `${s.kind} / ${s.priceSource}`);
    }
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed ? `FAIL ${failed} 项` : 'PASS 全部通过'}（${results.length} 项）`);
process.exit(failed ? 1 : 0);
