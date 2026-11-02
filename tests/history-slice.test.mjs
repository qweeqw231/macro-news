// tests/history-slice.test.mjs
// 离线回归：近一年历史切片的选取/压缩/索引逻辑（纯函数，不联网、不写盘）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beijingDay,
  dayWindow,
  packItem,
  selectDayItems,
  buildDayDoc,
  buildIndex,
} from '../scripts/news-db/history-slice.mjs';
import { BRIEF_LINE_MAX, briefLineOf } from '../src/brief-meta.mjs';

const row = (o) =>
  ({
    id: 'x',
    source: '中新网',
    channel: '',
    title: '标题',
    summary: '',
    url: '',
    published_ts: 1793580000,
    kind: 'news',
    content_status: 'title_only',
    hash: '',
    ...o,
  });

test('beijingDay：UTC 跨零点换算成北京日期', () => {
  // 2026-11-01 17:30 UTC = 2026-11-02 01:30 北京
  const ts = Date.UTC(2026, 10, 1, 17, 30) / 1000;
  assert.equal(beijingDay(ts), '2026-11-02');
  assert.equal(beijingDay(1793518857), '2026-11-01');
  assert.equal(beijingDay(0), '');
  assert.equal(beijingDay(-1), '');
});

test('dayWindow：默认到昨天为止的 365 天（含首尾）', () => {
  const w = dayWindow({ days: 365, to: '2026-11-01' });
  assert.equal(w.from, '2025-11-02');
  assert.equal(w.to, '2026-11-01');
  assert.equal(w.days, 365);
});

test('同日同 hash 去重：优先官方/全文，而不是标题占位行', () => {
  const rows = [
    row({ id: 'placeholder', hash: 'h1', title: '央行发布', published_ts: 100 }),
    row({ id: 'full', hash: 'h1', title: '央行发布', source: '中国人民银行', kind: 'official', content_status: 'full', published_ts: 101 }),
  ];
  const picked = selectDayItems(rows, { limit: 10 });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].id, 'full');
});

test('封顶：按优先级截断，输出仍按时间降序', () => {
  const rows = [
    row({ id: 'a', hash: 'a', source: '中新网', published_ts: 100 }),
    row({ id: 'b', hash: 'b', source: '华尔街见闻', content_status: 'full', published_ts: 101 }),
    row({ id: 'c', hash: 'c', source: '东方财富', content_status: 'full', published_ts: 102 }),
    row({ id: 'd', hash: 'd', source: '中国人民银行', kind: 'official', published_ts: 99 }),
  ];
  // 分数：官方 70+5=75（ts 99）、华尔街见闻 50+5=55（ts 101）、东财 40+5=45、中新网 30
  // ⇒ 取官方与华尔街见闻，再按时间降序 → b(101) 在前
  const picked = selectDayItems(rows, { limit: 2 });
  assert.deepEqual(picked.map((x) => x.id), ['b', 'd']);
});

test('packItem：省略空字段、摘要截断、普通新闻不写 k', () => {
  const packed = packItem(
    row({ id: 'p1', title: '  多行\n标题  ', summary: '一二三四五六七八九十十一', content_status: 'full' }),
    10
  );
  assert.equal(packed.t, '多行 标题');
  assert.equal(packed.s, '一二三四五六七八九十');
  assert.equal(packed.u, undefined);
  assert.equal(packed.c, undefined);
  assert.equal(packed.k, undefined);
  assert.equal(packed.p, 1793580000);

  const official = packItem(row({ kind: 'official', url: 'https://x', channel: '政策/监管' }));
  assert.equal(official.k, 'official');
  assert.equal(official.u, 'https://x');
  assert.equal(official.c, '政策/监管');
});

test('buildDayDoc：n 与 items 一致，空天不入选', () => {
  const doc = buildDayDoc('2025-11-09', [row({ id: 'a', hash: 'a' }), row({ id: 'b', hash: 'b' })], {
    limit: 400,
    summaryChars: 160,
    generatedAt: '2026-11-02T09:00:00+08:00',
  });
  assert.equal(doc.v, 2);
  assert.equal(doc.d, '2025-11-09');
  assert.equal(doc.n, 2);
  assert.equal(doc.items.length, 2);
  assert.equal(buildDayDoc('2025-11-10', [], {}).n, 0);
});

test('buildIndex：日期降序、total 求和、空集不出现 from/to 越界', () => {
  const idx = buildIndex([
    { d: '2025-11-10', n: 3, b: 120 },
    { d: '2025-11-12', n: 5, b: 200 },
    { d: '2025-11-11', n: 4, b: 160 },
  ], { generatedAt: '2026-11-02T09:00:00+08:00' });
  assert.deepEqual(idx.days.map((x) => x.d), ['2025-11-12', '2025-11-11', '2025-11-10']);
  assert.equal(idx.total, 12);
  assert.equal(idx.from, '2025-11-10');
  assert.equal(idx.to, '2025-11-12');

  const empty = buildIndex([], {});
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.days, []);
  assert.equal(empty.from, '');
});

test('buildIndex：早报字段透传（hasBriefing 默认 false，briefLine 只在有早报时出现）', () => {
  const idx = buildIndex([
    { d: '2026-11-01', n: 2, b: 10, hasBriefing: true, briefLine: '当日主线摘要' },
    { d: '2026-10-31', n: 1, b: 8 },
  ], {});
  assert.equal(idx.days[0].d, '2026-11-01');
  assert.equal(idx.days[0].hasBriefing, true);
  assert.equal(idx.days[0].briefLine, '当日主线摘要');
  assert.equal(idx.days[1].hasBriefing, false);
  assert.equal(idx.days[1].briefLine, undefined);
});

test('briefLineOf：折叠空白并按上限截断', () => {
  assert.equal(briefLineOf({ overview: '  多行\n摘要  ' }), '多行 摘要');
  assert.equal(briefLineOf({}), '');
  assert.equal(briefLineOf(null), '');
  const long = '一'.repeat(BRIEF_LINE_MAX + 10);
  assert.equal(briefLineOf({ overview: long }).length, BRIEF_LINE_MAX);
});
