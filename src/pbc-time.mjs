// src/pbc-time.mjs
// 2.5.0：从人民银行详情页 URL 解析真实发布时间。
//
// 列表页只给日期（`<span class="hui12">YYYY-MM-DD</span>`），旧代码把它拼成
// `00:00+08:00`，导致 08:00 之后发布的条目被归到前一个新闻日。
// 详情页 URL 形如 `/goutongjiaoliu/113456/113469/2026110516262373524/index.html`，
// 前 14 位是 `YYYYMMDDHHMMSS`；73/73 条历史条目均可解析且与页面日期列一致。
//
// 解析失败（缺字段、畸形日期）返回 null，由调用方回退到原日期方案，绝不抛错。

const URL_RE = /\/goutongjiaoliu\/113456\/113469\/(\d{14})\d*\/index\.html/;

export function pbcTimeFromUrl(url) {
  const m = String(url || '').match(URL_RE);
  if (!m) return null;
  const s = m[1];
  const y = +s.slice(0, 4);
  const mo = +s.slice(4, 6);
  const d = +s.slice(6, 8);
  const hh = +s.slice(8, 10);
  const mi = +s.slice(10, 12);
  const ss = +s.slice(12, 14);
  if (y < 2000 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  if (hh > 23 || mi > 59 || ss > 59) return null;

  // 按北京时间解释；Date.UTC 对 2 月 30 日这类非法日期会进位，必须回读校验。
  const ms = Date.UTC(y, mo - 1, d, hh - 8, mi, ss);
  const bj = new Date(ms + 8 * 3600 * 1000);
  if (bj.getUTCFullYear() !== y || bj.getUTCMonth() + 1 !== mo || bj.getUTCDate() !== d
    || bj.getUTCHours() !== hh || bj.getUTCMinutes() !== mi || bj.getUTCSeconds() !== ss) {
    return null;
  }

  const ts = Math.floor(ms / 1000);
  return {
    ts,
    // 与 sources.mjs 的 isoFromUnix 完全同格式
    time: new Date((ts + 8 * 3600) * 1000).toISOString().replace('Z', '+08:00'),
    day: new Date(ts * 1000).toISOString().slice(0, 10),
  };
}
