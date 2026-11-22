// scripts/build-search.mjs
// 2.33.1：部署期生成站内检索索引（不进 git）。
//
// 用法：
//   node scripts/build-search.mjs     # 生成 data/search.json + data/search-history/*
//
// 为什么放在部署期：search.json 每天被重写约 96 次，2,339 次提交在 git 历史里留下
//   18.88 MiB（clone 边际），而它完全是 data/archive + data/history 的派生数据。
//   改成现算后，clone 不再随采集增长；产物仍进 Pages artifact，前端路径与字段不变。
//
// 失败处理：任何一步失败都以非 0 退出。pages.yml 里这一步失败会让整次部署失败——
//   宁可站点停在上一版，也不发布「页面正常但搜索空白」的版本。
//
// 与采集共用实现：热段走 src/search-index.mjs（collect.mjs 也调它），
//   分片走 scripts/build-search-history.mjs，两侧不会各写一套口径。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHotSearchDoc } from '../src/search-index.mjs';
import { buildSearchHistory } from './build-search-history.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

const t0 = performance.now();
const generatedAt = new Date().toISOString();

// 1) 热段（search.json）
const { doc, stats } = buildHotSearchDoc({ dataDir: DATA, now: Date.now(), generatedAt });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'search.json'), JSON.stringify(doc, null, 2), 'utf8');
const t1 = performance.now();
console.log(
  `[search] 热段 ${stats.hotTotal} 条（窗口 ${stats.total} 条 / ${stats.days} 天，` +
    `其中 history ${stats.fromHistory} 天）· ${(t1 - t0).toFixed(0)} ms`
);

// 2) 月度分片（search-history/*）
const rc = buildSearchHistory({ generatedAt, dataDir: DATA });
const t2 = performance.now();
if (rc) {
  console.error(`[search] 分片构建失败（exit ${rc}），部署中止`);
  process.exit(rc);
}

const man = JSON.parse(fs.readFileSync(path.join(DATA, 'search-history', 'manifest.json'), 'utf8'));
console.log(`[search] 分片 ${man.months} 个月 ${man.total} 条 · ${(t2 - t1).toFixed(0)} ms`);
console.log(`[search] 合计 ${(t2 - t0).toFixed(0)} ms · data/search.json + data/search-history/*`);
