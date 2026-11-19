// scripts/kline-heartbeat.mjs
// K 线新鲜度哨兵的心跳：在**推送之前**写一个时间戳文件，让它随同一笔数据提交落库。
//
// 为什么不看「运行是否 success」：
//   2026-11-18 22:48（北京）那次运行结论是 success，但 push 撞 rebase 冲突后静默放弃，
//   main 上一个字节都没变。判据必须是「真的提交上去了」—— 所以时间戳必须和数据
//   一起提交：推不上去，时间戳就不会前进，页脚哨兵自然报陈旧。
//
// 用法：node scripts/kline-heartbeat.mjs minute|full
// 阈值：KLINE_FRESHNESS_MIN（默认 90 分钟），写进文件供页脚读取。
//
// 注意：这个文件每次运行都会变 ⇒ 即使当天行情没有变化，K 线 workflow 也会有一笔
//       「心跳」提交。这是有意的：它证明的不是「数据变了」，而是「链路还活着」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'data', 'kline', '_heartbeat.json');

const by = process.argv[2] || 'unknown';
const thresholdMin = Number(process.env.KLINE_FRESHNESS_MIN || 90);
const at = new Date().toISOString();

fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(FILE, `${JSON.stringify({ at, by, thresholdMin }, null, 2)}\n`, 'utf8');
console.log(`[heartbeat] ${at} by=${by} threshold=${thresholdMin}min`);
