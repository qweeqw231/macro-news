// tests/archive-time.test.mjs
// 3.0.0：归档页「时间轴缩放」的纯函数（ISO 周 / 月 / 路由 / 相关报告）。
// 这里直接 require 浏览器同一份 assets/archive-time.js：分组与路由语法只有一处实现。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AT = require('../assets/archive-time.js');

test('ISO 周：周一~周日，周年以该周周四所在年为准', () => {
  assert.deepEqual(AT.isoWeek('2026-11-22'), { year: 2026, week: 47, key: '2026-W47' });
  assert.equal(AT.isoWeek('2026-11-16').key, '2026-W47');
  assert.equal(AT.isoWeek('2026-11-23').key, '2026-W48');
  assert.equal(AT.isoWeek('2026-01-01').key, '2026-W01');
  // 2027-01-01 属于 2026 年第 53 周（跨年周按周四归年）
  assert.equal(AT.isoWeek('2027-01-01').key, '2026-W53');
  assert.equal(AT.weekStart('2026-11-22'), '2026-11-16');
});

test('周区间与主月：跨月周以周四所在月为准', () => {
  assert.deepEqual(AT.weekRange(2026, 47), { start: '2026-11-16', end: '2026-11-22' });
  assert.equal(AT.weekMidMonth(2026, 47), '2026-11');
  assert.equal(AT.weekMidMonth(2026, 49), '2026-12');
});

test('月分组：11 月涉及 W44~W49（首尾周跨月）', () => {
  const ws = AT.monthWeeks(2026, 11);
  assert.equal(ws.length, 6);
  assert.equal(ws[0].key, '2026-W44');
  assert.equal(ws[ws.length - 1].key, '2026-W49');
});

test('hash 路由：年/月/周/日/全部日期可解析、可生成', () => {
  assert.deepEqual(AT.parseArchiveHash('#archive/2026'), { level: 'year', year: '2026' });
  assert.deepEqual(AT.parseArchiveHash('#archive/2026/11'), { level: 'month', year: '2026', month: '11' });
  assert.deepEqual(AT.parseArchiveHash('#archive/2026/W47'), { level: 'week', year: '2026', week: '47' });
  assert.deepEqual(AT.parseArchiveHash('#archive/2026/11/22'), { level: 'day', year: '2026', month: '11', day: '22' });
  assert.deepEqual(AT.parseArchiveHash('#archive/all'), { level: 'all' });
  assert.deepEqual(AT.parseArchiveHash('#archive'), { level: 'default' });
  // 旧的视图级链接不归这里解析（由 viewFromHash 处理）
  assert.equal(AT.parseArchiveHash('#view-archive'), null);

  assert.equal(AT.archiveHash({ level: 'week', year: '2026', week: '7' }), '#archive/2026/W07');
  assert.equal(AT.routeKey({ level: 'month', year: '2026', month: '11' }), 'archive/2026/11');
  assert.equal(AT.archiveHash({ level: 'all' }), '#archive/all');
});

test('非法路由：越界月/日一律 null，由调用方落默认层', () => {
  assert.equal(AT.parseArchiveHash('#archive/2026/13'), null);
  assert.equal(AT.parseArchiveHash('#archive/2026/02/30'), null);
  assert.equal(AT.parseArchiveHash('#archive/2026/W99'), null);
  assert.equal(AT.parseArchiveHash('#archive/abc'), null);
});

test('默认落层：当前月优先；当前月无数据回退最近有数据的月', () => {
  assert.equal(AT.pickDefaultMonth(['2026-11', '2026-10', '2026-09'], '2026-11-23'), '2026-11');
  assert.equal(AT.pickDefaultMonth(['2026-10', '2026-09'], '2026-11-23'), '2026-10');
  assert.equal(AT.pickDefaultMonth([], '2026-11-23'), '2026-11');
  assert.equal(AT.addMonths('2026-01', -1), '2025-12');
  assert.equal(AT.addMonths('2026-12', 1), '2027-01');
});

test('最近入口：回退到不晚于目标的最近一层', () => {
  const months = ['2026-11', '2026-10', '2026-08'];
  assert.equal(AT.nearestMonth(months, '2026-09'), '2026-08');
  assert.equal(AT.nearestMonth(months, '2027-01'), '2026-11');
  const weeks = ['2026-W48', '2026-W47', '2026-W45'];
  assert.equal(AT.nearestWeek(weeks, '2026-W47'), '2026-W47');
  assert.equal(AT.nearestWeek(weeks, '2026-W46'), '2026-W45');
  const years = ['2026', '2025'];
  assert.equal(AT.nearestYear(years, '2026'), '2026');
  assert.equal(AT.nearestYear(years, '2024'), '2025');
});

test('相关报告：按周/月/年分组、各最多 3 条；空关键词不出带', () => {
  const reps = [
    { type: 'week', id: '2026-W47', title: '美联储降息路径与美元' },
    { type: 'week', id: '2026-W46', title: '降息预期回落' },
    { type: 'week', id: '2026-W45', title: '降息交易拥挤' },
    { type: 'week', id: '2026-W44', title: '降息第四次' },
    { type: 'month', id: '2026-11', title: '十一月月报：降息与通胀' },
    { type: 'year', id: '2026', title: '2026 年报' },
  ];
  const groups = AT.relatedReports(reps, '降息', 3);
  assert.deepEqual(groups.map((g) => g.type), ['week', 'month']);
  assert.equal(groups[0].list.length, 3, '每周最多 3 条');
  assert.equal(AT.relatedReports(reps, '  ').length, 0);
  // 摘要也算命中
  const bySummary = AT.relatedReports(
    [{ type: 'year', id: '2026', title: '年报', summary: '全年主线是降息' }], '降息', 3
  );
  assert.equal(bySummary.length, 1);
});
