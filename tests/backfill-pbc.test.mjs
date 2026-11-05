// tests/backfill-pbc.test.mjs
// 2.5.0：PBOC 错日回填脚本——跨日移动、同 id 重复合并、幂等与总数守恒。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { backfillPbcDays } from '../scripts/backfill-pbc-days.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AS_OF = '2026-11-06T00:00:00+08:00';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'macro-pbc-backfill-'));
}
function write(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function read(file) { return fs.readFileSync(file, 'utf8'); }
function snapshot(root) {
  const data = path.join(root, 'data');
  const out = {};
  for (const sub of ['archive', '.']) {
    const dir = sub === '.' ? data : path.join(data, sub);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      out[sub + '/' + f] = read(path.join(dir, f));
    }
  }
  return out;
}
const pbc = (id, title, url, ts, time) => ({
  id, ts, time, source: '中国人民银行', channel: '政策/监管', title,
  summary: '', content: '', url, kind: 'official',
});
const normal = (id, title, ts, time) => ({
  id, ts, time, source: '新浪财经', channel: '国内财经', title,
  summary: '', content: '', url: `https://example.com/${id}`, kind: 'news',
});

function fixture() {
  const root = tmpRoot();
  write(path.join(root, 'data/archive/2026-11-04.json'), {
    day: '2026-11-04',
    items: [
      pbc('pbcA', 'A 错日', 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110516262373524/index.html',
        1793808000, '2026-11-05T00:00:00.000+08:00'),
      pbc('pbcB', 'B 错日', 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110510330636555/index.html',
        1793808000, '2026-11-05T00:00:00.000+08:00'),
      pbc('pbcC', 'C URL 不可解析', 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/no-time/index.html',
        1793721600, '2026-11-04T00:00:00.000+08:00'),
      normal('n1', '普通 1', 1793800000, '2026-11-05T00:00:00.000+08:00'),
    ],
  });
  write(path.join(root, 'data/archive/2026-11-05.json'), {
    day: '2026-11-05',
    items: [
      // 同 id 重复：旧版已写入正确日，但时间仍是 00:00
      pbc('pbcA', 'A 重复副本', 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110516262373524/index.html',
        1793808000, '2026-11-05T00:00:00.000+08:00'),
      normal('n2', '普通 2', 1793810000, '2026-11-05T02:00:00.000+08:00'),
    ],
  });
  write(path.join(root, 'data/index.json'), {
    generatedAt: '2026-11-05T00:00:00.000Z',
    total: 6,
    days: [
      { day: '2026-11-05', count: 2, hasBriefing: true, briefLine: 'x', source: 'ai' },
      { day: '2026-11-04', count: 4, hasBriefing: false },
    ],
  });
  write(path.join(root, 'data/search.json'), { generatedAt: '', windowDays: 62, from: '', days: 0, total: 0, items: [] });
  write(path.join(root, 'data/latest.json'), { generatedAt: '', total: 0, items: [] });
  return root;
}

test('跨日移动 + 同 id 重复合并；唯一文章数不变', async () => {
  const root = fixture();
  const r = await backfillPbcDays({ root, asOf: AS_OF });
  assert.equal(r.moved, 2, 'A/B 两条跨日');
  assert.equal(r.updated, 3, 'A/B 跨日 + 目标日 A 的时间更新');
  assert.equal(r.timeOnly, 1);
  assert.equal(r.merged, 1, 'A 在目标日已有同 id 副本');
  assert.equal(r.uniqueBefore, 3);
  assert.equal(r.uniqueAfter, 3);
  assert.equal(r.pbcBefore, 4);
  assert.equal(r.pbcAfter, 3, '删掉 1 份重复副本，不是丢文章');
  assert.equal(r.totalBefore, 6);
  assert.equal(r.totalAfter, 5);

  const d4 = JSON.parse(read(path.join(root, 'data/archive/2026-11-04.json')));
  const d5 = JSON.parse(read(path.join(root, 'data/archive/2026-11-05.json')));
  assert.deepEqual(d4.items.map((x) => x.id).sort(), ['n1', 'pbcC']);
  assert.deepEqual(d5.items.map((x) => x.id).sort(), ['n2', 'pbcA', 'pbcB']);
  const a = d5.items.find((x) => x.id === 'pbcA');
  assert.equal(a.time, '2026-11-05T16:26:23.000+08:00');
  assert.equal(a.ts, Math.floor(Date.parse(a.time) / 1000));
  const c = d4.items.find((x) => x.id === 'pbcC');
  assert.equal(c.time, '2026-11-04T00:00:00.000+08:00', '无法解析的 URL 保持原样');

  const idx = JSON.parse(read(path.join(root, 'data/index.json')));
  assert.equal(idx.total, 5);
  assert.deepEqual(idx.days.map((x) => [x.day, x.count]), [['2026-11-05', 3], ['2026-11-04', 2]]);
  assert.equal(idx.days[0].hasBriefing, true, '早报字段必须保留');

  const search = JSON.parse(read(path.join(root, 'data/search.json')));
  assert.equal(search.total, 5);
  const sa = search.items.find((x) => x.id === 'pbcA');
  assert.equal(sa.time, '2026-11-05T16:26:23.000+08:00');
});

test('幂等：第二次运行 moved=0，文件不再变化', async () => {
  const root = fixture();
  await backfillPbcDays({ root, asOf: AS_OF });
  const before = snapshot(root);
  const r2 = await backfillPbcDays({ root, asOf: AS_OF });
  assert.equal(r2.moved, 0);
  assert.equal(r2.updated, 0);
  assert.equal(r2.merged, 0);
  assert.deepEqual(snapshot(root), before);
});

test('只更新同一天内的时间，不移动文件', async () => {
  const root = tmpRoot();
  write(path.join(root, 'data/archive/2026-11-04.json'), {
    day: '2026-11-04',
    items: [pbc('pbcD', 'D 同日', 'https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/2026110415000000000/index.html',
      1793721600, '2026-11-04T00:00:00.000+08:00')],
  });
  const r = await backfillPbcDays({ root, asOf: AS_OF });
  assert.equal(r.moved, 0);
  assert.equal(r.updated, 1);
  assert.equal(r.timeOnly, 1);
  assert.equal(r.totalBefore, 1);
  assert.equal(r.totalAfter, 1);
});

test('缺少 --root 时拒绝运行', async () => {
  await assert.rejects(() => backfillPbcDays({ root: '' }), /必须显式传入 root/);
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts/backfill-pbc-days.mjs')], {
    cwd: ROOT, encoding: 'utf8',
  });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /必须显式传 --root/);
});
