// src/source-error.mjs
// 2.5.0：采集源失败时提取底层 cause 的 code/message。
//
// Node 的 fetch 失败通常只抛出 `TypeError: fetch failed`，真正的
// `ECONNRESET` / `ENOTFOUND` / 证书错误在 `err.cause` 里，可能是嵌套的
// Error 或 AggregateError（`errors[]`）。旧版只写 `err.message`，导致
// `_last-run.json` 里永远只有 "fetch failed"。
//
// 纯函数、无 IO；取到第一个非空 code 即可，同时保留第一个非空 message。

const MAX_DEPTH = 8;
const cut = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

export function describeSourceError(err) {
  if (!err || typeof err !== 'object') return {};
  if (err.code) {
    return { causeCode: cut(err.code, 60), ...(err.message ? { causeMessage: cut(err.message, 160) } : {}) };
  }

  const queue = [];
  if (err.cause) queue.push(err.cause);
  const seen = new Set();
  let firstMessage = '';
  let depth = 0;

  while (queue.length && depth < MAX_DEPTH) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    if (typeof cur === 'string') {
      if (!firstMessage) firstMessage = cut(cur, 160);
      continue;
    }
    if (typeof cur !== 'object') continue;
    seen.add(cur);

    // code 与 message 取同一层，避免把内层 code 配上外层 message
    if (cur.code) {
      return { causeCode: cut(cur.code, 60), ...(cur.message ? { causeMessage: cut(cur.message, 160) } : {}) };
    }
    if (!firstMessage && cur.message) firstMessage = cut(cur.message, 160);
    if (Array.isArray(cur.errors)) queue.push(...cur.errors);
    if (cur.cause) queue.push(cur.cause);
    depth++;
  }

  return firstMessage ? { causeMessage: firstMessage } : {};
}
