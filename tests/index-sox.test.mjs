// tests/index-sox.test.mjs
// 2.10.0：费城半导体指数 SOX 接入行情卡 / K 线 / 快照 / 搜索 / Worker。
// 只读仓库文件、不写盘、不联网（数据断言走已生成的 data/ 与 assets/ 快照）。
//
// 几个必须被钉住的事实（都是源侧约束，不是本仓库的选择）：
//   · 东财 secid 是 **251.SOX**，不是 100. 段 —— 251 是另一套海外指数转播市场；
//   · 腾讯 usSOX 为空、新浪 gb_sox 有实时价但**没有日 K**
//     （US_MinKService.getDailyK?symbol=sox 返回 null）⇒ 日/周/月只有一个源；
//   · 日 K 只有 89 根、**起点 2026-07-06**（东财转播起点，指定 end=20250101 返回 0 行）；
//     不拿 SOXX / SMH 等 ETF 补历史（基金 ≠ 指数）；
//   · 分钟 K 由服务端预生成，快照 am/pm 与 dji/ixic/spx **完全同口径**。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES } from '../src/sources.mjs';
import { snapshotTargets } from '../src/snapshot.mjs';

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
  assert.equal(INDICES.length, 23, '指数总数应为 23');
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

test('K 线：日 89 根自 2026-07-06，周 18 / 月 5；全量同为 89 根（不伪造历史）', () => {
  const d = json('data/kline/sox.json');
  assert.equal(d.name, '费城半导体指数');
  assert.equal(d.market, 'US');
  assert.equal(d.period, '1d');
  assert.equal(d.bars.length, 89, '日 K 应为 89 根（东财转播起点决定的源侧上限）');
  assert.equal(d.bars[0].t, '2026-07-06', '日 K 起点应为 2026-07-06');

  const w = json('data/kline/sox_1w.json');
  assert.equal(w.period, '1w');
  assert.equal(w.bars.length, 18);

  const m = json('data/kline/sox_1M.json');
  assert.equal(m.period, '1M');
  assert.equal(m.bars.length, 5);

  // 全量文件：根数与日 K 一致（源侧没有更长的历史），起点也不能被 ETF 补早
  const full = json('data/kline/sox_full.json');
  assert.equal(full.bars.length, 89);
  assert.equal(full.bars[0][0], '2026-07-06');
  assert.equal(full.bars[full.bars.length - 1][0], d.bars[d.bars.length - 1].t);
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

test('quotes.json：sox 有价，卡片总数 62（23 指数 + 32 ETF + 7 组合）', () => {
  const doc = json('data/quotes.json');
  assert.equal(doc.quotes.length, 62);
  const q = doc.quotes.find((x) => x.key === 'sox');
  assert.ok(q, 'quotes.json 缺少 sox');
  assert.equal(q.market, 'US');
  assert.ok(q.price > 0, 'sox 价格无效');
  assert.ok(q.price > 1000, `半导体指数价格量级异常：${q.price}`);
  // 总数自洽：23 指数 + 32 ETF + 7 组合
  assert.equal(INDICES.length, 23);
  assert.equal(doc.quotes.length, INDICES.length + 32 + 7);
});
