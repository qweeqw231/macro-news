// scripts/briefing/pipeline.mjs
// 2.3.0 三段式早报的确定性部分：输入快照、检查点、校验、原子发布、索引。
//
// 设计文档：docs/superpowers/specs/2026-11-02-briefing-llm-pipeline-design.md
//
// 边界：这里**不生成任何摘要正文**。prepare 只固化候选；publish 只校验 LLM 产物并落盘。
// 测试只允许写 os.tmpdir() 下的临时目录；所有路径都由调用方显式传入。

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  acquireLock,
  addDays,
  atomicWriteJSON,
  atomicWriteText,
  beijingNow,
  briefingMarkdown,
  checkBriefing,
  normalizeBriefingSource,
  updateStatus,
} from './core.mjs';
import { buildCandidates } from '../news-db/brief-candidates.mjs';
import { importArchive } from '../news-db/import-archive.mjs';
import { briefLineOf } from '../../src/brief-meta.mjs';

export const RUN_VERSION = 1;
export const CHECKPOINTS = ['outline', 'draft', 'final'];

const sha256 = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/** 快照指纹只覆盖可复现内容，不含 preparedAt */
export function snapshotSha(date, window, items) {
  return sha256(JSON.stringify({ date, window, items })).slice(0, 16);
}

export function runDirOf(runsDir, date) {
  return path.join(runsDir, date);
}

export function readJson(file) {
  if (!fs.existsSync(file)) return { ok: false, exists: false, error: '文件不存在' };
  try {
    return { ok: true, exists: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ok: false, exists: true, error: `JSON 解析失败：${e.message}` };
  }
}

function readCheckpoint(file, stage, date, inputSha) {
  const r = readJson(file);
  if (!r.exists) return { exists: false, valid: false, stale: false };
  if (!r.ok) return { exists: true, valid: false, stale: false, error: r.error };
  const v = r.value || {};
  const stale = v.date !== date || v.inputSha !== inputSha || v.stage !== stage;
  return {
    exists: true,
    valid: !stale,
    stale,
    stage: v.stage || '',
    at: v.createdAt || v.generatedAt || '',
  };
}

/**
 * 检查点报告：给 LLM / 调度看的“从哪继续”。
 * @returns {{input:object, checkpoints:object, latest:string|null, next:string}}
 */
export function checkpointReport({ date, runsDir }) {
  const dir = runDirOf(runsDir, date);
  const inputR = readJson(path.join(dir, 'input.json'));
  if (!inputR.ok) {
    return {
      input: { exists: inputR.exists, valid: false, error: inputR.error },
      checkpoints: {},
      latest: null,
      next: 'prepare',
    };
  }
  const input = inputR.value;
  const inputSha = input.inputSha || snapshotSha(input.date, input.window, input.items);
  const checkpoints = {};
  for (const stage of CHECKPOINTS) {
    checkpoints[stage] = readCheckpoint(path.join(dir, `${stage}.json`), stage, date, inputSha);
  }
  const latest = ['final', 'draft', 'outline'].find((s) => checkpoints[s] && checkpoints[s].valid) || null;
  const next = latest === 'final' ? 'publish'
    : latest === 'draft' ? 'final'
      : latest === 'outline' ? 'draft'
        : 'outline';
  return {
    input: {
      exists: true,
      valid: true,
      path: path.join(dir, 'input.json'),
      sha: inputSha,
      preparedAt: input.preparedAt || '',
      selected: Number(input.selectedCount) || (Array.isArray(input.items) ? input.items.length : 0),
    },
    checkpoints,
    latest,
    next,
  };
}

function emptyInputError(date) {
  return new Error(`${date} 候选为空：新闻库可能没同步（先检查 MacroNews-Pull / import-archive）`);
}

/**
 * 生成/复用输入快照。
 * - input.json 已存在且日期一致 → 直接复用，不读 DB、不读 archive（证明“不重抓”）。
 * - force=true 才重建；旧检查点会因 inputSha 变化自动作废。
 */
export function prepareSnapshot({
  date,
  runsDir,
  dbFile,
  archiveDir,
  limit = 120,
  noImport = false,
  force = false,
  now = Date.now(),
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error(`日期格式不对：${date}`);
  const dir = runDirOf(runsDir, date);
  fs.mkdirSync(dir, { recursive: true });
  const inputFile = path.join(dir, 'input.json');

  const prev = readJson(inputFile);
  if (!force && prev.ok && prev.value && prev.value.date === date) {
    return {
      ok: true,
      reused: true,
      date,
      runDir: dir,
      inputPath: inputFile,
      inputSha: prev.value.inputSha || snapshotSha(prev.value.date, prev.value.window, prev.value.items),
      input: prev.value,
      report: checkpointReport({ date, runsDir }),
    };
  }

  if (!noImport && archiveDir && fs.existsSync(archiveDir)) {
    importArchive({ dbFile, archiveDir, quiet: true });
  }
  const window = { from: addDays(date, -1), to: date };
  const cand = buildCandidates({ dbFile, from: window.from, to: window.to, limit });
  if (!cand.items.length) throw emptyInputError(date);

  const items = cand.items;
  const inputSha = snapshotSha(date, window, items);
  const input = {
    v: RUN_VERSION,
    date,
    preparedAt: beijingNow(now).iso,
    generator: 'prepare-v1',
    window,
    candidateCount: cand.candidates,
    selectedCount: items.length,
    inputSha,
    items,
  };
  atomicWriteJSON(inputFile, input);
  return {
    ok: true,
    reused: false,
    date,
    runDir: dir,
    inputPath: inputFile,
    inputSha,
    input,
    report: checkpointReport({ date, runsDir }),
  };
}

const trim = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const charLen = (s) => Array.from(trim(s)).length;

function candidateMap(input) {
  const map = new Map();
  const items = Array.isArray(input && input.items) ? input.items : [];
  for (const it of items) {
    const url = trim(it && it.url);
    if (url) map.set(url, it);
  }
  return map;
}

/**
 * 校验 LLM 定稿。只做确定性判据，不评价文笔。
 * 候选 Map 在函数内部构建：不放在模块级，避免并发调用串数据。
 * @returns {{ok:boolean, errors:Array<{path:string,msg:string}>}}
 */
export function validateFinal({ doc, input, date }) {
  const inputMap = candidateMap(input);
  const errors = [];
  const add = (p, m) => errors.push({ path: p, msg: m });
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: [{ path: 'final', msg: '不是对象' }] };
  }
  if (doc.date !== date) add('date', `应为 ${date}，实际 ${doc.date || '空'}`);
  if (doc.inputSha !== input.inputSha) add('inputSha', '与输入快照不一致（可能是旧稿）');
  if (doc.stage !== 'final') add('stage', '必须是 final，不能把 draft 当定稿');
  if (doc.source != null && doc.source !== 'ai') add('source', '只能是 ai；rule/draft 不得冒充定稿');
  if (!trim(doc.overview)) add('overview', '为空');
  else if (charLen(doc.overview) > 400) add('overview', '超过 400 字');

  const items = Array.isArray(doc.items) ? doc.items : [];
  if (items.length < 3) add('items', `至少 3 条，实际 ${items.length}`);
  if (items.length > 10) add('items', `最多 10 条，实际 ${items.length}`);

  const words = ['title', 'summary', 'why', 'source', 'url'];
  const seen = new Set();
  items.forEach((it, i) => {
    const p = `items[${i}]`;
    if (!it || typeof it !== 'object') {
      add(p, '不是对象');
      return;
    }
    for (const k of words) {
      if (!trim(it[k])) add(`${p}.${k}`, '为空');
    }
    const url = trim(it.url);
    if (!url) return;
    if (seen.has(url)) add(`${p}.url`, '主链接重复（同一事件应合并）');
    seen.add(url);
    const cand = inputMap.get(url);
    if (!cand) {
      add(`${p}.url`, '不在输入快照里（不可追溯）');
    } else if (trim(it.source) && trim(cand.source) && trim(it.source) !== trim(cand.source)) {
      add(`${p}.source`, `与候选来源不一致（应为 ${cand.source}）`);
    }
    const refs = it.refs;
    if (refs != null) {
      if (!Array.isArray(refs)) add(`${p}.refs`, '必须是数组');
      else {
        refs.forEach((u, j) => {
          const ref = trim(u);
          if (!ref) add(`${p}.refs[${j}]`, '为空');
          else if (!inputMap.has(ref)) add(`${p}.refs[${j}]`, '不在输入快照里（不可追溯）');
        });
      }
    }
  });

  const watch = doc.watch;
  if (watch == null) add('watch', '必须是数组（可为空）');
  else if (!Array.isArray(watch)) add('watch', '必须是数组');
  else if (watch.length > 6) add('watch', `最多 6 条，实际 ${watch.length}`);
  else watch.forEach((w, i) => {
    if (!trim(w)) add(`watch[${i}]`, '为空');
  });

  return { ok: errors.length === 0, errors };
}

/** 定稿 → 站点产物：剥掉 LLM 检查点字段，统一补 source/generator/window/endedAt */
export function normalizeFinalForPublish({ doc, input, date, now = Date.now() }) {
  const t = beijingNow(now);
  const items = doc.items.map((it, i) => {
    const o = {
      rank: i + 1,
      title: trim(it.title),
      summary: trim(it.summary),
      why: trim(it.why),
      source: trim(it.source),
      publishedAt: trim(it.publishedAt),
      url: trim(it.url),
    };
    if (Array.isArray(it.refs) && it.refs.length) {
      o.refs = [...new Set(it.refs.map(trim).filter(Boolean))];
    }
    return o;
  });
  const out = {
    date,
    generatedAt: trim(doc.generatedAt) || t.iso,
    endedAt: t.iso,
    source: 'ai',
    generator: 'llm-v1',
    window: input.window,
    overview: trim(doc.overview),
    items,
    watch: (Array.isArray(doc.watch) ? doc.watch : []).map(trim).filter(Boolean),
  };
  if (trim(doc.model)) out.model = trim(doc.model);
  return out;
}

/**
 * 降级事实清单：只搬运候选标题/来源/时间/链接，不写任何 AI 摘要。
 * 固定模板句 + source:"draft"，避免被误读成 AI 早报。
 */
export function buildDraftFallback({ input, date, now = Date.now(), reason = '' }) {
  const t = beijingNow(now);
  const items = (Array.isArray(input.items) ? input.items : [])
    .filter((x) => x && trim(x.title))
    .slice(0, 10)
    .map((x, i) => ({
      rank: i + 1,
      title: trim(x.title),
      summary: '',
      why: '事实清单条目（按候选得分排序，未做语义判断）',
      source: trim(x.source),
      publishedAt: trim(x.date),
      url: trim(x.url),
    }));
  if (!items.length) throw new Error('输入快照没有可发布的候选');
  const why = trim(reason).slice(0, 120);
  return {
    date,
    generatedAt: t.iso,
    endedAt: t.iso,
    source: 'draft',
    generator: 'draft-v1',
    window: input.window,
    overview: `AI 定稿不可用${why ? `（${why}）` : ''}。以下为按候选得分排序的事实清单，未做语义判断。`.slice(0, 400),
    items,
    watch: [],
  };
}

/** 只改已存在的那一天；不新增日期（避免把没有归档的日子塞进索引） */
export function patchIndexDoc(doc, { date, briefLine, source }) {
  if (!doc || !Array.isArray(doc.days)) return false;
  const entry = doc.days.find((x) => x && (x.day === date || x.d === date));
  if (!entry) return false;
  entry.hasBriefing = true;
  const line = trim(briefLine).slice(0, 80);
  if (line) entry.briefLine = line;
  else delete entry.briefLine;
  entry.source = source;
  return true;
}

export function patchIndexFiles({ dataDir, date, briefLine, source }) {
  if (!dataDir) return 0;
  let patched = 0;
  for (const rel of ['index.json', 'history/index.json']) {
    const file = path.join(dataDir, rel);
    if (!fs.existsSync(file)) continue;
    const r = readJson(file);
    if (!r.ok) continue;
    if (patchIndexDoc(r.value, { date, briefLine, source })) {
      atomicWriteJSON(file, r.value);
      patched++;
    }
  }
  return patched;
}

/**
 * 2.4.19：发布自检 —— 索引里当天那一条必须真的带上早报标记。
 *
 * 为什么需要（2026-11-06 实测事故）：
 *   `patchIndexFiles()` → `patchIndexDoc()` **只改已存在的那天**（不新增日期）。
 *   本地 checkout 落后一天时，索引里根本没有当天的行 ⇒ 补丁**静默 no-op**：
 *   publish 照样报「完成 · published」、退出码 0，但站点索引当天不显示早报
 *   （hasBriefing=false、无 briefLine），只有仓库里的不变式测试能发现。
 *
 * 语义：**索引不存在 → 无从核对，不拦**（测试沙箱/极端场景）；
 *       **索引存在但当天没打上标记 → 判发布失败**，并明确提示先同步本地。
 *
 * @param {{dataDir?:string, date:string, expectLine?:string}} o
 * @returns {{ok:boolean, code:string, reason:string, entry?:object}}
 */
export function verifyIndexBriefing({ dataDir, date, expectLine = '' }) {
  if (!dataDir) return { ok: true, code: 'skipped', reason: '未指定 data 目录，跳过索引自检' };
  const file = path.join(dataDir, 'index.json');
  if (!fs.existsSync(file)) return { ok: true, code: 'no-index', reason: 'data/index.json 不存在，跳过索引自检' };
  const r = readJson(file);
  if (!r.ok) return { ok: false, code: 'bad-index', reason: `data/index.json 无法解析：${r.error}` };
  const entry = (Array.isArray(r.value.days) ? r.value.days : [])
    .find((x) => x && (x.day === date || x.d === date));
  if (!entry) {
    return {
      ok: false,
      code: 'day-missing',
      reason: `data/index.json 里没有 ${date} 这一行 —— 本地 checkout 落后于采集器？`
        + '请先 git fetch origin main && git merge --ff-only origin main 再发布',
    };
  }
  if (!entry.hasBriefing) {
    return {
      ok: false,
      code: 'not-marked',
      reason: `data/index.json 里 ${date} 的 hasBriefing 仍是 false，早报标记没打上`,
    };
  }
  if (!trim(entry.briefLine)) {
    return { ok: false, code: 'no-line', reason: `data/index.json 里 ${date} 缺少 briefLine` };
  }
  if (!trim(entry.source)) {
    return { ok: false, code: 'no-source', reason: `data/index.json 里 ${date} 缺少 source` };
  }
  const want = trim(expectLine);
  if (want && trim(entry.briefLine) !== want) {
    return {
      ok: false,
      code: 'line-mismatch',
      reason: `data/index.json 里 ${date} 的 briefLine 与已发布产物不一致`,
    };
  }
  return { ok: true, code: 'index-ok', reason: '', entry };
}

function readExisting(file) {
  const chk = checkBriefing(file);
  if (!chk.complete) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      file,
      doc,
      source: normalizeBriefingSource(doc),
      items: chk.items,
      raw: fs.readFileSync(file, 'utf8'),
    };
  } catch {
    return null;
  }
}

function writeBriefingFiles({ doc, localOut, siteOut }) {
  const text = JSON.stringify(doc, null, 2);
  const written = new Set();
  if (localOut) {
    const localFile = path.join(localOut, `${doc.date}.json`);
    atomicWriteText(localFile, text);
    atomicWriteText(path.join(localOut, `${doc.date}.md`), briefingMarkdown(doc));
    written.add(path.resolve(localFile));
  }
  if (siteOut) {
    const siteFile = path.join(siteOut, `${doc.date}.json`);
    if (!written.has(path.resolve(siteFile))) atomicWriteText(siteFile, text);
  }
}

/**
 * 发布段：校验 LLM 定稿 → 原子写站点 → 补索引 → 写状态。
 * 任何情况下都不覆盖已有完整 AI 早报；失败绝不写规则版。
 */
export function publishRun({
  date,
  runsDir,
  siteOut,
  localOut = null,
  status = null,
  dataDir = null,
  draftOnFail = false,
  noLock = false,
  now = Date.now(),
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error(`日期格式不对：${date}`);
  const dir = runDirOf(runsDir, date);
  fs.mkdirSync(dir, { recursive: true });
  let lock = null;
  if (!noLock) {
    lock = acquireLock(path.join(dir, 'run.lock'), { now });
    if (!lock.ok) return { ok: false, code: 'locked', holder: lock.holder };
  }

  const started = Date.now();
  const t = beijingNow(now);
  const siteFile = path.join(siteOut, `${date}.json`);
  const localFile = localOut ? path.join(localOut, `${date}.json`) : null;

  const markDone = (o) => {
    if (!status) return;
    updateStatus(status, date, {
      status: 'done',
      stage: 'publish',
      startedAt: t.iso,
      endedAt: t.iso,
      exitCode: o.exitCode == null ? 0 : o.exitCode,
      items: o.items,
      source: o.source,
      reason: o.reason || '',
      durationMs: Date.now() - started,
      generator: o.generator,
      attempt: o.attempt,
    }, { now });
  };
  const markMissed = (reason) => {
    if (!status) return;
    updateStatus(status, date, {
      status: 'missed',
      stage: 'publish',
      startedAt: t.iso,
      endedAt: t.iso,
      exitCode: 1,
      items: 0,
      source: '',
      reason,
      durationMs: Date.now() - started,
      generator: 'publish',
    }, { now });
  };
  // 2.4.19：发布自检失败（索引没打上标记）也算失败 —— 不能「产物写好了就算成功」
  const markFailed = (reason) => {
    if (!status) return;
    updateStatus(status, date, {
      status: 'failed',
      stage: 'publish',
      startedAt: t.iso,
      endedAt: beijingNow().iso,
      exitCode: 1,
      items: 0,
      source: '',
      reason,
      durationMs: Date.now() - started,
      generator: 'publish',
    }, { now });
  };
  /** 补索引 + 立刻核对；核对不过就判失败（不吞掉） */
  const patchAndVerify = (briefLine, source) => {
    patchIndexFiles({ dataDir, date, briefLine, source });
    return verifyIndexBriefing({ dataDir, date, expectLine: briefLine });
  };
  const indexFail = (v) => ({
    ok: false,
    code: 'index-not-patched',
    indexCheck: v.code,
    reason: `索引自检未通过（${v.code}）：${v.reason}`,
  });
  const prev = status ? (fs.existsSync(status) ? readJson(status).value : null) : null;
  const attempt = Number(prev && prev.days && prev.days[date] && prev.days[date].attempt) || 0;

  try {
    const existingSite = readExisting(siteFile);
    if (existingSite && existingSite.source === 'ai') {
      const reason = '已存在 AI 早报，未覆盖';
      // 文件已经在，索引也该立刻反映（不新增日期，只改已存在的那天）
      const v = patchAndVerify(briefLineOf(existingSite.doc), 'ai');
      if (!v.ok) {
        markFailed(indexFail(v).reason);
        return { ...indexFail(v), source: 'ai', items: existingSite.items, preserved: true };
      }
      markDone({ source: 'ai', items: existingSite.items, generator: 'existing', reason, attempt });
      return { ok: true, code: 'existing-ai', skipped: true, source: 'ai', items: existingSite.items, reason };
    }

    // 本地已有完整 AI 产物、站点没有（或只有 rule/draft）：只发布，不生成
    const existingLocal = localFile ? readExisting(localFile) : null;
    if (existingLocal && existingLocal.source === 'ai') {
      atomicWriteText(siteFile, existingLocal.raw);
      const v = patchAndVerify(briefLineOf(existingLocal.doc), 'ai');
      if (!v.ok) {
        markFailed(indexFail(v).reason);
        return { ...indexFail(v), source: 'ai', items: existingLocal.items, preserved: true };
      }
      const reason = '本地已有完整 AI 早报，仅发布到站点';
      markDone({ source: 'ai', items: existingLocal.items, generator: 'publish', reason, attempt });
      return { ok: true, code: 'existing-local-ai', source: 'ai', items: existingLocal.items, reason };
    }

    const inputR = readJson(path.join(dir, 'input.json'));
    if (!inputR.ok) {
      const reason = `缺少输入快照 input.json（${inputR.error}）；请先运行 prepare`;
      markMissed(reason);
      return { ok: false, code: 'no-input', reason };
    }
    const input = inputR.value;

    const finalR = readJson(path.join(dir, 'final.json'));
    if (!finalR.ok) {
      const rep = checkpointReport({ date, runsDir });
      const reason = finalR.exists
        ? `final.json 无法解析（${finalR.error}）`
        : `未到定稿检查点（当前：${rep.latest || 'input'}；下一段：${rep.next}）`;
      if (existingSite) {
        markDone({
          source: existingSite.source, items: existingSite.items, generator: 'existing',
          reason: `保留已有 ${existingSite.source} 产物：${reason}`, attempt, exitCode: 1,
        });
        return { ok: false, code: 'no-final', preserved: true, source: existingSite.source, reason };
      }
      markMissed(reason);
      return { ok: false, code: 'no-final', reason };
    }

    // 校验在函数内部构建候选 Map，避免并发串数据
    const verdict = validateFinal({ doc: finalR.value, input, date });
    if (!verdict.ok) {
      const reason = '定稿校验失败：' + verdict.errors.slice(0, 3)
        .map((e) => `${e.path} ${e.msg}`).join('；');
      if (draftOnFail) {
        const draft = buildDraftFallback({ input, date, now, reason });
        writeBriefingFiles({ doc: draft, localOut, siteOut });
        const v = patchAndVerify(briefLineOf(draft), 'draft');
        if (!v.ok) {
          markFailed(indexFail(v).reason);
          return { ...indexFail(v), degraded: true, source: 'draft', items: draft.items.length, errors: verdict.errors };
        }
        markDone({
          source: 'draft', items: draft.items.length, generator: 'draft-v1',
          reason, attempt, exitCode: 1,
        });
        return {
          ok: true, code: 'degraded-draft', degraded: true, source: 'draft',
          items: draft.items.length, reason, errors: verdict.errors,
        };
      }
      if (existingSite) {
        markDone({
          source: existingSite.source, items: existingSite.items, generator: 'existing',
          reason: `保留已有 ${existingSite.source} 产物：${reason}`, attempt, exitCode: 1,
        });
        return { ok: false, code: 'invalid', preserved: true, source: existingSite.source, reason, errors: verdict.errors };
      }
      markMissed(reason);
      return { ok: false, code: 'invalid', reason, errors: verdict.errors };
    }

    const doc = normalizeFinalForPublish({ doc: finalR.value, input, date, now });
    writeBriefingFiles({ doc, localOut, siteOut });
    const v = patchAndVerify(briefLineOf(doc), 'ai');
    if (!v.ok) {
      // 产物已写盘但索引没打上标记 ⇒ 不算发布成功（不回滚文件，明确提示先同步本地）
      markFailed(indexFail(v).reason);
      return { ...indexFail(v), source: 'ai', items: doc.items.length };
    }
    markDone({ source: 'ai', items: doc.items.length, generator: 'llm-v1', reason: '', attempt });
    return {
      ok: true, code: 'published', source: 'ai', items: doc.items.length, endedAt: doc.endedAt,
    };
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    if (status) {
      updateStatus(status, date, {
        status: 'failed',
        stage: 'publish',
        startedAt: t.iso,
        endedAt: beijingNow().iso,
        exitCode: 1,
        items: 0,
        source: '',
        reason,
        durationMs: Date.now() - started,
        generator: 'publish',
      }, { now });
    }
    return { ok: false, code: 'error', reason };
  } finally {
    if (lock && lock.ok) lock.release();
  }
}

/** ensure 拉起 prepare 时的参数（所有路径必须显式传，防止临时目录模拟写进仓库） */
export function prepareArgs({
  date, runs, status, db, archive, noImport = true, quiet = true,
}) {
  const a = ['--date', date, '--runs', runs, '--status', status, '--db', db, '--archive', archive];
  if (noImport) a.push('--no-import');
  if (quiet) a.push('--quiet');
  return a;
}

const PROMPT_TEMPLATE = `你是「宏观早报」的写作段（LLM）。你只负责语义判断：选主线、写摘要、定观察项。
确定性管道已经由脚本完成：取数、去重、候选打分、输入固化。你不要联网，不要重新抓取，
不要再运行 brief-candidates / import-archive / generate，也不要修改 input.json。

日期：{{DATE}}
输入快照：{{INPUT_PATH}}
快照指纹：{{INPUT_SHA}}
输出目录：{{RUN_DIR}}
当前续写点：{{RESUME}}

一、先读输入快照
input.json 结构：
{
  "v": 1,
  "date": "YYYY-MM-DD",
  "preparedAt": "...",
  "window": {"from": "...", "to": "..."},
  "candidateCount": 919,
  "selectedCount": 120,
  "inputSha": "...",
  "items": [
    {"rank":1,"date":"YYYY-MM-DDTHH:MM","source":"...","channel":"...","title":"...",
     "summary":"...","url":"...","score":12,"content_status":"full","published_ts":...}
  ]
}
候选已按宏观关键词权重 + 来源权重 + 全文/摘要质量排序；score 只用于参考，不替代你的判断。
只允许使用 items 里的条目；每条最终产物必须能通过 url 追溯到某个候选。

二、写三个检查点（只写这三个文件，全部 UTF-8 JSON）
1) outline.json —— 提纲（先想清楚再写）
{
  "date": "...",
  "inputSha": "...",
  "stage": "outline",
  "createdAt": "ISO",
  "thesis": "今日主线一句话，≤60字",
  "picks": [
    {"rank":1,"title":"...","url":"候选 url","angle":"为什么选它，≤40字"}
  ],
  "watch": ["明日观察项 1", "..."],
  "notes": "取舍说明，可空"
}
picks 6~12 条，按重要性排序；watch 2~4 条。

2) draft.json —— 草稿（完整正文，允许粗糙）
{
  "date": "...",
  "inputSha": "...",
  "stage": "draft",
  "createdAt": "ISO",
  "overview": "今日主线，60~140字",
  "items": [
    {"rank":1,"title":"...","summary":"60~120字","why":"为什么重要，≤40字",
     "source":"...","publishedAt":"...","url":"候选 url",
     "refs":["可选，同事件的其他候选 url"]}
  ],
  "watch": ["..."]
}

3) final.json —— 定稿（publish 只认这个文件）
{
  "date": "...",
  "inputSha": "...",
  "stage": "final",
  "generatedAt": "YYYY-MM-DDTHH:MM:SS+08:00",
  "overview": "...",
  "items": [...同 draft...],
  "watch": ["..."],
  "model": "可选：模型标识",
  "selfCheck": {"traceable": true, "notes": "可选：自检说明"}
}

三、写作口径
- 3~10 条；正常 8~10 条；合格事件不足 6 条时按实际条数输出，并在 selfCheck.notes 说明。
- 排序：中国政策/央行/利率/PMI/财政 > 三大央行/美国数据 > 地缘/原油/黄金/美元 > A股/港股/美股主线。
- 同一事件多源报道合并成一条：主 url 选信息最完整的一条，其他放 refs。
- summary 必须基于候选的 title/summary 改写，不得编造数字、时间、引语；不确定就不写。
- why 说明「为什么今天重要」，不要复述标题。
- watch 是明天要盯的 2~4 个具体变量（数据、会议、价格位），不要写空话。
- overview 只写今日主线，不要罗列全部条目。
- source 必须与候选的 source 一致；publishedAt 用候选的 date。
- items 的 url 必须逐字出现在 input.json 的某个 item.url 里；refs 里的 url 也必须能追溯。
- 不得写 source:"rule" 或 source:"draft"；来源由 publish 统一标记为 ai。
- 不得把规则版/模板拼接当早报；没有把握就少写，不要编。

四、中断续写
先看输出目录里已有的 outline.json / draft.json / final.json：
- 若 final.json 已存在且 inputSha 一致：只做自检，不要重写。
- 若 draft.json 已存在且 inputSha 一致：从定稿继续，不要重写提纲和草稿。
- 若只有 outline.json 且 inputSha 一致：从草稿继续，按提纲展开。
- 若 inputSha 不一致（脚本用 --force 重建了快照）：三个检查点全部作废，从 outline 重写。
- 任何情况下都不要重新抓取、不要生成另一套候选。

五、完成标准
final.json 通过以下校验才算完成：
- date 等于当天；inputSha 等于输入快照；
- overview 非空；
- items 3~10 条；每条 title/summary/why/source/url 非空；
- 每个 url 都能在 input.json 中找到，且 source 与候选一致；
- watch 为 0~6 条非空字符串；
- 没有 source:"rule"/"draft"。
写完 final.json 后停止，不要自己发布；发布由 publish 脚本完成。`;

const RESUME_TEXT = {
  prepare: '快照不存在，先运行 prepare',
  outline: '从 outline 开始（当前没有有效检查点）',
  draft: '从 draft 继续（提纲已存在，不要重写）',
  final: '从 final 继续（草稿已存在，不要重写提纲和草稿）',
  publish: 'final 已存在，只做自检，不要重写；交给 publish',
};

/** 生成给 LLM 的提示词全文（写进 .local/runs/<date>/prompt.md） */
export function renderPrompt({ date, inputPath, inputSha, runDir, next }) {
  const values = {
    DATE: date,
    INPUT_PATH: inputPath,
    INPUT_SHA: inputSha,
    RUN_DIR: runDir,
    RESUME: RESUME_TEXT[next] || RESUME_TEXT.outline,
  };
  return PROMPT_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] || '');
}
