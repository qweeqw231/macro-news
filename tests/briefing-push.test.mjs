// tests/briefing-push.test.mjs
// 2.4.2：publish --push 的白名单、失败留痕、采集兜底。
// 只写临时目录；git 操作用注入的假 exec，不碰真实仓库。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushPathsFor, commitAndPush } from '../scripts/briefing/git-push.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH = fs.readFileSync(path.join(ROOT, 'scripts', 'briefing', 'publish.mjs'), 'utf8');
const COLLECT = fs.readFileSync(path.join(ROOT, 'scripts', 'collect-and-push.ps1'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefpush-'));
  fs.mkdirSync(path.join(dir, 'data', 'briefings'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'history'), { recursive: true });
  for (const p of pushPathsFor('2026-11-03')) {
    if (p.endsWith('.json') && p.includes('briefings/')) {
      fs.writeFileSync(path.join(dir, p), '{"source":"ai","items":[]}');
    }
  }
  return dir;
}

function fakeExec(failAt) {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(' '));
    if (failAt && args[0] === failAt) throw new Error(`${args[0]} simulated failure`);
    if (args[0] === 'diff') return { stdout: 'data/briefings/2026-11-03.json\n' };
    if (args[0] === 'commit') return { stdout: '[main abc123] data: 早报入库 2026-11-03\n' };
    return { stdout: '' };
  };
  return { calls, exec };
}

test('白名单：只提交早报相关 4 个路径，不整目录', () => {
  assert.deepEqual(pushPathsFor('2026-11-03'), [
    'data/briefings/2026-11-03.json',
    'data/index.json',
    'data/history/index.json',
    'data/_briefing-status.json',
  ]);
});

test('成功路径：add → commit → fetch → rebase → push', () => {
  const dir = sandbox();
  const f = fakeExec();
  try {
    const r = commitAndPush({ root: dir, date: '2026-11-03', exec: f.exec });
    assert.equal(r.pushed, true);
    assert.equal(r.committed, true);
    assert.deepEqual(f.calls.map((c) => c.split(' ')[0]), ['add', 'diff', 'commit', 'fetch', 'rebase', 'push']);
    assert.ok(f.calls[0].includes('data/briefings/2026-11-03.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('真实 exec 形态：execFileSync 返回字符串时也能识别暂存并提交', () => {
  const dir = sandbox();
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'diff') return 'data/briefings/2026-11-03.json\n';
    if (args[0] === 'commit') return '[main abc123] data: 早报入库 2026-11-03\n';
    return '';
  };
  try {
    const r = commitAndPush({ root: dir, date: '2026-11-03', exec });
    assert.equal(r.committed, true);
    assert.ok(calls.some((c) => c.startsWith('commit')));
    assert.equal(r.pushed, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('push 失败：不回滚已发布文件，返回 error', () => {
  const dir = sandbox();
  const f = fakeExec('push');
  try {
    const before = fs.readFileSync(path.join(dir, 'data/briefings/2026-11-03.json'), 'utf8');
    const r = commitAndPush({ root: dir, date: '2026-11-03', exec: f.exec });
    assert.equal(r.pushed, false);
    assert.match(r.error, /push 失败/);
    assert.equal(fs.readFileSync(path.join(dir, 'data/briefings/2026-11-03.json'), 'utf8'), before);
    assert.ok(!f.calls.some((c) => /^(reset|checkout|restore|clean)\b/.test(c)), '禁止回滚操作');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('rebase 失败：abort 后返回 error，文件仍在', () => {
  const dir = sandbox();
  const f = fakeExec('rebase');
  try {
    const r = commitAndPush({ root: dir, date: '2026-11-03', exec: f.exec });
    assert.equal(r.pushed, false);
    assert.match(r.error, /rebase 失败/);
    assert.ok(f.calls.some((c) => c === 'rebase --abort'));
    assert.ok(f.calls.some((c) => c === 'rebase --autostash origin/main'));
    assert.ok(fs.existsSync(path.join(dir, 'data/briefings/2026-11-03.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish 源码锁定：--push 与 commitAndPush 接线', () => {
  assert.match(PUBLISH, /const PUSH = flag\('push'\)/);
  assert.match(PUBLISH, /commitAndPush\(\{ root: ROOT, date: DATE/);
  assert.match(PUBLISH, /pushed: !!push\.pushed/);
  assert.match(PUBLISH, /pushError/);
});

test('采集兜底：只放行今天/昨天的单文件，禁止整目录', () => {
  assert.match(COLLECT, /data\/briefings\/\$d\.json/);
  assert.ok(!/git add -- data\/briefings(?![\/\w$])/.test(COLLECT), '不得整目录 add briefings');
});

test('页脚：pushed=false 显示“已发布未入库”', () => {
  assert.match(APP, /rec\.pushed === false/);
  assert.match(APP, /早报 已发布未入库/);
});
