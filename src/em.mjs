// src/em.mjs
// 东方财富取数基础设施：主机镜像 + 限速 + 退避重试 + 磁盘缓存 + 熔断
//
// ── 为什么需要这一层（2026-10-29 实测教训）──
//   第一版快照脚本一轮就打 105~147 个请求（行情 49 + 日K 50 + 5分钟K 42），
//   连打几轮之后，**整个东财 push2 主机族对本机变成 socket 级拒绝**：
//     fetch failed (UND_ERR_SOCKET)，push2his / 1.push2his / push2 三个主机全挂，
//     但同一时刻其它域名正常 —— 所以不是断网，是被东财按 IP 做了反爬限流。
//   触发的直接后果：
//     · 上一轮 54/54 全成功、下一轮 47/54 随机失败（同一天数据忽好忽坏）
//     · 当天 pm 快照被误判成「非交易日」而拒写
//     · 失败时仍然继续打满 147 次请求，把封禁越撑越长（单轮白等 23 秒）
//
// ── 这一层的四件事 ──
//   1. 主机镜像：东财每类接口都有多个等价主机，逐个降级尝试
//   2. 限速：全局最小间隔 + 低并发，避免瞬时打满
//   3. 退避重试：失败按 1s/3s/6s 退避，而不是立刻重试
//   4. 熔断：连续 5 次 socket 级失败即判定「被封」，后续请求直接失败退出，
//      避免在一个已经被拒的 IP 上继续加压（并给出可读的失败原因）
//   5. 磁盘缓存：K 线类数据按 TTL 缓存到 .cache/（不进 git），
//      让「同一天跑多轮」不会重复打同一批接口
//
// 注意：缓存目录 .cache/ 必须在 .gitignore 里。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0 Safari/537.36';

export const QUOTE_HOSTS = [
  'https://push2.eastmoney.com',
  'https://1.push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
];
export const KLINE_HOSTS = [
  'https://push2his.eastmoney.com',
  'https://1.push2his.eastmoney.com',
];

// ---- 全局限速 ----
// 实测：连打 100+ 请求会被 IP 级反爬。这里把最小间隔设成 90ms、并发压到 3。
const MIN_GAP_MS = Number(process.env.EM_MIN_GAP_MS || 90);
let chain = Promise.resolve();
let lastAt = 0;

/** 把所有请求串到同一条时间线上，保证全局最小间隔 */
function pace() {
  const run = chain.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  });
  chain = run.catch(() => {});
  return run;
}

// ---- 熔断 ----
// ⚠ 熔断必须**按主机组隔离**：第一版是全局计数，结果东财 K 线端点被限流后
//   连续 5 次失败把全局熔断打开，连**腾讯备用源**也被一起熔断，
//   结果整轮快照只剩 15/54 —— 一个源挂掉反而把冗余源也干掉了。
//   现在按 hosts 集合分组，各组独立计数、独立熔断。
const BREAK_THRESHOLD = Number(process.env.EM_BREAK_THRESHOLD || 5);
const breakers = new Map(); // group → { fails, blocked }

function breakerOf(hosts) {
  const key = (hosts || []).join('|');
  if (!breakers.has(key)) breakers.set(key, { fails: 0, blocked: false });
  return breakers.get(key);
}

export function emStatus() {
  return {
    groups: [...breakers.entries()].map(([k, v]) => ({ hosts: k.split('|')[0], fails: v.fails, blocked: v.blocked })),
    minGapMs: MIN_GAP_MS,
  };
}

/** 手动复位（长间隔任务开始前调用，避免上一轮的熔断状态影响这一轮） */
export function emReset() {
  breakers.clear();
}

// ---- 磁盘缓存 ----
async function cacheRead(key, ttlMs) {
  if (!ttlMs) return null;
  const file = path.join(CACHE_DIR, `${createHash('sha1').update(key).digest('hex')}.json`);
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(await readFile(file, 'utf8'));
    if (Date.now() - (doc.fetchedAt || 0) > ttlMs) return null;
    return doc.data;
  } catch {
    return null;
  }
}

async function cacheWrite(key, data) {
  if (!key) return;
  const file = path.join(CACHE_DIR, `${createHash('sha1').update(key).digest('hex')}.json`);
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf8');
  } catch { /* 缓存失败不影响主流程 */ }
}

const isSocketErr = (err) => {
  const msg = String(err?.message || err);
  const code = String(err?.cause?.code || '');
  return /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|UND_ERR/i.test(msg + ' ' + code);
};

/**
 * 取一个东财 JSON 接口，自动降级主机、限速、退避重试、命中缓存。
 *
 * @param {string} pathnameWithQuery 形如 '/api/qt/stock/get?secid=...'
 * @param {object} opts
 * @param {string[]} opts.hosts      候选主机（按顺序降级）
 * @param {number} [opts.timeout]    单次超时 ms
 * @param {number} [opts.retries]    重试次数（每次都会换下一个主机）
 * @param {number} [opts.cacheTtlMs] 缓存有效期；0 = 不缓存
 * @param {string} [opts.cacheTag]   缓存键前缀（区分不同 TTL 语义）
 * @returns {Promise<object>} 解析后的 JSON
 */
export async function emGetJSON(pathnameWithQuery, opts = {}) {
  const {
    hosts = QUOTE_HOSTS,
    timeout = 15000,
    retries = 3,
    cacheTtlMs = 0,
    cacheTag = '',
    referer = 'https://quote.eastmoney.com/',
  } = opts;

  const cacheKey = cacheTag ? `${cacheTag}|${pathnameWithQuery}` : pathnameWithQuery;
  const cached = await cacheRead(cacheKey, cacheTtlMs);
  if (cached) return cached;

  const breaker = breakerOf(hosts);
  if (breaker.blocked) {
    throw new Error('东财主机处于熔断状态（本组已连续失败过多），本轮不再请求');
  }

  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const host = hosts[attempt % hosts.length];
    await pace();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(host + pathnameWithQuery, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json', Referer: referer },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      breaker.fails = 0;
      await cacheWrite(cacheKey, data);
      return data;
    } catch (err) {
      lastErr = err;
      if (isSocketErr(err)) {
        breaker.fails++;
        if (breaker.fails >= BREAK_THRESHOLD) {
          breaker.blocked = true;
          throw new Error(
            `东财主机连续 ${breaker.fails} 次连接失败（${String(err.message)}），判定被限流，本组中止`
          );
        }
      } else {
        breaker.fails = 0;
      }
      if (attempt < retries - 1) {
        // 退避 ~1.3s / ~2.3s（retries=3 时共两次等待）
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt) + 300));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('东财请求失败');
}

/** 并发跑一批任务（限流 + 低并发 + 失败不抛，返回逐项结果） */
export async function emPool(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = { ok: true, value: await worker(items[i], i) };
      } catch (err) {
        out[i] = { ok: false, error: String(err?.message || err).slice(0, 160) };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

/**
 * 取纯文本（腾讯行情是 GBK，且不是 JSON）。
 * 与 emGetJSON 同样带主机镜像、限速、退避、熔断。
 */
export async function emGetText(pathnameWithQuery, opts = {}) {
  const { hosts, timeout = 12000, retries = 2, gbk = false, referer = 'https://gu.qq.com/' } = opts;
  const breaker = breakerOf(hosts);
  if (breaker.blocked) {
    throw new Error(`主机组处于熔断状态（${hosts?.[0]}），本轮不再请求`);
  }
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const host = hosts[attempt % hosts.length];
    await pace();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(host + pathnameWithQuery, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Referer: referer },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      breaker.fails = 0;
      if (gbk) {
        try { return new TextDecoder('gbk').decode(buf); }
        catch { return buf.toString('utf8'); }
      }
      return buf.toString('utf8');
    } catch (err) {
      lastErr = err;
      if (isSocketErr(err)) {
        breaker.fails++;
        if (breaker.fails >= BREAK_THRESHOLD) {
          breaker.blocked = true;
          throw new Error(`主机连续 ${breaker.fails} 次连接失败（${String(err.message)}），判定被限流，本组中止`);
        }
      } else {
        breaker.fails = 0;
      }
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt) + 300));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('文本请求失败');
}
