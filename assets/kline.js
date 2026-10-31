// assets/kline.js
// K线图组件（Canvas 手绘，零依赖）
// 视觉规范参照主流行情软件：红涨绿跌、十字光标、均线、成交量副图

// 均线颜色（与主流行情软件的可区分度优先）
const MA_COLOR = {
  5: '#f0a020', 10: '#2c5e8e', 20: '#8e44ad', 30: '#e91e63',
  60: '#16a085', 120: '#795548', 250: '#607d8b',
};

class KlineChart {
  constructor(root) {
    this.root = root;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'display:block;width:100%;touch-action:none;cursor:crosshair';
    root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.bars = [];
    this.hover = -1;
    this.barsShown = 90;
    this.offset = 0;          // 右侧回看的根数：0 = 显示到最新
    this.dragging = false;
    this.period = '1d';       // 周期：决定横轴刻度格式与年份标记
    this._anim = null;        // 缩放动画的 requestAnimationFrame id
    this._zoomTarget = this.barsShown; // 连续缩放时的目标根数（避免动画中反复重算基准）
    // 均线：5/10/20/30/60/120/250，可在弹窗里逐条开关（年K 不画均线）
    this.maEnabled = new Set([5, 10, 20, 30, 60, 120, 250]);
    // 触屏状态：双指缩放 / 单指拖动 / 双击回最新 / 单击看明细
    this._pinch = null;
    this._lastTap = null;
    this._touchStart = null;
    this._touchMoved = false;
    this._coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    this._bind();
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(root);
  }

  destroy() {
    cancelAnimationFrame(this._anim);
    clearTimeout(this._animEnd);
    this._ro.disconnect();
    document.removeEventListener('mousemove', this._onDocMove);
    document.removeEventListener('mouseup', this._onDocUp);
    this.canvas.remove();
  }

  setData(bars, period) {
    cancelAnimationFrame(this._anim);
    clearTimeout(this._animEnd);
    this.bars = bars || [];
    if (period) this.period = period;
    this.offset = Math.max(0, Math.min(this.offset, this._maxOffset()));
    this._zoomTarget = this.barsShown;
    this.render();
  }

  setMAEnabled(list) {
    this.maEnabled = new Set((list || []).filter((n) => n >= 2));
    this.render();
  }

  /**
   * 清空画面并复位视图状态。
   *
   * ⚠ 切换标的时必须调用：图表实例是**单例**（app.js 里 `if (!kChart) kChart = new KlineChart(...)`），
   *   不清的话，新标的的标题会配上**上一个标的的 K 线**（用户报「上一轮打开的图会残留」）。
   */
  reset() {
    this.setData([], this.period);
    this.offset = 0;
    this.barsShown = 90;
    this.hover = -1;
    this.mouse = null;
    this._zoomTarget = 90;
  }

  _bind() {
    const cvs = this.canvas;
    const pos = (e) => {
      const r = cvs.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };
    const inPlot = (y) => this._h && y >= 0 && y <= this._h * 0.78;

    // 开始拖动：整块画布都可按下（不限于价格区），只要还有可回看的根数
    const startDrag = (clientX) => {
      if (!this.bars.length || this._maxOffset() <= 0) return false;
      const r = cvs.getBoundingClientRect();
      this.dragging = true;
      this.dragX = clientX - r.left;
      this.dragOffset = this.offset;
      this.hover = -1;
      this.mouse = null;
      cvs.style.cursor = 'grabbing';
      console.log(`[kline] 拖动开始 · 共 ${this.bars.length} 根 · 可回看 ${this._maxOffset()} 根`);
      return true;
    };

    const moveDrag = (clientX) => {
      if (!this.dragging) return;
      const r = cvs.getBoundingClientRect();
      const x = clientX - r.left;
      const bw = (this._w - this._pad.l - this._pad.r) / this._barsShown();
      const delta = Math.round((this.dragX - x) / bw);
      const next = Math.max(0, Math.min(this._maxOffset(), this.dragOffset + delta));
      if (next !== this.offset) {
        this.offset = next;
        this.render();
      }
    };

    const endDrag = () => {
      if (!this.dragging) return;
      this.dragging = false;
      this.render();
    };

    // —— 鼠标：整块弹窗上按下，document 上移动/松开 ——
    // 这是最经典可靠的拖拽写法：不依赖 setPointerCapture，鼠标移出画布也不会中断。
    // ⚠ 按下区域从 canvas 放宽到整个弹窗：用户把鼠标拖出画布再松手后，
    //   下一次「向右拖回最新」往往落在弹窗阴影里；只绑 canvas 的话按下去毫无反应，
    //   表现就是「最后一根再也拖不回来了」（2026-10-31 实测复现）。
    //   按钮/链接（关闭、周期切换）不抢事件。
    const dragSurface = cvs.closest('.kline-modal') || cvs;
    dragSurface.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button, a, input, textarea, select')) return;
      if (startDrag(e.clientX)) e.preventDefault();
    });
    this._onDocMove = (e) => moveDrag(e.clientX);
    this._onDocUp = endDrag;
    document.addEventListener('mousemove', this._onDocMove);
    document.addEventListener('mouseup', this._onDocUp);

    // 悬停十字光标（仅在价格区、且未拖动时；音量副图/底部区域不显示）
    cvs.addEventListener('mousemove', (e) => {
      if (this.dragging || !this._h) return;
      const p = pos(e);
      const n = this._barsShown();
      if (!n || !inPlot(p.y)) {
        if (this.hover !== -1) { this.hover = -1; this.mouse = null; this.render(); }
        return;
      }
      const bw = (this._w - this._pad.l - this._pad.r) / n;
      const i = Math.round((p.x - this._pad.l) / bw - 0.5);
      this.hover = Math.max(0, Math.min(n - 1, i));
      this.mouse = { x: p.x, y: p.y };
      this.render();
    });
    cvs.addEventListener('mouseleave', () => {
      if (this.dragging) return;
      if (this.hover !== -1) { this.hover = -1; this.mouse = null; this.render(); }
    });

    // 双击回到最新
    cvs.addEventListener('dblclick', () => {
      this.offset = 0;
      this.render();
    });

    // —— 触屏：单指平移 / 双指缩放 / 双击回最新 / 单击看明细 ——
    const tdist = (a, b) => Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
    const pinchAnchorOf = (e) => {
      const r = cvs.getBoundingClientRect();
      const mid = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
      const plotW = (this._w - this._pad.l - this._pad.r) || 1;
      return Math.max(0, Math.min(1, (mid - this._pad.l) / plotW));
    };
    const startPinch = (e) => {
      this.dragging = false;
      this.hover = -1;
      this._lastTap = null;
      this._touchStart = null;
      this._pinch = {
        dist: tdist(e.touches[0], e.touches[1]),
        shown: this._barsShown(),
        anchor: pinchAnchorOf(e),
      };
      if (e.cancelable) e.preventDefault();
    };

    cvs.addEventListener('touchstart', (e) => {
      this._coarse = true;   // 混合设备（触摸本 + 鼠标）以「真实用过触摸」为准
      if (e.touches.length >= 2) { startPinch(e); return; }
      this._pinch = null;
      this._touchMoved = false;
      this._touchStart = {
        x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(),
      };
      if (startDrag(e.touches[0].clientX) && e.cancelable) e.preventDefault();
    }, { passive: false });

    cvs.addEventListener('touchmove', (e) => {
      if (e.touches.length >= 2) {
        if (!this._pinch) startPinch(e);
        // 双指捏合：两指距离变大 = 放大（显示的根数变少），锚点固定在双指中点
        const d = tdist(e.touches[0], e.touches[1]);
        this.zoomTo(this._pinch.shown * (this._pinch.dist / d), this._pinch.anchor, false);
        if (e.cancelable) e.preventDefault();
        return;
      }
      if (this._touchStart) {
        const dx = e.touches[0].clientX - this._touchStart.x;
        const dy = e.touches[0].clientY - this._touchStart.y;
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) this._touchMoved = true;
      }
      if (this.dragging) moveDrag(e.touches[0].clientX);
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    cvs.addEventListener('touchend', (e) => {
      if (this._pinch) {
        if (e.touches.length >= 2) return;
        this._pinch = null;
        this.dragging = false;
        this._touchStart = null;
        this.render();
        return;
      }
      endDrag();
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) { this._touchStart = null; return; }
      const now = performance.now();
      if (!this._touchMoved && this._touchStart && now - this._touchStart.t < 300) {
        const prev = this._lastTap;
        if (prev && now - prev.t < 320 && Math.abs(t.clientX - prev.x) < 32) {
          // 双击：回到最新（触屏上 dblclick 不可靠，自己判）
          this.offset = 0;
          this.hover = -1;
          this._lastTap = null;
          this.render();
        } else {
          this._lastTap = { t: now, x: t.clientX };
          // 单击：把十字光标/明细浮窗钉在点击的那根上（触屏没有 hover）
          this.showPointAt(t.clientX, t.clientY);
        }
      } else {
        this._lastTap = null;
      }
      this._touchStart = null;
    });

    cvs.addEventListener('touchcancel', () => {
      this._pinch = null;
      this.dragging = false;
      this._touchStart = null;
    });

    // 滚轮缩放：上滚放大、下滚缩小；以光标位置为锚点平滑过渡。
    // Ctrl+滚轮同为缩放，并阻止浏览器整页缩放（Ctrl+滚轮默认会缩放整个页面）
    cvs.addEventListener('wheel', (e) => {
      e.preventDefault();
      const pad = this._pad || { l: 6, r: 58 };
      const plotW = Math.max(1, this._w - pad.l - pad.r);
      const r = cvs.getBoundingClientRect();
      const anchor = Math.max(0, Math.min(1, (e.clientX - r.left - pad.l) / plotW));
      const step = e.ctrlKey ? 0.08 : 0.2;              // Ctrl 轮档次更细
      const factor = 1 + (e.deltaY > 0 ? step : -step); // >1 显示更多根（缩小）
      this.zoomBy(factor, anchor);
    }, { passive: false });
  }

  _barsShown() { return Math.max(1, Math.min(Math.round(this.barsShown), this.bars.length)); }

  _maxOffset() { return Math.max(0, this.bars.length - this._barsShown()); }

  // 缩放限幅：最少 20 根（再少就看不出形态），最多显示全部
  _zoomLimits() {
    const total = this.bars.length;
    return { min: Math.max(1, Math.min(20, total)), max: total };
  }

  /**
   * 以某个横向位置为锚点缩放（锚点下的那根 K 线在缩放前后保持不动）
   * @param {number} target      目标显示根数
   * @param {number} anchorRatio 锚点位置占绘图区宽度比例 0(左)~1(右)
   * @param {boolean} animate    是否平滑过渡
   */
  zoomTo(target, anchorRatio, animate = true) {
    if (!this.bars.length) return;
    const { min, max } = this._zoomLimits();
    const next = Math.max(min, Math.min(max, target));
    const from = this.barsShown;
    if (Math.abs(next - from) < 0.5) return;

    const r = anchorRatio == null ? 0.5 : Math.max(0, Math.min(1, anchorRatio));
    const len = this.bars.length;
    // 锚点处 K 线的绝对索引（缩放过程中保持不变）
    const anchorIdx = (len - this.offset - this._barsShown()) + r * this._barsShown();

    const apply = (n) => {
      this.barsShown = n;
      const startIdx = anchorIdx - r * n;
      const off = len - Math.round(n) - startIdx;
      this.offset = Math.max(0, Math.min(Math.max(0, len - Math.round(n)), Math.round(off)));
      this.render();
    };

    cancelAnimationFrame(this._anim);
    clearTimeout(this._animEnd);
    this._zoomTarget = next;
    // 后台标签页 rAF 会被节流，直接落终值
    if (!animate || document.hidden) { apply(next); return; }

    const t0 = performance.now();
    const dur = 160;                       // 主流行情软件的缩放过渡在 120~200ms
    const tick = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);    // easeOutCubic
      apply(from + (next - from) * e);
      if (k < 1) this._anim = requestAnimationFrame(tick);
      else clearTimeout(this._animEnd);
    };
    this._anim = requestAnimationFrame(tick);
    // 兜底：即便 rAF 不触发，也在过渡时长后落到终值，绝不会"按了没反应"
    this._animEnd = setTimeout(() => {
      cancelAnimationFrame(this._anim);
      apply(next);
    }, dur + 60);
  }

  // 按倍率缩放（factor<1 放大、>1 缩小），供滚轮/键盘调用
  zoomBy(factor, anchorRatio) {
    this.zoomTo((this._zoomTarget || this.barsShown) * factor, anchorRatio);
  }

  // 键盘平移：delta>0 表示回看更早，<0 表示回到更近
  panBy(delta) {
    if (!this.bars.length) return;
    const next = Math.max(0, Math.min(this._maxOffset(), this.offset + delta));
    if (next === this.offset) return;
    this.offset = next;
    this.render();
  }

  showPointAt(clientX, clientY) {
    if (!this.bars.length) return;
    const r = this.canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const n = this._barsShown();
    const plotW = this._w - this._pad.l - this._pad.r;
    const bw = plotW / n;
    const i = Math.floor((x - this._pad.l) / bw);
    if (i < 0 || i >= n) {
      // 点在绘图区外：既然触屏没有 mouseleave，就用「点空白」收起明细
      if (this.hover !== -1) { this.hover = -1; this.mouse = null; this.render(); }
      return;
    }
    this.hover = i;
    this.mouse = { x, y: clientY - r.top };
    this.render();
  }

  _calcMA(bars, n) {
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      sum += bars[i].c;
      if (i >= n) sum -= bars[i - n].c;
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  render() {
    const cvs = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = (this._w = cvs.parentElement.clientWidth);
    const h = (this._h = cvs.parentElement.clientHeight || 420);
    cvs.width = w * dpr; cvs.height = h * dpr;
    cvs.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    this._pad = { l: 6, r: 58, t: 12, b: 22 };
    if (!this.bars.length) {
      ctx.fillStyle = '#9a9a9a';
      ctx.font = '14px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('暂无数据', w / 2, h / 2);
      return;
    }

    const n = this._barsShown();
    this.offset = Math.max(0, Math.min(this.offset, this._maxOffset()));
    const end = this.bars.length - this.offset;
    const start = end - n;
    const view = this.bars.slice(start, end);
    const pad = this._pad;
    const plotW = w - pad.l - pad.r;
    const mainH = h * 0.72;
    const volTop = mainH + 10;
    const volH = h - volTop - pad.b;
    const bw = plotW / n;

    // ---- 价格区间（含均线） ----
    // 均线按「全量 bars」计算再切片，平移时左侧边缘也能得到正确的均线值。
    // 年K 的均线单位是「年」：只支持 5/10/20/30，且数据不足 n 根时 MA_n 不画。
    const YEAR_MA = [5, 10, 20, 30];
    const maList = this.period === '1y'
      ? YEAR_MA.filter((n) => this.maEnabled.has(n) && this.bars.length >= n)
      : [...this.maEnabled].filter((x) => x >= 2).sort((a, b) => a - b);
    const mas = maList.map((n) => ({
      n,
      arr: this._calcMA(this.bars, n).slice(start, end),
      color: MA_COLOR[n] || '#888',
    }));
    let lo = Infinity, hi = -Infinity;
    view.forEach((b) => { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
    mas.forEach(({ arr }) => arr.forEach((v) => { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }));
    const padY = (hi - lo) * 0.06 || 1;
    lo -= padY; hi += padY;

    const yOf = (p) => pad.t + ((hi - p) / (hi - lo)) * mainH;
    const xOf = (i) => pad.l + i * bw + bw / 2;

    // ---- 网格 + 右侧价格轴 ----
    ctx.font = '11px system-ui';
    ctx.textBaseline = 'middle';
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const p = hi - ((hi - lo) / steps) * i;
      const y = yOf(p);
      ctx.strokeStyle = '#efede6';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = '#8a8a8a';
      ctx.textAlign = 'left';
      ctx.fillText(p.toFixed(2), w - pad.r + 5, y);
    }

    // ---- 成交量副图 ----
    const maxV = Math.max(...view.map((b) => b.v || 0)) || 1;
    const vY = (v) => volTop + volH - ((v || 0) / maxV) * volH;

    // ---- K线实体 ----
    const UP = '#d93025', DOWN = '#1a9e5f';
    view.forEach((b, i) => {
      const up = b.c >= b.o;
      const col = up ? UP : DOWN;
      const x = xOf(i);
      const yH = yOf(b.h), yL = yOf(b.l), yO = yOf(b.o), yC = yOf(b.c);
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      // 影线
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, yH); ctx.lineTo(Math.round(x) + 0.5, yL); ctx.stroke();
      // 实体
      const bodyW = Math.max(1, Math.min(bw * 0.68, 14));
      const top = Math.min(yO, yC);
      const bh = Math.max(1, Math.abs(yC - yO));
      // A股习惯：阳线空心、阴线实心
      if (up) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
        ctx.strokeRect(Math.round(x - bodyW / 2) + 0.5, Math.round(top) + 0.5, Math.round(bodyW), Math.round(bh));
      } else {
        ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
      }
      // 成交量
      ctx.fillStyle = col;
      const vh = volTop + volH - vY(b.v);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x - bodyW / 2, vY(b.v), bodyW, vh);
      ctx.globalAlpha = 1;
    });

    // ---- 均线 ----
    const drawMA = (arr, color, label) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      arr.forEach((v, i) => {
        if (v == null) return;
        const x = xOf(i), y = yOf(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    mas.forEach(({ arr, color }) => drawMA(arr, color));

    // ---- 图例（只列当前开启的均线）----
    ctx.textAlign = 'left';
    ctx.font = '11px system-ui';
    const leg = mas.map(({ n, arr, color }) => ['MA' + n, arr[arr.length - 1], color]);
    let lx = pad.l + 4;
    leg.forEach(([name, v, col]) => {
      const txt = name + ':' + (v == null ? '--' : v.toFixed(2));
      ctx.fillStyle = col;
      ctx.fillText(txt, lx, pad.t + 6);
      lx += ctx.measureText(txt).width + 10;
    });

    // 回看提示：触屏没有滚轮 / Ctrl，文案换成手势；字号也略大一点便于拇指屏阅读
    ctx.textAlign = 'left';
    ctx.font = (this._coarse ? '12px' : '11px') + ' system-ui';
    const canPan = this._maxOffset() > 0;
    const touch = this._coarse;
    ctx.fillStyle = this.offset > 0 ? '#8b5a2b' : '#b9b3a4';
    const hint = this.offset > 0
      ? (touch
          ? `← 回看 ${this.offset} 根 · 双击回最新 · 双指缩放`
          : `← 已回看 ${this.offset} 根 · 双击回到最新`)
      : (canPan
          ? (touch
              ? `共 ${this.bars.length} 根 · 单指拖动 · 双指缩放`
              : `共 ${this.bars.length} 根 · 拖动/←→ 平移 · 滚轮或 Ctrl+± 缩放`)
          : `共 ${this.bars.length} 根 · 已全部显示`);
    ctx.fillText(hint, pad.l + 4, pad.t + 22);

    // 光标：可拖动时显示抓手，提示"这里能拖"
    cvs.style.cursor = this.dragging ? 'grabbing' : (canPan ? 'grab' : 'crosshair');

    // ---- 日期轴（周期感知：周/月/长期日K 带年份；跨年画淡色分隔线）----
    const per = this.period || '1d';
    const fmtTick = (s) => {
      const t = String(s);
      if (per === '1y') return t.slice(0, 4);                // 2026
      if (per === '1M') return t.slice(0, 7);               // 2024-12
      if (per === '1w' || per === '1d') return t.slice(2, 10); // 24-12-30
      return t.slice(5, 16);                                // 09-30 09:34
    };
    if (per === '1M' || per === '1w' || per === '1d') {
      ctx.save();
      ctx.strokeStyle = '#e2ded3';
      ctx.lineWidth = 1;
      let prevY = String(view[0].t).slice(0, 4);
      view.forEach((b, i) => {
        const y = String(b.t).slice(0, 4);
        if (y !== prevY) {
          const x = Math.round(pad.l + i * bw) + 0.5;
          ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, volTop + volH); ctx.stroke();
          prevY = y;
        }
      });
      ctx.restore();
    }

    ctx.fillStyle = '#8a8a8a';
    ctx.textAlign = 'center';
    const tick = Math.max(1, Math.floor(n / 6));
    view.forEach((b, i) => {
      if (i % tick) return;
      ctx.fillText(fmtTick(b.t), xOf(i), h - pad.b / 2 - 2);
    });

    // ---- 十字光标 + 浮窗 ----
    if (this.hover >= 0 && this.hover < n) {
      const b = view[this.hover];
      const x = xOf(this.hover);
      const y = this.mouse?.y ?? yOf(b.c);
      ctx.strokeStyle = '#9a9a9a';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, volTop + volH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.setLineDash([]);
      // 右侧价格标签
      ctx.fillStyle = '#333';
      ctx.fillRect(w - pad.r + 2, y - 8, pad.r - 4, 16);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.fillText(yOfInverse(y, lo, hi, mainH).toFixed(2), w - pad.r + 5, y);

      // 信息浮窗：涨跌按惯例对比「上一根收盘」，不是当天开盘。
      // ⚠ view 是切片，上一根要用全量 bars 的绝对下标取，否则视图左边缘会算错；
      //   第一根没有上一根时才退回开盘价。
      const absIdx = start + this.hover;
      const prevBar = absIdx > 0 ? this.bars[absIdx - 1] : null;
      const base = prevBar ? prevBar.c : b.o;
      const chg = b.c - base;
      const pct = base ? (chg / base) * 100 : 0;
      const lines = [
        `${b.t}`,
        `开 ${b.o.toFixed(2)}   高 ${b.h.toFixed(2)}`,
        `低 ${b.l.toFixed(2)}   收 ${b.c.toFixed(2)}`,
        `涨跌 ${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
        `量 ${fmtVol(b.v)}`,
      ];
      ctx.font = '12px system-ui';
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 18;
      const th = lines.length * 17 + 12;
      let bx = x + 12;
      if (bx + tw > w - pad.r) bx = x - tw - 12;
      const by = pad.t + 4;
      ctx.fillStyle = 'rgba(255,255,255,.96)';
      ctx.strokeStyle = '#c9c4b7';
      ctx.fillRect(bx, by, tw, th);
      ctx.strokeRect(bx + 0.5, by + 0.5, tw, th);
      ctx.textAlign = 'left';
      lines.forEach((l, i) => {
        ctx.fillStyle = i === 0 ? '#555' : (i === 3 ? (chg >= 0 ? UP : DOWN) : '#333');
        ctx.fillText(l, bx + 9, by + 16 + i * 17);
      });
    }
  }
}

function yOfInverse(y, lo, hi, mainH) {
  return hi - ((y - 12) / mainH) * (hi - lo);
}
function fmtVol(v) {
  if (!v) return '—';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
  return String(Math.round(v));
}

window.KlineChart = KlineChart;
