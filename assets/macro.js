// assets/macro.js
// 宏观视图数据层（2.36.0）：读 data/macro/index.json（列表）与 data/macro/<key>.json（单指标历史）。
//
// 为什么列表和历史分开：与 K 线一致 —— 行情卡读 quotes.json，点开才读 kline/<key>.json。
// 宏观 5 个序列合计约 780 KB，首屏没必要全下。
(function () {
  'use strict';

  const DIR = 'data/macro';
  const CACHE_MS = 10 * 60 * 1000;   // 宏观每天 16:30 才更新，10 分钟内复用
  let indexDoc = null;
  let indexAt = 0;
  let indexPromise = null;
  const seriesCache = new Map();     // key → { doc, at, promise }

  async function getJSON(url) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    return r.json();
  }

  function loadIndex(force) {
    if (!force && indexDoc && Date.now() - indexAt < CACHE_MS) return Promise.resolve(indexDoc);
    if (indexPromise) return indexPromise;
    indexPromise = getJSON(`${DIR}/index.json`)
      .then((d) => {
        indexDoc = d && Array.isArray(d.items) ? d : { items: [] };
        indexAt = Date.now();
        indexPromise = null;
        return indexDoc;
      })
      .catch((e) => {
        indexPromise = null;
        if (indexDoc) return indexDoc;   // 刷新失败沿用旧列表，不把页面弄空
        throw e;
      });
    return indexPromise;
  }

  function loadSeries(key, force) {
    const hit = seriesCache.get(key);
    if (!force && hit && hit.doc && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.doc);
    if (!force && hit && hit.promise) return hit.promise;
    const p = getJSON(`${DIR}/${key}.json`)
      .then((d) => {
        const doc = d && Array.isArray(d.bars) ? d : { key, bars: [] };
        seriesCache.set(key, { doc, at: Date.now(), promise: null });
        return doc;
      })
      .catch((e) => {
        seriesCache.delete(key);
        throw e;
      });
    seriesCache.set(key, { doc: hit && hit.doc, at: hit && hit.at, promise: p });
    return p;
  }

  const RANGES = [
    { id: '1y', label: '1年', days: 365 },
    { id: '3y', label: '3年', days: 365 * 3 },
    { id: '5y', label: '5年', days: 365 * 5 },
    { id: 'all', label: '全部', days: 0 },
  ];

  /** 时间键 → UTC 毫秒（月频 t='YYYY-MM' 取当月 1 日） */
  function tMs(t) {
    const s = String(t || '');
    if (/^\d{4}-\d{2}$/.test(s)) return Date.parse(`${s}-01T00:00:00Z`);
    return Date.parse(`${s}T00:00:00Z`);
  }

  /** 按区间切片；'all' 原样返回 */
  function sliceRange(bars, rangeId, nowMs) {
    const list = Array.isArray(bars) ? bars : [];
    const r = RANGES.find((x) => x.id === rangeId);
    if (!r || !r.days) return list.slice();
    const now = Number(nowMs) || Date.now();
    const from = now - r.days * 86400000;
    return list.filter((b) => tMs(b.t) >= from);
  }

  /** 该区间至少 2 个点才画（1 个点画不出趋势）；月频指标 1 年通常只有 12 个点，够用 */
  function rangeUsable(bars, rangeId, nowMs) {
    return sliceRange(bars, rangeId, nowMs).length >= 2;
  }

  function fmtNum(v, decimals) {
    const d = Number.isFinite(decimals) ? decimals : 2;
    return Number(v).toLocaleString('zh-CN', {
      minimumFractionDigits: d, maximumFractionDigits: d,
    });
  }

  function fmtValue(v, item) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
    const unit = (item && item.unit) || '';
    return fmtNum(Number(v), item && item.decimals) + unit;
  }

  /** 环比文案：% 类用 pp（百分点），亿元用原单位 + 百分比，PMI 用指数点 */
  function fmtChange(item) {
    const a = item && item.latest && Number(item.latest.v);
    const b = item && item.prev && Number(item.prev.v);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const diff = a - b;
    const unit = (item && item.unit) || '';
    const dec = Number.isFinite(item.decimals) ? item.decimals : 2;
    const sign = diff > 0 ? '+' : (diff < 0 ? '' : '±');
    let text;
    if (unit === '%') {
      text = `${sign}${diff.toFixed(2)}pp`;
    } else if (unit === '') {
      text = `${sign}${diff.toFixed(dec)}`;
    } else {
      text = `${sign}${fmtNum(diff, dec)}${unit}`;
      if (b) text += `（${diff >= 0 ? '+' : ''}${((diff / b) * 100).toFixed(2)}%）`;
    }
    return { text, dir: diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat'), diff };
  }

  /** 所属期文案：日频原样，月频 `2026-10` → `2026年10月` */
  function fmtPeriod(t, freq) {
    const s = String(t || '');
    if (freq === 'M' && /^\d{4}-\d{2}$/.test(s)) {
      return `${s.slice(0, 4)}年${Number(s.slice(5, 7))}月`;
    }
    return s;
  }

  /** 图下口径说明 */
  function noteOf(item) {
    if (!item) return '';
    if (item.key === 'margin') {
      return '两融余额：沪深两市融资融券余额合计（亿元）。交易所 T+1 晚间发布，最新一条通常滞后一个交易日。';
    }
    if (item.key === 'us10y') {
      return '10Y 美债收益率（%）：美国 10 年期国债到期收益率，美股收盘后定稿（北京时间次日凌晨）。';
    }
    if (item.key === 'social_financing') {
      return '社融增量：当月社会融资规模增量（亿元），是月度流量、不是存量；正值表示当月净增。';
    }
    if (item.key === 'cpi') return 'CPI 同比：全国居民消费价格指数同比涨幅（%），所属期为统计月份。';
    if (item.key === 'pmi') return '制造业 PMI：国家统计局制造业采购经理指数，50 为荣枯线；所属期为统计月份。';
    return '';
  }

  window.MacroData = {
    RANGES, loadIndex, loadSeries, sliceRange, rangeUsable,
    fmtValue, fmtChange, fmtPeriod, noteOf, tMs,
  };
})();
