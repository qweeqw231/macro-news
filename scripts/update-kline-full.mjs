// scripts/update-kline-full.mjs
// 生成/更新「服务端预生成的全量日K」：data/kline/<key>_full.json
//
// 为什么需要它（2026-10-29 本机实测）：
//   · 现有 data/kline/<key>.json 只有 **1000 根（4 年）**（日更主体），
//     而「尽可能多的 K 线」要 8752 根（36 年）—— 直连新浪给全量是 977KB / 21 秒；
//   · 直连源走**外网**（本机到新浪约 46 KB/s），Pages 走 **3~6 KB/s**
//     ⇒ 直连并不慢，慢的是 Pages；但直连**会因东财限流而失败**。
//   · 所以服务端预一份全量：**直连失败时照样能给全量**，且不依赖第三方源的可用性。
//
// 格式：**紧凑数组行** [t,o,c,h,l,v]（不是对象行）—— 体积省约 60%：
//   8000 根 ≈ 360KB 原始（gzip 后约 90KB）；对象行会是 1MB+。
//   ⚠ 前端解析见 assets/market.js 的 localFullKline()。
//
// 用法：
//   node scripts/update-kline-full.mjs             # 每天最多更新一次（按 generatedAt 判断）
//   node scripts/update-kline-full.mjs --force     # 强制刷新全部
//   node scripts/update-kline-full.mjs --dry-run   # 只抓不写
//   node scripts/update-kline-full.mjs --only sh_comp
//
// 退出码：0 = 成功（或全部已是最新）；1 = 一个都没成功

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDICES, PORTFOLIO_KLINE, fetchKline, getKlineSource } from '../src/sources.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'kline');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');
const ONLY = arg('only', '');

// 东财 lmt / 新浪 datalen 都是「给多少给多少」⇒ 给 20000 拿到的就是源侧全量
// （上证 = 8752 根 / 1990-12-19 起，36 年；纳斯达克 = 8865 根 / 1991 年起）。
// 前端直连也是按 20000 要的，两边口径一致。
// ⚠ 2026-10-30 实测：东财 push2his **限流是间歇性的** —— 同一天里先用后被 socket 级拒绝。
//   所以本脚本靠「东财 → 新浪 → 腾讯」的降级链取数，拿不到就跳过（不写残缺文件），
//   下一轮再来。港美日德英韩的标的**只有东财**有长历史 ⇒ 东财被限流时它们这一轮就更新不了。
const LIMIT = 20000;

// 低于这个根数就不写文件：存量的日K 快照是 1000 根，全量文件必须**明显更全**才有意义。
// （北证50 全量 1089 根、科创50 1652 根 —— 都在门槛之上）
const MIN_BARS = 1050;

const today = new Date().toISOString().slice(0, 10);
// 目标 = 17 个指数 + 4 个组合标的（纳指100 / 伦敦金 / 上海金 / 人民币中间价）
const ALL_TARGETS = [...INDICES, ...PORTFOLIO_KLINE];
const list = ONLY ? ALL_TARGETS.filter((i) => i.key === ONLY) : ALL_TARGETS;

console.log(`[update-kline-full] 目标 ${list.length} 个标的 · limit=${LIMIT}${DRY ? '（dry-run）' : ''}`);

let changed = 0;
let skipped = 0;
let failed = 0;

for (const idx of list) {
  const file = path.join(OUT_DIR, `${idx.key}_full.json`);
  if (!FORCE && existsSync(file)) {
    try {
      const j = JSON.parse(await readFile(file, 'utf8'));
      if (String(j.generatedAt || '').slice(0, 10) === today) {
        skipped++;
        continue;
      }
    } catch {
      /* 文件损坏 → 重新生成 */
    }
  }
  try {
    const bars = await fetchKline(idx.key, '1d', LIMIT);
    // 太短的说明只拿到某个备源（腾讯 clamp 到 1000），当全量写进去反而误导
    if (!bars || bars.length < MIN_BARS) {
      throw new Error(`只取到 ${bars ? bars.length : 0} 根，不足 ${MIN_BARS} 根，不当全量写`);
    }
    if (!DRY) {
      await mkdir(OUT_DIR, { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          key: idx.key,
          name: idx.name,
          market: idx.market,
          period: '1d',
          generatedAt: new Date().toISOString(),
          // 取数源与口径都写进文件：全量文件是「离线快照」，必须能自证是哪来的
          source: `服务端预生成的全量日K（limit=${LIMIT}）· 取数源：${getKlineSource() || '未知'}`,
          caliber: idx.klineNote || '',
          // 紧凑数组行：[t,o,c,h,l,v]
          bars: bars.map((b) => [b.t, b.o, b.c, b.h, b.l, b.v]),
        }),
        'utf8'
      );
    }
    changed++;
    console.log(
      `  ${idx.key.padEnd(9)} ${String(bars.length).padStart(6)} 根  ` +
      `${bars[0].t} → ${bars[bars.length - 1].t}  [${getKlineSource() || '未知源'}]${DRY ? '（dry-run）' : ''}`
    );
  } catch (e) {
    failed++;
    console.log(`  ⚠ ${idx.key.padEnd(9)} 失败：${String(e.message).slice(0, 90)}`);
  }
}

console.log(
  `[update-kline-full] 更新 ${changed} 个 / 跳过 ${skipped} 个（今天已更新） / 失败 ${failed} 个`
);
if (failed && !changed) process.exitCode = 1;
