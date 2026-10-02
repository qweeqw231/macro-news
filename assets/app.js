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
  async function renderQuotes() {
    const box = $('#quotes');
    try {
      const d = await jget('quotes.json');
      box.innerHTML = '';
      d.quotes.forEach((q) => {
        const up = q.changePct >= 0;
        const c = el('div', 'q');
        c.appendChild(el('div', 'q-name', q.name));
        c.appendChild(el('div', 'q-price', q.price.toLocaleString('zh-CN', { maximumFractionDigits: 4 })));
        c.appendChild(el('div', `q-chg ${up ? 'up' : 'down'}`, `${up ? '▲' : '▼'} ${Math.abs(q.changePct).toFixed(2)}%`));
        box.appendChild(c);
      });
      $('#quoteTime').textContent = '更新于 ' + new Date(d.generatedAt).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
      box.innerHTML = `<div class="skeleton">行情载入失败：${esc(e.message)}</div>`;
    }
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

  // ---------- 启动 ----------
  async function boot() {
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

    renderQuotes();
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
