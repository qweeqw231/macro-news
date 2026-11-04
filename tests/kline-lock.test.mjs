// tests/kline-lock.test.mjs
// 2.4.15：按标的写锁。使用系统临时目录，不污染 .cache/。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireKlineLock, releaseKlineLock, withKlineLock, lockSkipText, klineLockPath,
} from '../src/kline-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'kline-lock-'));

test('并发获取同一把锁：只有一个成功', async () => {
  const dir = await tmpDir();
  const [a, b] = await Promise.all([
    acquireKlineLock('sh_comp', { dir }),
    acquireKlineLock('sh_comp', { dir }),
  ]);
  assert.equal(Number(a.ok) + Number(b.ok), 1, '同一时刻只能有一个持有者');
  const winner = a.ok ? a : b;
  assert.equal(await releaseKlineLock(winner), true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('拿不到锁：返回 skip、不执行回调，文案含“写锁被占用”', async () => {
  const dir = await tmpDir();
  const held = await acquireKlineLock('sge_au9999', { dir });
  assert.equal(held.ok, true);

  const busy = await acquireKlineLock('sge_au9999', { dir });
  assert.equal(busy.ok, false);
  assert.ok(busy.holder && busy.holder.pid, '应能读到持有者');
  assert.match(lockSkipText('sge_au9999', busy), /跳过：写锁被占用/);

  let ran = false;
  const res = await withKlineLock('sge_au9999', () => { ran = true; }, { dir });
  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.equal(ran, false, '拿不到锁不得执行写入回调');
  assert.match(lockSkipText('sge_au9999', res), /写锁被占用/);

  assert.equal(await releaseKlineLock(held), true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('释放后可以重新获取', async () => {
  const dir = await tmpDir();
  const a = await acquireKlineLock('cgb_1y', { dir });
  assert.equal(await releaseKlineLock(a), true);
  const b = await acquireKlineLock('cgb_1y', { dir });
  assert.equal(b.ok, true);
  assert.equal(await releaseKlineLock(b), true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('陈旧锁可接管，旧持有者释放不会删掉新锁', async () => {
  const dir = await tmpDir();
  const first = await acquireKlineLock('dji', { dir });
  const old = new Date(Date.now() - 60_000);
  await fsp.utimes(first.file, old, old);

  const second = await acquireKlineLock('dji', { dir, staleMs: 5_000 });
  assert.equal(second.ok, true, '60 秒的锁在 5 秒阈值下应被接管');
  assert.equal(await releaseKlineLock(first), false, '旧 token 不得删除新锁');
  assert.equal(await releaseKlineLock(second), true);

  const third = await acquireKlineLock('dji', { dir });
  assert.equal(third.ok, true);
  assert.equal(await releaseKlineLock(third), true);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('锁路径按标的隔离', async () => {
  const dir = await tmpDir();
  assert.notEqual(klineLockPath('sh_comp', dir), klineLockPath('hsi', dir));
  assert.match(klineLockPath('sh_comp', dir), /kline-sh_comp\.lock$/);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('八个写入路径都必须接入写锁与跳过文案', () => {
  const writers = [
    'src/collect.mjs',
    'scripts/update-kline-minute.mjs',
    'scripts/update-kline-full.mjs',
    'scripts/update-kline-last.mjs',
    'scripts/backfill-cgb1y.mjs',
    'scripts/backfill-macro.mjs',
    'src/portfolio-collect.mjs',
    'scripts/repair-sge-volume.mjs',
  ];
  for (const f of writers) {
    const src = read(f);
    assert.match(src, /kline-lock\.mjs/, `${f} 未 import 写锁`);
    assert.match(src, /(acquireKlineLock|withKlineLock)/, `${f} 未获取写锁`);
    assert.match(src, /lockSkipText/, `${f} 未记录锁占用原因`);
  }
});

test('锁占用不算失败：不把锁跳过写进 failures / 不改退出码', () => {
  const minute = read('scripts/update-kline-minute.mjs');
  assert.doesNotMatch(minute, /failures\.push\(`\$\{key\}.*锁/, '锁占用不能当失败');
  assert.match(minute, /锁占用 \$\{locked\} 个/);
  const full = read('scripts/update-kline-full.mjs');
  assert.match(full, /if \(\(failed \|\| rejected\) && !changed\) process\.exitCode = 1;/);
  assert.match(full, /锁占用 \$\{locked\} 个/);
  const last = read('scripts/update-kline-last.mjs');
  assert.match(last, /锁占用 \$\{locked\} 个/);
});
