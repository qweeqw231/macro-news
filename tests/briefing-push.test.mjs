// tests/briefing-push.test.mjs
// 2.4.2：publish --push 的白名单、失败留痕、采集兜底。
// 只写临时目录；git 操作用注入的假 exec，不碰真实仓库。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushPathsFor, commitAndPush, commitStatusPush } from '../scripts/briefing/git-push.mjs';

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

// ---------- 2.4.4：pushed 状态二次提交 ----------
test('状态二次提交：只 add data/_briefing-status.json 并推送', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'data', '_briefing-status.json'), '{"days":{}}');
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'diff') return 'data/_briefing-status.json\n';
    if (args[0] === 'commit') return '[main def456] data: 记录早报入库 2026-11-03\n';
    return '';
  };
  try {
    const r = commitStatusPush({
      root: dir,
      statusPath: path.join(dir, 'data', '_briefing-status.json'),
      date: '2026-11-03',
      exec,
    });
    assert.equal(r.pushed, true);
    assert.equal(r.committed, true);
    assert.ok(calls[0].startsWith('add -- data/_briefing-status.json'), '只允许状态文件');
    assert.ok(!calls[0].includes('briefings/'), '不得顺手提交早报正文');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('状态二次提交：文件内容未变（已 pushed:true）时不重复提交/推送', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'data', '_briefing-status.json'), '{"days":{}}');
  const calls = [];
  const exec = (cmd, args) => { calls.push(args.join(' ')); return ''; };
  try {
    const r = commitStatusPush({
      root: dir,
      statusPath: path.join(dir, 'data', '_briefing-status.json'),
      date: '2026-11-03',
      exec,
    });
    assert.equal(r.pushed, true);
    assert.equal(r.committed, false);
    assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['add', 'diff'], '干净时不 fetch/rebase/push');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish 源码锁定：成功后调用 commitStatusPush', () => {
  assert.match(PUBLISH, /import \{ commitAndPush, commitStatusPush \}/);
  assert.match(PUBLISH, /if \(push\.pushed\) \{/);
  assert.match(PUBLISH, /commitStatusPush\(\{/);
  assert.match(PUBLISH, /statusCommit: false/);
});

// ---------- 2.4.8：rebase 与采集器改同一份 index.json 的冲突 ----------
// ⚠️ rebase 冲突时：`:2:` = **上游**(origin/main)，`:3:` = **正在重放的本地提交**
//    （2026-11-05 真实 git 实测确认；merge 才是 ours=当前 HEAD）
test('index.json 冲突：以远端计数为底、叠加本地早报字段后继续 rebase', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'data', 'index.json'), '{}');
  fs.writeFileSync(path.join(dir, 'data', 'history', 'index.json'), '{"days":[]}');
  const upstream = {
    days: [{ day: '2026-11-04', count: 345, hasBriefing: false }, { day: '2026-11-03', count: 700 }],
  };
  const local = {
    days: [{ day: '2026-11-04', count: 302, hasBriefing: true, briefLine: '早报摘要', source: 'ai' }],
  };
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rebase' && args[1] === '--autostash') {
      throw new Error('CONFLICT (content): Merge conflict in data/index.json');
    }
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) return 'data/index.json\n';
    if (args[0] === 'show' && args[1] === ':2:data/index.json') return JSON.stringify(upstream);
    if (args[0] === 'show' && args[1] === ':3:data/index.json') return JSON.stringify(local);
    if (args[0] === 'diff') return 'data/index.json\n';
    if (args[0] === 'commit') return '[main abc123] data: 早报入库 2026-11-04\n';
    return '';
  };
  try {
    const r = commitAndPush({ root: dir, date: '2026-11-04', exec });
    assert.equal(r.pushed, true);
    const merged = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'index.json'), 'utf8'));
    const e = merged.days.find((x) => x.day === '2026-11-04');
    assert.equal(e.count, 345, '计数必须取远端最新值');
    assert.equal(e.hasBriefing, true, '早报字段必须保留本地值');
    assert.equal(e.briefLine, '早报摘要');
    assert.equal(e.source, 'ai');
    assert.ok(merged.days.some((x) => x.day === '2026-11-03'), '远端其它天必须保留');
    assert.ok(calls.some((c) => c === 'rebase --continue'));
    assert.ok(!calls.some((c) => /push --force/.test(c)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('状态文件冲突：远端为底 + 本地当天的发布状态，语义合并后继续 rebase', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'data', 'index.json'), '{}');
  const upstream = {
    v: 1,
    updatedAt: '2026-11-05T08:00:00+08:00',
    days: { '2026-11-04': { date: '2026-11-04', status: 'done', source: 'ai' } },
  };
  const local = {
    v: 1,
    updatedAt: '2026-11-05T09:00:00+08:00',
    days: { '2026-11-05': { date: '2026-11-05', status: 'done', source: 'ai', items: 10 } },
  };
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rebase' && args[1] === '--autostash') {
      throw new Error('CONFLICT (content): Merge conflict in data/_briefing-status.json');
    }
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) return 'data/_briefing-status.json\n';
    if (args[0] === 'show' && args[1] === ':2:data/_briefing-status.json') return JSON.stringify(upstream);
    if (args[0] === 'show' && args[1] === ':3:data/_briefing-status.json') return JSON.stringify(local);
    if (args[0] === 'diff') return 'data/_briefing-status.json\n';
    if (args[0] === 'commit') return '[main abc123] data: 早报入库 2026-11-05\n';
    return '';
  };
  try {
    const r = commitAndPush({ root: dir, date: '2026-11-05', exec });
    assert.equal(r.pushed, true);
    const merged = JSON.parse(fs.readFileSync(path.join(dir, 'data', '_briefing-status.json'), 'utf8'));
    assert.equal(merged.days['2026-11-05'].status, 'done', '本地当天的发布状态必须保留');
    assert.equal(merged.days['2026-11-05'].items, 10);
    assert.equal(merged.days['2026-11-04'].status, 'done', '远端其它天必须保留');
    assert.equal(merged.updatedAt, '2026-11-05T09:00:00+08:00', 'updatedAt 取较晚者');
    assert.ok(calls.some((c) => c === 'rebase --continue'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('非派生索引冲突：仍然中止 rebase 并返回 conflict，不自动乱合', () => {
  const dir = sandbox();
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rebase' && args[1] === '--autostash') throw new Error('CONFLICT');
    if (args[0] === 'diff' && args.includes('--diff-filter=U')) return 'data/archive/2026-11-04.json\n';
    if (args[0] === 'diff') return 'data/index.json\n';
    if (args[0] === 'commit') return '[main abc] x\n';
    return '';
  };
  try {
    const r = commitAndPush({ root: dir, date: '2026-11-03', exec });
    assert.equal(r.pushed, false);
    assert.equal(r.kind, 'conflict');
    assert.ok(calls.some((c) => c === 'rebase --abort'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish 状态记录 pushErrorKind', () => {
  assert.match(PUBLISH, /pushErrorKind: push\.kind/);
});
