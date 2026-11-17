// tests/macro-refresh.test.mjs
// 2.19.0：宏观最新记录补新的判定（纯函数） + 回补脚本接线检查。
//
// 背景：17:13 的日更拿不到当天才发布的两融（晚间）与 10Y 美债（美股收盘后），
//   门禁又按「今天已有记录」永久跳过 → 消费端会整天停在 T-1。这里锁住补新规则：
//   只有源侧数据日期**变新**才替换，相同/更旧一律不动（源抖动不能把数据改回去）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeLatestDaily, DAILY_MACRO_KEYS } from '../src/macro-refresh.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const margin = (note, value = 22650.12) => ({ key: 'margin', name: '两融余额', value, unit: '亿元', note });
const us10y = (note, value = 5.12) => ({ key: 'us10y', name: '10Y美债', value, unit: '%', note });

test('源侧数据日期更新时才替换（2026-11-16 那次的真实形态）', () => {
  const items = [
    { key: 'margin', value: 22865.25, unit: '亿元', note: '2026-11-13' },
    { key: 'us10y', value: 5.15, unit: '%', note: '2026-11-13' },
    { key: 'cpi', value: 0.7, unit: '%', note: '2026年10月份' },
  ];
  const r = mergeLatestDaily(items, [margin('2026-11-16'), us10y('2026-11-16')]);
  assert.equal(r.changes.length, 2);
  assert.equal(r.items.find((x) => x.key === 'margin').note, '2026-11-16');
  assert.equal(r.items.find((x) => x.key === 'margin').value, 22650.12);
  assert.equal(r.items.find((x) => x.key === 'us10y').note, '2026-11-16');
  // 月度项原样保留
  assert.deepEqual(r.items.find((x) => x.key === 'cpi'), items[2]);
});

test('相同或更旧的日期不覆盖（源重试/回退时不能把数据改旧）', () => {
  const items = [margin('2026-11-16'), us10y('2026-11-16')];
  assert.equal(mergeLatestDaily(items, [margin('2026-11-16'), us10y('2026-11-16')]).changes.length, 0);
  const old = mergeLatestDaily(items, [margin('2026-11-13'), us10y('2026-11-12')]);
  assert.equal(old.changes.length, 0);
  assert.equal(old.items.find((x) => x.key === 'margin').note, '2026-11-16');
});

test('缺 key 时追加；非日频 key 与无日期值不参与', () => {
  const r = mergeLatestDaily([], [margin('2026-11-16'), us10y(''), { key: 'cpi', value: 0.7, note: '2026年10月份' }]);
  assert.deepEqual(r.items.map((x) => x.key), ['margin', 'us10y']);
  assert.equal(r.changes.length, 2);
  // us10y 没有 note：追加后下次不会被更旧/同值覆盖，也不会被空值替换
  const again = mergeLatestDaily(r.items, [{ key: 'us10y', value: 1, note: '' }]);
  assert.equal(again.changes.length, 0);
  assert.equal(again.items.find((x) => x.key === 'us10y').value, 5.12);
  assert.deepEqual(DAILY_MACRO_KEYS, ['margin', 'us10y']);
});

test('回补脚本接上了补新与「记录完整但缺日 K」两个分支', () => {
  const src = read('scripts/backfill-macro.mjs');
  assert.match(src, /import \{ mergeLatestDaily \} from '\.\.\/src\/macro-refresh\.mjs'/);
  assert.match(src, /mergeLatestDaily\(newest\.items, latest\)/);
  assert.match(src, /addDays\(bjToday\(\), -3\)/);
  assert.match(src, /记录完整，补 1Y 国债日 K/);
  // 今天：17:13 那轮可能拿不到 17:00 后的曲线，必须每轮幂等补一次
  assert.match(src, /（今天）：补 1Y 国债日 K/);
});
