// scripts/briefing/prepare-range.mjs
// 批量为一段连续日期生成早报输入快照（.local/runs/<date>/input.json）。
//
// 为什么需要它：早报补写是「一天一份」的粒度，671 天要跑 671 次 prepare。
// 逐日手工调用太慢，也容易中途停在一半、看不出进度。
// 本脚本按批跑，逐日失败只记账不中断，最后汇总一行退出码。
//
// 用法：
//   node scripts/briefing/prepare-range.mjs --from 2024-01-01 --to 2024-01-31
//   node scripts/briefing/prepare-range.mjs --from 2024-01-01 --to 2024-03-31 --batch-size 30
//   node scripts/briefing/prepare-range.mjs --from 2024-01-01 --to 2024-01-31 --dry-run
//
// 退出码：0 全部成功 / 1 有日期失败 / 2 参数问题
//
// 边界：只写 .local/runs/（本机派生，不进 git），不碰 data/ 下的任何站点文件。
// 产物本身仍由 prepare.mjs 生成 —— 本脚本只是批量调度器，不复制取数逻辑。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : dflt;
};
const flag = (name) => process.argv.includes('--' + name);

const FROM = arg('from', '');
const TO = arg('to', '');
const BATCH = Math.max(1, Number(arg('batch-size', 30)) || 30);
const DRY_RUN = flag('dry-run');
const SKIP_EXISTING = !flag('force');

const DAY_MS = 86400000;
const d2t = (s) => Date.parse(`${s}T00:00:00Z`);
const t2d = (n) => new Date(n).toISOString().slice(0, 10);
const addDays = (s, n) => t2d(d2t(s) + n * DAY_MS);

function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM) || !/^\d{4}-\d{2}-\d{2}$/.test(TO)) {
    console.error('用法：node scripts/briefing/prepare-range.mjs --from YYYY-MM-DD --to YYYY-MM-DD');
    return 2;
  }
  if (d2t(FROM) > d2t(TO)) {
    console.error('--from 晚于 --to');
    return 2;
  }

  const days = [];
  for (let d = FROM; d <= TO; d = addDays(d, 1)) days.push(d);

  const script = path.join(ROOT, 'scripts', 'briefing', 'prepare.mjs');
  let ok = 0;
  let skipped = 0;
  const failed = [];

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const inputFile = path.join(ROOT, '.local', 'runs', d, 'input.json');
    if (SKIP_EXISTING && fs.existsSync(inputFile)) {
      skipped++;
      continue;
    }
    if (DRY_RUN) {
      ok++;
      continue;
    }
    const r = spawnSync(
      process.execPath,
      [script, '--date', d, '--backfill-kind', 'pre-era', '--no-import', '--no-prompt', '--quiet'],
      { cwd: ROOT, encoding: 'utf8', timeout: 120000 }
    );
    if (r.status === 0 && fs.existsSync(inputFile)) {
      ok++;
    } else {
      failed.push(d);
    }
    if ((i + 1) % BATCH === 0 || i === days.length - 1) {
      console.log(`进度 ${i + 1}/${days.length}（成功 ${ok} / 跳过 ${skipped} / 失败 ${failed.length}）`);
    }
  }

  console.log(`共 ${days.length} 天：成功 ${ok}，跳过 ${skipped}，失败 ${failed.length}`);
  if (failed.length) {
    console.log(`失败日期：${failed.slice(0, 30).join(' ')}`);
    return 1;
  }
  return 0;
}

process.exitCode = main();
