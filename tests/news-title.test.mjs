// tests/news-title.test.mjs
// 2.4.6：标题不再硬截 40 字；短版只在标点边界断开；前端用 line-clamp。
// 纯函数；不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titleFromText, shortenTitle, normalizeTitleText } from '../src/news-title.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = fs.readFileSync(path.join(ROOT, 'src', 'sources.mjs'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

const TEXT = '科创50跌超5%，创业板指跌近3%，算力硬件、算力芯片股持续下挫，深南电路、景旺电子、光迅科技午后跌停，寒武纪、沐曦股份、天孚通信、中际旭创等多股跌超10%。';

test('真实事故：标题取完整第一句，不再切到「光迅」', () => {
  const t = titleFromText(TEXT);
  assert.ok(t.length > 40, '完整标题必须长于旧的 40 字硬截');
  assert.ok(t.includes('光迅科技午后跌停'), '不得切断专有名词');
  assert.ok(t.includes('等多股跌超10%。'), '第一整句必须完整');
  assert.ok(t.endsWith('。'));
  assert.notEqual(t, TEXT.slice(0, 40));
});

test('第一整句优先：两句话只取第一句', () => {
  assert.equal(titleFromText('甲句。乙句。'), '甲句。');
  assert.equal(titleFromText('甲句！乙句。'), '甲句！');
});

test('短版只在标点边界断开并加省略号', () => {
  const long = '这是一段很长的快讯正文，包含多个分句，用来验证截断不会落在专有名词中间，而是停在标点之后。还有后续内容。';
  const s = shortenTitle(long, 30);
  assert.ok(s.endsWith('…'));
  const before = s.slice(0, -1).slice(-1);
  assert.ok('。！？；，、'.includes(before), `截断点应落在标点后，实际前一位：${before}`);
  assert.ok(!/…$/.test(shortenTitle(long.slice(0, 20), 30)), '短于上限时不加省略号');
});

test('窗口内没有标点：不硬切，返回全文', () => {
  const noPunct = '科创50跌超5%创业板指跌近3%深南电路景旺电子光迅科技午后跌停寒武纪沐曦股份天孚通信中际旭创等多股跌超10';
  assert.equal(shortenTitle(noPunct, 20), noPunct);
  assert.equal(titleFromText(noPunct, 20), noPunct);
});

test('空白归一化；空输入安全', () => {
  assert.equal(normalizeTitleText('  a\n b  '), 'a b');
  assert.equal(titleFromText(''), '');
  assert.equal(titleFromText(null), '');
});

test('sources 源码锁定：使用 titleFromText，且不再有 text.slice(0, 40)', () => {
  assert.match(SOURCES, /import \{ titleFromText \} from '\.\/news-title\.mjs'/);
  assert.match(SOURCES, /title: rawTitle \|\| titleFromText\(text\)/);
  assert.ok(!/text\.slice\(0,\s*40\)/.test(SOURCES), '不得恢复 40 字硬截');
});

test('前端：.item-title 用多行省略（line-clamp），不是 substring', () => {
  assert.match(CSS, /\.item-title[^}]*display:\s*-webkit-box/s);
  assert.match(CSS, /\.item-title[^}]*-webkit-line-clamp:\s*2/s);
  assert.ok(!/it\.title\.(slice|substring)/.test(APP), '前端不得对标题做字符截断');
});
