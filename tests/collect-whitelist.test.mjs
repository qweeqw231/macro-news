// tests/collect-whitelist.test.mjs
// 静态校验：本机采集脚本提交数据时必须用「白名单」，不能整目录 add。
//
// 背景（2026-11-02 事故）：collect-and-push.ps1 当时的 `git add -- data` 把 2.2.1 模拟误写的
// 规则版早报与 _briefing-status.json 一并打包推送，覆盖了远端 AI 早报。
// 这个测试不联网、不写盘，只读脚本文本，防止白名单被改回去。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'collect-and-push.ps1');
const text = fs.readFileSync(SCRIPT, 'utf8');

test('采集脚本不再整目录提交 data/', () => {
  // 只匹配真正的命令（行首 $null =），不把历史注释里的 `git add -- data` 当违规
  assert.ok(
    !/^\s*[^#\n]*git add -- data\s*$/m.test(text),
    '不允许 `git add -- data`（会把 data/ 下的意外文件一起提交）'
  );
  assert.ok(!/^\s*[^#\n]*git add (-A|--all)\b/m.test(text), '不允许 git add -A/--all');
  assert.ok(!/^\s*[^#\n]*git add \.\s*$/m.test(text), '不允许 git add .');
});

test('采集脚本使用白名单：archive/kline 已跟踪修改 + 固定文件', () => {
  assert.ok(text.includes('git add -u -- data/archive data/kline'), '缺少 -u 白名单暂存');
  for (const f of [
    'data/latest.json', 'data/index.json', 'data/search.json',
    'data/quotes.json', 'data/_last-run.json', 'data/_briefing-status.json',
  ]) {
    assert.ok(text.includes(f), `白名单缺少 ${f}`);
  }
  assert.ok(text.includes("data/archive/$d.json"), '缺少今天/昨天 archive 的显式 add');
});

test('采集脚本不提交早报 / 历史切片 / 快照 / 宏观', () => {
  const commandLines = text
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  for (const forbidden of ['data/briefings', 'data/history', 'data/snapshots', 'data/macro']) {
    assert.ok(!commandLines.includes(forbidden), `命令里不应出现 ${forbidden}`);
  }
});
