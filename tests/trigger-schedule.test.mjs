// tests/trigger-schedule.test.mjs
// 2.4.14：触发去重（Cloudflare 主触发、GitHub 错峰兜底）的静态守卫。
// 不依赖 GitHub / Cloudflare 线上状态，只校验仓库内的 cron 与 workflow 职责。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ghCrons = (file) =>
  [...read(file).matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);

/** 只覆盖本项目使用的两种形式：`M * * * *` 与 `M H * * *` */
function cronTimes(expr) {
  const [min, hour] = expr.split(' ');
  const minutes = min.split(',').map(Number);
  return minutes.map((m) => ({
    hour: hour === '*' ? null : Number(hour),
    minute: m,
  }));
}

const setOf = (expr) => new Set(cronTimes(expr).map((t) => t.minute));

const CF = {
  collect: '7,22,37,52 * * * *',
  snapshot: '13,43 * * * *',
  minute: '17,47 * * * *',
};
// CF 的 kline-full 由 gh-cron 在 UTC 04:17 附带 dispatch
const CF_FULL = { hour: 4, minute: 17 };

test('Cloudflare 主触发配置未变（wrangler + gh-cron）', () => {
  const toml = read('worker/gh-cron/wrangler.toml');
  for (const c of Object.values(CF)) {
    assert.ok(toml.includes(`"${c}"`), `wrangler 缺少 ${c}`);
  }
  const worker = read('worker/gh-cron/gh-cron.js');
  assert.match(worker, /getUTCHours\(\) === 4 && d\.getUTCMinutes\(\) === 17/);
});

test('GitHub 兜底与 CF 主触发不同分钟', () => {
  const pairs = [
    ['collect', '.github/workflows/collect.yml'],
    ['snapshot', '.github/workflows/snapshot.yml'],
    ['minute', '.github/workflows/kline-minute.yml'],
  ];
  for (const [name, file] of pairs) {
    const cf = setOf(CF[name]);
    const gh = new Set();
    for (const expr of ghCrons(file)) {
      for (const m of setOf(expr)) gh.add(m);
    }
    assert.ok(gh.size > 0, `${file} 没有 cron`);
    for (const m of gh) assert.ok(!cf.has(m), `${name} 在 :${m} 与 CF 同分钟`);
  }
});

test('kline-full：GH 与 CF 至少错开 45 分钟', () => {
  const gh = cronTimes(ghCrons('.github/workflows/kline-full.yml')[0])[0];
  const gap = Math.abs((gh.hour * 60 + gh.minute) - (CF_FULL.hour * 60 + CF_FULL.minute));
  assert.ok(gap >= 45, `kline-full 兜底只错开 ${gap} 分钟，长任务会并发`);
});

test('分钟 / 快照任务的兜底偏移在 10~25 分钟', () => {
  const dist = (a, b) => {
    const d = Math.abs(a - b);
    return Math.min(d, 60 - d);
  };
  for (const [name, file] of [
    ['snapshot', '.github/workflows/snapshot.yml'],
    ['minute', '.github/workflows/kline-minute.yml'],
  ]) {
    const cf = [...setOf(CF[name])];
    for (const expr of ghCrons(file)) {
      for (const m of setOf(expr)) {
        const nearest = Math.min(...cf.map((c) => dist(m, c)));
        assert.ok(nearest >= 10 && nearest <= 25, `${name} :${m} 距主触发 ${nearest} 分钟`);
      }
    }
  }
});

test('所有写数据的 workflow 都保留手动触发', () => {
  for (const f of ['collect', 'snapshot', 'kline-minute', 'kline-full']) {
    assert.match(read(`.github/workflows/${f}.yml`), /workflow_dispatch:/, `${f} 缺 workflow_dispatch`);
  }
});

test('日/周/月 K 只在 kline-minute 的 UTC 04 点刷新，kline-full 只写 _full', () => {
  const minute = read('.github/workflows/kline-minute.yml');
  assert.match(minute, /每天刷新日\/周\/月K（UTC 04 点）/);
  assert.match(minute, /collect\.mjs --kline-only/);
  assert.match(minute, /\[ "\$h" = "04" \]/);
  const full = read('.github/workflows/kline-full.yml');
  assert.match(full, /update-kline-full\.mjs/);
  assert.doesNotMatch(full, /collect\.mjs --kline-only/, 'kline-full 不应再写日/周/月 K');
});

test('GitHub 自己的 cron 之间也不撞分钟', () => {
  const all = [];
  for (const f of ['collect', 'snapshot', 'kline-minute']) {
    for (const expr of ghCrons(`.github/workflows/${f}.yml`)) {
      for (const m of setOf(expr)) all.push(`${f}:${m}`);
    }
  }
  const minutes = all.map((x) => x.split(':')[1]);
  assert.equal(new Set(minutes).size, minutes.length, `GitHub cron 分钟重复：${all.join(' ')}`);
});
