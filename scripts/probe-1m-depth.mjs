// scripts/probe-1m-depth.mjs —— 一次性实测：各源 1m 真实上限
// 结果写 data/kline/min/_probe-1m.json，供人工出表；不参与日常调度。
// 东财 push2his 在本机不可达，必须在 Actions 上跑。
import fs from 'node:fs';
import { emGetJSON, KLINE_HOSTS } from '../src/em.mjs';

const KL_FIELDS = 'fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EM_TARGETS = [
  ['dxy', '100.UDI', '外汇指数'],
  ['usdcny', '133.USDCNH', '离岸人民币'],
  ['eurusd', '119.EURUSD', '美元对'],
  ['gbpusd', '119.GBPUSD', '美元对'],
  ['usdjpy', '119.USDJPY', '美元对'],
  ['usdkrw', '119.USDKRW', '美元对'],
  ['audusd', '119.AUDUSD', '美元对'],
  ['usdcad', '119.USDCAD', '美元对'],
  ['usdchf', '119.USDCHF', '美元对'],
  ['eurcny', '119.EURCNY', '交叉盘'],
  ['gbpcny', '119.GBPCNY', '交叉盘'],
  ['jpycny', '119.JPYCNY', '交叉盘'],
  ['krwcny', '119.KRWCNY', '交叉盘'],
  ['audcny', '119.AUDCNY', '交叉盘'],
  ['n225', '100.N225', '股票'],
  ['dax', '100.GDAXI', '股票'],
  ['cac40', '100.FCHI', '股票'],
  ['ukx', '100.FTSE', '股票'],
  ['kospi', '100.KS11', '股票'],
  ['sox', '251.SOX', '股票'],
  ['sge_au9999', '118.AU9999', '商品'],
  ['xag', '122.XAG', '商品'],
  ['xau', '122.XAU', '商品'],
];

const SINA_SYMS = [
  ['eurcny', 'fx_seurcny'], ['gbpcny', 'fx_sgbpcny'], ['jpycny', 'fx_sjpycny'],
  ['krwcny', 'fx_skrwcny'], ['audcny', 'fx_saudcny'],
  ['eurusd', 'fx_seurusd'], ['gbpusd', 'fx_sgbpusd'], ['usdjpy', 'fx_susdjpy'],
  ['usdkrw', 'fx_susdkrw'], ['audusd', 'fx_saudusd'], ['usdcad', 'fx_susdcad'],
  ['usdchf', 'fx_susdchf'], ['usdcny', 'fx_susdcnh'],
];

async function probeEm(key, secid, group, lmt) {
  try {
    const j = await emGetJSON(
      `/api/qt/stock/kline/get?secid=${secid}&klt=1&fqt=1&lmt=${lmt}&end=20500101&${KL_FIELDS}`,
      { hosts: KLINE_HOSTS, cacheTtlMs: 0, cacheTag: `probe1m-${key}-${lmt}`, timeout: 20000 }
    );
    const rows = j?.data?.klines || [];
    return {
      key, secid, group, lmt, bars: rows.length,
      first: rows.length ? rows[0] : '', last: rows.length ? rows[rows.length - 1] : '',
    };
  } catch (e) {
    return { key, secid, group, lmt, error: String(e.message || e).slice(0, 160) };
  }
}

async function probeSina(key, sym) {
  const url = 'https://vip.stock.finance.sina.com.cn/forex/api/jsonp.php/var%20_data=/' +
    `NewForexService.getMinKLine?symbol=${sym}&scale=1&datalen=20000`;
  try {
    const txt = await (await fetch(url, { headers: { Referer: 'https://finance.sina.com.cn/' } })).text();
    const m = txt.match(/=\((\[[\s\S]*\])\)/);
    if (!m) return { key, sym, error: '格式异常' };
    const a = JSON.parse(m[1]);
    return {
      key, sym, bars: a.length,
      first: a.length ? a[0].d : '', last: a.length ? a[a.length - 1].d : '',
    };
  } catch (e) {
    return { key, sym, error: String(e.message || e).slice(0, 160) };
  }
}

const em = [];
for (const [key, secid, group] of EM_TARGETS) {
  em.push(await probeEm(key, secid, group, 20000));
  console.log('EM', JSON.stringify(em[em.length - 1]));
  await sleep(1500);
}

// dxy 的 lmt 阶梯：确认东财是「给多少算多少」还是按 lmt 截断
const emLadder = [];
for (const lmt of [300, 1000, 2000, 5000, 20000]) {
  emLadder.push(await probeEm('dxy', '100.UDI', '外汇指数', lmt));
  console.log('LADDER', JSON.stringify(emLadder[emLadder.length - 1]));
  await sleep(1500);
}

const sina = [];
for (const [key, sym] of SINA_SYMS) {
  sina.push(await probeSina(key, sym));
  console.log('SINA', JSON.stringify(sina[sina.length - 1]));
  await sleep(600);
}

const out = {
  generatedAt: new Date().toISOString(),
  runner: process.env.RUNNER_NAME || 'local',
  em, emLadder, sina,
};
fs.writeFileSync('data/kline/min/_probe-1m.json', JSON.stringify(out, null, 2));
console.log('WROTE data/kline/min/_probe-1m.json');
