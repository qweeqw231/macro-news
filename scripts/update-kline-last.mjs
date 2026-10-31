// scripts/update-kline-last.mjs
// 把「当前正在交易的市场」的最后一根日 K 重新拉一遍，合并进 data/kline/<key>.json
//
// ── 为什么需要它 ──
//   日/周/月 K 由 kline-full.yml 每天 12:23 刷一次就够「收盘价」，
//   但上海金这类有夜盘的品种，周五夜盘归属**下一交易日**：那根「未来蜡烛」在周六看是对的，
//   并且从周日晚 / 周一日盘开始会持续变化。每天只刷一次的话，页面上那根 bar 会停在旧值。
//   这个脚本每小时只动**最后一根**（按 t upsert），不做全历史重写，代价很小。
//
// 用法：node scripts/update-kline-last.mjs [--dry-run]
// 只处理「当前处于交易时段」的品种（CN/HK/JP/KR/EU/UK/US/SGE），其余跳过。

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INDICES, PORTFOLIO_KLINE, fetchKline, klineAvailable, klineTarget, getKlineSource,
} from '../src/sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KLINE_DIR = path.join(ROOT, 'data', 'kline');
const DRY_RUN = process.argv.includes('--dry-run');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 北京时间的 星期 / 小时 */
function beijingNow() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return { wd: t.getUTCDay(), h: t.getUTCHours() + t.getUTCMinutes() / 60 };
}

function inRange(h, a, b) {
  return b <= 24 ? (h >= a && h < b) : (h >= a || h < b - 24);
}

// 北京时间交易时段；b>24 表示跨零点
const SESSIONS = {
  CN: [9.5, 15], ETF: [9.5, 15], HK: [9.5, 16],
  JP: [8, 14], KR: [8, 14.5], EU: [16, 24.5], UK: [16, 24.5],
  US: [21.5, 29],
  SGE: [9, 15.5, 20, 26.5],
};
// 周六凌晨仍在跑「周五夜盘」的品种与收盘时刻（北京时间小时）
const SAT_TAIL = { SGE: 2.5, US: 5, EU: 0.5, UK: 0.5 };

function activeNow(market, now) {
  const win = SESSIONS[market];
  if (!win) return false;
  if (now.wd === 0) return false;
  if (now.wd === 6) {
    const tail = SAT_TAIL[market];
    if (!tail || now.h >= tail) return false;
  }
  return win.length === 4
    ? inRange(now.h, win[0], win[1]) || inRange(now.h, win[2], win[3])
    : inRange(now.h, win[0], win[1]);
}

async function main() {
  const now = beijingNow();
  const keys = [...INDICES, ...PORTFOLIO_KLINE].map((x) => x.key);
  let updated = 0, skipped = 0, failed = 0;

  for (const key of keys) {
    if (!klineAvailable(key)) { skipped++; continue; }
    const meta = klineTarget(key);
    if (!activeNow(meta?.market, now)) { skipped++; continue; }

    const file = path.join(KLINE_DIR, `${key}.json`);
    if (!existsSync(file)) { skipped++; continue; }

    try {
      // 只取最近 5 根：够覆盖「今天 + 上一交易日」，不会把全量历史拖下来
      const latest = await fetchKline(key, '1d', 5);
      const old = JSON.parse(await readFile(file, 'utf8'));
      const merged = new Map((old.bars || []).map((b) => [b.t, b]));
      for (const b of latest) merged.set(b.t, b);
      const bars = [...merged.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
      const changed = JSON.stringify(bars) !== JSON.stringify(old.bars || []);
      if (!changed) { skipped++; continue; }

      const doc = {
        ...old,
        key,
        name: old.name || meta?.name || key,
        market: old.market || meta?.market || '',
        period: '1d',
        generatedAt: new Date().toISOString(),
        source: getKlineSource() || old.source || '',
        bars,
      };
      if (!DRY_RUN) await writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
      updated++;
      const last = latest[latest.length - 1];
      console.log(`  ${key}：最后一根 ${last.t} 收 ${last.c}${DRY_RUN ? '（dry-run 不写盘）' : ''}`);
    } catch (err) {
      failed++;
      console.log(`  ❌ ${key}：${String(err.message).slice(0, 100)}`);
    }
    // 东财按 IP 限流，请求之间留点间隔
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`[kline-last] 更新 ${updated} 个 · 跳过 ${skipped} 个 · 失败 ${failed} 个`);
}

main().catch((err) => {
  console.error('[kline-last] 致命错误', err);
  process.exit(1);
});
