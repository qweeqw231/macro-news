// scripts/briefing/core.mjs
// 早报容错链路的纯逻辑 + 文件助手：判据、补跑计划、原子写、锁、状态、组装。
//
// 设计文档：docs/superpowers/specs/2026-11-02-briefing-resilience-design.md
//
// 这里刻意不碰网络、也不直接开数据库：generate / ensure 负责取数，core 只做确定性的判断与落盘，
// 方便离线测试（tests/briefing-core.test.mjs 只用临时目录）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { newsDay, newsDayWindow } from '../../src/news-day.mjs';

export const STATUS_VERSION = 1;
export const DEADLINE_HM = '09:00';     // 预期完成时刻
export const GRACE_MIN = 30;            // 宽限到 09:30
export const HARD_TIMEOUT_MS = 15 * 60 * 1000;
export const LOCK_STALE_MS = 20 * 60 * 1000;   // > 硬超时 + 余量
export const STATUS_KEEP_DAYS = 14;

const BJ_MS = 8 * 3600 * 1000;
const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

/** 北京时间的日期 / 时刻 / ISO（日期走统一新闻日；时刻仍是北京墙钟） */
export function beijingNow(now = Date.now()) {
  const t = new Date(now + BJ_MS);
  return {
    date: newsDay(now),
    hm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`,
    iso: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T` +
      `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}+08:00`,
  };
}

/** 'YYYY-MM-DD' 加减天数 */
export function addDays(day, n) {
  const t = Date.parse(`${day}T00:00:00Z`) + n * DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * 2.13.0：早报候选窗口 = 新闻日口径。
 * - 起点：新闻日 D-1 的起点（北京 D-1 08:00）
 * - 终点：新闻日 D 的 09:00（出报时刻），与 now 取小
 * 旧实现用北京自然日 T00:00:00+08:00 / T23:59:59+08:00 取「两天」，
 * 会把新闻日 D-2 的 08:00–24:00 也算进 D 日早报，与归档卡片的日期语义错位。
 */
export function briefWindow(date, now = Date.now()) {
  const from = addDays(date, -1);
  const { fromTs, toTs } = newsDayWindow(from, date, now);
  return { from, to: date, fromAt: isoFromTs(fromTs), toAt: isoFromTs(toTs), fromTs, toTs };
}

const hmToMin = (hm) => {
  const [h, m] = String(hm || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN;
};

/** 是否已过「预期时刻 + 宽限」 */
export function deadlinePassed(nowHm, deadline = DEADLINE_HM, graceMin = GRACE_MIN) {
  const now = hmToMin(nowHm);
  const due = hmToMin(deadline) + Number(graceMin || 0);
  if (!Number.isFinite(now) || !Number.isFinite(due)) return false;
  return now >= due;
}

/**
 * 完成判据。只看产物本身：
 *   缺失 / 半成品（JSON 截断）/ 不完整（items=0、overview 空、没有任何时间标记）/ 完整。
 * ⚠ 不能用 generatedAt 判断「是否按时」——11-02 事故里它写着 09:02，实际 12:15 才写盘。
 */
export function checkBriefing(file) {
  if (!file || !fs.existsSync(file)) return { complete: false, state: 'missing', items: 0, reason: '文件不存在' };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { complete: false, state: 'invalid', items: 0, reason: 'JSON 解析失败（可能是半成品）' };
  }
  const items = Array.isArray(doc && doc.items) ? doc.items.length : 0;
  if (!items) return { complete: false, state: 'incomplete', items: 0, reason: 'items 为空' };
  if (!String(doc.overview || '').trim()) {
    return { complete: false, state: 'incomplete', items, reason: 'overview 为空' };
  }
  if (!doc.endedAt && !doc.generatedAt) {
    return { complete: false, state: 'incomplete', items, reason: '缺 endedAt / generatedAt' };
  }
  return { complete: true, state: 'complete', items, legacy: !doc.endedAt };
}

/**
 * 最近 N 天的补跑计划（按日期升序，今天最后）。
 * 2.3.0 起缺失当天只做 `prepare`（固化输入快照，交给 LLM 写作），不再自动生成规则版。
 * @param {object} o
 * @param {string} o.today 北京今天
 * @param {string} o.nowHm 北京当前时刻
 * @param {(day:string)=>{complete:boolean, localComplete:boolean}} o.check
 * @returns {Array<{date:string, action:'publish'|'prepare'}>}
 */
export function planCatchup({
  today,
  nowHm,
  days = 1,
  deadline = DEADLINE_HM,
  graceMin = GRACE_MIN,
  check,
}) {
  const out = [];
  for (let i = Math.max(1, days) - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const r = check(date) || {};
    if (r.complete) continue;
    // 今天要到宽限之后才补；历史日**不再自动生成**（2.2.2 起只扫今天）
    if (date === today && !deadlinePassed(nowHm, deadline, graceMin)) continue;
    if (date !== today) continue;
    out.push({ date, action: r.localComplete ? 'publish' : 'prepare' });
  }
  return out;
}

/**
 * 历史缺口（不含今天）：只用于在状态文件里标 `missed`，**不生成任何产物**。
 * 「早报是 AI 写的判断性内容，用规则版补历史等于造假资产」——宁缺不假。
 */
export function scanMissed({ today, days = 7, check }) {
  const out = [];
  for (let i = 1; i < Math.max(1, days); i++) {
    const date = addDays(today, -i);
    const r = check(date) || {};
    if (!r.complete) out.push(date);
  }
  return out.sort();
}

/**
 * 2.14.0：早报制度起点 = 目录里最早一份**完整**早报的日子。
 *
 * 为什么需要它：判断「某天该不该有早报」不能凭感觉。制度起点之前没有这个约定，
 * 把那些日子标成「缺失」等于凭空立规（本仓库 10-28…10-31 有新闻、无早报，
 * 一次就会冒出几十条红字）。起点从产物推导，不硬编码，换目录也自洽。
 * @param {string} siteOut data/briefings 目录
 * @returns {string} 'YYYY-MM-DD'；没有任何完整早报时返回 ''
 */
export function briefEraStart(siteOut) {
  let names = [];
  try { names = fs.readdirSync(siteOut); } catch { return ''; }
  const days = names
    .map((n) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((d) => {
      const file = path.join(siteOut, `${d}.json`);
      if (!checkBriefing(file).complete) return false;
      // 2.20.0：补写产物不能把制度起点往前推。补写是「事后追认某天本该有」，
      //   不是「制度从那天开始」。10-30 补写后起点从 11-01 落到 10-30，
      //   11-01 之前那些日子（如 10-31）就会被误判成「制度后缺失」，页脚冒出假告警。
      try { return !JSON.parse(fs.readFileSync(file, 'utf8')).backfill; } catch { return true; }
    })
    .sort();
  return days[0] || '';
}

/**
 * 2.14.0：归档跨度与逐日条数（判「这天有没有新闻可写」的唯一依据）。
 * 只认 count > 0 的日子：无新闻的日子写不出早报，那是合理空缺，不是缺失。
 *
 * 2.23.0：把近一年历史切片（data/history/index.json）也算进来，取两者较大值。
 * 只看 archive 会把「归档只有 0~4 条、切片有 90~300 条」的日子（08-17~09-18 等）
 * 判成 no-news 而跳过；页面上这些日子本来就是按切片显示的，口径要一致。
 * @param {object} indexDoc data/index.json 的文档
 * @param {object} [historyDoc] data/history/index.json 的文档（可选）
 */
export function archiveSpan(indexDoc, historyDoc) {
  const counts = new Map();
  const put = (day, n) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(n) || n <= 0) return;
    if (n > (counts.get(day) || 0)) counts.set(day, n);
  };
  const list = Array.isArray(indexDoc && indexDoc.days) ? indexDoc.days : [];
  for (const d of list) put(String((d && d.day) || ''), Number(d && d.count));
  const hlist = Array.isArray(historyDoc && historyDoc.days) ? historyDoc.days : [];
  for (const d of hlist) {
    const n = d && (d.n != null ? d.n : d.count);
    put(String((d && (d.d || d.day)) || ''), Number(n));
  }
  const keys = [...counts.keys()].sort();
  return { first: keys[0] || '', last: keys[keys.length - 1] || '', counts };
}

/**
 * 2.14.0：预期内缺口 = 制度起点之后、今天之前、**有新闻**、却没有完整早报的日子。
 *
 * 三条同时成立才算缺口（缺一不可）：
 *   ① D < 今天（今天走页脚既有的时间分层，不并入缺口）；
 *   ② D >= 制度起点（之前的年代不立规，但可以显式补写）；
 *   ③ D 有新闻（count > 0，否则写不出早报，属合理空缺）。
 * 「有新闻但没写」才是真缺口；这类才该在站点上显形、才可补写。
 *
 * @returns {Array<{day:string, news:number}>} 按日倒序（最近的缺口在前）
 */
export function scanGaps({ today, eraStart, counts, check, days = STATUS_KEEP_DAYS }) {
  const out = [];
  const map = counts instanceof Map ? counts : new Map(Object.entries(counts || {}));
  if (!eraStart) return out;
  for (let i = 1; i < Math.max(2, days + 1); i++) {
    const date = addDays(today, -i);
    if (date < eraStart) break;
    const news = Number(map.get(date)) || 0;
    if (!news) continue;                       // ③ 无新闻：不立缺口
    const r = check(date) || {};
    if (r.complete) continue;
    out.push({ day: date, news });
  }
  return out;
}

/**
 * 2.14.0：补写窗口守卫。补写是「按历史日的新闻切片重跑」，不是「随便填一天」。
 *
 * 拒绝的两类（都不估算、不生成）：
 *   · 窗口沾到今天或未来 —— 今天由 09:00 那条链路负责，混进来会让「今日早报」有两份来源；
 *   · 早于归档起点 —— 那天一条新闻都没有，切片为空，写出来只能是编造。
 *
 * @returns {{ok:boolean, code:string, reason:string}}
 */
export function guardBackfill({ from, to, today, archiveFirst }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) || !/^\d{4}-\d{2}-\d{2}$/.test(String(to || ''))) {
    return { ok: false, code: 'bad-date', reason: `补写窗口日期格式不对：${from}..${to}` };
  }
  if (from > to) return { ok: false, code: 'bad-range', reason: `补写窗口非法：${from} 晚于 ${to}` };
  if (to >= today) {
    return {
      ok: false,
      code: 'includes-today',
      reason: `补写只处理已过去的日子：${to} 不早于今天 ${today}（今天由 09:00 链路负责）`,
    };
  }
  if (archiveFirst && from < archiveFirst) {
    return {
      ok: false,
      code: 'before-archive',
      reason: `${from} 早于归档起点 ${archiveFirst}：那天没有任何新闻可切片，不能补写`,
    };
  }
  return { ok: true, code: 'ok', reason: '' };
}

/** 旧产物没有 source 字段 → 按 AI 处理（不回写历史文件）；2.3.0 起保留 draft */
export function normalizeBriefingSource(doc) {
  if (doc && (doc.source === 'rule' || doc.source === 'draft')) return doc.source;
  return 'ai';
}

/** 已存在完整 AI 早报时拒绝覆盖；规则版可以被重新生成 */
export function shouldSkipExisting({ complete, source, force = false }) {
  return !!complete && normalizeBriefingSource({ source }) === 'ai' && !force;
}

/**
 * 手动补齐窗口：必须同时给 from / to，默认关闭（不参与自动调度）。
 * @returns {{from:string,to:string,days:number}|null}
 */
export function parseBackfillRange(from, to) {
  if (!from && !to) return null;
  if (!from || !to) throw new Error('手动补齐必须同时指定 --backfill-from 与 --backfill-to');
  for (const d of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) {
      throw new Error(`日期格式不对：${d}`);
    }
  }
  if (from > to) throw new Error(`补齐窗口非法：${from} 晚于 ${to}`);
  const days = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS) + 1;
  return { from, to, days };
}

/**
 * 状态不变式：done ⇔ 存在对应产物；missed ⇔ 不存在产物；done 的 source 必须与文件一致。
 * @param {object} records  status.days
 * @param {Map<string,{source:string}>} files  已存在且完整的早报（day → {source}）
 * @returns {Array<{day,kind}>} 违规项
 */
export function checkStatusInvariants(records, files) {
  const bad = [];
  const map = files instanceof Map ? files : new Map();
  for (const [day, rec] of Object.entries(records || {})) {
    if (!rec) continue;
    const f = map.get(day);
    if (rec.status === 'done' && !f) bad.push({ day, kind: 'done_without_file' });
    if (rec.status === 'missed' && f) bad.push({ day, kind: 'missed_with_file' });
    if (rec.status === 'done' && f && rec.source && rec.source !== f.source) {
      bad.push({ day, kind: 'source_mismatch', want: f.source, got: rec.source });
    }
  }
  return bad;
}

/** 原子写：先 `.tmp` 再 rename；Windows 下目标被占用时退化为「删目标再改名」 */
export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EEXIST' || e.code === 'EACCES') {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      fs.renameSync(tmp, file);
    } else {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
  }
}

export function atomicWriteJSON(file, obj) {
  atomicWriteText(file, JSON.stringify(obj, null, 2));
}

/** 读取状态文件；不存在/损坏 → 空结构 */
export function readStatus(file) {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc && typeof doc.days === 'object' && doc.days) return doc;
  } catch { /* ignore */ }
  return { v: STATUS_VERSION, days: {} };
}

/**
 * 更新某一天的状态并落盘（保留最近 14 天）。
 *
 * 2.14.0 → 2.19.0 修正：**刚写入的那一天永远保留**。
 * 历史补写会写一个 30 天前的日子，旧实现按日期排序直接 `shift()` 掉最老的键，
 * 等于「写进去就被自己删掉」——补写状态永远读不到。现在只淘汰「不是本次写入日」
 * 的最老键，总量仍是 keepDays（写入日占一个名额）。
 * @param {string} file
 * @param {string} date
 * @param {object} patch
 */
export function updateStatus(file, date, patch, { now = Date.now(), keepDays = STATUS_KEEP_DAYS } = {}) {
  // 状态文件是多进程共享的读改写目标（每条补写线都会写自己的那天），
  // 读取要在锁内做，否则「读-改-写」交错会把对方刚写的日期挤掉。
  return withSharedLock(sharedLockPath(file), () => {
    const doc = readStatus(file);
    const prev = doc.days[date] || {};
    const rec = { ...prev, date, ...patch };
    doc.days[date] = rec;
    const keys = Object.keys(doc.days).sort();
    let left = keys.length;
    for (const k of keys) {
      if (left <= keepDays) break;
      if (k === date) continue;
      delete doc.days[k];
      left--;
    }
    const ordered = {};
    Object.keys(doc.days).sort().forEach((k) => { ordered[k] = doc.days[k]; });
    const out = { v: STATUS_VERSION, updatedAt: beijingNow(now).iso, days: ordered };
    atomicWriteJSON(file, out);
    return rec;
  });
}

/**
 * 获取防重入锁。返回 {ok, holder?, release}。
 * 锁内容 {pid, startedAt, host}；年龄 ≥ staleMs 视为失效（上一个进程被杀）。
 */
export function acquireLock(
  file,
  { now = Date.now(), pid = process.pid, staleMs = LOCK_STALE_MS, host = os.hostname() } = {}
) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let holder = null;
  if (fs.existsSync(file)) {
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { holder = null; }
    const age = holder && holder.startedAt ? now - Date.parse(holder.startedAt) : Infinity;
    const stale = !Number.isFinite(age) || age < 0 || age >= staleMs;
    if (!stale) return { ok: false, holder };
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
  }
  atomicWriteText(file, JSON.stringify({ pid, startedAt: new Date(now).toISOString(), host }));
  return {
    ok: true,
    holder: { pid, startedAt: new Date(now).toISOString(), host },
    release() {
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cur && Number(cur.pid) === Number(pid)) fs.rmSync(file, { force: true });
      } catch { /* ignore */ }
    },
  };
}

/**
 * 共享写盘锁的锁文件：按目标文件绝对路径散列后放进系统临时目录。
 * 为什么不放仓库：`data/index.json`、`data/_briefing-status.json` 是站点产物，
 * 旁边多出 `.lock` 会污染 git 状态。
 */
export function sharedLockPath(file) {
  const h = crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `macro-news-briefing-${h}.lock`);
}

/**
 * 共享锁的原语必须是原子建文件（O_EXCL），不能用「先判存在再写」：
 * 临界区只有几毫秒，两条进程同时判空再同时落锁的窗口很大，实测会双双拿到锁。
 */
function acquireSharedLock(lockFile, { staleMs = 60000 } = {}) {
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() });
  for (;;) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
      return {
        ok: true,
        release() {
          try {
            const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
            if (cur && Number(cur.pid) === Number(process.pid)) fs.rmSync(lockFile, { force: true });
          } catch { /* ignore */ }
        },
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { holder = null; }
      const age = holder && holder.startedAt ? Date.now() - Date.parse(holder.startedAt) : Infinity;
      const stale = !Number.isFinite(age) || age < 0 || age >= staleMs;
      if (stale) {
        try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
        continue;
      }
      return { ok: false, holder };
    }
  }
}

/**
 * 在共享锁内执行一次读改写。
 *
 * 按日 `run.lock` 只锁各自的 run 目录，挡不住两条补写线在不同日期上并发、
 * 却同时改写同一份 `data/index.json` / `data/_briefing-status.json` 的丢更新。
 * 临界区只有一次 JSON 读写，锁龄毫秒级；拿不到锁说明持锁进程异常，
 * 超时后抛错让调用方失败，而不是无锁裸写。
 */
export function withSharedLock(lockFile, fn, { timeoutMs = 15000, staleMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = acquireSharedLock(lockFile, { staleMs });
    if (lock.ok) {
      try { return fn(); } finally { lock.release(); }
    }
    if (Date.now() >= deadline) {
      throw new Error(`共享写盘锁占用超时（pid ${lock.holder && lock.holder.pid}，${lockFile}）`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

/** 从候选条目里挑 2~3 个关键词，给规则版 why 用（完整打分在 brief-candidates） */
const WHY_KW = [
  '央行', '降息', '加息', '降准', '利率', '美联储', 'cpi', 'pmi', '非农', '社融',
  '财政', '关税', '原油', '黄金', '人民币', '国债', 'a股', '港股', '美股',
];

function whyOf(r) {
  const text = `${r.title || ''} ${r.summary || ''}`.toLowerCase();
  const hits = WHY_KW.filter((k) => text.includes(k)).slice(0, 3);
  if (hits.length) return `命中宏观关键词：${hits.join(' / ')}`;
  if (r.content_status === 'full') return '当日全文条目，信息完整度较高';
  return '来源权重较高';
}

const isoFromTs = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date((n + 8 * 3600) * 1000).toISOString().slice(0, 19) + '+08:00';
};

/**
 * 规则版早报（结构不变）。只用于「缺了自动补」的兜底；AI 版仍可覆盖。
 * @param {object} o
 * @param {string} o.date
 * @param {Array} o.candidates  brief-candidates 的 items
 * @param {number} o.now
 * @param {number} o.limit
 */
export function buildBriefing({ date, candidates, now = Date.now(), limit = 10 }) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, Math.max(1, limit));
  const items = list.map((r, i) => ({
    rank: i + 1,
    title: String(r.title || '').replace(/\s+/g, ' ').trim(),
    summary: String(r.summary || '').replace(/\s+/g, ' ').trim(),
    why: whyOf(r),
    source: r.source || '',
    publishedAt: isoFromTs(r.published_ts) || (r.date ? `${r.date}:00+08:00` : ''),
    url: r.url || '',
  }));
  // 概览优先用「事件型」标题，跳过早餐/盘前/提醒这类汇总稿（汇总稿仍保留在 items 里）
  const DIGEST = /早报|晚报|早餐|盘前|盘后|提醒|日内请重点|要闻盘点|每日要闻/;
  const picks = items.filter((x) => x.title && !DIGEST.test(x.title)).slice(0, 3);
  const top = (picks.length ? picks : items).slice(0, 3).map((x) => x.title).filter(Boolean);
  const overview = top.length
    ? `今日主线：${top.join('；')}。`.slice(0, 240)
    : '今日暂无足够的宏观候选条目。';
  const { iso } = beijingNow(now);
  return {
    date,
    generatedAt: iso,
    endedAt: iso,
    source: 'rule',
    generator: 'rule-v1',
    window: briefWindow(date, now),
    overview,
    items,
    watch: [],
  };
}

/** 人读版 Markdown（与 JSON 同源，结构简单） */
export function briefingMarkdown(b) {
  const lines = [`# ${b.date} 宏观早报`, '', `> ${b.overview}`, '', '## 今日要闻', ''];
  b.items.forEach((it, i) => {
    lines.push(`${i + 1}. **${it.title}**`);
    if (it.summary) lines.push(`   ${it.summary}`);
    lines.push(`   — ${it.source}${it.publishedAt ? ' · ' + it.publishedAt : ''}${it.url ? ' · ' + it.url : ''}`);
    lines.push('');
  });
  lines.push('## 观察项', '');
  if (b.watch && b.watch.length) b.watch.forEach((w) => lines.push(`- ${w}`));
  else lines.push(b.source === 'draft' ? '- （事实清单暂无观察项）' : '- （规则版暂无观察项，等待 AI 版补充）');
  lines.push('');
  return lines.join('\n');
}