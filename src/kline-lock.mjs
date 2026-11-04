// src/kline-lock.mjs
// 2.4.15：data/kline 的按标的写锁（仅同一文件系统内有效）。
//
// 只包「读旧文件 → 合并 → 写盘」这一小段，不包 fetchKline；
// 持锁时间通常 <1 秒，拿不到锁就跳过本轮，不等待、不强写。
//
// ⚠ 边界：GitHub Actions 的不同 runner 文件系统隔离，本锁无法跨 runner 互斥；
//   跨 runner 仍靠触发错峰 + push-data.sh 的 rebase 重试。

import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_LOCK_DIR = path.join(ROOT, '.cache', 'locks');

const envStale = Number(process.env.KLINE_LOCK_STALE_MS);
export const DEFAULT_STALE_MS = Number.isFinite(envStale) && envStale > 0
  ? envStale
  : 5 * 60 * 1000;

const safeKey = (key) => String(key || 'unknown').replace(/[^\w.-]+/g, '_');

export function klineLockPath(key, dir = DEFAULT_LOCK_DIR) {
  return path.join(dir, `kline-${safeKey(key)}.lock`);
}

async function readHolder(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 获取按标的写锁。
 * @returns {Promise<{ok:true,file,token}|{ok:false,file,ageMs,holder}>}
 */
export async function acquireKlineLock(key, opts = {}) {
  const dir = opts.dir || DEFAULT_LOCK_DIR;
  const staleMs = Number.isFinite(opts.staleMs) ? opts.staleMs : DEFAULT_STALE_MS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const file = klineLockPath(key, dir);
  const token = randomUUID();
  const payload = JSON.stringify({
    key: String(key),
    pid: process.pid,
    host: os.hostname(),
    at: new Date(now).toISOString(),
    token,
  });

  await mkdir(dir, { recursive: true });

  let last = { file, ageMs: 0, holder: null };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fh = await open(file, 'wx');
      try {
        await fh.writeFile(payload);
      } finally {
        await fh.close();
      }
      return { ok: true, file, token };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      let st = null;
      try { st = await stat(file); } catch { /* 刚刚被释放 */ }
      if (!st) continue;   // 锁已消失，重试创建

      const ageMs = Math.max(0, now - st.mtimeMs);
      last = { file, ageMs, holder: await readHolder(file) };

      if (ageMs > staleMs) {
        // 原子接管：rename 只有一个进程能成功；失败者会重新尝试 wx，
        // 最终仍只有一个进程能拿到新锁。
        const staleName = `${file}.stale.${process.pid}.${now}`;
        try {
          await rename(file, staleName);
          await unlink(staleName).catch(() => {});
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
        continue;
      }
      return { ok: false, ...last };
    }
  }
  return { ok: false, ...last };
}

/** 只删除自己持有的锁；被接管后不会误删新锁 */
export async function releaseKlineLock(lock) {
  if (!lock || !lock.ok || !lock.file || !lock.token) return false;
  const holder = await readHolder(lock.file);
  if (!holder || holder.token !== lock.token) return false;
  try {
    await unlink(lock.file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 拿锁执行 fn；拿不到锁返回 {ok:false, skipped:true, lock}，不执行 fn。
 */
export async function withKlineLock(key, fn, opts = {}) {
  const lock = await acquireKlineLock(key, opts);
  if (!lock.ok) return { ok: false, skipped: true, lock };
  try {
    return { ok: true, value: await fn() };
  } finally {
    await releaseKlineLock(lock);
  }
}

/** 统一的跳过日志文案（锁定占用不算失败） */
export function lockSkipText(key, res) {
  const lock = res && res.lock ? res.lock : res;
  const h = lock && lock.holder;
  const who = h && h.pid
    ? `pid ${h.pid}${h.host ? '@' + h.host : ''}`
    : '未知进程';
  const age = lock && Number.isFinite(lock.ageMs)
    ? `${Math.round(lock.ageMs / 1000)}s`
    : '?';
  return `⏭ ${key} 跳过：写锁被占用（${who}，已持有 ${age}）`;
}
