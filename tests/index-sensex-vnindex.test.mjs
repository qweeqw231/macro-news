// tests/index-sensex-vnindex.test.mjs
// 2.8.0：印度 SENSEX（孟买30）与越南 VNINDEX 接入行情卡 / 实时 / K 线 / 休市表。
// 只读仓库文件、不写盘、不联网（休市表断言走 assets/market-calendar.json 快照）。
//
// 为什么不加 NIFTY 50：东财「全球指数」全量 63 个里只有 SENSEX，NIFTY / NIFTY50 / NSEI
// 等 secid 实测均为空，新浪 int_nifty、腾讯 usSENSEX 也没有 ⇒ 印度这一格只能上 SENSEX。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { INDICES } from '../src/sources.mjs';
import { snapshotTargets } from '../src/snapshot.mjs';

// 2.12.1：行情条数不写死，直接与代码里的目标清单对齐（加标的/加 ETF 会自己长大）。
const TARGET_COUNT = snapshotTargets('am').length;

const require = createRequire(import.meta.url);
const QS = require('../assets/quote-status.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const CAL = json('assets/market-calendar.json');
const BJ = (s) => Date.parse(s + '+08:00');

test('INDICES：sensex / vnindex 走东财 secid，排在韩国之后', () => {
  const s = INDICES.find((x) => x.key === 'sensex');
  const v = INDICES.find((x) => x.key === 'vnindex');
  assert.ok(s, '缺少 sensex');
  assert.ok(v, '缺少 vnindex');
  assert.equal(s.name, '印度SENSEX');
  assert.equal(s.market, 'IN');
  assert.equal(s.secid, '100.SENSEX');
  assert.equal(s.sina, null);
  assert.equal(s.tx, null);
  assert.equal(v.name, '越南VN指数');
  assert.equal(v.market, 'VN');
  assert.equal(v.secid, '100.VNINDEX');
  assert.equal(v.sina, null);
  assert.equal(v.tx, null);
  // 2.15.0：INDICES 末尾又加了 dxy / usdcny 两个外汇标的，
  // 所以这里不再断言「vnindex 是最后一个」，只锁定 sensex 紧跟 vnindex 之前。
  assert.equal(INDICES[INDICES.length - 1].market, 'FX');
  assert.equal(INDICES[INDICES.length - 1].key, 'usdcny');
  assert.equal(INDICES[INDICES.length - 2].market, 'FX');
  assert.equal(INDICES[INDICES.length - 2].key, 'dxy');
  const iV = INDICES.findIndex((x) => x.key === 'vnindex');
  assert.equal(INDICES[iV - 1].key, 'sensex', 'sensex 应紧邻 vnindex 之前');
});

test('前端与 Worker：卡片 / 代码 / 搜索 / 分组都认识两个新标的', () => {
  const market = read('assets/market.js');
  assert.ok(market.includes("{ key: 'sensex',  secid: '100.SENSEX',  market: 'IN', name: '印度SENSEX' }"),
    'market.js META 缺少 sensex');
  assert.ok(market.includes("{ key: 'vnindex', secid: '100.VNINDEX', market: 'VN', name: '越南VN指数' }"),
    'market.js META 缺少 vnindex');

  const app = read('assets/app.js');
  assert.ok(app.includes("sensex: 'SENSEX', vnindex: 'VNINDEX'"), 'app.js CODE_MAP 缺少代码');
  assert.ok(app.includes('sensex: \'印度 孟买 印度指数 bse sensex 孟买30\''), 'app.js 搜索别名缺少 sensex');
  assert.ok(app.includes('vnindex: \'越南 胡志明 hose vn vnindex\''), 'app.js 搜索别名缺少 vnindex');
  assert.ok(app.includes("IN: '印度', VN: '越南'"), 'app.js MARKET_LABEL 缺少分组名');
  // 假日表未加载时的降级窗口（按本地时区，与其它市场同口径）
  assert.ok(app.includes('IN: [11.75, 18]'), 'app.js 降级窗口缺少印度');
  assert.ok(app.includes('VN: [10, 12.5, 14, 15.75]'), 'app.js 降级窗口缺少越南');

  const worker = read('worker/worker.js');
  assert.ok(worker.includes("sensex: { secid: '100.SENSEX', market: 'IN' }"), 'worker.js 缺少 sensex');
  assert.ok(worker.includes("vnindex: { secid: '100.VNINDEX', market: 'VN' }"), 'worker.js 缺少 vnindex');
});

test('交易时段：印度 09:15-15:30 IST；越南 09:00-11:30 / 13:00-14:45 ICT', () => {
  const q = (market, now, sourceTime) =>
    QS.quoteStatus({ sourceTime: sourceTime + '+08:00', now: BJ(now), market, calendar: CAL });

  // 2026-11-06 周五：北京 12:00 = IST 09:30（印度盘中）
  assert.equal(q('IN', '2026-11-06T12:00:00', '2026-11-06T11:58:00').state, 'realtime');
  // 北京 18:10 = IST 15:40（印度已收盘）
  assert.equal(q('IN', '2026-11-06T18:10:00', '2026-11-06T18:00:00').state, 'closed');

  // 越南：北京 15:00 = ICT 14:00（下午盘）
  assert.equal(q('VN', '2026-11-06T15:00:00', '2026-11-06T14:59:00').state, 'realtime');
  // 北京 12:40 = ICT 11:40（刚进午休；源时间不能太旧，否则会先被判「延迟」）
  const lunch = q('VN', '2026-11-06T12:40:00', '2026-11-06T12:29:00');
  assert.equal(lunch.state, 'closed');
  assert.ok(lunch.card.includes('午间休市'), `越南午休文案不对：${lunch.card}`);
});

test('休市表：印度含 01-15 临时休市，越南含春节与国庆，均只覆盖 2026', () => {
  // 2.12.1：休市日**条数**不钉死——补 2027 覆盖、加临时休市都会让条数长大。
  // 真正要守的是「关键日子有 / 结算假日不许混进来 / 全部落在声明覆盖期内」。
  assert.ok(CAL.markets.IN.length >= 16, `印度休市日疑似被删：${CAL.markets.IN.length}`);
  assert.ok(CAL.markets.IN.includes('2026-01-15'), '印度缺 01-15 市政选举临时休市');
  assert.ok(CAL.markets.IN.includes('2026-11-10'), '印度缺排灯节 Balipratipada');
  // 货币衍生品通函里的结算假日（02-19 / 03-19 / 04-01 / 08-26）股票段照常交易，不能混进来
  for (const d of ['2026-02-19', '2026-03-19', '2026-04-01', '2026-08-26']) {
    assert.ok(!CAL.markets.IN.includes(d), `${d} 是结算假日，不应进股票段休市表`);
  }
  assert.ok(CAL.markets.VN.length >= 13, `越南休市日疑似被删：${CAL.markets.VN.length}`);
  for (const d of ['2026-01-02', '2026-02-16', '2026-02-20', '2026-08-31', '2026-09-02']) {
    assert.ok(CAL.markets.VN.includes(d), `越南缺休市日 ${d}`);
  }
  assert.equal(CAL.coverageByMarket.IN.to, '2026-12-31');
  assert.equal(CAL.coverageByMarket.VN.to, '2026-12-31');

  // 假日真的生效：印度排灯节、越南春节
  const inHoliday = QS.quoteStatus({
    sourceTime: '2026-11-09T18:00:00+08:00',
    now: BJ('2026-11-10T12:00:00'),
    market: 'IN',
    calendar: CAL,
  });
  assert.equal(inHoliday.state, 'holiday');
  // 越南春节是长假，源时间必然停在节前（4 天前）⇒ 卡片按既有规则显示「延迟」，
  // 这里断言日历判定本身（sessionAt.phase），而不是卡片文案。
  const vnHoliday = QS.sessionAt('VN', BJ('2026-02-17T15:00:00'), CAL);
  assert.equal(vnHoliday.phase, 'holiday');
  assert.equal(vnHoliday.holiday, true);
});

test('K 线：日/周/月/全量文件齐全，起点正确，根数只钉下限（随交易日增长）', () => {
  // 2.11.1：不再断言精确根数与「末根 = 某一天」（两者都会随采集漂移），
  // 改为钉「起点 / 下限 / 末根不早于基准日」。
  const d = json('data/kline/sensex.json');
  assert.equal(d.name, '印度SENSEX');
  assert.equal(d.period, '1d');
  assert.ok(d.bars.length >= 1000, `SENSEX 日 K 根数不足：${d.bars.length}`);
  const lastSensex = d.bars[d.bars.length - 1].t;
  assert.ok(lastSensex >= '2026-11-06', `SENSEX 日 K 末根过旧：${lastSensex}`);

  const m = json('data/kline/sensex_1M.json');
  assert.equal(m.name, '印度SENSEX');
  assert.ok(m.bars.length >= 400, 'SENSEX 月 K 根数不足');

  const full = json('data/kline/sensex_full.json');
  assert.equal(full.name, '印度SENSEX');
  assert.ok(full.bars.length >= 8000, 'SENSEX 全量根数不足');
  assert.ok(String(full.bars[0][0]) <= '1990-01-02', `SENSEX 全量起点过晚：${full.bars[0][0]}`);

  const v = json('data/kline/vnindex.json');
  assert.equal(v.name, '越南VN指数');
  assert.ok(v.bars.length >= 1000, `VNINDEX 日 K 根数不足：${v.bars.length}`);
  const lastVn = v.bars[v.bars.length - 1].t;
  assert.ok(lastVn >= '2026-11-06', `VNINDEX 日 K 末根过旧：${lastVn}`);
  const vFull = json('data/kline/vnindex_full.json');
  assert.equal(vFull.name, '越南VN指数');
  assert.ok(vFull.bars.length >= 3900, 'VNINDEX 全量根数不足');
  assert.ok(String(vFull.bars[0][0]) <= '2010-09-21', `VNINDEX 全量起点过晚：${vFull.bars[0][0]}`);
});

test('quotes.json：两个标的都有价，条数与代码里的标的数量自洽', () => {
  const doc = json('data/quotes.json');
  assert.equal(doc.quotes.length, TARGET_COUNT);
  for (const [key, market] of [['sensex', 'IN'], ['vnindex', 'VN']]) {
    const q = doc.quotes.find((x) => x.key === key);
    assert.ok(q, `quotes.json 缺少 ${key}`);
    assert.equal(q.market, market);
    assert.ok(q.price > 0, `${key} 价格无效`);
  }
});
