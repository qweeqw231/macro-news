// tests/kline-guard.test.mjs
// 2.4.10：K 线短序列覆盖守卫。纯函数，离线。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideBars, mergeBars, barTime, barVolume, upsertBars, hkVolumeScaleVerdict } from '../src/kline-guard.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const obj = (t, c = 100) => ({ t, o: c, h: c, l: c, c, v: 1 });
const arr = (t, c = 100) => [t, c, c, c, c, 1];

test('短且首根更晚、且覆盖不足 ⇒ 拒绝，保留现有（reason 可区分）', () => {
  const old = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'].map((t) => obj(t));
  const next = ['2026-02-01', '2026-02-02'].map((t) => obj(t));
  const d = decideBars(old, next);
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'shorter-too-partial');
  assert.equal(d.bars, old);
});

test('2.14.0：取消抓取上限后，源端只回几十根的「真短序列」仍被拒绝', () => {
  // 模拟 usdcny / xau 的真实形态：文件 1001 根，源端临时只返回最近 30 根
  const days = (n, start) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1) + (start + i) * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const old = days(1001, 0).map((t) => obj(t));
  const next = days(30, 971).map((t) => obj(t));
  assert.equal(next.length < old.length && next[0].t > old[0].t, true);
  const d = decideBars(old, next);
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'shorter-too-partial');
  assert.equal(d.bars.length, 1001, '现有 1001 根必须完好保留');
});

test('2.14.1：仅左端缺失 + 重叠逐根一致 + 右端不落后 ⇒ 并集合并', () => {
  const days = (n, start) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1) + (start + i) * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const old = days(1047, 0).map((t, i) => obj(t, 100 + i));
  // 少了最左 4 根，右端比现有更新一根
  const next = days(1043, 4).map((t, i) => obj(t, 100 + 4 + i));
  next[next.length - 1] = obj('2029-01-01', 999);
  const d = decideBars(old, next);
  assert.equal(d.action, 'merge');
  assert.equal(d.reason, 'left-edge-merge');
  assert.equal(d.bars.length, 1048, '旧 1047 根 + 新多出的 1 根');
  assert.equal(barTime(d.bars[d.bars.length - 1]), '2029-01-01');
});

test('2.14.1 反例①：重叠区间 OHLC 有差异 ⇒ 拒绝', () => {
  const old = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'].map((t) => obj(t));
  const next = ['2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'].map((t) => obj(t));
  next[1].c = 123;
  const d = decideBars(old, next);
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'shorter-overlap-mismatch');
});

test('2.14.1 反例②：新序列右端更旧 ⇒ 拒绝', () => {
  const days = (n, start) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1) + (start + i) * 86400000);
    return d.toISOString().slice(0, 10);
  });
  const old = days(100, 0).map((t) => obj(t));
  // 覆盖 90%，但只到第 91 根，右端落后 9 根
  const next = days(90, 2).map((t) => obj(t));
  const d = decideBars(old, next);
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'shorter-right-behind');
});

test('等长但末根更新 ⇒ 接受', () => {
  const old = ['2026-01-01', '2026-01-02', '2026-01-03'].map((t) => obj(t));
  const next = ['2026-01-01', '2026-01-02', '2026-01-03'].map((t) => obj(t));
  next[2].c = 120;
  const d = decideBars(old, next);
  assert.equal(d.action, 'accept');
  assert.equal(d.reason, 'same-length-newer');
  assert.equal(d.bars[2].c, 120);
  assert.equal(barTime(d.bars[d.bars.length - 1]), '2026-01-03');
});

test('更长且覆盖现有 ⇒ 接受', () => {
  const old = ['2026-01-01', '2026-01-02'].map((t) => obj(t));
  const next = ['2026-01-01', '2026-01-02', '2026-01-03'].map((t) => obj(t));
  const d = decideBars(old, next);
  assert.equal(d.action, 'accept');
  assert.equal(d.reason, 'longer');
  assert.equal(d.bars.length, 3);
});

test('更长但中间有缺口 ⇒ 合并（union，时间升序）', () => {
  const old = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'].map((t) => obj(t));
  const next = ['2026-01-01', '2026-01-02', '2026-01-04', '2026-01-05'].map((t) => obj(t));
  const d = decideBars(old, next);
  assert.equal(d.action, 'merge');
  assert.equal(d.reason, 'gap-merge');
  assert.deepEqual(d.bars.map(barTime), ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
});

test('空结果 ⇒ 拒绝；现有为空 ⇒ 接受', () => {
  const old = [obj('2026-01-01')];
  assert.equal(decideBars(old, []).action, 'reject');
  assert.equal(decideBars([], [obj('2026-01-01')]).action, 'accept');
  assert.equal(decideBars(undefined, []).action, 'reject');
});

test('兼容紧凑数组行（分钟/全量）', () => {
  const old = ['2026-01-01 09:00', '2026-01-01 09:05', '2026-01-01 09:10'].map((t) => arr(t));
  const next = ['2026-01-02 09:00', '2026-01-02 09:05'].map((t) => arr(t));
  assert.equal(decideBars(old, next).action, 'reject');
  const merged = mergeBars(old, ['2026-01-01 09:10', '2026-01-01 09:15'].map((t) => arr(t)));
  assert.equal(merged.length, 4);
  assert.equal(barTime(merged[3]), '2026-01-01 09:15');
});

test('成交量保护：上金所 v=0 不得覆盖东财已有成交量', () => {
  const old = [
    { t: '2026-10-28', o: 1, h: 1, l: 1, c: 1, v: 800 },
    { t: '2026-10-29', o: 1, h: 1, l: 1, c: 1, v: 900 },
    { t: '2026-10-30', o: 1, h: 1, l: 1, c: 1, v: 1000 },
  ];
  const sge = [
    { t: '2026-10-28', o: 2, h: 2, l: 2, c: 2, v: 0 },
    { t: '2026-10-29', o: 2, h: 2, l: 2, c: 2, v: 0 },
    { t: '2026-10-30', o: 2, h: 2, l: 2, c: 2, v: 0 },
  ];
  const d = decideBars(old, sge);
  assert.equal(d.action, 'accept');
  assert.deepEqual(d.bars.map(barVolume), [800, 900, 1000], 'volume 必须保留');
  assert.equal(d.bars[0].c, 2, 'OHLC 仍按新数据更新');
});

test('成交量保护也适用于数组行（分钟/全量）', () => {
  const old = [[ '2026-11-04 09:00', 1, 1, 1, 1, 500 ]];
  const next = [[ '2026-11-04 09:00', 2, 2, 2, 2, 0 ]];
  const d = decideBars(old, next);
  assert.equal(d.action, 'accept');
  assert.equal(d.bars[0][5], 500);
  assert.equal(d.bars[0][1], 2);
});

test('增量 upsert：只刷新最后几根时保留历史与成交量', () => {
  const old = [
    { t: '2026-10-28', o: 1, h: 1, l: 1, c: 1, v: 800 },
    { t: '2026-10-29', o: 1, h: 1, l: 1, c: 1, v: 900 },
    { t: '2026-10-30', o: 1, h: 1, l: 1, c: 1, v: 1000 },
  ];
  const latest = [
    { t: '2026-10-29', o: 2, h: 2, l: 2, c: 2, v: 0 },
    { t: '2026-10-30', o: 2, h: 2, l: 2, c: 2, v: 0 },
    { t: '2026-11-02', o: 2, h: 2, l: 2, c: 2, v: 0 },
  ];
  const out = upsertBars(old, latest);
  assert.deepEqual(
    out.map(barTime),
    ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02']
  );
  assert.equal(barVolume(out[1]), 900, '旧的成交量必须保留');
  assert.equal(barVolume(out[2]), 1000, '旧的成交量必须保留');
  assert.equal(out[1].c, 2, 'OHLC 仍按新数据更新');
  assert.equal(out[3].c, 2, '新增的最后几根要接上');
});

test('写 K 线的脚本都接入共享守卫', () => {
  assert.match(read('src/collect.mjs'), /import \{ decideBars, markCloseOnlyBars, barTime \} from '\.\/kline-guard\.mjs'/);
  assert.match(read('src/collect.mjs'), /: decideBars\(prev && prev\.bars, incoming\)/);
  // 2026-11-18：6 个周/月文件改由自有日 K 聚合维护，且聚合结果明显变短时仍拒
  assert.match(read('src/collect.mjs'), /WM_FROM_DAILY/);
  assert.match(read('src/collect.mjs'), /derive-shorter/);
  // 2026-11-18：分钟窗口是滚动窗口，不再走「短覆盖」判定，改为 upsert + 尾部裁剪
  assert.match(read('scripts/update-kline-minute.mjs'), /upsertBars\(oldDoc\.bars, incoming\)/);
  assert.match(read('scripts/update-kline-minute.mjs'), /KEEP_SPEC/);
  assert.doesNotMatch(read('scripts/update-kline-minute.mjs'), /const d = decideBars/);
  assert.match(read('scripts/update-kline-full.mjs'), /decideBars\(oldTrimmed, incoming\)/);
  // 2.9.0：存量先裁掉未收盘的当天 bar，否则 decideBars 会把它当缺失历史合并回来
  assert.match(read('scripts/update-kline-full.mjs'), /dropUnclosedBars\(old\.bars/);
  assert.match(read('scripts/backfill-cgb1y.mjs'), /decideBars\(old\.bars, bars\)/);
});

test('只刷新最后一根的脚本也必须经过守卫（2.4.11 漏网点）', () => {
  const src = read('scripts/update-kline-last.mjs');
  assert.match(src, /import \{ upsertBars, markCloseOnlyBars, hkVolumeScaleVerdict \} from '\.\.\/src\/kline-guard\.mjs'/);
  assert.match(src, /markCloseOnlyBars\(upsertBars\(old\.bars, latest\)\)/);
  // 2.35.0：港股写盘前必须有量级自检，且拒绝时要打日志
  assert.match(src, /hkVolumeScaleVerdict\(old\.bars, latest\)/);
  assert.match(src, /成交量量级异常，拒绝写入/);
  // 不能再回到「Map 直接覆盖」：上金所官网无 volume，会抹掉东财成交量
  assert.doesNotMatch(src, /new Map\(\(old\.bars/);
});

// ── 2.35.0：港股量级自检（成交量「股」vs 成交额「港元」）──

const volBar = (t, v) => ({ t, o: 100, h: 100, l: 100, c: 100, v });

test('港股量级自检：同一日相差 18.56 倍（成交额/成交量）⇒ 拒绝', () => {
  // 2026-11-20 恒指真实形态：旧文件是股、新结果是成交额
  const old = [volBar('2026-11-18', 14_000_000_000), volBar('2026-11-19', 15_000_000_000), volBar('2026-11-20', 14_565_080_064)];
  const next = [volBar('2026-11-19', 278_000_000_000), volBar('2026-11-20', 270_299_646_695)];
  const bad = hkVolumeScaleVerdict(old, next);
  assert.ok(bad, '18~19 倍必须命中');
  assert.equal(bad.t, '2026-11-19');
  assert.ok(bad.ratio > 18 && bad.ratio < 19, `ratio=${bad.ratio}`);
});

test('港股量级自检：反过来（旧成交额、新股）也拒绝', () => {
  const old = [volBar('2026-11-19', 278_000_000_000), volBar('2026-11-20', 270_299_646_695)];
  const next = [volBar('2026-11-19', 15_000_000_000), volBar('2026-11-20', 14_565_080_064)];
  const bad = hkVolumeScaleVerdict(old, next);
  assert.ok(bad, '1/18.5 必须命中反向区间');
  assert.ok(bad.ratio < 1 / 8 && bad.ratio > 1 / 80, `ratio=${bad.ratio}`);
});

test('港股量级自检：正常日间波动（0.5~2 倍）放行', () => {
  const old = [volBar('2026-11-18', 14_000_000_000), volBar('2026-11-19', 15_000_000_000), volBar('2026-11-20', 14_565_080_064)];
  const next = [volBar('2026-11-19', 16_100_000_000), volBar('2026-11-20', 9_800_000_000), volBar('2026-11-21', 12_000_000_000)];
  assert.equal(hkVolumeScaleVerdict(old, next), null);
});

test('港股量级自检：跳过盘中未走完的最后一根（不能误杀正常更新）', () => {
  // 旧文件今天这根是 09:35 的 1/20 量；新结果是 15:00 的全天量 —— 差 20 倍但合法
  const old = [volBar('2026-11-19', 15_000_000_000), volBar('2026-11-20', 700_000_000)];
  const next = [volBar('2026-11-19', 15_000_000_000), volBar('2026-11-20', 14_565_080_064)];
  assert.equal(hkVolumeScaleVerdict(old, next), null, '最新一根（双方同一天）应跳过');
});

test('港股量级自检：成交量缺失（0）的 bar 不参与比较', () => {
  const old = [volBar('2026-11-19', 0), volBar('2026-11-20', 0)];
  const next = [volBar('2026-11-19', 15_000_000_000), volBar('2026-11-20', 14_565_080_064)];
  assert.equal(hkVolumeScaleVerdict(old, next), null);
});

test('港股量级自检：同一日的量级比值只认均价区间，不做手/股换算', () => {
  // 8 与 80 是闭区间边界；7.9 / 80.1 不拦（价格假想值，仅验证阈值语义）
  const base = [volBar('2026-11-19', 1_000), volBar('2026-11-20', 1_000)];
  assert.ok(hkVolumeScaleVerdict(base, [volBar('2026-11-19', 8_000), volBar('2026-11-20', 1_000)]));
  assert.ok(hkVolumeScaleVerdict(base, [volBar('2026-11-19', 80_000), volBar('2026-11-20', 1_000)]));
  assert.equal(hkVolumeScaleVerdict(base, [volBar('2026-11-19', 7_900), volBar('2026-11-20', 1_000)]), null);
  assert.equal(hkVolumeScaleVerdict(base, [volBar('2026-11-19', 81_000), volBar('2026-11-20', 1_000)]), null);
});

test('港股不接腾讯兜底：服务端与前端都要排除', () => {
  const src = read('src/sources.mjs');
  assert.match(src, /else if \(idx\.market === 'HK'\) \{[\s\S]*?pushEm\(\);/, '港股分支没有只留东财');
  assert.doesNotMatch(src, /if \(idx\.market !== 'HK'\) pushTx\(\);/, '仍保留旧的腾讯注册写法');
  // 单源失败必须抛错（上层据此「不写」），不能返回空数组冒充成功
  assert.match(src, /if \(!bars \|\| !bars\.length\) throw new Error\('返回空'\)/);
  assert.match(src, /throw new Error\(`K线不可得：\$\{errors\.join/);
  const market = read('assets/market.js');
  assert.match(market, /if \(!\(meta && meta\.market === 'HK'\)\) \{[\s\S]*?add\('腾讯兜底'/,
    '前端直连赛马仍对港股注册腾讯');
});

test('量能浮窗带单位：A 股/港股显示「股」', () => {
  const chart = read('assets/kline.js');
  assert.match(chart, /fmtVol\(b\.v\) \+ this\.volumeUnit/, '浮窗量能没有拼单位');
  assert.match(chart, /setVolumeUnit\(unit\)/);
  const app = read('assets/app.js');
  assert.match(app, /kChart\.setVolumeUnit\(volUnitOf\(key\)\)/);
  assert.match(app, /\(meta\.market === 'CN' \|\| meta\.market === 'HK'\) \? '股'/);
});

// ── 2026-11-18：只放宽「最后一桶」与「价格精度」，不拆守卫 ──

test('最后一桶被源侧重述 ⇒ 仍然并集（xau_1w 3910.34 → 3879.92 的真实形态）', () => {
  const old = ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-13'].map((t, i) => obj(t, 100 + i));
  // 源侧起点更晚（左端残缺）、最后一桶 close 被重述（103 → 109）、右端更新
  const next = ['2026-11-02', '2026-11-09', '2026-11-13', '2026-11-18'].map((t, i) =>
    obj(t, i === 2 ? 109 : 102 + i)
  );
  const d = decideBars(old, next);
  assert.equal(d.action, 'merge');
  assert.equal(d.reason, 'left-edge-merge');
  assert.equal(d.bars.length, 6, '旧左端 10-19 / 10-26 必须保留');
  assert.equal(d.bars.at(-1).t, '2026-11-18');
  assert.equal(d.bars.find((b) => b.t === '2026-11-13').c, 109, '最后一桶按源侧最新值覆盖');
});

test('价格精度容差：997.323 vs 997.32 不算不一致', () => {
  const old = ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-13'].map((t) => ({
    t, o: 997.323, h: 997.323, l: 997.323, c: 997.323, v: 0,
  }));
  const next = ['2026-11-02', '2026-11-09', '2026-11-13', '2026-11-18'].map((t) => ({
    t, o: 997.32, h: 997.32, l: 997.32, c: 997.32, v: 0,
  }));
  const d = decideBars(old, next);
  assert.equal(d.action, 'merge', '精度差异不应把整条序列判死');
});

test('中段真实不一致 / 真短序列仍然拒绝（守卫没有被拆掉）', () => {
  const old = ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09', '2026-11-13'].map((t, i) => obj(t, 100 + i));
  // 11-02 是中段、不是最后一桶：差 100% ⇒ 必须拒
  const mid = ['2026-11-02', '2026-11-09', '2026-11-13', '2026-11-18'].map((t, i) =>
    obj(t, i === 0 ? 200 : 101 + i)
  );
  const d1 = decideBars(old, mid);
  assert.equal(d1.action, 'reject');
  assert.equal(d1.reason, 'shorter-overlap-mismatch');
  // 源侧只回 2 根（覆盖不足 80%）⇒ 仍然拒，且不能靠「最后一桶」放行
  const tiny = ['2026-11-13', '2026-11-18'].map((t) => obj(t));
  const d2 = decideBars(old, tiny);
  assert.equal(d2.action, 'reject');
  assert.equal(d2.reason, 'shorter-too-partial');
});
