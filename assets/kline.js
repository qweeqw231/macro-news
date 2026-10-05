// assets/kline.js
// K线图组件（Canvas 手绘，零依赖）
// 视觉规范参照主流行情软件：红涨绿跌、十字光标、均线、成交量副图

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

    // —— 鼠标：canvas 上按下，document 上移动/松开 ——
    // 这是最经典可靠的拖拽写法：不依赖 setPointerCapture，鼠标移出画布也不会中断
    cvs.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
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

    // —— 触屏：canvas 上按下/移动/松开（touchmove 阻止页面滚动）——
    cvs.addEventListener('touchstart', (e) => {
      if (startDrag(e.touches[0].clientX) && e.cancelable) e.preventDefault();
    }, { passive: false });
    cvs.addEventListener('touchmove', (e) => {
      if (!this.dragging) return;
      moveDrag(e.touches[0].clientX);
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    cvs.addEventListener('touchend', endDrag);

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
    // 均线按「全量 bars」计算再切片，平移时左侧边缘也能得到正确的均线值
    const ma5 = this._calcMA(this.bars, 5).slice(start, end);
    const ma10 = this._calcMA(this.bars, 10).slice(start, end);
    const ma20 = this._calcMA(this.bars, 20).slice(start, end);
    const ma60 = this._calcMA(this.bars, 60).slice(start, end);
    let lo = Infinity, hi = -Infinity;
    view.forEach((b) => { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; });
    [ma5, ma10, ma20, ma60].forEach((m) => m.forEach((v) => { if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; } }));
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
    drawMA(ma5, '#f0a020', 'MA5');
    drawMA(ma10, '#2c5e8e', 'MA10');
    drawMA(ma20, '#8e44ad', 'MA20');
    drawMA(ma60, '#16a085', 'MA60');

    // ---- 图例 ----
    ctx.textAlign = 'left';
    ctx.font = '11px system-ui';
    const lg = view[n - 1];
    const leg = [
      ['MA5', ma5[n - 1], '#f0a020'],
      ['MA10', ma10[n - 1], '#2c5e8e'],
      ['MA20', ma20[n - 1], '#8e44ad'],
      ['MA60', ma60[n - 1], '#16a085'],
    ];
    let lx = pad.l + 4;
    leg.forEach(([name, v, col]) => {
      ctx.fillStyle = col;
      ctx.fillText(name + ':' + (v == null ? '--' : v.toFixed(2)), lx, pad.t + 6);
      lx += ctx.measureText(name + ':' + (v == null ? '--' : v.toFixed(2))).width + 10;
    });

    // 回看提示（拖动/滚轮查看历史时显示）
    ctx.textAlign = 'left';
    ctx.font = '11px system-ui';
    const canPan = this._maxOffset() > 0;
    ctx.fillStyle = this.offset > 0 ? '#8b5a2b' : '#b9b3a4';
    ctx.fillText(
      this.offset > 0
        ? `← 已回看 ${this.offset} 根 · 双击回到最新`
        : (canPan ? `共 ${this.bars.length} 根 · 拖动/←→ 平移 · 滚轮或 Ctrl+± 缩放`
                  : `共 ${this.bars.length} 根 · 已全部显示`),
      pad.l + 4, pad.t + 22
    );

    // 光标：可拖动时显示抓手，提示"这里能拖"
    cvs.style.cursor = this.dragging ? 'grabbing' : (canPan ? 'grab' : 'crosshair');

    // ---- 日期轴（周期感知：周/月/长期日K 带年份；跨年画淡色分隔线）----
    const per = this.period || '1d';
    const fmtTick = (s) => {
      const t = String(s);
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

      // 信息浮窗
      const chg = b.c - b.o;
      const pct = b.o ? (chg / b.o) * 100 : 0;
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
