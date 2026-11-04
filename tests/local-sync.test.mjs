// tests/local-sync.test.mjs
// 2.4.17：本机同步跳过计数 + 页脚 token + 云端字段保留。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const LS = require('../assets/local-sync.js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('计数：跳过递增，成功重置', () => {
  let s = LS.nextLocalSync(null, 'skipped:fetch-failed', 't1');
  assert.equal(s.consecutiveSkips, 1);
  s = LS.nextLocalSync(s, 'skipped:unmerged', 't2');
  assert.equal(s.consecutiveSkips, 2);
  s = LS.nextLocalSync(s, 'ff-only', 't3');
  assert.equal(s.consecutiveSkips, 0);
  assert.equal(s.reason, '');
  s = LS.nextLocalSync(s, 'stash-restored', 't4');
  assert.equal(s.consecutiveSkips, 0);
  s = LS.nextLocalSync(s, 'merge', 't5');
  assert.equal(s.consecutiveSkips, 0);
});

test('result → 原因映射', () => {
  assert.equal(LS.reasonOf('skipped:stash-pop-conflict'), 'stash 恢复冲突');
  assert.equal(LS.reasonOf('skipped:merge-conflict'), '合并冲突');
  assert.equal(LS.reasonOf('ff-only'), '');
  assert.equal(LS.reasonOf('skipped:unknown'), 'skipped:unknown');
});

test('页脚 0 / 1 / 3 档文案与颜色', () => {
  assert.equal(LS.localSyncView({ consecutiveSkips: 0 }).show, false);
  const one = LS.localSyncView({ consecutiveSkips: 1, result: 'skipped:fetch-failed', reason: 'git fetch 失败', at: 'x' });
  assert.equal(one.show, true);
  assert.equal(one.level, 'warn');
  assert.equal(one.text, '本机同步跳过 1 轮 · git fetch 失败');
  assert.match(one.title, /云端主链路可能仍正常/);
  const three = LS.localSyncView({ consecutiveSkips: 3, result: 'skipped:stash-pop-conflict', reason: 'stash 恢复冲突' });
  assert.equal(three.level, 'bad');
  assert.equal(three.text, '本机同步跳过 3 轮 · stash 恢复冲突');
});

test('mergeLocalSync 不覆盖云端字段', () => {
  const doc = {
    runner: 'cloud', startedAt: '2026-11-05T00:00:00Z', durationMs: 1,
    sources: [{ id: 'sina', ok: true }], quotes: 50, added: 10,
  };
  const sync = { result: 'skipped:unmerged', reason: '存在未合并文件', at: 't', consecutiveSkips: 2 };
  const out = LS.mergeLocalSync(doc, sync);
  assert.equal(out.runner, 'cloud');
  assert.equal(out.startedAt, '2026-11-05T00:00:00Z');
  assert.deepEqual(out.sources, doc.sources);
  assert.equal(out.quotes, 50);
  assert.deepEqual(out.localSync, sync);
  assert.equal(doc.localSync, undefined, '不得修改入参');
});

test('CLI：连续跳过 1→2，成功后清零，云端字段不变', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'local-sync-'));
  const dataDir = path.join(dir, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, '_last-run.json');
  const cloud = {
    runner: 'cloud', startedAt: '2026-11-05T00:00:00Z', durationMs: 3,
    sources: [{ id: 'sina', ok: true }], quotes: 1,
  };
  await fsp.writeFile(file, JSON.stringify(cloud, null, 2), 'utf8');
  const cli = path.join(ROOT, 'scripts', 'local-sync-write.mjs');
  execFileSync(process.execPath, [cli, '--root', dir, '--result', 'skipped:fetch-failed']);
  let doc = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(doc.runner, 'cloud');
  assert.equal(doc.localSync.consecutiveSkips, 1);

  execFileSync(process.execPath, [cli, '--root', dir, '--result', 'skipped:stash-pop-conflict']);
  doc = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(doc.localSync.consecutiveSkips, 2);
  assert.deepEqual(doc.sources, cloud.sources);

  execFileSync(process.execPath, [cli, '--root', dir, '--result', 'up-to-date']);
  doc = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(doc.localSync.consecutiveSkips, 0);
  assert.equal(doc.runner, 'cloud');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('云端两个写者都保留未知字段（不清 localSync）', () => {
  for (const f of ['src/collect.mjs', 'src/portfolio-collect.mjs']) {
    const src = read(f);
    assert.match(src, /const prevLog = await readJSON\(logFile, \{\}\);/);
    assert.match(src, /\.\.\.prevLog/);
    assert.doesNotMatch(src, /delete\s+[^\n]*localSync/i);
  }
});

test('页脚调用 localSyncView，且不改变既有总灯 level', () => {
  const app = read('assets/app.js');
  assert.match(app, /MacroLocalSync/);
  assert.match(app, /localSyncView\(last\.localSync\)/);
  assert.match(app, /ft-state \$\{lsView\.level\}/);
  // 总灯只由 runMin/srcBad 等决定；不得用 localSync 改 level
  const foot = app.slice(app.indexOf('async function renderFoot'), app.indexOf('// ---------- K线图'));
  assert.doesNotMatch(foot, /level\s*=\s*[^\n]*localSync/i);
  assert.match(read('index.html'), /assets\/local-sync\.js\?v=/);
});

test('本机脚本在跳过分支写 localSync，并只提交 _last-run.json', () => {
  const ps = read('scripts/collect-and-push.ps1');
  assert.match(ps, /local-sync-write\.mjs/);
  assert.match(ps, /function Publish-LocalSync/);
  assert.match(ps, /Publish-LocalSync 'skipped:unmerged'/);
  assert.match(ps, /Write-LocalSync 'skipped:fetch-failed'/);
  assert.match(ps, /Publish-LocalSync \$syncResult/);
  assert.match(ps, /git commit -m "data: 本机同步跳过（\$result）" -- data\/_last-run\.json/);
  assert.doesNotMatch(ps, /git push[^\n]*--force/i);
});
