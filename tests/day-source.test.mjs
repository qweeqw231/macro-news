// tests/day-source.test.mjs
// 2.4.10：同一天 archive / history 取值规则（阈值 20，显式可见）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DS = require('../assets/day-source.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

test('阈值 20：h 不多于 a 时按 archive=19/20/21 三档', () => {
  assert.equal(DS.ARCHIVE_MIN_COUNT, 20);
  const h = 10;
  const a19 = DS.decideDaySource({ archiveCount: 19, historyCount: h });
  assert.equal(a19.kind, 'history');
  assert.equal(a19.count, h);
  assert.ok(a19.reason.includes('该日归档仅 19 条'));
  assert.ok(a19.reason.includes('已改用历史切片 10 条'));
  assert.ok(a19.reason.includes('正文请点原文'));

  const a20 = DS.decideDaySource({ archiveCount: 20, historyCount: h });
  assert.equal(a20.kind, 'archive');
  assert.equal(a20.count, 20);
  assert.equal(a20.reason, '归档全文');

  const a21 = DS.decideDaySource({ archiveCount: 21, historyCount: h });
  assert.equal(a21.kind, 'archive');
  assert.equal(a21.count, 21);
});

// 2.21.0：占位归档挡住更全切片的三天（实测 10-01/10-02/10-04）
test('2.21.0：history 条数多于 archive ⇒ 一律用 history（含 archive>=20）', () => {
  for (const [a, h] of [[31, 119], [122, 204], [103, 137], [19, 129], [3, 243]]) {
    const r = DS.decideDaySource({ archiveCount: a, historyCount: h });
    assert.equal(r.kind, 'history', `a=${a} h=${h}`);
    assert.equal(r.count, h);
  }
  const big = DS.decideDaySource({ archiveCount: 31, historyCount: 119 });
  assert.ok(big.reason.includes('该日归档 31 条，少于历史切片 119 条'));
  assert.ok(big.reason.includes('正文请点原文'));
});

test('2.21.0：h 等于或少于 a 时行为不变（平手仍用 archive）', () => {
  for (const [a, h] of [[20, 20], [100, 50], [800, 300]]) {
    const r = DS.decideDaySource({ archiveCount: a, historyCount: h });
    assert.equal(r.kind, 'archive', `a=${a} h=${h}`);
    assert.equal(r.count, a);
  }
});

test('archive 为 0 但有 history ⇒ 用历史切片', () => {
  const r = DS.decideDaySource({ archiveCount: 0, historyCount: 100 });
  assert.equal(r.kind, 'history');
  assert.equal(r.count, 100);
});

test('archive 有但条数少且无 history ⇒ 仍用 archive，不显示空白', () => {
  const r = DS.decideDaySource({ archiveCount: 3, historyCount: 0 });
  assert.equal(r.kind, 'archive');
  assert.equal(r.count, 3);
  assert.ok(r.reason.includes('无历史切片可补'));
});

test('两边都没有 ⇒ none；两边都正常 ⇒ archive', () => {
  const none = DS.decideDaySource({ archiveCount: 0, historyCount: 0 });
  assert.equal(none.kind, 'none');
  assert.equal(none.count, 0);
  const normal = DS.decideDaySource({ archiveCount: 800, historyCount: 300 });
  assert.equal(normal.kind, 'archive');
  assert.equal(normal.count, 800);
});

test('app.js 使用显式规则，且打开某天时显示原因', () => {
  assert.match(APP, /MacroDaySource\.decideDaySource\(\{ archiveCount: a, historyCount: h \}\)/);
  assert.match(APP, /info\.reason/);
  assert.match(APP, /kind: dec\.kind === 'history' \? 'hist' : 'live'/);
});

// 2.21.0：规则顺序本身要锁住——「h > a」必须排在「a >= 阈值」之前，
// 否则 h 更多却仍被阈值挡掉（回退时这条会先红）。
test('2.21.0：day-source.js 与 app.js 兜底都先判 h > a', () => {
  const DS_SRC = fs.readFileSync(path.join(ROOT, 'assets', 'day-source.js'), 'utf8');
  assert.ok(DS_SRC.indexOf('h > a') > 0, 'day-source.js 缺 h > a 分支');
  assert.ok(DS_SRC.indexOf('h > a') < DS_SRC.indexOf('a >= min'), 'h > a 必须早于 a >= min');
  assert.ok(APP.indexOf('h > a') > 0, 'app.js 兜底缺 h > a 分支');
  assert.ok(APP.indexOf('h > a') < APP.indexOf('if (a >= 20)'), 'app.js 兜底顺序不对');
});
