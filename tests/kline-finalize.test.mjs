// tests/kline-finalize.test.mjs
// 2.9.0：收盘定稿窗口 + 全量文件剔除未收盘 bar 的纯逻辑。
// 不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastClosedBarDate, dropUnclosedBars, writePlan,
} from '../src/kline-finalize.mjs';

const BJ = (s) => Date.parse(s + '+08:00');

test('港股：12:18 生成全量时，当天 bar 还不能入库', () => {
  const now = BJ('2026-11-06T12:18:00');
  assert.equal(lastClosedBarDate('HK', now), '2026-11-05');
  const bars = [
    { t: '2026-11-05', o: 1, c: 2, h: 2, l: 1, v: 1 },
    { t: '2026-11-06', o: 1, c: 3, h: 3, l: 1, v: 1 },
  ];
  const r = dropUnclosedBars(bars, 'HK', now);
  assert.deepEqual(r.dropped, ['2026-11-06']);
  assert.equal(r.bars.length, 1);
  assert.equal(r.bars[0].t, '2026-11-05');
});

test('港股：收盘后同一根 bar 可以入库', () => {
  const now = BJ('2026-11-06T16:30:00');
  assert.equal(lastClosedBarDate('HK', now), '2026-11-06');
  const bars = [{ t: '2026-11-06', o: 1, c: 3, h: 3, l: 1, v: 1 }];
  assert.equal(dropUnclosedBars(bars, 'HK', now).bars.length, 1);
});

test('上海金：14:49 不能把今天那根当收盘（夜盘尾巴 02:30 不算日线收盘）', () => {
  assert.equal(lastClosedBarDate('SGE', BJ('2026-11-06T14:49:00')), '2026-11-05');
  assert.equal(lastClosedBarDate('SGE', BJ('2026-11-06T16:00:00')), '2026-11-06');
  // 20:30 夜盘已开：今天日盘那根已定稿，但「明天」的未来蜡烛不能进全量
  const bars = [
    { t: '2026-11-06', o: 1, c: 868.57, h: 1, l: 1, v: 1 },
    { t: '2026-11-09', o: 1, c: 870, h: 1, l: 1, v: 1 },
  ];
  const r = dropUnclosedBars(bars, 'SGE', BJ('2026-11-06T20:30:00'));
  assert.deepEqual(r.dropped, ['2026-11-09']);
  assert.equal(r.bars[0].t, '2026-11-06');
});

test('A股 12:18 未收盘；美股按美东日期', () => {
  assert.equal(lastClosedBarDate('CN', BJ('2026-11-06T12:18:00')), '2026-11-05');
  // 北京 12:18 = 美东 23:18（11-05），最近收盘是 11-05 16:00 ET
  assert.equal(lastClosedBarDate('US', BJ('2026-11-06T12:18:00')), '2026-11-05');
});

test('大宗 24h 与外汇 24h 的日线口径（2.14.0：FX 不再拿北京当天当已收盘）', () => {
  assert.equal(lastClosedBarDate('CMDTY', BJ('2026-11-06T12:18:00')), '2026-11-05');
  assert.equal(lastClosedBarDate('CMDTY', BJ('2026-11-06T04:00:00')), '2026-11-04');
  // FX：24h 连续、按北京自然日切分 ⇒ 当天那根要到次日 00:00 才定稿
  assert.equal(lastClosedBarDate('FX', BJ('2026-11-06T12:18:00')), '2026-11-05');
  assert.equal(lastClosedBarDate('FX', BJ('2026-11-06T23:59:00')), '2026-11-05');
  assert.equal(lastClosedBarDate('FX', BJ('2026-11-07T00:01:00')), '2026-11-06');
});

test('FX / CMDTY 无时段市场也要能定稿（writePlan 不再直接 skip）', () => {
  // FX：文件里已有当天（仍在走）那根 ⇒ 每轮 open
  assert.equal(
    writePlan('FX', BJ('2026-11-06T12:00:00'), { lastBar: '2026-11-06', generatedAt: '2026-11-06T04:00:00Z' }).action,
    'open'
  );
  // FX：文件停在昨天、且昨天那根是在收盘（11-07 00:00）之前写的 ⇒ 补定稿
  assert.equal(
    writePlan('FX', BJ('2026-11-07T03:00:00'), { lastBar: '2026-11-06', generatedAt: '2026-11-06T08:00:00Z' }).action,
    'finalize'
  );
  // FX：收盘后已写过 ⇒ 幂等
  assert.equal(
    writePlan('FX', BJ('2026-11-07T03:00:00'), { lastBar: '2026-11-06', generatedAt: '2026-11-06T16:10:00Z' }).action,
    'skip'
  );
  // CMDTY：05:00 前（04:59）最后一根已收完的是前天，文件里已有昨天的 bar ⇒ 它还在走 → open
  assert.equal(
    writePlan('CMDTY', BJ('2026-11-06T04:59:00'), { lastBar: '2026-11-05', generatedAt: '2026-11-05T00:00:00Z' }).action,
    'open'
  );
  // 05:00 后昨天那根已收完，文件却停在 11-04 ⇒ 补定稿
  assert.equal(
    writePlan('CMDTY', BJ('2026-11-06T05:10:00'), { lastBar: '2026-11-04', generatedAt: '2026-11-05T00:00:00Z' }).action,
    'finalize'
  );
  // 没有规则的市场仍然跳过
  assert.equal(writePlan('XX', Date.now(), {}).action, 'skip');
});

test('writePlan：盘中更新 / 收盘补定稿 / 已定稿幂等 / 收盘缓冲', () => {
  const now = BJ('2026-11-06T16:30:00');
  const base = { lastBar: '2026-11-06' };

  // 盘中
  assert.equal(writePlan('HK', BJ('2026-11-06T11:00:00'), {}).action, 'open');
  // 午休不是日线收盘 → 不该在午休补定稿
  assert.equal(
    writePlan('HK', BJ('2026-11-06T12:20:00'), { lastBar: '2026-11-06' }).action,
    'skip'
  );
  // 收盘后但文件还是 15:48 写的 → 补定稿
  assert.equal(
    writePlan('HK', now, { ...base, generatedAt: '2026-11-06T07:48:24Z' }).action,
    'finalize'
  );
  // 16:20 已经写过 → 幂等跳过
  assert.equal(
    writePlan('HK', now, { ...base, generatedAt: '2026-11-06T08:20:00Z' }).action,
    'skip'
  );
  // 收盘后 1 分钟：还在缓冲
  assert.equal(
    writePlan('HK', BJ('2026-11-06T16:01:00'), { lastBar: '2026-11-06' }).action,
    'skip'
  );
  // 没有交易时段配置、也没有 NO_SESSION_CLOSE 规则的：不归本脚本管
  assert.equal(writePlan('XX', now, {}).action, 'skip');
});
