// tests/kline-freshness.test.mjs
// K 线新鲜度哨兵（2026-11-18 事故后的补充）：
//   判据必须是「最后一次真正落到 main 的 kline 提交时间」，而不是「运行是否 success」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const NOW = Date.parse('2026-11-19T10:00:00+08:00');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

test('klineFreshness：阈值内 ok，超过 ok→bad', () => {
  assert.equal(QS.klineFreshness({ at: iso(10), thresholdMin: 90 }, NOW).level, 'ok');
  assert.equal(QS.klineFreshness({ at: iso(89), thresholdMin: 90 }, NOW).level, 'ok');
  assert.equal(QS.klineFreshness({ at: iso(91), thresholdMin: 90 }, NOW).level, 'bad');
  assert.equal(QS.klineFreshness({ at: iso(600), thresholdMin: 90 }, NOW).level, 'bad');
  assert.equal(QS.klineFreshness({ at: iso(120), thresholdMin: 90 }, NOW).ageMin, 120);
});

test('klineFreshness：阈值以心跳文件为准，缺失/损坏/时钟超前都不许显示正常', () => {
  assert.equal(QS.klineFreshness({ at: iso(40), thresholdMin: 30 }, NOW).level, 'bad');
  assert.equal(QS.klineFreshness({ at: iso(40), thresholdMin: 60 }, NOW).level, 'ok');
  assert.equal(QS.klineFreshness(null, NOW).level, 'none');
  assert.equal(QS.klineFreshness({}, NOW).level, 'none');
  assert.equal(QS.klineFreshness({ at: 'not-a-date' }, NOW).level, 'none');
  // 心跳时间在未来（本机时钟/产物异常）→ 按异常处理
  assert.equal(QS.klineFreshness({ at: iso(-30), thresholdMin: 90 }, NOW).level, 'bad');
});

test('心跳写入必须发生在推送之前（否则推失败也会前进）', () => {
  for (const wf of ['.github/workflows/kline-minute.yml', '.github/workflows/kline-full.yml']) {
    const src = read(wf);
    const hb = src.indexOf('kline-heartbeat.mjs');
    const push = src.indexOf('push-data.sh data/kline');
    assert.ok(hb > 0, `${wf} 缺少心跳步骤`);
    assert.ok(push > 0, `${wf} 缺少推送步骤`);
    assert.ok(hb < push, `${wf} 心跳步骤必须在推送之前`);
  }
});

test('心跳脚本：默认 90 分钟、写 data/kline/_heartbeat.json、带 by 标记', () => {
  const s = read('scripts/kline-heartbeat.mjs');
  assert.match(s, /KLINE_FRESHNESS_MIN \|\| 90/);
  assert.match(s, /kline', '_heartbeat\.json'/);
  assert.match(s, /by, thresholdMin/);
  assert.ok(existsSync(new URL('../scripts/kline-heartbeat.mjs', import.meta.url)));
});

test('页脚哨兵：读心跳、按阈值把总灯染红、并显示相对时间', () => {
  const src = read('assets/app.js');
  assert.match(src, /kline\/_heartbeat\.json/);
  assert.match(src, /klineFreshness\(hb, Date\.now\(\)\)/);
  assert.match(src, /state = `K线任务停摆 \$\{agoText\(kf\.ageMin\)\}`/);
  assert.match(src, /bits\.push\(`K线任务 \$\{agoText\(kf\.ageMin\)\}`\)/);
  // 日K末根改为 4 次/天，但哨兵衡量的是 workflow 存活，阈值保持 90 分钟
  assert.match(src, /阈值保持 90 分钟/);
});
