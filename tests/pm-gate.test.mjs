// tests/pm-gate.test.mjs
// 2.9.0：pm 快照的消费方门禁（capturedAt >= 16:10 / date=当日 / isTradingDay=true）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPmGate, checkPmKeys, pmGateKeys } from '../src/pm-gate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const real = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'snapshots', '2026-11-06_pm.json'), 'utf8')
);

test('2026-11-06 的 pm 通过三条门禁', () => {
  const r = checkPmGate(real, { today: '2026-11-06' });
  assert.equal(r.ok, true, r.reasons.join(','));
  assert.equal(real.capturedAt.slice(11, 16) >= '16:10', true);
});

test('capturedAt 早于 16:10 → 拒绝（今天的 pm 才算）', () => {
  const doc = { ...real, capturedAt: '2026-11-06T16:04:00+08:00' };
  const r = checkPmGate(doc, { today: '2026-11-06' });
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('capturedAt-before-16:10'));
});

test('日期不一致 / 非交易日 → 拒绝', () => {
  const a = checkPmGate({ ...real, date: '2026-11-05' }, { today: '2026-11-06' });
  assert.equal(a.ok, false);
  assert.ok(a.reasons.includes('date-not-today'));
  const b = checkPmGate({ ...real, isTradingDay: false }, { today: '2026-11-06' });
  assert.equal(b.ok, false);
  assert.ok(b.reasons.includes('not-trading-day'));
});

test('历史回补不受 16:10 限制（capturedAt 是补采时刻）', () => {
  const doc = { ...real, capturedAt: '2026-11-07T09:00:00+08:00' };
  // date 仍是 11-06；只有 today=11-06 时才卡 16:10
  assert.equal(checkPmGate(doc).ok, true);
});

test('关键 key 必须是当日 asOf', () => {
  assert.deepEqual(checkPmKeys(real, ['csi300', 'hsi', 'hs_tech', 'sge_au9999']), []);
  const bad = JSON.parse(JSON.stringify(real));
  bad.quotes.hsi.asOf = '2026-11-05T16:00:00+08:00';
  const out = checkPmKeys(bad, ['hsi']);
  assert.equal(out.length, 1);
  assert.ok(out[0].startsWith('hsi:asOf-2026-11-05'));
});

test('关键 key 清单自动覆盖快照内的全部 A 股指数（新增标的无需改清单）', () => {
  const doc = {
    quotes: {
      csi300: { kind: 'index', market: 'CN', asOf: '2026-11-13T15:00:00+08:00' },
      a100: { kind: 'index', market: 'CN', asOf: '2026-11-13T15:00:00+08:00' },
      hsi: { kind: 'index', market: 'HK', asOf: '2026-11-13T16:00:00+08:00' },
      xau: { kind: 'portfolio', market: 'CMDTY', asOf: '2026-11-13T16:12:00+08:00' },
    },
  };
  const keys = pmGateKeys(doc);
  assert.ok(keys.includes('a100'), 'a100 必须被纳入 pm 门禁');
  assert.ok(keys.includes('csi300'));
  assert.ok(keys.includes('hsi'));
  assert.ok(!keys.includes('xau'), 'portfolio 不走「当日」语义');
  // 旧快照里没有 a100 时不能凭空要求它（历史文件照常通过）
  assert.ok(!pmGateKeys(real).includes('a100'));
  assert.deepEqual(checkPmKeys(doc, keys).filter((x) => x.startsWith('a100')), []);
});
