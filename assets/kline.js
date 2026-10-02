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
    this._bind();
    this._ro = new ResizeObserver(() => this.render());
    this._ro.observe(root);
  }

  destroy() { this._ro.disconnect(); this.canvas.remove(); }

  setData(bars) { this.bars = bars || []; this.render(); }

  _bind() {
    const move = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const y = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      const n = this._barsShown();
      if (!n || y < 0 || y > this._h * 0.78) { this.hover = -1; this.render(); return; }
      const plotW = this._w - this._pad.l - this._pad.r;
      const i = Math.round((x - this._pad.l) / (plotW / n) - 0.5);
      this.hover = Math.max(0, Math.min(n - 1, i));
      this.mouse = { x, y };
      this.render();
    };
    this.canvas.addEventListener('mousemove', move);
    this.canvas.addEventListener('touchmove', (e) => { move(e); e.preventDefault(); }, { passive: false });
    const leave = () => { this.hover = -1; this.mouse = null; this.render(); };
    this.canvas.addEventListener('mouseleave', leave);
    this.canvas.addEventListener('touchend', leave);
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = e.deltaY > 0 ? 12 : -12;
      this.barsShown = Math.max(30, Math.min(this.bars.length, this.barsShown - d));
      this.render();
    }, { passive: false });
  }

  _barsShown() { return Math.min(this.barsShown, this.bars.length); }

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
    const view = this.bars.slice(-n);
    const pad = this._pad;
    const plotW = w - pad.l - pad.r;
    const mainH = h * 0.72;
    const volTop = mainH + 10;
    const volH = h - volTop - pad.b;
    const bw = plotW / n;

    // ---- 价格区间（含均线） ----
    const ma5 = this._calcMA(view, 5), ma10 = this._calcMA(view, 10);
    const ma20 = this._calcMA(view, 20), ma60 = this._calcMA(view, 60);
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

    // ---- 日期轴 ----
    ctx.fillStyle = '#8a8a8a';
    ctx.textAlign = 'center';
    const tick = Math.max(1, Math.floor(n / 6));
    view.forEach((b, i) => {
      if (i % tick) return;
      const t = String(b.t).slice(5, 16);
      ctx.fillText(t, xOf(i), h - pad.b / 2 - 2);
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
