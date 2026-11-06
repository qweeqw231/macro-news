// tests/commodity-quotes.test.mjs
// 2.7.0：伦敦金 / 伦敦银 / 布伦特原油卡片改由浏览器直连腾讯 hf_* 实时报价。
// 此前这三项只读 quotes.json（15 分钟采集），前端实时批里没有它们，
// 卡片一律被标成「本地快照」——数据在更新，状态却说不通。
//
// 只读仓库文件，不联网（fetch 为桩），不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKET = fs.readFileSync(path.join(ROOT, 'assets', 'market.js'), 'utf8');
const STATUS = fs.readFileSync(path.join(ROOT, 'assets', 'quote-status.js'), 'utf8');

// 实测响应（2026-11-06 11:31 抓取），字段顺序：现价/涨跌幅/买/卖/最高/最低/时间/昨收/开盘/…/日期/名称
const HF_TEXT = [
  'v_hf_XAU="4049.47,-0.96,4049.47,4049.82,4106.79,4046.18,11:31:00,4088.80,4087.48,0,0,0,2026-11-06,伦敦金";',
  'v_hf_XAG="51.57,-0.41,51.57,51.62,52.15,51.22,11:31:00,51.78,51.70,0,0,0,2026-11-06,伦敦银";',
  'v_hf_OIL="100.23,1.97,100.21,100.24,100.29,98.87,11:32:04,98.29,98.87,0,4,2,2026-11-06,布伦特原油";',
].join('\n');

const EM_JSON = {
  data: {
    diff: [{
      f2: 3647.9, f3: -1.14, f5: 311335115, f12: '000001', f13: 1, f14: '上证指数',
      f15: 3660.49, f16: 3610.2, f17: 3689.91, f18: 3689.91, f124: 1793937000,
    }],
  },
};

function load({ hfOk = true, emOk = true } = {}) {
  const calls = [];
  const fetchStub = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('qt.gtimg.cn')) {
      return hfOk
        ? { ok: true, text: async () => HF_TEXT, json: async () => ({}) }
        : { ok: false, status: 502, text: async () => '', json: async () => ({}) };
    }
    if (u.includes('ulist.np')) {
      return emOk
        ? { ok: true, text: async () => '', json: async () => EM_JSON }
        : { ok: false, status: 502, text: async () => '', json: async () => ({}) };
    }
    return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
  };
  const ctx = { window: {}, fetch: fetchStub, AbortController, setTimeout, clearTimeout, console };
  vm.createContext(ctx);
  vm.runInContext(STATUS, ctx);
  vm.runInContext(MARKET, ctx);
  return { MD: ctx.window.MarketData, QS: ctx.window.MacroQuoteStatus, calls };
}

test('外盘三项进入前端实时批：TX_HF 用 hf_XAU / hf_XAG / hf_OIL', () => {
  assert.ok(MARKET.includes("const TX_HF = { xau: 'hf_XAU', xag: 'hf_XAG', brent: 'hf_OIL' };"),
    'market.js 缺少 TX_HF');
  assert.ok(MARKET.includes('async function fetchQuotesHF()'), '缺少 fetchQuotesHF');
  // 品种口径：伦敦银必须是 hf_XAG，不能是 COMEX 的 hf_SI
  assert.ok(!/TX_HF[^;]*hf_SI/.test(MARKET), '伦敦银不能用 hf_SI（COMEX 期货）');
});

test('fetchQuotes 合并东财指数批与腾讯外盘批', async () => {
  const { MD, calls } = load();
  const quotes = await MD.fetchQuotes();
  // vm 里的数组与宿主不是同一个 realm，先转成宿主数组再比较
  const keys = Array.from(quotes, (q) => q.key);
  assert.ok(keys.includes('sh_comp'), '缺少东财指数');
  for (const k of ['xau', 'xag', 'brent']) assert.ok(keys.includes(k), `缺少 ${k}`);
  assert.equal(quotes.find((q) => q.key === 'sh_comp').source, 'eastmoney');

  const xau = quotes.find((q) => q.key === 'xau');
  assert.equal(xau.price, 4049.47);
  assert.equal(xau.changePct, -0.96);
  assert.equal(xau.prevClose, 4088.8);
  assert.equal(xau.open, 4087.48, '开盘价取 [8]，不是 [2]（买一价）');
  assert.equal(xau.high, 4106.79);
  assert.equal(xau.low, 4046.18);
  assert.equal(xau.updatedAt, '2026-11-06T11:31:00+08:00');
  assert.equal(xau.source, 'tencent');
  assert.equal(xau.market, 'CMDTY');
  assert.ok(calls.some((u) => u.includes('hf_XAU,hf_XAG,hf_OIL')), '外盘应合成一次请求');
});

test('外盘失败不拖垮指数：仍返回东财批次，不抛错', async () => {
  const { MD } = load({ hfOk: false });
  const quotes = await MD.fetchQuotes();
  assert.deepEqual(Array.from(quotes, (q) => q.key), ['sh_comp']);
});

test('东财失败时外盘仍在：返回腾讯外盘三项', async () => {
  const { MD } = load({ emOk: false });
  const quotes = await MD.fetchQuotes();
  assert.deepEqual(Array.from(quotes, (q) => q.key).sort(), ['brent', 'xag', 'xau']);
});

test('状态：外盘源时间 1 分钟内 ⇒ 实时（不再是本地快照）', () => {
  const { QS } = load();
  const now = Date.parse('2026-11-06T11:32:00+08:00');
  const s = QS.quoteStatus({
    sourceTime: '2026-11-06T11:31:00+08:00', now, fromLocal: false, market: 'CMDTY',
  });
  assert.equal(s.state, 'realtime');
  assert.match(s.card, /实时/);
  assert.ok(!s.card.includes('本地快照'));
});
