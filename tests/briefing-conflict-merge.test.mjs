// tests/briefing-conflict-merge.test.mjs
// 真实 git 端到端：采集器（远端）与早报发布器（本地）同时改 data/index.json 与
// data/_briefing-status.json ⇒ rebase 冲突 ⇒ 自动语义合并 ⇒ 推送成功。
//
// 为什么用真 git：2026-11-04/11-05 两次事故都源于「rebase 冲突时 :2:/:3: 到底是谁」
// 这一 stage 语义被想当然写反，而假 exec 的 fixture 会把错误语义一起固化。
// 本文件用真实仓库把语义钉死。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitAndPush } from '../scripts/briefing/git-push.mjs';

const DATE = '2026-11-05';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * 搭一个「远端裸仓库 + 本地工作区 + 采集器克隆」的三方场景。
 * 远端（采集器）：index.json 计数刷新到 40 / total 345，状态文件也动过；
 * 本地（发布器）：index.json 计数还是旧的 10，但带上了当天的早报标记。
 */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'briefmerge-'));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const collector = path.join(root, 'collector');
  fs.mkdirSync(work);
  fs.mkdirSync(collector);

  git(root, ['init', '--bare', '-b', 'main', remote]);

  git(work, ['init', '-b', 'main']);
  git(work, ['config', 'user.email', 't@example.com']);
  git(work, ['config', 'user.name', 't']);
  git(work, ['config', 'core.autocrlf', 'false']);
  git(work, ['config', 'commit.gpgsign', 'false']);
  git(work, ['remote', 'add', 'origin', remote]);

  // 基线
  writeJson(path.join(work, 'data', 'index.json'), {
    generatedAt: '2026-11-05T00:00:00.000Z', total: 100,
    days: [{ day: DATE, count: 10, hasBriefing: false }],
  });
  writeJson(path.join(work, 'data', 'history', 'index.json'), {
    generatedAt: '2026-11-05T00:00:00.000Z', total: 100,
    days: [{ d: DATE, n: 10, hasBriefing: false }],
  });
  writeJson(path.join(work, 'data', '_briefing-status.json'), {
    v: 1, updatedAt: '2026-11-04T09:07:14+08:00',
    days: { '2026-11-04': { date: '2026-11-04', status: 'done', source: 'ai' } },
  });
  git(work, ['add', '-A']);
  git(work, ['commit', '-m', 'base']);
  git(work, ['push', 'origin', 'main']);

  // 采集器在远端提交新计数（同时动了状态文件）
  git(collector, ['clone', remote, '.']);
  git(collector, ['config', 'user.email', 'c@example.com']);
  git(collector, ['config', 'user.name', 'c']);
  git(collector, ['config', 'core.autocrlf', 'false']);
  writeJson(path.join(collector, 'data', 'index.json'), {
    generatedAt: '2026-11-05T00:52:42.618Z', total: 345,
    days: [{ day: DATE, count: 40, hasBriefing: false }],
  });
  writeJson(path.join(collector, 'data', '_briefing-status.json'), {
    v: 1, updatedAt: '2026-11-05T08:10:00+08:00',
    days: {
      '2026-11-04': { date: '2026-11-04', status: 'done', source: 'ai' },
      [DATE]: { date: DATE, status: 'awaiting', stage: 'awaiting-llm', items: 0 },
    },
  });
  git(collector, ['add', '-A']);
  git(collector, ['commit', '-m', 'collector']);
  git(collector, ['push', 'origin', 'main']);

  // 本地（发布器）写当天早报：计数仍是旧值，但打上早报标记
  writeJson(path.join(work, 'data', 'index.json'), {
    generatedAt: '2026-11-05T00:00:00.000Z', total: 100,
    days: [{ day: DATE, count: 10, hasBriefing: true, briefLine: '早报摘要', source: 'ai' }],
  });
  writeJson(path.join(work, 'data', 'briefings', `${DATE}.json`), {
    date: DATE, source: 'ai', generator: 'llm-v1', overview: '概览', items: [{ rank: 1 }],
  });
  writeJson(path.join(work, 'data', '_briefing-status.json'), {
    v: 1, updatedAt: '2026-11-05T09:30:00+08:00',
    days: {
      '2026-11-04': { date: '2026-11-04', status: 'done', source: 'ai' },
      [DATE]: { date: DATE, status: 'done', source: 'ai', items: 10, generator: 'llm-v1' },
    },
  });

  return { root, remote, work };
}

test('真实 rebase 冲突：远端计数 + 本地早报标记 合并后推送成功', () => {
  const { root, remote, work } = setup();
  try {
    const r = commitAndPush({ root: work, date: DATE });
    assert.equal(r.pushed, true, `推送应成功：${r.error || ''}`);

    // 远端最终内容：计数取采集器的新鲜值，早报标记取本地发布器的值
    const remoteIndex = JSON.parse(git(remote, ['show', `main:data/index.json`]));
    const e = remoteIndex.days.find((x) => x.day === DATE);
    assert.equal(e.count, 40, '计数必须取远端最新值');
    assert.equal(e.hasBriefing, true, '当天早报标记必须保留');
    assert.equal(e.briefLine, '早报摘要');
    assert.equal(e.source, 'ai');
    assert.equal(remoteIndex.total, 345, 'total 取远端最新值');

    const remoteStatus = JSON.parse(git(remote, ['show', 'main:data/_briefing-status.json']));
    assert.equal(remoteStatus.days[DATE].status, 'done', '本地当天的发布状态必须保留');
    assert.equal(remoteStatus.days[DATE].items, 10);
    assert.equal(remoteStatus.days['2026-11-04'].status, 'done', '远端其它天必须保留');
    assert.equal(remoteStatus.updatedAt, '2026-11-05T09:30:00+08:00', 'updatedAt 取较晚者');

    // 工作区与远端一致
    const localIndex = JSON.parse(fs.readFileSync(path.join(work, 'data', 'index.json'), 'utf8'));
    assert.equal(localIndex.days.find((x) => x.day === DATE).count, 40);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真实 rebase 冲突：非白名单文件冲突仍然中止，不静默乱合', () => {
  const { root, work, remote } = setup();
  try {
    // 采集器再提交一次，改的是一个早报管线管不到的文件（data/archive/...）
    const collector = path.join(root, 'collector2');
    fs.mkdirSync(collector);
    git(collector, ['clone', remote, '.']);
    git(collector, ['config', 'user.email', 'c@example.com']);
    git(collector, ['config', 'user.name', 'c']);
    writeJson(path.join(collector, 'data', 'archive', `${DATE}.json`), { items: [{ id: 1 }] });
    git(collector, ['add', '-A']);
    git(collector, ['commit', '-m', 'archive']);
    git(collector, ['push', 'origin', 'main']);

    // 本地也改同一个文件 → 必然冲突，且不在白名单
    writeJson(path.join(work, 'data', 'archive', `${DATE}.json`), { items: [{ id: 2 }] });

    const r = commitAndPush({ root: work, date: DATE });
    assert.equal(r.pushed, false);
    assert.equal(r.kind, 'conflict');
    assert.ok(!fs.existsSync(path.join(work, '.git', 'rebase-merge')), 'rebase 必须已中止');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
