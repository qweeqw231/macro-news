// tests/history-summary.test.mjs
// 2.4.9：归档页历史文案必须由索引真实值计算，不得硬编码日期/天数。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HS = require('../assets/history-summary.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

test('文案随索引 from/to/天数/总条数变化，不是硬编码', () => {
  const hist = { from: '2001-01-01', to: '2001-03-31', days: new Array(90).fill(0), total: 1234 };
  const s = HS.summary(hist, []);
  assert.ok(s.includes('归档前历史 90 天'));
  assert.ok(s.includes('2001-01-01 ~ 2001-03-31'));
  assert.ok(s.includes('1,234 条'));
  assert.ok(s.includes('仅标题/来源/时间'));
  const s2 = HS.summary({ ...hist, from: '2002-02-02', to: '2002-04-04', total: 88 }, []);
  assert.notEqual(s, s2);
  assert.ok(s2.includes('2002-02-02 ~ 2002-04-04'));
});

test('文案统计「之后另有 N 天归档卡片」，且只数 to 之后、非 hist 的天', () => {
  const hist = { from: '2001-01-01', to: '2001-03-31', days: [1, 2, 3], total: 10 };
  const list = [
    { day: '2001-04-01', kind: 'live' },
    { day: '2001-04-02', kind: 'live' },
    { day: '2001-03-31', kind: 'hist' },
    { day: '2001-03-01', kind: 'hist' },
  ];
  const s = HS.summary(hist, list);
  assert.ok(s.includes('2001-03-31 之后另有 2 天在下方归档卡片'));
  const noNewer = HS.summary(hist, [{ day: '2001-03-01', kind: 'hist' }]);
  assert.ok(noNewer.includes('2001-03-31 之后暂无归档卡片'));
});

test('空索引不产生文案', () => {
  assert.equal(HS.summary(null, []), '');
  assert.equal(HS.summary({ days: [], from: '', to: '', total: 0 }, []), '');
});

test('app.js 使用共用文案函数，且不再硬编码 2026-09-19 / 304 天', () => {
  assert.match(APP, /MacroHistorySummary\.summary\(hist, list\)/);
  assert.ok(!/2026-09-19/.test(APP), '不得硬编码历史截止日期');
  assert.ok(!/历史 304 天/.test(APP), '不得硬编码天数');
  assert.ok(!/仅标题\/摘要/.test(APP), '历史切片实际没有摘要字段');
});
