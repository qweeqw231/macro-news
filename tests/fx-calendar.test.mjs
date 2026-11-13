// tests/fx-calendar.test.mjs
// 外汇（FX）日切口径的单一真源 + 7 个美元对 + 交叉盘分钟 K 的配置回归。
// 只读仓库文件 / 纯函数，不联网、不写盘。
//
// 背景：FX 曾同时存在三套口径（snapshot 05:00+1 / kline-finalize 北京自然日 00:00 /
// 前端没有 FX 时段）。2.16.0 统一为**固定 22:00 UTC = 北京 06:00**，依据是实测
// 东财 119.* / 133.* 的日 K 开盘价 == 当天 06:01 的 1 分钟 K 开盘价。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  FX_DAY_CUT_UTC_HM, FX_DAY_CUT_BJ_HM, FX_DAY_CUT_BJ_MINUTES,
  FX_BAR_CLOSED_AT, fxDayCloseMs, fxLastClosedBarDate,
} from '../src/fx-calendar.mjs';
import { NO_SESSION_CLOSE } from '../src/kline-finalize.mjs';
import { barClosedAt, lastClosedBarDate } from '../src/snapshot.mjs';
import { INDICES, PORTFOLIO_KLINE, KLINE_PERIODS, klineTarget, sinaFxMinute } from '../src/sources.mjs';

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BJ = (s) => Date.parse(s.includes('+') ? s : s + '+08:00');

test('单一真源：22:00 UTC 派生 06:00 北京，D 日 bar 在 D+1 06:00 收盘', () => {
  assert.equal(FX_DAY_CUT_UTC_HM, '22:00');
  assert.equal(FX_DAY_CUT_BJ_HM, '06:00');
  assert.equal(FX_DAY_CUT_BJ_MINUTES, 360);
  assert.equal(FX_BAR_CLOSED_AT, '06:00+1');
  // D 日 22:00 UTC == D+1 06:00 北京
  assert.equal(fxDayCloseMs('2026-11-13'), Date.parse('2026-11-14T06:00:00+08:00'));
  // 夏令时不影响：切日按固定 UTC，不按 America/New_York
  assert.equal(fxDayCloseMs('2026-07-15'), Date.parse('2026-07-16T06:00:00+08:00'));
});

test('最近已收完的 bar：06:00 前是前天，06:00 后是昨天', () => {
  assert.equal(fxLastClosedBarDate(BJ('2026-11-13T05:59:00')), '2026-11-11');
  assert.equal(fxLastClosedBarDate(BJ('2026-11-13T06:01:00')), '2026-11-12');
  assert.equal(fxLastClosedBarDate(BJ('2026-11-13T23:00:00')), '2026-11-12');
});

test('kline-finalize 与 snapshot 都从同一个常量派生（不再各自硬编码）', () => {
  assert.equal(NO_SESSION_CLOSE.FX.closeHm, FX_DAY_CUT_BJ_MINUTES);
  assert.ok(NO_SESSION_CLOSE.FX.label.includes(FX_DAY_CUT_BJ_HM));
  // snapshot 的 BAR_CLOSED_AT['FX'] 只能通过行为验证：D 日 bar 在 D+1 06:00 前都算未收盘
  assert.equal(lastClosedBarDate('FX', '2026-11-13', 'am'), '2026-11-12');
  assert.equal(barClosedAt('FX', '2026-11-13'), Date.parse('2026-11-14T06:00:00+08:00'));
});

test('前端 quote-status 的 FX 时段与日切同值（浏览器无法 import ESM，靠此测试守一致）', () => {
  const fx = QS.CONTINUOUS_SESSIONS.FX;
  assert.ok(fx, 'quote-status 缺少 FX 连续时段配置');
  assert.equal(fx.tz, 'Asia/Shanghai');
  assert.equal(fx.windows[0][0], FX_DAY_CUT_BJ_MINUTES);
  assert.equal(fx.windows[fx.windows.length - 1][1], 1440 + FX_DAY_CUT_BJ_MINUTES, '收盘 = 次日 06:00');
  assert.equal(fx.tail, FX_DAY_CUT_BJ_MINUTES, '周六凌晨仍应算周五夜盘');
  assert.equal(fx.openWeekday, 1, '周一 06:00 才开盘');
});

test('FX 周末不再显示「延迟」：周六/周日/周一凌晨 → 已收盘；开盘且新价 → 实时', () => {
  const st = (src, now) => QS.classifySession(src, BJ(now), 'FX', null).state;
  assert.equal(st('2026-11-13T19:00:00+08:00', '2026-11-13T19:05:00+08:00'), 'realtime');
  // 周六 05:58 是最后一个 tick，周六中午/周日/周一凌晨都应是「已收盘」而不是「延迟」
  assert.equal(st('2026-11-14T05:58:00+08:00', '2026-11-14T12:00:00+08:00'), 'closed');
  assert.equal(st('2026-11-14T05:58:00+08:00', '2026-11-15T12:00:00+08:00'), 'closed');
  assert.equal(st('2026-11-14T05:58:00+08:00', '2026-11-16T03:00:00+08:00'), 'closed');
  // 周一 06:00 开盘后拿到新价 → 实时
  assert.equal(st('2026-11-16T07:02:00+08:00', '2026-11-16T07:03:00+08:00'), 'realtime');
});

test('7 个美元对：东财 119.* 同源、市场惯例方向、4 位小数', () => {
  const want = {
    eurusd: '119.EURUSD', gbpusd: '119.GBPUSD', usdjpy: '119.USDJPY',
    usdkrw: '119.USDKRW', audusd: '119.AUDUSD', usdcad: '119.USDCAD', usdchf: '119.USDCHF',
  };
  for (const [key, secid] of Object.entries(want)) {
    const i = INDICES.find((x) => x.key === key);
    assert.ok(i, `INDICES 缺少 ${key}`);
    assert.equal(i.secid, secid);
    assert.equal(i.market, 'FX');
  }
  // 反方向刻意不接（历史只有 2013/2019 起）
  for (const bad of ['usdeur', 'usdgbp', 'usdaud']) {
    assert.equal(INDICES.find((x) => x.key === bad), undefined, `不应接入反方向 ${bad}`);
  }
  const market = read('assets/market.js');
  for (const key of Object.keys(want)) {
    assert.ok(
      new RegExp(`key: '${key}'[^}]*decimals: 4`).test(market),
      `market.js META 缺少 ${key} 或精度不是 4`
    );
  }
  // Worker 映射：改表后必须 wrangler deploy 才生效，但表本身要与 sources 同步
  const worker = read('worker/worker.js');
  for (const secid of Object.values(want)) {
    assert.ok(worker.includes(`'${secid}'`), `worker.js 缺少 ${secid}`);
  }
});

test('分钟 K：5 个交叉盘走新浪 getMinKLine，美元对走东财，且都在预生成清单里', () => {
  const market = read('assets/market.js');
  assert.equal(typeof sinaFxMinute, 'function');
  for (const p of ['1m', '5m', '15m', '30m', '60m']) {
    assert.ok(KLINE_PERIODS.includes(p), `KLINE_PERIODS 缺少 ${p}`);
  }
  for (const key of ['eurcny', 'gbpcny', 'jpycny', 'krwcny', 'audcny']) {
    const t = PORTFOLIO_KLINE.find((x) => x.key === key);
    assert.ok(t && t.sinaFx, `${key} 缺少 sinaFx 配置`);
  }
  const script = read('scripts/update-kline-minute.mjs');
  for (const key of ['eurcny', 'gbpcny', 'jpycny', 'krwcny', 'audcny', 'eurusd', 'usdjpy', 'usdchf']) {
    assert.ok(new RegExp(`'${key}'`).test(script), `update-kline-minute 缺少 ${key}`);
  }
  // 错误结论必须已删除（保留纠正说明的注释不算）
  assert.ok(!market.includes("throw new Error('新浪外汇只有日线"), 'market.js 仍把「新浪外汇只有日线」当结论抛出');
  assert.ok(!/eurcny:\s*'[^']*没有分钟级数据'/.test(market), 'market.js 的 NO_MINUTE_REASON 仍把交叉盘说成没有分钟级数据');
});
