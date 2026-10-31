// scripts/collect-macro-if-due.mjs
// 由 snapshot.yml 每 30 分钟调用：只在「北京工作日 17:00 后」且「当天还没有宏观记录」时，
// 才真正跑 src/portfolio-collect.mjs。
//
// 为什么挂在快照 workflow 上：
//   · Cloudflare Worker 已经在每 30 分钟触发 snapshot.yml，不需要再加第 4 条 cron；
//   · 17:13 / 17:43 两轮之间天然形成重试（失败那轮不写记录，下一轮会再跑）；
//   · 门禁幂等：当天已有记录 → 之后每轮都是 no-op，不会重复打接口。
//
// 17:00 之后才跑的原因：1Y 国债曲线（中债）要 17:00 才发布，16:30 采会把昨天的值当今天。
//
// 用法：
//   node scripts/collect-macro-if-due.mjs                  # 正常门禁
//   node scripts/collect-macro-if-due.mjs --force          # 忽略时间/周末/已存在（手动验证）
//   node scripts/collect-macro-if-due.mjs --force --dry-run

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');
const DRY = process.argv.includes('--dry-run');
const MACRO_FILE = path.join(ROOT, 'data', 'macro', 'daily.json');

// 不依赖 runner 本地时区：显式换算北京时间
const bj = new Date(Date.now() + 8 * 3600 * 1000);
const day = bj.toISOString().slice(0, 10);
const hm = bj.toISOString().slice(11, 16);
const wd = bj.getUTCDay(); // 0 = 周日 … 6 = 周六

const say = (m) => console.log(`[macro-gate] ${m}`);

if (!FORCE) {
  if (wd === 0 || wd === 6) {
    say(`${day} 是周末，跳过`);
    process.exit(0);
  }
  if (hm < '17:00') {
    say(`北京时间 ${hm}，未到 17:00（中债曲线未发布），跳过`);
    process.exit(0);
  }
  if (fs.existsSync(MACRO_FILE)) {
    try {
      const doc = JSON.parse(fs.readFileSync(MACRO_FILE, 'utf8'));
      const list = Array.isArray(doc) ? doc : [];
      if (list.some((x) => x && x.date === day && Array.isArray(x.items) && x.items.length > 0)) {
        say(`${day} 已有宏观记录，跳过`);
        process.exit(0);
      }
    } catch { /* 文件损坏就照常跑，让采集器覆盖 */ }
  }
}

say(`开始采集 ${day} 的宏观指标${DRY ? '（dry-run）' : ''}`);
const args = ['src/portfolio-collect.mjs'];
if (DRY) args.push('--dry-run');
const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
