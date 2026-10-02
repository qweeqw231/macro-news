// site/assets/app.js
// 宏观资讯台 · 前端逻辑
// 零框架，直接 fetch data/*.json 渲染。
// 搜索用 Fuse.js（延迟建索引，不阻塞首屏）。

(function () {
  'use strict';

  const DATA = 'data';   // 与 index.html 同级（GitHub Pages 从仓库根发布）
  const PAGE = 40;

  const S = {
    view: 'feed',
    filter: 'all',
    q: '',
    items: [],
    searchIdx: null,
    fuse: null,
    shown: PAGE,
    archive: null,
  };

  const $ = (s) => document.querySelector(s);
  const el = (t, c, txt) => {
    const n = document.createElement(t);
    if (c) n.className = c;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (m) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
    );

  async function jget(name) {
    const r = await fetch(`${DATA}/${name}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${name} HTTP ${r.status}`);
    return r.json();
  }

  // ---------- 时间显示 ----------
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const p = (n) => String(n).padStart(2, '0');
    const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return sameDay ? `今天 ${hm}` : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  }

  // ---------- 渲染：行情仪表盘 ----------
  const MARKET_LABEL = { CN: 'A股', HK: '港股', US: '美股', JP: '日本', EU: '欧洲', UK: '英国', KR: '韩国' };

  // 判断某市场当前是否处于交易时段（北京时间粗略判断，用于决定刷新频率）
  function isTrading(market, now = new Date()) {
    const wd = now.getDay();
    if (wd === 0 || wd === 6) return false;              // 周末休市
    const h = now.getHours() + now.getMinutes() / 60;
    const win = {
      CN: [9.5, 11.5, 13, 15],
      HK: [9.5, 12, 13, 16],
      JP: [8.5, 11.3, 12.5, 15],
      KR: [8.5, 11.3, 12.5, 15.3],
      SG: [9, 12, 13, 17],
      EU: [15, 23.5],                                   // 夏令时约 15:00-23:30
      UK: [14.5, 23],
      US: [21.5, 28],                                  // 含夏令时，覆盖 21:30-次日 4:00
    }[market];
    if (!win) return false;
    if (win.length === 4) {
      return (h >= win[0] && h < win[1]) || (h >= win[2] && h < win[3]);
    }
    return h >= win[0] && h < win[1];
  }

  function fmtNum(v, d = 2) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  let lastQuoteSig = '';
  async function renderQuotes() {
    const box = $('#quotes');
    try {
      const d = await jget('quotes.json');
      S.quotes = d.quotes;
      // 行情没变就不重绘，避免轮询时闪烁
      const sig = d.quotes.map((q) => q.key + q.price).join('|');
      if (sig === lastQuoteSig) return;
      lastQuoteSig = sig;

      box.innerHTML = '';
      const groups = new Map();
      d.quotes.forEach((q) => {
        if (!groups.has(q.market)) groups.set(q.market, []);
        groups.get(q.market).push(q);
      });

      for (const [mk, list] of groups) {
        const open = list.some((q) => isTrading(q.market));
        const g = el('div', 'mkt');
        const h = el('div', 'mkt-hd');
        h.appendChild(el('span', 'mkt-name', MARKET_LABEL[mk] || mk));
        h.appendChild(el('span', `mkt-state${open ? ' open' : ''}`, open ? '交易中' : '休市'));
        g.appendChild(h);

        const grid = el('div', 'mkt-grid');
        list.forEach((q) => {
          const up = (q.changePct || 0) >= 0;
          const card = el('a', 'q');
          card.href = '#';
          card.dataset.key = q.key;
          card.title = '查看 K 线图';
          const head = el('div', 'q-hd');
          head.appendChild(el('span', 'q-name', q.name));
          const px = el('span', `q-px ${up ? 'up' : 'down'}`, fmtNum(q.price));
          head.appendChild(px);
          card.appendChild(head);
          const chg = el('div', 'q-chg');
          const amt = (q.price || 0) - (q.prevClose || 0);
          chg.appendChild(el('span', up ? 'up' : 'down', `${up ? '▲' : '▼'} ${fmtNum(Math.abs(amt))}`));
          chg.appendChild(el('span', up ? 'up' : 'down', `  ${Math.abs(q.changePct || 0).toFixed(2)}%`));
          card.appendChild(chg);
          grid.appendChild(card);
        });
        g.appendChild(grid);
        box.appendChild(g);
      }

      $('#quoteTime').textContent = '更新于 ' + new Date(d.generatedAt).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      box.innerHTML = `<div class="skeleton">行情载入失败：${esc(e.message)}</div>`;
    }
  }

  // 交易时段内加快轮询，其余时间放慢
  function startQuotePolling() {
    const anyOpen = () =>
      (S.quotes || []).some((q) => isTrading(q.market));
    setInterval(async () => {
      if (anyOpen()) {
        await renderQuotes();
      }
    }, (CFG.POLL_SECONDS || 15) * 1000);
  }

  // ---------- 渲染：条目 ----------
  function itemNode(it) {
    const a = el('a', 'item');
    a.href = it.url || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const hd = el('div', 'item-hd');
    hd.appendChild(el('span', 'item-time', fmtTime(it.time)));
    hd.appendChild(el('span', `item-src${it.kind === 'official' ? ' official' : ''}`, it.source));
    hd.appendChild(el('span', 'item-time', it.channel || ''));
    a.appendChild(hd);
    a.appendChild(el('div', 'item-title', it.title));
    // RSS 源的 description 常与标题完全相同，重复显示没有意义
    const sum = (it.summary || '').trim();
    if (sum && sum !== it.title.trim()) a.appendChild(el('div', 'item-sum clamp', sum));
    return a;
  }

  function renderFeed() {
    const box = $('#feed');
    box.innerHTML = '';
    const list = S.items.slice(0, S.shown);
    if (!list.length) {
      box.appendChild(el('div', 'empty', S.q ? '没有匹配的条目' : '暂无数据，请先运行采集脚本'));
      $('#moreBtn').hidden = true;
      return;
    }
    list.forEach((it) => box.appendChild(itemNode(it)));
    $('#moreBtn').hidden = S.shown >= S.items.length;
  }

  function renderFilters() {
    const box = $('#filters');
    const counts = new Map();
    S.items.forEach((i) => {
      const k = i.channel || '其他';
      counts.set(k, (counts.get(k) || 0) + 1);
    });
    box.innerHTML = '';
    const mk = (label, key, n) => {
      const b = el('button', `fchip${S.filter === key ? ' on' : ''}`, `${label} ${n}`);
      b.onclick = () => { S.filter = key; S.shown = PAGE; renderFilters(); applyFilter(); };
      return b;
    };
    box.appendChild(mk('全部', 'all', S.items.length));
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, n]) => box.appendChild(mk(k, k, n)));
  }

  function applyFilter() {
    if (S.filter === 'all') return S.items;
    return S.items.filter((i) => (i.channel || '其他') === S.filter);
  }

  // ---------- 搜索 ----------
  let searchTimer = null;
  function onSearchInput(v) {
    clearTimeout(searchTimer);
    $('#qClear').hidden = !v;
    searchTimer = setTimeout(() => runSearch(v), 220);
  }

  async function runSearch(q) {
    S.q = q.trim();
    if (!S.q) {
      S.items = S.base || [];
      S.shown = PAGE;
      renderFilters();
      renderFeed();
      $('#qMeta').textContent = '';
      return;
    }
    if (!S.searchIdx) {
      $('#qMeta').textContent = '检索索引载入中…';
      try {
        const d = await jget('search.json');
        S.searchIdx = d.items;
        const build = () => {
          S.fuse = new window.Fuse(S.searchIdx, {
            includeScore: true, ignoreLocation: true,
            minMatchCharLength: 2, threshold: 0.4, distance: 100,
            keys: [
              { name: 'title', weight: 0.55 },
              { name: 'summary', weight: 0.3 },
              { name: 'source', weight: 0.1 },
              { name: 'channel', weight: 0.05 },
            ],
          });
          doSearch();
        };
        if (window.requestIdleCallback) window.requestIdleCallback(build, { timeout: 800 });
        else build();
      } catch (e) {
        $('#qMeta').textContent = '索引载入失败：' + e.message;
        return;
      }
    } else {
      doSearch();
    }
  }

  function doSearch() {
    if (!S.fuse) return;
    const res = S.fuse.search(S.q, { limit: 120 });
    S.items = res.map((r) => r.item);
    S.shown = PAGE;
    renderFilters();
    renderFeed();
    $('#qMeta').textContent = `命中 ${res.length} 条 · 在 ${S.searchIdx.length} 条归档中检索`;
  }

  // ---------- 视图切换 ----------
  function showView(v) {
    S.view = v;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
    ['feed', 'archive', 'sources', 'status'].forEach((k) => {
      $('#view-' + k).hidden = k !== v;
    });
    document.querySelector('.hd').classList.remove('nav-open');
    window.scrollTo(0, 0);
  }

  // ---------- 归档 ----------
  async function renderArchive() {
    const box = $('#days');
    box.innerHTML = '<div class="skeleton">载入中…</div>';
    try {
      if (!S.archive) S.archive = await jget('index.json');
      box.innerHTML = '';
      if (!S.archive.days.length) { box.appendChild(el('div', 'empty', '暂无归档')); return; }
      S.archive.days.forEach((d) => {
        const a = el('a', 'day');
        a.href = '#';
        a.appendChild(el('div', 'day-d', d.day));
        a.appendChild(el('div', 'day-n', d.count + ' 条'));
        a.onclick = (e) => { e.preventDefault(); openDay(d.day); };
        box.appendChild(a);
      });
    } catch (e) {
      box.innerHTML = `<div class="skeleton">载入失败：${esc(e.message)}</div>`;
    }
  }

  async function openDay(day) {
    showView('feed');
    const box = $('#feed');
    box.innerHTML = '<div class="skeleton">载入中…</div>';
    try {
      const d = await jget(`archive/${day}.json`);
      S.items = d.items;
      S.filter = 'all';
      S.q = '';
      $('#q').value = '';
      $('#qClear').hidden = true;
      S.shown = PAGE;
      renderFilters();
      renderFeed();
      $('#qMeta').textContent = `归档：${day} · ${d.items.length} 条`;
    } catch (e) {
      box.innerHTML = `<div class="skeleton">载入失败：${esc(e.message)}</div>`;
    }
  }

  // ---------- 来源 ----------
  async function renderSources() {
    const box = $('#sources');
    box.innerHTML = '<div class="skeleton">载入中…</div>';
    try {
      const [last, idx] = await Promise.all([jget('_last-run.json'), jget('index.json')]);
      const counts = new Map();
      idx.days.forEach((d) => counts.set(d.day, d.count));

      const n = (k) => {
        let c = 0;
        counts.forEach((v) => { c += v; });
        return c;
      };

      let rows = '';
      last.sources.forEach((s) => {
        rows += `<tr>
          <td>${esc(s.label)}</td>
          <td class="${s.ok ? 'ok' : 'bad'}">${s.ok ? '正常' : '失败'}</td>
          <td class="num">${s.count}</td>
          <td class="num">${s.ms} ms</td>
          <td style="color:var(--ink-mute);font-size:.85rem">${esc(s.error || '')}</td>
        </tr>`;
      });

      box.innerHTML = `
        <h2 style="font-size:1.2rem;margin:1.5rem 0 .5rem">数据源</h2>
        <div class="tbl-wrap"><table>
          <thead><tr><th>来源</th><th>状态</th><th class="num">本次条数</th><th class="num">耗时</th><th>错误</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>

        <h2 style="font-size:1.2rem;margin:1.75rem 0 .5rem">采集概况</h2>
        <div class="tbl-wrap"><table>
          <tbody>
            <tr><td>最近一次运行</td><td class="num">${new Date(last.startedAt).toLocaleString('zh-CN', { hour12: false })}</td></tr>
            <tr><td>总耗时</td><td class="num">${last.durationMs} ms</td></tr>
            <tr><td>本次新增</td><td class="num">${last.added} 条</td></tr>
            <tr><td>行情快照</td><td class="num">${last.quotes} 项</td></tr>
            <tr><td>库内总计</td><td class="num">${n()} 条 / ${idx.days.length} 天</td></tr>
          </tbody>
        </table></div>

        <div class="note">
          采集由 Windows 计划任务按固定周期运行 <code>node src/collect.mjs</code>，
          完全不占用 AI 对话上下文。脚本幂等，重复运行不会产生重复条目；
          单个源失败不影响其他源，失败原因见上表。
        </div>`;
    } catch (e) {
      box.innerHTML = `<div class="skeleton">载入失败：${esc(e.message)}</div>`;
    }
  }

  // ---------- 移动端汉堡 ----------
  function initBurger() {
    const hd = document.querySelector('.hd');
    const b = el('button', 'nav-burger');
    b.type = 'button';
    b.setAttribute('aria-label', '打开导航');
    b.innerHTML = '<span></span><span></span><span></span>';
    b.onclick = (e) => {
      e.stopPropagation();
      const on = hd.classList.toggle('nav-open');
      b.setAttribute('aria-label', on ? '关闭导航' : '打开导航');
    };
    hd.querySelector('.hd-in').appendChild(b);
  }

  // ---------- K线图 ----------
  const CFG = window.MACRO_CONFIG || { WORKER_URL: '', POLL_SECONDS: 15 };
  const PERIOD_LABEL = { '1d': '日K', '1w': '周K', '1M': '月K', '5m': '5分', '30m': '30分', '60m': '60分' };
  const NO_KLINE = new Set(['hs_tech', 'n225', 'dax', 'ukx', 'kospi']);
  let kChart = null;

  function openKline(key) {
    const q = (S.quotes || []).find((x) => x.key === key);
    const modal = $('#klineModal');
    modal.hidden = false;
    $('#kmName').textContent = q ? q.name : key;
    $('#kmPrice').textContent = q ? fmtNum(q.price) : '';
    $('#kmPrice').className = 'km-price ' + ((q?.changePct || 0) >= 0 ? 'up' : 'down');

    const periods = $('#kmPeriods');
    periods.innerHTML = '';
    Object.keys(PERIOD_LABEL).forEach((p) => {
      const b = el('button', 'pchip', PERIOD_LABEL[p]);
      b.onclick = () => loadKline(key, p);
      periods.appendChild(b);
    });

    if (!kChart) kChart = new window.KlineChart($('#kmCanvas'));
    loadKline(key, CFG.DEFAULT_PERIOD || '1d');
  }

  function closeKline() { $('#klineModal').hidden = true; }

  async function loadKline(key, period) {
    document.querySelectorAll('.pchip').forEach((b) => b.classList.remove('on'));
    const chip = [...document.querySelectorAll('.pchip')].find((b) => b.textContent === PERIOD_LABEL[period]);
    if (chip) chip.classList.add('on');

    const note = $('#kmNote');
    if (NO_KLINE.has(key)) {
      kChart.setData([]);
      note.textContent = '该指数暂无可用 K 线数据源（实时行情仍正常）。';
      return;
    }

    note.textContent = '加载中…';
    let bars = null;
    // 优先走 Worker 代理（可按需取任意周期 = 真·实时）
    if (CFG.WORKER_URL) {
      try {
        const r = await fetch(`${CFG.WORKER_URL}/kline?key=${key}&period=${period}&limit=250`);
        const j = await r.json();
        if (j.bars) bars = j.bars;
      } catch (e) { /* 代理不可用则回退 */ }
    }
    // 回退：本地预生成的日K
    if (!bars && period === '1d') {
      try {
        const r = await fetch(`data/kline/${key}.json`, { cache: 'no-store' });
        const j = await r.json();
        if (j.bars) bars = j.bars;
      } catch (e) { /* 忽略 */ }
    }

    if (!bars || !bars.length) {
      kChart.setData([]);
      note.textContent = CFG.WORKER_URL
        ? '加载失败：该周期无数据，或 Worker 代理未部署。'
        : '该周期需要配置 Cloudflare Worker 代理才能加载（当前仅有本地日K）。请在 assets/config.js 填入 WORKER_URL。';
      return;
    }
    kChart.setData(bars);
    note.textContent = `${bars.length} 根 · ${bars[0].t} → ${bars[bars.length - 1].t}` +
      (CFG.WORKER_URL ? ' · 实时代理' : ' · 本地日K快照');
  }

  function bindKline() {
    $('#kmClose').onclick = closeKline;
    $('#klineModal').onclick = (e) => { if (e.target.id === 'klineModal') closeKline(); };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#klineModal').hidden) closeKline();
    });
    // 指数卡片点击 → 打开K线
    $('#quotes').addEventListener('click', (e) => {
      const card = e.target.closest('.q');
      if (card && card.dataset.key) openKline(card.dataset.key);
    });
  }

  // ---------- 启动 ----------
  async function boot() {
    // file:// 下浏览器会拦截 fetch()，页面必然空白。
    // 与其让用户对着白屏发呆，不如直接说明原因和解决办法。
    if (location.protocol === 'file:') {
      document.body.innerHTML = `
        <div style="max-width:640px;margin:12vh auto;padding:2rem;font-family:system-ui,sans-serif;line-height:1.8">
          <h1 style="font-size:1.4rem;margin:0 0 1rem">需要通过本地服务器打开</h1>
          <p style="color:#555">本站通过 <code>fetch()</code> 读取 <code>data/</code> 目录下的数据文件，
          而浏览器在 <code>file://</code> 协议下会拦截 fetch（跨源安全限制），
          因此直接双击 <code>index.html</code> 必然是空白页 —— 这不是站点坏了。</p>
          <p style="color:#555">在项目根目录双击运行：</p>
          <pre style="background:#f5f3ec;padding:1rem;border-radius:6px;overflow-x:auto">start.cmd</pre>
          <p style="color:#555">或在命令行执行：</p>
          <pre style="background:#f5f3ec;padding:1rem;border-radius:6px;overflow-x:auto">node scripts\\serve.mjs</pre>
          <p style="color:#555">然后访问 <a href="http://127.0.0.1:8848/">http://127.0.0.1:8848/</a></p>
        </div>`;
      return;
    }

    bindKline();

    initBurger();
    document.querySelectorAll('.tab').forEach((t) => {
      t.onclick = () => {
        showView(t.dataset.view);
        if (t.dataset.view === 'archive') renderArchive();
        if (t.dataset.view === 'sources') renderSources();
        if (t.dataset.view === 'status') renderSources();
      };
    });
    $('#moreBtn').onclick = () => { S.shown += PAGE; renderFeed(); };
    $('#q').addEventListener('input', (e) => onSearchInput(e.target.value));
    $('#qClear').onclick = () => { $('#q').value = ''; onSearchInput(''); };

    renderQuotes().then(startQuotePolling);
    try {
      const d = await jget('latest.json');
      S.base = d.items;
      S.items = d.items;
      renderFilters();
      renderFeed();
      $('#ftMeta').textContent = `库内 ${d.total} 条 · 快照生成于 ${new Date(d.generatedAt).toLocaleString('zh-CN', { hour12: false })}`;
    } catch (e) {
      $('#feed').innerHTML = `<div class="empty">数据载入失败：${esc(e.message)}<br>请先运行 <code>node src/collect.mjs</code></div>`;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
