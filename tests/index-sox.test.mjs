// tests/index-sox.test.mjs
// 2.10.0：费城半导体指数 SOX 接入行情卡 / K 线 / 快照 / 搜索 / Worker。
// 只读仓库文件、不写盘、不联网（数据断言走已生成的 data/ 与 assets/ 快照）。
//
// 几个必须被钉住的事实（都是源侧约束，不是本仓库的选择）：
//   · 东财 secid 是 **251.SOX**，不是 100. 段 —— 251 是另一套海外指数转播市场；
//   · 腾讯 usSOX 为空、新浪 gb_sox 有实时价但**没有日 K**
//     （US_MinKService.getDailyK?symbol=sox 返回 null）⇒ 日/周/月只有一个源；
//   · 日 K **起点 2026-07-06**（东财转播起点，指定 end=20250101 返回 0 行）；
//     根数随交易日增长，断言只钉起点与下限，不钉精确根数（否则每天漂移）；
//     不拿 SOXX / SMH 等 ETF 补历史（基金 ≠ 指数）；
//   · 分钟 K 由服务端预生成，快照 am/pm 与 dji/ixic/spx **完全同口径**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES } from '../src/sources.mjs';
import { snapshotTargets } from '../src/snapshot.mjs';

// 2.12.1：行情条数不写死，直接与代码里的目标清单对齐（加标的/加 ETF 会自己长大）。
const TARGET_COUNT = snapshotTargets('am').length;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

test('INDICES：sox 走东财 251.SOX，落 US 组，紧邻 spx 之后', () => {
  const i = INDICES.findIndex((x) => x.key === 'sox');
  assert.ok(i >= 0, '缺少 sox');
  const s = INDICES[i];
  assert.equal(s.name, '费城半导体指数');
  assert.equal(s.market, 'US');
  assert.equal(s.secid, '251.SOX');
  assert.equal(s.sina, null, 'sox 不应挂新浪（gb_sox 只有实时价，没有日 K）');
  assert.equal(s.tx, null, 'sox 不应挂腾讯（usSOX 为空）');
  assert.equal(INDICES[i - 1].key, 'spx', 'sox 应紧跟在 spx 之后');
  // 2.15.0：INDICES 末尾多了 dxy / usdcny 两个外汇标的（报价与 K 线同走东财），
  // 「指数」仍是 23 个 —— 断言按 market 剔除 FX 后计数，避免以后加外汇又改一次。
  assert.equal(INDICES.length, 25, 'INDICES 总数应为 25（23 指数 + 2 外汇）');
  assert.equal(INDICES.filter((x) => x.market !== 'FX').length, 23, '指数总数应为 23');
  // 落在 US 组内：前后邻居都是 US（或本组边界）
  assert.equal(INDICES[i - 1].market, 'US');
});

test('前端与 Worker：卡片 / 代码 / 搜索都认识 sox', () => {
  const market = read('assets/market.js');
  assert.ok(
    market.includes("{ key: 'sox',     secid: '251.SOX',  market: 'US', name: '费城半导体指数' }"),
    'market.js META 缺少 sox'
  );

  const app = read('assets/app.js');
  assert.ok(app.includes("sox: 'SOX'"), 'app.js CODE_MAP 缺少 SOX');
  assert.ok(app.includes("sox: '费城 半导体 芯片 费半 phlx semiconductor sox'"), 'app.js 搜索别名缺少 sox');

  const worker = read('worker/worker.js');
  assert.ok(worker.includes("sox: { secid: '251.SOX', market: 'US' }"), 'worker.js 缺少 sox');
});

test('快照：am / pm 都包含 sox，且与 dji/ixic/spx 同口径（不单独剔除）', () => {
  for (const session of ['am', 'pm']) {
    const keys = snapshotTargets(session).map((x) => x.key);
    for (const k of ['dji', 'ixic', 'spx', 'sox']) {
      assert.ok(keys.includes(k), `${session} 快照缺少 ${k}`);
    }
  }
  // US 组不是「印度那种」特例：pm 里没有任何按 key 的单点剔除
  const src = read('src/snapshot.mjs');
  assert.ok(!/key\s*===\s*'sox'/.test(src), 'snapshot.mjs 不应为 sox 写单独分支');
});

test('K 线：日 K 起点固定 2026-07-06，周 / 月 / 全量只钉下限（根数随交易日增长）', () => {
  const d = json('data/kline/sox.json');
  assert.equal(d.name, '费城半导体指数');
  assert.equal(d.market, 'US');
  assert.equal(d.period, '1d');
  // 2.11.1：不再断言精确根数（每天会 +1），只钉源侧起点与下限。
  assert.ok(d.bars.length >= 89, `日 K 根数不足：${d.bars.length}`);
  assert.equal(d.bars[0].t, '2026-07-06', '日 K 起点应为 2026-07-06');
  const lastDaily = d.bars[d.bars.length - 1].t;
  assert.ok(lastDaily >= '2026-11-06', `日 K 末根过旧：${lastDaily}`);

  const w = json('data/kline/sox_1w.json');
  assert.equal(w.period, '1w');
  assert.ok(w.bars.length >= 18, `周 K 根数不足：${w.bars.length}`);

  const m = json('data/kline/sox_1M.json');
  assert.equal(m.period, '1M');
  assert.ok(m.bars.length >= 5, `月 K 根数不足：${m.bars.length}`);

  // 全量文件：起点不能被 ETF 补早；末根允许比日 K 落后一天（_full 由另一个脚本生成）
  const full = json('data/kline/sox_full.json');
  assert.ok(full.bars.length >= 89, `全量根数不足：${full.bars.length}`);
  assert.equal(full.bars[0][0], '2026-07-06');
  const lastFull = full.bars[full.bars.length - 1][0];
  assert.ok(lastFull >= '2026-11-06', `全量末根过旧：${lastFull}`);
  assert.ok(lastFull <= lastDaily, `全量末根不应晚于日 K：${lastFull} > ${lastDaily}`);
});

test('分钟 K：5 个周期都由服务端预生成（含 1m，且与月 K 文件名物理隔离）', () => {
  for (const p of ['1m', '5m', '15m', '30m', '60m']) {
    const rel = `data/kline/min/sox_${p}.json`;
    assert.ok(exists(rel), `缺少 ${rel}`);
    const j = json(rel);
    assert.equal(j.key, 'sox');
    assert.equal(j.period, p);
    assert.ok(j.bars.length >= 30, `${p} 根数不足：${j.bars.length}`);
    // 紧凑数组行 [t,o,c,h,l,v]
    assert.equal(j.bars[0].length, 6);
  }
});

test('脚本：短历史白名单与分钟预生成目标都包含 sox', () => {
  const full = read('scripts/update-kline-full.mjs');
  assert.ok(
    full.includes("const SHORT_HISTORY_KEYS = new Set(['sox']);"),
    'update-kline-full.mjs 缺少 sox 短历史白名单（否则 89 根会被 MIN_BARS=1050 拒写）'
  );

  const minute = read('scripts/update-kline-minute.mjs');
  assert.ok(/TARGET_KEYS = \[[\s\S]*?'sox'/.test(minute), 'update-kline-minute.mjs 的 TARGET_KEYS 缺少 sox');
});

test('quotes.json：sox 有价，条数与代码里的标的数量自洽', () => {
  const doc = json('data/quotes.json');
  const q = doc.quotes.find((x) => x.key === 'sox');
  assert.ok(q, 'quotes.json 缺少 sox');
  assert.equal(q.market, 'US');
  assert.ok(q.price > 0, 'sox 价格无效');
  assert.ok(q.price > 1000, `半导体指数价格量级异常：${q.price}`);
  // 总数自洽：与快照目标清单一致（INDICES + ETFS + 组合）
  assert.equal(doc.quotes.length, TARGET_COUNT);
});
