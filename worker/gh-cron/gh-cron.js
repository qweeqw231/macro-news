/**
 * 宏观资讯台 · GitHub Actions 外部定时触发器
 * Cloudflare Worker + Cron Trigger
 *
 * 为什么需要它：
 *   GitHub 的 schedule 排程器对本仓库极不可靠 —— 实测 2026-10-04 ~ 10-30（26 天），
 *   collect.yml 声明每 5 分钟（后来每 15 分钟），实际每天只被触发 4~8 次，
 *   合计 144 次 / 26 天 ≈ 5.5 次/天（≈ 声明量的 3%）。
 *   改 cron 分钟数、加主备两条、错峰都改变不了这个比例。
 *   本 Worker 在 Cloudflare 的边缘节点上按时触发 workflow_dispatch，
 *   不依赖 GitHub 排程器，也不依赖你的电脑是否开机。
 *
 * ⚠ 部署在 Cloudflare 服务端执行，所以不受 workers.dev 在国内被 DNS 污染的影响
 *   （被污染的只是「从国内访问这个域名」，不影响到点自己往外发请求）。
 *
 * 环境变量（用 wrangler secret 或控制台 Variables 配置）：
 *   GITHUB_TOKEN  fine-grained PAT：Repository access 只选本仓库，
 *                 Permissions = Actions: Read and write（够用）
 *   REPO          可选，默认 qweeqw231/macro-news
 *   REF           可选，默认 main
 *
 * 部署：
 *   cd worker/gh-cron
 *   npx wrangler secret put GITHUB_TOKEN
 *   npx wrangler deploy
 *
 * 手动验证（部署完成后）：
 *   https://<你的子域>.workers.dev/run?run=collect   → 返回 {"key":"collect","status":204,"ok":true}
 */

const DEFAULT_REPO = 'qweeqw231/macro-news';

// ⚠ 这里只能写**文件名**，不能写完整路径 `.github/workflows/xxx.yml`。
//   实测：POST .../workflows/collect.yml/dispatches           -> 401（路由存在，需鉴权）
//         POST .../workflows/.github/workflows/collect.yml/... -> 404（路由不存在）
//   写完整路径会被 GitHub 当成多级路径，返回 400/404，且响应体为空 —— 很容易误判成 token 问题。
const WORKFLOWS = {
  collect: 'collect.yml',
  snapshot: 'snapshot.yml',
  klineMinute: 'kline-minute.yml',
  klineFull: 'kline-full.yml',
};

// 与 wrangler.toml 里的 crons 一一对应
const CRON_COLLECT = '7,22,37,52 * * * *';   // 每 15 分钟
const CRON_SNAPSHOT = '13,43 * * * *';       // 每 30 分钟
const CRON_HOURLY = '17 * * * *';            // 每小时（整点 17 分）

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// 把最近一次 dispatch 的结果写进 KV（只存状态码与错误原文，不含 token）
// 目的：workers.dev 在国内不可访问、wrangler tail 也被网络挡住，
//      没有这个落点就完全看不到「GitHub 到底返回了什么」。
async function record(env, data) {
  try {
    if (env.STATE) await env.STATE.put('last_dispatch', JSON.stringify(data));
  } catch (e) {
    console.log('KV 写入失败: ' + (e && e.message));
  }
}

async function dispatch(env, key) {
  const file = WORKFLOWS[key];
  if (!file) return { key, ok: false, error: 'unknown workflow key' };
  if (!env.GITHUB_TOKEN) return { key, ok: false, error: 'GITHUB_TOKEN 未配置' };

  const repo = env.REPO || DEFAULT_REPO;
  const ref = env.REF || 'main';
  const url = `https://api.github.com/repos/${repo}/actions/workflows/${file}/dispatches`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'macro-news-cron',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref }),
  });

  // 成功是 204 No Content
  const out = { key, status: res.status, ok: res.status === 204 };
  if (!out.ok) {
    try { out.error = (await res.text()).slice(0, 200); } catch { /* 忽略 */ }
  }
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    const tasks = [];

    if (event.cron === CRON_COLLECT) {
      tasks.push('collect');
    } else if (event.cron === CRON_SNAPSHOT) {
      tasks.push('snapshot');
    } else if (event.cron === CRON_HOURLY) {
      tasks.push('klineMinute');
      // 全量日K/日周月K 每天一次即可：每小时 :17 触发时，只在 UTC 04 点那一次带上
      if (new Date(event.scheduledTime).getUTCHours() === 4) tasks.push('klineFull');
    } else {
      // 未知 cron（比如后来改了表达式却没改这里）：保守地按采集处理
      tasks.push('collect');
    }

    const results = await Promise.all(tasks.map((t) => dispatch(env, t)));
    const payload = { at: new Date(event.scheduledTime).toISOString(), cron: event.cron, results };
    console.log(JSON.stringify(payload));
    await record(env, payload);
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return json({ ok: true, repo: env.REPO || DEFAULT_REPO, workflows: Object.keys(WORKFLOWS), hasToken: !!env.GITHUB_TOKEN });
    }
    const key = url.searchParams.get('run');
    if (key) {
      const r = await dispatch(env, key);
      await record(env, { at: new Date().toISOString(), manual: key, results: [r] });
      return json(r, r.ok ? 200 : 502);
    }
    return json({
      ok: true,
      routes: ['GET /health', 'GET /run?run=collect|snapshot|klineMinute|klineFull'],
      crons: [CRON_COLLECT, CRON_SNAPSHOT, CRON_HOURLY],
    });
  },
};
