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
import { upsertBars, markCloseOnlyBars } from '../src/kline-guard.mjs';
import { withKlineLock, lockSkipText } from '../src/kline-lock.mjs';
import { writePlan, barDate, CAL } from '../src/kline-finalize.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const KLINE_DIR = path.join(ROOT, 'data', 'kline');
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const nowMs = Date.now();
  const keys = [...INDICES, ...PORTFOLIO_KLINE].map((x) => x.key);
  let updated = 0, finalized = 0, skipped = 0, failed = 0, locked = 0;

  for (const key of keys) {
    if (!klineAvailable(key)) { skipped++; continue; }
    const meta = klineTarget(key);
    const market = meta?.market;
    if (!market) { skipped++; continue; }

    const file = path.join(KLINE_DIR, `${key}.json`);
    if (!existsSync(file)) { skipped++; continue; }

    // 判据：不是「现在是否在交易时段」，而是「今天这根收盘 bar 写过没有」。
    //   · 盘中 → 照旧每轮 upsert（含上海金夜盘这类“未来蜡烛”）；
    //   · 收盘后 → 若文件 generatedAt 还早于收盘时刻，补一次定稿；
    //   · 已定稿 → 跳过，幂等。
    let state = {};
    try {
      const doc = JSON.parse(await readFile(file, 'utf8'));
      const bars = Array.isArray(doc.bars) ? doc.bars : [];
      state = {
        generatedAt: doc.generatedAt,
        lastBar: bars.length ? barDate(bars[bars.length - 1]) : '',
      };
    } catch {
      skipped++;
      continue;
    }
    const plan = writePlan(market, nowMs, state, CAL);
    if (plan.action === 'skip') { skipped++; continue; }

    try {
      // 只取最近 5 根：够覆盖「今天 + 上一交易日」，不会把全量历史拖下来
      const latest = await fetchKline(key, '1d', 5);
      if (!latest || !latest.length) { skipped++; continue; }
      // 定稿轮必须真的拿到「收盘日」那一根：源侧还没吐出今天的话，等下一轮，
      // 绝不能把昨天那根重新写一遍就算完。
      // ⚠ 2.14.0：24h 品种（FX/CMDTY）的源侧最后一根可能**比收盘日更新**
      //   （当天 bar 还在走，收盘日只是「上一根已定稿的」）⇒ 用 >= 而不是 !==。
      const srcLast = barDate(latest[latest.length - 1]);
      if (plan.action === 'finalize' && !(srcLast && srcLast >= plan.close.date)) {
        console.log(
          `  ⏳ ${key}：待定稿 ${plan.close.date}，但源侧最后一根是 ` +
            `${srcLast || '空'}，等下一轮`
        );
        skipped++;
        continue;
      }
      const res = await withKlineLock(key, async () => {
        const old = JSON.parse(await readFile(file, 'utf8'));
        // 2.4.12 补丁位：按时间键 upsert，并保留非零成交量。
        //   上金所官网兜底没有 volume（全部 0），以前这里用 Map 直接覆盖，
        //   一次 SGE 源切换就把最近 5 根的东财成交量抹成 0（2026-11-04 14:28 UTC 实测）。
        // 2.18.0：o=h=l=0 且只有收盘的 bar 必须显式标记（写库路径统一打标）
        const bars = markCloseOnlyBars(upsertBars(old.bars, latest)).bars;
        const changed = JSON.stringify(bars) !== JSON.stringify(old.bars || []);
        if (!changed) return { changed: false };

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
        return { changed: true, last: latest[latest.length - 1] };
      });
      if (!res.ok) {
        locked++;
        console.log(`  ${lockSkipText(key, res)}`);
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      if (!res.value.changed) { skipped++; continue; }
      updated++;
      if (plan.action === 'finalize') finalized++;
      const last = res.value.last;
      console.log(
        `  ${key}：${plan.action === 'finalize' ? '收盘定稿' : '盘中更新'} ` +
          `${last.t} 收 ${last.c}${DRY_RUN ? '（dry-run 不写盘）' : ''}`
      );
    } catch (err) {
      failed++;
      console.log(`  ❌ ${key}：${String(err.message).slice(0, 100)}`);
    }
    // 东财按 IP 限流，请求之间留点间隔
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(
    `[kline-last] 更新 ${updated} 个（收盘定稿 ${finalized}）· 跳过 ${skipped} 个 · ` +
      `锁占用 ${locked} 个 · 失败 ${failed} 个`
  );
}

main().catch((err) => {
  console.error('[kline-last] 致命错误', err);
  process.exit(1);
});
