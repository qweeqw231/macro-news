// scripts/repair-sge-volume.mjs
// 2.4.11：回填上海金 Au99.99 日 K 的历史成交量。
//
// 根因：`sge_au9999` 日线有两个源交替写同一文件——
//   · 东财 118.AU9999：有 volume（全部历史）
//   · 上金所官网 Dailyhq：只有 [日期,开,收,低,高]，没有 volume
// 谁最后写谁赢，上金所写入时把整列 volume 变成 0。
//
// 做法：拉东财日线（1000 根，2022-09-19 起），按时间键 union 回现有文件，
// 然后重新聚合周/月。东财覆盖不到的更早两根（2022-09-15/16）保持 0，
// **不估算、不伪造**，前端注记会写明成交量覆盖范围。
//
//   node scripts/repair-sge-volume.mjs --dry-run
//   node scripts/repair-sge-volume.mjs --apply

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchKline, aggregateBars, getKlineSource } from '../src/sources.mjs';
import { mergeBars, barVolume } from '../src/kline-guard.mjs';
import { acquireKlineLock, releaseKlineLock, lockSkipText } from '../src/kline-lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'data', 'kline');
const APPLY = process.argv.includes('--apply');
const BASE = { key: 'sge_au9999', name: '上海金Au99.99', market: 'SGE' };

const read = async (f) => JSON.parse(await readFile(path.join(DIR, f), 'utf8'));
const write = (f, obj) => writeFile(path.join(DIR, f), JSON.stringify(obj, null, 2), 'utf8');

async function main() {
  const incoming = await fetchKline('sge_au9999', '1d', 1000);
  const src = getKlineSource();
  if (src !== '东方财富') throw new Error(`本次取数源是「${src}」，没有成交量；请稍后重试`);
  if (incoming.filter((b) => b.v > 0).length < 900) throw new Error('东财返回的成交量异常（>0 少于 900 根）');

  let lock = null;
  if (APPLY) {
    lock = await acquireKlineLock('sge_au9999');
    if (!lock.ok) {
      console.log(`[sge-volume] ${lockSkipText('sge_au9999', lock)}`);
      return;
    }
  }

  try {
    const old = await read('sge_au9999.json');
    const merged = mergeBars(old.bars, incoming);
    const filled = merged.filter((b) => barVolume(b) > 0);
    const firstFilled = filled[0];
    const lastFilled = filled[filled.length - 1];
    const before = old.bars.filter((b) => barVolume(b) > 0).length;

    console.log(`[sge-volume] 现有 ${old.bars.length} 根 / volume>0 ${before}`);
    console.log(`[sge-volume] 合并后 ${merged.length} 根 / volume>0 ${filled.length}；`
      + `覆盖 ${firstFilled && firstFilled.t} → ${lastFilled && lastFilled.t}`);

    if (!APPLY) {
      console.log('[sge-volume] dry-run，未写盘');
      return;
    }

    await write('sge_au9999.json', {
      ...BASE,
      period: '1d',
      generatedAt: new Date().toISOString(),
      source: '东方财富（成交量回填 2.4.11）',
      bars: merged,
    });
    for (const [unit, period, suffix] of [['week', '1w', '_1w'], ['month', '1M', '_1M']]) {
      const bars = aggregateBars(merged, unit);
      await write(`sge_au9999${suffix}.json`, {
        ...BASE,
        period,
        generatedAt: new Date().toISOString(),
        source: '本地聚合自 sge_au9999 日线（成交量回填 2.4.11）',
        bars,
      });
      console.log(`[sge-volume] ${period} ${bars.length} 根，volume>0 ${bars.filter((b) => b.v > 0).length}`);
    }
  } finally {
    if (lock) await releaseKlineLock(lock);
  }
}

main().catch((e) => { console.error('[sge-volume] 失败', e.message); process.exit(1); });
