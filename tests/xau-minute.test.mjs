// tests/xau-minute.test.mjs
// 2.4.1：伦敦金分钟 K（东财 122.XAU）接入回归。
// 只读仓库文件，不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTFOLIO_KLINE, KLINE_PERIODS, klineAvailable } from '../src/sources.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'sources.mjs'), 'utf8');
const MARKET = fs.readFileSync(path.join(ROOT, 'assets', 'market.js'), 'utf8');
const MINUTE = fs.readFileSync(path.join(ROOT, 'scripts', 'update-kline-minute.mjs'), 'utf8');
const xau = PORTFOLIO_KLINE.find((x) => x.key === 'xau');

test('配置：xau 有东财现货 secid，且日线仍保留新浪外盘', () => {
  assert.ok(xau, 'PORTFOLIO_KLINE 缺少 xau');
  assert.equal(xau.secid, '122.XAU');
  assert.equal(xau.sinaGlobal, 'XAU');
  assert.equal(xau.emMinuteOnly, true, '东财 secid 必须只用于分钟');
  assert.match(xau.klineNote, /新浪/);
  assert.match(xau.klineNote, /东财/);
  // 仍然不能挂 COMEX 期货
  assert.ok(!SRC.includes("secid: '101.GC00Y'"));
});

test('周期映射：1m/5m/15m/30m/60m 可用，日/周/月仍可用', () => {
  for (const p of ['1m', '5m', '15m', '30m', '60m', '1d', '1w', '1M']) {
    assert.ok(KLINE_PERIODS.includes(p), `缺少周期 ${p}`);
  }
  assert.equal(klineAvailable('xau'), true);
});

test('日线保护：东财不参与 xau 的日/周/月（避免 longest 顶掉新浪）', () => {
  assert.match(SRC, /idx\.emMinuteOnly && dailyPeriod/);
  // 分钟周期仍会 pushEm（guard 只在 dailyPeriod 生效）
  assert.match(SRC, /if \(!\(idx\.emMinuteOnly && dailyPeriod\)\) pushEm\(\);/);
});

test('采集名单：TARGET_KEYS 含 xau，且旧注释已更正', () => {
  const m = MINUTE.match(/const TARGET_KEYS = \[([\s\S]*?)\n\];/);
  assert.ok(m, '找不到 TARGET_KEYS');
  assert.match(m[1], /'xau'/);
  assert.ok(!MINUTE.includes('伦敦金/布伦特：**全网都没有同口径的分钟源**'), '旧注释未改');
  assert.match(MINUTE, /伦敦金：东财 122\.XAU/);
});

test('前端：xau 的 klineSecid 为 122.XAU，且不再有 NO_MINUTE_REASON.xau', () => {
  assert.match(MARKET, /key: 'xau'.*klineSecid: '122\.XAU'/);
  // 前端也必须把东财限制在分钟：否则日K 会先到并顶掉新浪外盘
  assert.match(MARKET, /emMinuteOnly: true/);
  assert.match(MARKET, /meta\.emMinuteOnly && isDaily/);
  const block = MARKET.match(/const NO_MINUTE_REASON = \{([\s\S]*?)\n  \};/);
  assert.ok(block, '找不到 NO_MINUTE_REASON');
  assert.ok(!/\bxau\s*:/.test(block[1]), 'xau 不应再出现在 NO_MINUTE_REASON');
  assert.match(block[1], /\bbrent\s*:/);
});

test('前端周期映射：1/5/15/30/60 分钟与日/周/月都在 KLT', () => {
  assert.match(
    MARKET,
    /const KLT = \{ '1m': 1, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1d': 101, '1w': 102, '1M': 103 \};/
  );
});

test('落盘：xau 的 5m/30m/1m 快照非空且时间格式正确', () => {
  for (const p of ['5m', '30m', '1m']) {
    const file = path.join(ROOT, 'data', 'kline', 'min', `xau_${p}.json`);
    assert.ok(fs.existsSync(file), `缺少 ${file}`);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Array.isArray(j.bars) && j.bars.length > 0, `${p} 为空`);
    assert.match(String(j.bars[0][0]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.match(String(j.bars[j.bars.length - 1][0]), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.match(j.source, /东方财富/);
  }
});
