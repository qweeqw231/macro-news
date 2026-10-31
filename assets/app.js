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
    total: 0,        // 库内总条数（用于标注当前列表的母集）
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

  async function jget(name, cache) {
    // ⚠ 检索索引（几 MB）用默认缓存：Pages 的 cache-control 是 max-age=600，
    //   10 分钟内刷新页面可以直接复用浏览器缓存，不用再拉一次几 MB。
    const r = await fetch(`${DATA}/${name}`, { cache: cache || 'no-store' });
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
  // CMDTY / SGE / FX 是组合行情链路的三个新市场（快照回退时才会出现）
  // ETF 是场内 ETF 的独立分组（32 只，market='ETF'）
  const MARKET_LABEL = {
    CN: 'A股', HK: '港股', US: '美股', JP: '日本', EU: '欧洲', UK: '英国', KR: '韩国',
    CMDTY: '大宗商品', SGE: '上海金', FX: '外汇', ETF: '场内ETF',
  };

  // 交易时段判断（北京时间；小时可 >24 表示跨零点，如美股 21:30–次日 04:00）
  function inRange(h, a, b) {
    return b <= 24 ? (h >= a && h < b) : (h >= a || h < b - 24);
  }
  function isTrading(market, now = new Date()) {
    const wd = now.getDay();
    const h = now.getHours() + now.getMinutes() / 60;
    if (wd === 0) return false;                          // 周日休市
    // 有夜盘的品种：周六凌晨仍算「周五夜盘」（上海金夜盘到次日 02:30）
    if (wd === 6 && !(market === 'SGE' && h < 2.5)) return false;
    const win = {
      CN: [9.5, 11.5, 13, 15],
      ETF: [9.5, 11.5, 13, 15],                          // 场内 ETF 与 A 股同时段
      HK: [9.5, 12, 13, 16],
      JP: [8.5, 11.3, 12.5, 15],
      KR: [8.5, 11.3, 12.5, 15.3],
      SG: [9, 12, 13, 17],
      EU: [15, 23.5],                                   // 夏令时约 15:00-23:30
      UK: [14.5, 23],
      US: [21.5, 28],                                  // 含夏令时，覆盖 21:30-次日 4:00
      // 上海金：09:00-11:30 / 13:30-15:30 / 20:00-次日 02:30（夜盘归属下一交易日）
      SGE: [9, 15.5, 20, 26.5],
    }[market];
    if (!win) return false;
    if (win.length === 4) {
      return inRange(h, win[0], win[1]) || inRange(h, win[2], win[3]);
    }
    return inRange(h, win[0], win[1]);
  }

  function fmtNum(v, d = 2) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  let lastQuoteSig = '';
  async function renderQuotes() {
    const box = $('#quotes');
    let quotes = null;
    let generatedAt = null;
    let realtime = false;
    let localQuotes = null;
    let localGeneratedAt = null;

    // 优先直连东方财富实时行情（国内可达、带 CORS），失败再回退本地采集快照
    if (window.MarketData) {
      try {
        const live = await window.MarketData.fetchQuotes();
        if (live && live.length) {
          quotes = live;
          generatedAt = new Date().toISOString();
          realtime = true;
        }
      } catch (e) { /* 直连失败，走本地快照 */ }
    }
    // 本地快照始终读一次：直连行情只覆盖指数+ETF，
    // 组合行情（ndx/xau/sge/usdcny/cgb）与「云端补采的 ETF」都在 quotes.json 里。
    // 合并后两者同屏，且不会出现「实时模式下反而看不到某些标的」。
    try {
      const d = await jget('quotes.json');
      if (d && Array.isArray(d.quotes)) {
        localQuotes = d.quotes;
        localGeneratedAt = d.generatedAt || null;
      }
    } catch (e) { /* 本地快照不可用 */ }

    if (!quotes) {
      if (!localQuotes) {
        box.innerHTML = '<div class="skeleton">行情载入失败：实时源与本地快照均不可用</div>';
        return;
      }
      quotes = localQuotes;
      generatedAt = localGeneratedAt;
    } else if (localQuotes) {
      const seen = new Set(quotes.map((q) => q.key));
      const extra = localQuotes.filter((q) => !seen.has(q.key));
      if (extra.length) quotes = [...quotes, ...extra];
    }

    S.quotes = quotes;
    S.quotesRealtime = realtime;
    // 行情没变就不重绘，避免轮询时闪烁
    const sig = quotes.map((q) => q.key + q.price).join('|');
    if (sig === lastQuoteSig) return;
    lastQuoteSig = sig;

    // 用 fragment 一次性替换：`innerHTML=''` 再逐个 append 会让仪表盘在渲染过程中
    // 高度塌成 0（既闪一下，又把「视口对齐」的基准位置弄乱）
    const frag = document.createDocumentFragment();
    const groups = new Map();
    quotes.forEach((q) => {
      if (!groups.has(q.market)) groups.set(q.market, []);
      groups.get(q.market).push(q);
    });

    // A 股置顶；场内 ETF 紧随其后
    const ORDER = ['CN', 'ETF', 'HK', 'US', 'JP', 'EU', 'UK', 'KR', 'CMDTY', 'SGE', 'FX'];
    [...groups.keys()]
      .sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
      .forEach((mk) => {
        const list = groups.get(mk);
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
        frag.appendChild(g);
      });
    box.replaceChildren(frag);

    $('#quoteTime').textContent =
      '更新于 ' + new Date(generatedAt).toLocaleString('zh-CN', { hour12: false }) +
      (realtime ? ' · 实时' : ' · 本地快照');
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
  function itemNode(it, idx) {
    const a = el('article', 'item');
    a.tabIndex = 0;
    a.setAttribute('role', 'button');
    a.setAttribute('aria-label', `阅读：${it.title || ''}`);
    a.onclick = () => openReader(idx);
    a.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openReader(idx); }
    };
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
    // ⚠ 必须在这里应用频道筛选。之前 applyFilter() 的返回值被直接丢掉，
    //   点「全球」只是把 chip 高亮，列表纹丝不动。
    const visible = applyFilter();
    S.visible = visible;   // 阅读器的上下条也走这份顺序，否则筛选后下标会错位
    const list = visible.slice(0, S.shown);
    if (!list.length) {
      const msg = S.q ? '没有匹配的条目'
        : (S.filter === 'all' ? '暂无数据，请先运行采集脚本' : '该频道暂无条目');
      box.appendChild(el('div', 'empty', msg));
      $('#moreBtn').hidden = true;
      return;
    }
    list.forEach((it, i) => box.appendChild(itemNode(it, i)));
    $('#moreBtn').hidden = S.shown >= visible.length;
  }

  // ---------- 站内阅读器 ----------
  let readerIdx = -1;

  function fmtFullTime(iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('zh-CN', { hour12: false });
  }

  function openReader(idx) {
    const list = S.visible || S.items;
    if (idx < 0 || idx >= list.length) return;
    readerIdx = idx;
    renderReader();
    $('#readerModal').hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeReader() {
    readerIdx = -1;
    $('#readerModal').hidden = true;
    document.body.style.overflow = '';
  }

  // 搜索结果来自 search.json —— 只有 title + summary，**没有正文**；
  // 完整正文存在按天的归档文件里（content 最多 4000 字）。
  // 所以打开一条没有正文的条目时，按日期去 data/archive/YYYY-MM-DD.json 取全文（带缓存）。
  const dayCache = new Map();

  async function fetchFullItem(it) {
    if (!it) return it;
    if ((it.content || '').trim()) return it;
    const day = String(it.time || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return it;
    try {
      let items = dayCache.get(day);
      if (!items) {
        const d = await jget(`archive/${day}.json`);
        items = d.items || [];
        dayCache.set(day, items);
      }
      const full = items.find((x) => x.id === it.id);
      return full || it;
    } catch (e) {
      return it;
    }
  }

  function renderReader() {
    const list = S.visible || S.items;
    const it = list[readerIdx];
    if (!it) return;
    $('#rdSource').textContent = it.source || '';
    $('#rdTime').textContent = fmtFullTime(it.time);
    $('#rdChannel').textContent = it.channel || '';
    $('#rdTitle').textContent = it.title || '';

    const body = $('#rdBody');
    body.innerHTML = '';
    const text = (it.content || it.summary || '').trim();
    if (text) {
      text.split(/\r?\n+/).map((p) => p.trim()).filter(Boolean)
        .forEach((p) => body.appendChild(el('p', null, p)));
    } else {
      body.appendChild(el('p', 'rd-empty', '本条仅有标题，暂无正文内容，可点击「阅读原文」查看。'));
    }

    // 缺正文（多半是搜索命中）→ 异步从归档补齐后重绘
    if (!(it.content || '').trim()) {
      const cur = readerIdx;
      fetchFullItem(it).then((full) => {
        if (readerIdx !== cur || !S.items[cur] || full === it) return;
        S.items[cur] = full;
        renderReader();
      });
    }

    const link = $('#rdLink');
    if (it.url) { link.href = it.url; link.hidden = false; } else { link.hidden = true; }
    $('#rdPrev').disabled = readerIdx <= 0;
    $('#rdNext').disabled = readerIdx >= list.length - 1;
    body.scrollTop = 0;
    $('#readerModal').querySelector('.rd-box').scrollTop = 0;
  }

  function stepReader(d) {
    const n = readerIdx + d;
    if (n < 0 || n >= (S.visible || S.items).length) return;
    readerIdx = n;
    renderReader();
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
      b.onclick = () => { S.filter = key; S.shown = PAGE; renderFilters(); renderFeed(); };
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

  // 检索索引 `data/search.json` 有 6~10MB（gzip 后 ~2.7MB），
  // 从 GitHub Pages 拉一次要**几十秒到几分钟**（本机实测带宽 5~30 KB/s）。
  // ⇒ 在要闻流加载完之后**后台预取**：用户敲关键词时通常已经就绪；
  //   还没好时 qMeta 显示「检索索引载入中…」。
  let searchIdxPromise = null;
  function ensureSearchIndex() {
    if (S.searchIdx) return Promise.resolve(S.searchIdx);
    if (!searchIdxPromise) {
      searchIdxPromise = jget('search.json', 'default')
        .then((d) => {
          S.searchIdx = d.items || [];
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
          return S.searchIdx;
        })
        .catch((e) => { searchIdxPromise = null; throw e; });
    }
    return searchIdxPromise;
  }

  async function runSearch(q) {
    S.q = q.trim();
    closeReader();
    if (!S.q) {
      S.items = S.base || [];
      S.shown = PAGE;
      renderFilters();
      renderFeed();
      // 标注母集：空搜索时列表是「最新快照」，检索却覆盖全库 —— 不写清楚，
      // 同一个分类会出现「带关键词的条数 > 不带的条数」这种看起来自相矛盾的数字。
      $('#qMeta').textContent =
        `最新快照 ${(S.base || []).length} 条` +
        (S.total ? ` · 库内共 ${S.total} 条（输入关键词可检索全库）` : '');
      return;
    }
    if (!S.searchIdx) {
      $('#qMeta').textContent = '检索索引载入中…（首次检索要下载索引，请稍候）';
      try {
        // ⚠ 别用 requestIdleCallback：用户已经在等搜索结果了，等「空闲」反而更慢
        //   （而且 requestIdleCallback 在后台标签页里可能迟迟不触发 → 搜索看起来「没反应」）
        await ensureSearchIndex();
        doSearch();
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
    closeReader();
    // ⚠ **不要设 limit**：以前写死 `limit: 120` 会把结果**静默截断**，
    //   于是「命中 120 条」其实是「至多 120 条」—— 真实命中更多时这个数字是假的
    //   （「加息」实测真实命中 185 条，界面却显示 120）。
    const res = S.fuse.search(S.q);
    S.items = res.map((r) => r.item);
    S.shown = PAGE;
    renderFilters();
    renderFeed();
    $('#qMeta').textContent = `全库 ${S.searchIdx.length} 条中命中 ${res.length} 条`;
  }

  // ---------- 视图切换 ----------
  // 视图与 URL 的 hash 一一对应（#view-feed / #view-market / #view-archive / #view-sources）：
  //   · 页签是真链接，点一下 URL 就变 —— 有即时反馈，也能收藏/分享某个视图；
  //   · 即使 app.js 还没加载完，点下去也会跳到对应区块，而不是毫无反应。
  const VIEWS = ['feed', 'market', 'archive', 'sources'];

  // ---------- 视图切换后的视口对齐 ----------
  //
  // ⚠ 为什么不能「算一次位置就滚」：
  //   页面总高度是**异步变化**的。宏观仪表盘的行情卡要等
  //   「东财直连 + 本地 quotes.json」都回来才渲染（实测 5~10 秒都可能），
  //   渲染完会把下面所有区块整体往下推 ⇒ 切换瞬间算好的目标位置当场失效。
  //   实测症状：**第一次**点「归档」停在仪表盘中段（差了 588px），
  //   等行情渲染完再点第二次才对。
  //
  // ⚠ 而且切换瞬间**页面可能还不够高**（板块还是空的、文档比视口还矮），
  //   这时 `scrollTo` 会被浏览器钳到 0 —— 只能等页面长出来之后再对齐。
  //
  // 对策：用 `ResizeObserver` **常驻**盯着 body 尺寸，
  //   尺寸一变就重新对齐（**不设时间窗**：行情渲染快则 1 秒、慢则 10 秒，
  //   任何固定窗口都会漏）。用户自己滚了就停手，不抢方向盘。
  let alignRO = null;
  let alignState = null;

  function initAlign() {
    // 用户自己滚了 → 本次视图的自动纠偏停手（否则布局一变就把人拽回去）
    const onUser = () => { if (alignState) alignState.userMoved = true; };
    window.addEventListener('wheel', onUser, { passive: true });
    window.addEventListener('touchmove', onUser, { passive: true });
    window.addEventListener('keydown', onUser);

    alignRO = new ResizeObserver(() => {
      const st = alignState;
      if (!st || st.userMoved) return;
      const y = Math.max(0, st.sec.getBoundingClientRect().top + window.scrollY - 72);
      if (Math.abs(y - st.last) < 4) return;
      st.last = y;
      // 用瞬时定位而不是 smooth：smooth 会和正在进行的动画互相打架
      window.scrollTo({ top: y, behavior: 'auto' });
    });
    alignRO.observe(document.body);
  }

  function alignToView(v, instant) {
    const sec = $('#view-' + v);
    if (!sec) return;
    // 目标 = 该区块的绝对位置 - sticky 顶栏高度
    const target = () => Math.max(0, sec.getBoundingClientRect().top + window.scrollY - 72);
    alignState = { sec, userMoved: false, last: target() };
    window.scrollTo({ top: target(), behavior: instant ? 'auto' : 'smooth' });
  }

  function viewFromHash() {
    const m = String(location.hash || '').match(/^#view-(feed|market|archive|sources)$/);
    return m ? m[1] : null;
  }

  function showView(v, instant) {
    S.view = v;
    closeReader();
    document.querySelectorAll('.tab, .mnav-item').forEach((t) => {
      const on = t.dataset.view === v;
      t.classList.toggle('active', on);
      if (on) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    VIEWS.forEach((k) => {
      $('#view-' + k).hidden = k !== v;
    });
    // ⚠ 必须滚到**该视图的区块**，不能 `scrollTo(0,0)`：
    //   宏观仪表盘是常驻在页面顶部的，四个视图的内容都在它下面。
    //   滚回顶部 ⇒ 切换后画面还是仪表盘 ⇒ 用户看到「四个页签一模一样」、
    //   「点了没反应」。这里滚到区块顶部（避开 sticky 顶栏高度）。
    alignToView(v, instant);
    // URL 与视图保持同步（replaceState 不会触发 hashchange，不会造成循环）
    if (viewFromHash() !== v) history.replaceState(null, '', '#view-' + v);
    // 需要数据的视图在切过去时才去取（懒加载）
    if (v === 'archive') renderArchive();
    if (v === 'sources') renderSources();
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
    closeReader();
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

  // ---------- 来源 + 页脚概况 ----------
  // ⚠ 这两处共用同一份数据（`_last-run.json` + `index.json`），但**必须分别填各自的容器**：
  //   以前两个区块都写进了 `#sources`，而 `#status` 从来没被写过
  //   ⇒ 点「运行状态」永远是空白一片（看起来像"点了没反应"）。
  //   现在「运行状态」页签已取消，概况直接渲染到页脚（见 renderFoot）。
  let runMeta = null;
  async function loadRunMeta() {
    if (!runMeta) {
      const [last, idx] = await Promise.all([jget('_last-run.json'), jget('index.json')]);
      let total = 0;
      (idx.days || []).forEach((d) => { total += d.count || 0; });
      runMeta = { last: last || {}, total, days: (idx.days || []).length };
    }
    return runMeta;
  }

  async function renderSources() {
    const box = $('#sources');
    box.innerHTML = '<div class="skeleton">载入中…</div>';
    try {
      const { last } = await loadRunMeta();
      const srcs = last.sources || [];
      let rows = '';
      srcs.forEach((s) => {
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
        ${srcs.length ? `<div class="tbl-wrap"><table>
          <thead><tr><th>来源</th><th>状态</th><th class="num">本次条数</th><th class="num">耗时</th><th>错误</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>` : '<div class="note">没有可用的来源状态记录。</div>'}

        <div class="note">
          共 ${srcs.length} 个新闻源，每个源独立 try/catch —— <strong>单个源失败不影响其他源</strong>，
          失败原因见上表。状态与耗时是最近一次采集时的现场值，随当次网络状况波动。
        </div>`;
    } catch (e) {
      box.innerHTML = `<div class="skeleton">载入失败：${esc(e.message)}</div>`;
    }
  }

  // ---------- 页脚：采集概况 ----------
  //
  // ⚠ 这里原本是一个独立的「运行状态」页签，但它的内容就是页脚那一行 ⇒ 页签冗余，
  //   已按用户意见取消这个导航项（2026-10-29）。
  //   概况改为直接渲染到页脚，任何视图下都看得到。
  async function renderFoot() {
    const el = $('#ftMeta');
    try {
      const { last, total, days } = await loadRunMeta();
      const bits = [];
      if (last.startedAt) bits.push('最近一次采集 ' + new Date(last.startedAt).toLocaleString('zh-CN', { hour12: false }));
      if (last.durationMs != null) bits.push('耗时 ' + last.durationMs + ' ms');
      if (last.added != null) bits.push('本次新增 ' + last.added + ' 条');
      if (last.quotes != null) bits.push('行情快照 ' + last.quotes + ' 项');
      bits.push('库内 ' + total + ' 条 / ' + days + ' 天');
      el.textContent = bits.join(' · ');
    } catch (e) {
      // 运行状态读不到就退回快照信息（latest.json 那条）
      if (!el.textContent) el.textContent = '运行状态读取失败：' + esc(e.message);
    }
  }

  // ---------- K线图 ----------
  const CFG = window.MACRO_CONFIG || { POLL_SECONDS: 15, REFRESH_SECONDS: 20, DEFAULT_PERIOD: '1d' };
  const PERIOD_LABEL = {
    '1m': '1分', '5m': '5分', '15m': '15分', '30m': '30分', '60m': '60分',
    '1d': '日K', '1w': '周K', '1M': '月K', '1y': '年K',
  };
  // 日频标的（1Y国债收益率）可用的周期
  const DAILY_PERIODS = ['1d', '1w', '1M', '1y'];
  // 均线：日/周/月/分钟用 5/10/20/30/60/120/250；年K 只用 5/10/20/30（单位是年），
  // 且数据长度不足 n 根时，MA_n 及更长的均线不绘制、对应按钮置灰。
  const YEAR_MA = [5, 10, 20, 30];
  const MA_LIST = [5, 10, 20, 30, 60, 120, 250];
  const MA_STORE = 'macro.maShown';
  const loadMA = () => {
    try {
      const v = JSON.parse(localStorage.getItem(MA_STORE) || 'null');
      if (Array.isArray(v)) return new Set(v.filter((n) => MA_LIST.includes(n)));
    } catch (e) { /* 忽略损坏的本地状态 */ }
    return new Set(MA_LIST);
  };
  const maShown = loadMA();
  let kChart = null;
  let klineTimer = null;
  let klineKey = '';
  let klinePeriod = '1d';
  let maBars = 0;            // 当前周期数据的总根数：决定 MA_n 是否可画（0 = 数据还没到）
  // 请求令牌：每次取数 +1。
  // ⚠ 没有它会出两个 bug：
  //   ① 旧图残留 —— 图表是单例，切标的时画布还留着上一个标的的 K 线；
  //   ② 数据串台 —— 快速点 A→B 时，A 的响应后到会执行 setData(A的bars)，
  //      结果 **A 的 K 线显示在 B 的标题下**。
  // ⇒ 任何异步回来的结果，先校验令牌，过期的直接丢弃。
  let klineReqId = 0;

  // 「更全的结果到了」的等待器。
  // 直连链里各源到货时间不同（新浪 ~0.8s / 腾讯 ~1.4s / 东财可能挂到超时），
  // 在决定要不要去拉「服务端全量文件」之前，先给还在路上的源留一个宽限期，
  // 否则会在新浪还没到时就抢着去拉全量文件 —— 白耗 Pages 带宽（实测只有 7~20 KB/s）。
  let upgradeWaiters = [];
  const notifyUpgrade = () => {
    const w = upgradeWaiters;
    upgradeWaiters = [];
    w.forEach((fn) => fn());
  };
  const waitUpgrade = (ms) =>
    new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      upgradeWaiters.push(fin);
      setTimeout(fin, ms);
    });

  // 当前可用的均线 = （年K 只到 30）∩ 已开启 ∩ 数据根数足够
  const enabledMA = () =>
    (klinePeriod === '1y' ? YEAR_MA : MA_LIST)
      .filter((n) => maShown.has(n) && n <= maBars);

  function renderMA() {
    const box = $('#kmMA');
    if (!box) return;
    box.innerHTML = '';
    const isYear = klinePeriod === '1y';
    const list = isYear ? YEAR_MA : MA_LIST;
    list.forEach((n) => {
      const unavailable = n > maBars;
      const on = maShown.has(n) && !unavailable;
      const b = el('button', 'mchip' + (on ? ' on' : '') + (unavailable ? ' disabled' : ''), 'MA' + n);
      b.type = 'button';
      if (unavailable) {
        b.disabled = true;
        b.title = '当前数据只有 ' + maBars + ' 根，不足 ' + n + ' 根';
      } else {
        b.onclick = () => {
          if (maShown.has(n)) maShown.delete(n);
          else maShown.add(n);
          b.classList.toggle('on', maShown.has(n));
          try { localStorage.setItem(MA_STORE, JSON.stringify([...maShown])); } catch (e) { /* 忽略 */ }
          if (kChart) kChart.setMAEnabled(enabledMA());
        };
      }
      box.appendChild(b);
    });
    if (kChart) kChart.setMAEnabled(enabledMA());
  }

  function openKline(key) {
    const q = (S.quotes || []).find((x) => x.key === key);
    $('#klineModal').hidden = false;
    $('#kmName').textContent = q ? q.name : key;
    $('#kmPrice').textContent = q ? fmtNum(q.price) : '';
    $('#kmPrice').className = 'km-price ' + ((q?.changePct || 0) >= 0 ? 'up' : 'down');

    const periods = $('#kmPeriods');
    periods.innerHTML = '';
    // 1Y国债收益率是**逐日一条曲线**（中债只有日频），既没有分钟源也没有腾讯代码
    // ⇒ 分钟周期对它必然是空的，直接不渲染这几个页签，别让用户点了只得到一句「加载失败」
    const dailyOnly = key === 'cgb_1y';
    Object.keys(PERIOD_LABEL).forEach((p) => {
      if (dailyOnly && !DAILY_PERIODS.includes(p)) return;
      const b = el('button', 'pchip', PERIOD_LABEL[p]);
      b.dataset.period = p;
      b.onclick = () => loadKline(key, p);
      periods.appendChild(b);
    });

    if (!kChart) kChart = new window.KlineChart($('#kmCanvas'));
    else kChart.reset();              // ← 清掉上一个标的的图（残留 bug）
    renderMA();
    loadKline(key, CFG.DEFAULT_PERIOD || '1d');
    scheduleKlineRefresh();
  }

  function closeKline() {
    clearTimeout(klineTimer);
    $('#klineModal').hidden = true;
  }

  // ---- K线取数根数（按周期给到「源侧真实上限」，而不是一刀切 1000）----
  //   日K/周K/月K/年K → **20000**：东财 `lmt` **没有上限**，给多少给多少；新浪 `datalen` 同理。
  //   分钟级 → 2000：
  //     · 东财 5m 实测 1536 根、1m 只有当天 240 根；15/30/60m 也在千根量级
  //     · 新浪分钟固定 **1023 根**，但**指数和场内 ETF 都有**（东财对 ETF 只给最近一天）
  //     · 腾讯分钟 320 根
  //   ⇒ 给 2000，让每个源回到自己的上限，最后由 app.js 的 apply 取「最新且根数最多」的那条。
  const klineLimit = (period) =>
    (period === '1d' || period === '1w' || period === '1M' || period === '1y') ? 20000 : 2000;

  async function loadKline(key, period) {
    const myId = ++klineReqId;          // 请求令牌：过期响应一律丢弃
    klineKey = key;
    klinePeriod = period;
    // 年K 是「月K 聚合」出来的派生周期：取数一律取月K，落图前再聚合
    const isYear = period === '1y';
    const fetchPeriod = isYear ? '1M' : period;
    // 年K 的均线单位是「年」：只保留 5/10/20/30，且数据没到之前全部置灰
    document.querySelectorAll('.pchip').forEach((b) => b.classList.toggle('on', b.dataset.period === period));

    const note = $('#kmNote');
    note.textContent = '加载中…';
    kChart.setData([], period);          // ← 立刻清空画布，绝不留上一个标的的图
    maBars = 0;
    renderMA();

    // 落图入口。三个约束：
    //   ① 令牌过期 → 丢弃（修「A 的响应后到，盖在 B 的标题下」）；
    //   ② **根数变少的结果不覆盖已有的** —— 否则后到的 1000 根会把先到的 8000 根降级；
    //   ③ 根数相同时**直连优先于本地** —— 直连是刚抓的，本地是采集器的每日快照。
    let shown = 0;
    let shownRank = -1;                   // 0 = 本地，1 = 直连
    let shownLast = '';                   // 已落图的最后一根时间（分钟级按新鲜度比就靠它）
    const isMinute = () =>
      (window.MarketData.MINUTE_PERIODS || []).includes(period);
    const apply = (bars, src, rank) => {
      if (myId !== klineReqId) return false;
      if (!bars || !bars.length) return false;
      // ⚠ 分钟级的时间戳格式不统一：新浪是 `YYYY-MM-DD HH:MM:SS`，东财/腾讯是 `YYYY-MM-DD HH:MM`。
      //   直接字符串比较会出现「15:00:00 比 15:00 大」→ 先到的新浪数据反而挡住后到的东财。
      //   统一截到分钟再比。
      const last = isMinute()
        ? String(bars[bars.length - 1].t || '').slice(0, 16)
        : String(bars[bars.length - 1].t || '');
      if (isMinute()) {
        // ---- 分钟级：先比「最后一根时间」，再比根数 ----
        //   直连（东财）可能只有今天的几十根，本地快照有几百根但停在**上一次刷新**
        //   ⇒ 不能只按根数比，否则本地会把今天的实时数据盖掉。
        //   但多个直连源之间（东财 1536 / 新浪 1023 / 腾讯 320）最后一根时间通常一样，
        //   旧规则「同时间只看优先级」会让先到的腾讯 320 根赢掉新浪 1023 根 ⇒ 现在同时间比根数。
        if (shown && last < shownLast) return false;
        if (shown && last === shownLast) {
          if (bars.length < shown) return false;
          if (bars.length === shown && rank <= shownRank) return false;
        }
      } else {
        // ---- 日/周/月：按**根数**比（历史越长越好） ----
        if (bars.length < shown) return false;
        if (bars.length === shown && rank <= shownRank) return false;
      }
      shown = bars.length;
      shownRank = rank;
      shownLast = last;
      kChart.setData(bars, period);
      // 数据变长后，原本「根数不足」的均线会自动变为可用（按钮取消置灰、曲线开始绘制）
      maBars = bars.length;
      renderMA();
      // 口径说明（组合标的的代理品种）必须显示出来，不能让用户以为看到的就是报价源本身
      const caliber = window.MarketData.getKlineNote ? window.MarketData.getKlineNote(key) : '';
      const span = isYear
        ? `${String(bars[0].t).slice(0, 4)} → ${String(bars[bars.length - 1].t).slice(0, 4)}`
        : `${bars[0].t} → ${bars[bars.length - 1].t}`;
      note.textContent =
        `${bars.length} 根 · ${span} · ${src}` +
        (isYear && !/聚合/.test(src) ? '（由月K聚合）' : '') +
        (caliber ? ` · ${caliber}` : '');
      notifyUpgrade();
      return true;
    };

    // ---- 第 1 波：直连多源赛马（东财/新浪/腾讯 同时发）+ 本地快路径（走 Pages）----
    // 直连源走外网、本地文件走 GitHub Pages，两条路带宽互不争抢，谁先回先出图。
    // 本地那一路是**保险**：直连全挂时，它也能在 1~4 秒内给出一张图（近 4 年 / 1000 根）。
    window.MarketData.localKline(key, period)
      .then((bars) => apply(
        bars,
        isYear
          ? '本地预生成（月K聚合）'
          : isMinute()
            ? '本地预生成（分钟快照·服务端每小时刷新）'
            : '本地预生成（近 4 年）',
        0
      ))
      .catch(() => false);

    await window.MarketData
      .fetchKlineRemote(key, fetchPeriod, klineLimit(fetchPeriod), (bars, src) => apply(
        isYear ? window.MarketData.aggregateYear(bars) : bars, src, 1
      ))
      .catch(() => false);
    if (myId !== klineReqId) return;      // 期间用户已经切到别的标的/周期了

    // 年K 兜底：月K 取不到（例如中债只有日频）就用日K 聚合
    if (isYear && shown === 0) {
      try {
        await window.MarketData.fetchKlineRemote(key, '1d', 20000, (bars, src) =>
          apply(window.MarketData.aggregateYear(bars), src, 1));
      } catch (e) { /* 日K 也没有 */ }
      if (myId !== klineReqId) return;
    }

    // ---- 第 2 波：直连没给够根数 ⇒ 拉服务端预生成的全量日K ----
    // 宽限 3 秒：给可能更慢但更全的源留窗口，避免在它还在路上时白耗 Pages 带宽。
    if (period === '1d' && shown < 2000) {
      await waitUpgrade(3000);
      if (myId !== klineReqId) return;
      if (shown < 2000) {
        try {
          const bars = await window.MarketData.localFullKline(key, period);
          apply(bars, '本地全量（服务端预生成）', 0);
        } catch (e) { /* 没有全量文件 */ }
      }
    }

    if (myId === klineReqId && shown === 0) {
      // 分钟级若是「全网本来就没有同口径的分钟源」，要说清楚**为什么**，
      // 别让用户以为页面坏了（2026-10-30：伦敦金/布伦特原油属于这一类）。
      const minuteReason = isMinute() && window.MarketData.getMinuteUnavailableReason
        ? window.MarketData.getMinuteUnavailableReason(key)
        : '';
      if (minuteReason) {
        note.textContent = `无分钟级数据：${minuteReason}`;
      } else if (isMinute()) {
        // 有源、但直连被挡 + 本地快照还没生成（服务端每小时刷新，可能正在补齐）
        note.textContent =
          '加载失败：直连源此刻不可达，且本地分钟快照尚未生成（服务端每小时刷新，可能正在补齐）。';
      } else {
        note.textContent = '加载失败：直连与本地均无该周期数据（本地仅有日/周/月）。';
      }
    }
  }

  // 交易时段内自动刷新最新一根；只重设数据不重建图表，保留缩放位置
  function scheduleKlineRefresh() {
    clearTimeout(klineTimer);
    const q = (S.quotes || []).find((x) => x.key === klineKey);
    if (!q || !isTrading(q.market)) return;
    klineTimer = setTimeout(async () => {
      if ($('#klineModal').hidden) return;
      const myId = klineReqId;            // 期间是否换过标的/周期
      const isYear = klinePeriod === '1y';
      const fetchPeriod = isYear ? '1M' : klinePeriod;
      try {
        // ⚠ 用 onData 而不是等返回值：赛马链里**首个成功**只保证「有数据」，
        //   不保证是最全的（腾讯 1000 根可能先于新浪 8752 根到）。
        //   onData 让每个源到货都单独判断一次，谁根数多谁上。
        await window.MarketData.fetchKlineRemote(
          klineKey, fetchPeriod, klineLimit(fetchPeriod),
          (bars) => {
            if (myId !== klineReqId) return;   // 换过了，丢弃这次刷新
            const next = isYear ? window.MarketData.aggregateYear(bars) : bars;
            if (!next || !next.length) return;
            // ⚠ 只在「根数不减少」时覆盖：直连只给 1000 根时，不能把本地全量的 8752 根降级
            if (next.length >= kChart.bars.length) {
              kChart.setData(next, klinePeriod);
              maBars = next.length;
              renderMA();
            }
          }
        );
      } catch (e) { /* 单次失败忽略，下一轮再试 */ }
      scheduleKlineRefresh();
    }, (CFG.REFRESH_SECONDS || 20) * 1000);
  }

  function bindKline() {
    $('#kmClose').onclick = closeKline;
    // 故意不绑定「点击阴影关闭」：拖动 K 线时鼠标很容易移到画布外松手，
    // 会被当作点击蒙层而误退出。关闭只保留右上角 × 与 Esc。
    document.addEventListener('keydown', (e) => {
      if ($('#klineModal').hidden) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return; // 别抢输入框的按键
      if (e.key === 'Escape') { closeKline(); return; }
      // ←/→ 平移（鼠标拖动之外的第二条通路）
      if (e.key === 'ArrowLeft') { kChart.panBy(15); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { kChart.panBy(-15); e.preventDefault(); }
      // Ctrl/⌘ + + / - 缩放（不带修饰键也可以）
      // ⚠ 看最新时不锚定中心：否则「缩小到全部 → 再放大」会把视图锚到历史中点，
      //   最后一根直接被推到屏幕外（实测 offset 变成 455）。看最新时锚在右边缘（1）。
      const zoomAnchor = kChart.offset === 0 ? 1 : 0.5;
      if (e.key === '+' || e.key === '=') { kChart.zoomBy(1 / 1.2, zoomAnchor); e.preventDefault(); }
      else if (e.key === '-' || e.key === '_') { kChart.zoomBy(1.2, zoomAnchor); e.preventDefault(); }
    });
    // 指数卡片点击 → 打开K线（阻止 href="#" 默认跳回页首）
    $('#quotes').addEventListener('click', (e) => {
      const card = e.target.closest('.q');
      if (card && card.dataset.key) { e.preventDefault(); openKline(card.dataset.key); }
    });
  }

  // ---------- 启动 ----------
  function bindReader() {
    $('#rdClose').onclick = closeReader;
    $('#readerModal').onclick = (e) => { if (e.target.id === 'readerModal') closeReader(); };
    $('#rdPrev').onclick = () => stepReader(-1);
    $('#rdNext').onclick = () => stepReader(1);
    document.addEventListener('keydown', (e) => {
      if ($('#readerModal').hidden) return;
      if (e.key === 'Escape') closeReader();
      else if (e.key === 'ArrowLeft') stepReader(-1);
      else if (e.key === 'ArrowRight') stepReader(1);
    });
  }

  // 搜索框提示：手机上输入框只有 ~240px，长 placeholder 会被截断。
  // HTML 默认用短版（窄屏首帧就不会截断），桌面再换成完整提示。
  const Q_PLACEHOLDER_FULL = '全文检索：标题 / 摘要 / 来源（如：降息、CPI、黄金、原油）';
  const Q_PLACEHOLDER_SHORT = '搜索：降息、CPI、黄金…';
  const syncSearchPlaceholder = () => {
    const q = $('#q');
    if (!q) return;
    q.placeholder = window.matchMedia('(max-width: 640px)').matches
      ? Q_PLACEHOLDER_SHORT
      : Q_PLACEHOLDER_FULL;
  };

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
    bindReader();

    // 常驻的视口对齐观察器（必须在第一次 showView 之前装好）
    initAlign();
    document.querySelectorAll('.tab, .mnav-item').forEach((t) => {
      t.onclick = (e) => {
        // 阻止浏览器默认的锚点跳转：滚动位置由 showView() 统一控制
        // （要滚到该视图的区块顶部，而不是浏览器默认的锚点位置）。
        // hash 仍然用 replaceState 同步（URL 变了 → 有即时反馈、可收藏/分享）。
        e.preventDefault();
        showView(t.dataset.view);
      };
    });
    // 手动改 hash / 前进后退时也要跟着切视图
    window.addEventListener('hashchange', () => {
      const v = viewFromHash();
      if (v && v !== S.view) showView(v);
    });
    // 带着 #view-xxx 打开时直接进对应视图（instant：首帧不要看到平滑滚动）
    const initialView = viewFromHash();
    if (initialView) showView(initialView, true);
    $('#moreBtn').onclick = () => { S.shown += PAGE; renderFeed(); };
    $('#q').addEventListener('input', (e) => onSearchInput(e.target.value));
    $('#qClear').onclick = () => { $('#q').value = ''; onSearchInput(''); };
    syncSearchPlaceholder();
    window.addEventListener('resize', syncSearchPlaceholder);

    renderQuotes().then(startQuotePolling);
    try {
      const d = await jget('latest.json');
      S.base = d.items;
      S.items = d.items;
      S.total = d.total || (d.items || []).length;
      // 走一遍空搜索分支：首次加载就把「母集」说明写进 #qMeta
      // （空搜索 = 最新快照 200 条，带关键词 = 全库 17092 条），同时渲染筛选条与列表
      runSearch('');
      // 后台预取检索索引（大文件，几十秒）—— 用户第一次敲关键词时多半已经就绪
      ensureSearchIndex().catch(() => {});
      // 页脚先放快照信息（兜底），随后由 renderFoot() 换成完整的采集概况
      $('#ftMeta').textContent = `库内 ${d.total} 条 · 快照生成于 ${new Date(d.generatedAt).toLocaleString('zh-CN', { hour12: false })}`;
      renderFoot();
    } catch (e) {
      $('#feed').innerHTML = `<div class="empty">数据载入失败：${esc(e.message)}<br>请先运行 <code>node src/collect.mjs</code></div>`;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
