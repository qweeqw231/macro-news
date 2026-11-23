// 2.36.2：宏观图的缩放/平移交互必须与 K 线同一套手感。
// 图表依赖 Canvas/DOM，Node 里无法直接实例化，这里按仓库既有做法做「源码契约」断言：
// 一旦有人删掉滚轮/Ctrl 档位、拖动或边界钳制，测试立刻失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('宏观图滚轮缩放与 K 线同方向、同幅度（Ctrl 档位更细）', () => {
  const src = read('assets/macro-chart.js');
  assert.match(src, /addEventListener\('wheel'/);
  assert.match(src, /\{ passive: false \}/);
  assert.match(src, /e\.preventDefault\(\)/);
  assert.match(src, /e\.ctrlKey \? 0\.08 : 0\.2/);
  assert.match(src, /1 \+ \(e\.deltaY > 0 \? step : -step\)/);
  // 以光标为锚点，并复用 K 线的 160ms easeOutCubic
  assert.match(src, /const anchor = Math\.max\(0, Math\.min\(1, \(e\.clientX - rect\.left - pad\.l\) \/ plotW\)\)/);
  assert.match(src, /const dur = 160/);
  assert.match(src, /1 - Math\.pow\(1 - k, 3\)/);
});

test('宏观图拖动平移沿用 K 线的弹窗表面 + document 事件', () => {
  const src = read('assets/macro-chart.js');
  assert.match(src, /closest\('\.kline-modal'\)/);
  assert.match(src, /surface\.addEventListener\('mousedown'/);
  assert.match(src, /document\.addEventListener\('mousemove', this\._onDocMove\)/);
  assert.match(src, /document\.addEventListener\('mouseup', this\._onDocUp\)/);
  assert.match(src, /const delta = Math\.round\(\(this\._dragX - x\) \/ bw\)/);
  assert.match(src, /const next = Math\.max\(0, Math\.min\(this\._maxOffset\(\), this\._dragOffset \+ delta\)\)/);
  // 双击回最新
  assert.match(src, /addEventListener\('dblclick'/);
});

test('宏观图缩放/平移有边界：最少 20 点、最多全部、不能拖出数据范围', () => {
  const src = read('assets/macro-chart.js');
  assert.match(src, /_zoomLimits\(\) \{[\s\S]*?min: Math\.max\(1, Math\.min\(20, total\)\), max: total/);
  assert.match(src, /_maxOffset\(\) \{[\s\S]*?return Math\.max\(0, this\.bars\.length - this\._barsShown\(\)\);/);
  assert.match(src, /const next = Math\.max\(min, Math\.min\(max, target\)\)/);
  assert.match(src, /const next = Math\.max\(0, Math\.min\(this\._maxOffset\(\), this\.offset \+ delta\)\)/);
});

test('宏观图只画可见窗口：横轴/纵轴/浮窗按缩放后的 view 重算', () => {
  const src = read('assets/macro-chart.js');
  assert.match(src, /const view = this\.bars\.slice\(start, end\)/);
  assert.match(src, /for \(const b of view\) \{ if \(b\.v < lo\) lo = b\.v; if \(b\.v > hi\) hi = b\.v; \}/);
  assert.match(src, /const txt = this\._fmtTick\(view\[i\]\.t\)/);
  // 「较上期」取真实上一期（跨可见窗口也对）
  assert.match(src, /const prev = abs > 0 \? this\.bars\[abs - 1\] : null/);
});

test('宏观图切换语义与 K 线一致：换指标 reset，区间切换保留缩放', () => {
  const src = read('assets/macro-chart.js');
  assert.match(src, /reset\(\) \{/);
  assert.match(src, /this\.barsShown = 0;/);
  const app = read('assets/app.js');
  assert.match(app, /else mmChart\.reset\(\)/);
  assert.match(app, /mmChart\.panBy\(15\)/);
  assert.match(app, /mmChart\.zoomBy\(1 \/ 1\.2/);
});
