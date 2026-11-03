// tests/briefing-index-invariant.test.mjs
// 2.4.2：hasBriefing=true 必须对应文件已存在且已被 git 跟踪。
// 只读仓库；不联网、不写盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'index.json'), 'utf8'));

function isGitRepo() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('hasBriefing=true 的日期：文件存在且已被 git 跟踪', () => {
  const tracked = isGitRepo();
  const days = (INDEX.days || []).filter((d) => d && d.hasBriefing);
  assert.ok(days.length > 0, '索引里没有任何早报？');
  for (const d of days) {
    const rel = `data/briefings/${d.day}.json`;
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${d.day} 索引为 true 但文件不存在`);
    if (tracked) {
      const out = execFileSync('git', ['ls-files', rel], { cwd: ROOT, encoding: 'utf8' }).trim();
      assert.ok(out, `${d.day} 索引为 true 但文件未被 git 跟踪`);
    }
    assert.ok(d.source === 'ai' || d.source === 'draft' || d.source === 'rule');
    assert.ok((d.briefLine || '').length > 0, `${d.day} 缺少 briefLine`);
  }
});

test('不存在“索引 false 但文件在 git 里”的漏标（允许，仅提示）', () => {
  const tracked = isGitRepo();
  if (!tracked) return;
  const files = execFileSync('git', ['ls-files', 'data/briefings'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const byDay = new Map((INDEX.days || []).map((d) => [d.day, d]));
  for (const f of files) {
    const m = f.match(/^data\/briefings\/(\d{4}-\d{2}-\d{2})\.json$/);
    if (!m) continue;
    const entry = byDay.get(m[1]);
    if (entry && !entry.hasBriefing) {
      assert.fail(`${m[1]} 文件已跟踪但索引 hasBriefing=false`);
    }
  }
});
