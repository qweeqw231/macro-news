// src/brief-meta.mjs
// 早报元信息：把 data/briefings/YYYY-MM-DD.json 压成索引里需要的两个字段。
//
// 为什么索引要带一句 briefLine：
//   归档页每张「当日卡片」默认要显示一行主线摘要，但又不能首屏预取早报正文
//   （早报会逐日累积到 365 份）。索引里只多存一句 ≤80 字的摘要，
//   用户点开折叠块时才去取完整 JSON（观察项）。
//
// 数据形状（沿用早报产物，不重写）：
//   { date, generatedAt, window, overview, items[], watch[] }
//   · overview = 当天主线摘要（折叠时显示这一行）
//   · watch    = 观察项（展开时显示）
//   · items    = 当日 ≤10 条早报条目（本站暂不展示，保留在文件里）

import fs from 'node:fs';
import path from 'node:path';

export const BRIEF_LINE_MAX = 80;

/** overview → 一行摘要（空白折叠 + 截断） */
export function briefLineOf(json, max = BRIEF_LINE_MAX) {
  const s = String((json && json.overview) || '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

/**
 * 扫描早报目录，返回 Map<day, {briefLine}>。
 * 只读；目录不存在时返回空 Map（站点还没发布过早报）。
 */
export function readBriefingMeta(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // 2.2.2：旧产物没有 source → 按 AI 处理（不回写历史文件）
      // 2.3.0：draft 是降级事实清单，必须保留来源，不能误判成 ai
      const source = j && (j.source === 'rule' || j.source === 'draft') ? j.source : 'ai';
      out.set(m[1], { briefLine: briefLineOf(j), source });
    } catch {
      // 损坏的早报不应拖垮索引：标记为「有文件但无摘要」，前端只会显示「当日早报」
      out.set(m[1], { briefLine: '', source: 'ai' });
    }
  }
  return out;
}
