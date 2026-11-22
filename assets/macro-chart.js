// assets/macro-chart.js
// 宏观折线/柱状图（2.36.0）：Canvas 手绘、零依赖，交互与 K 线一致（十字线 + 浮窗）。
//
// 为什么新写一个而不是复用 KlineChart：
//   K 线是「蜡烛 + 均线 + 量能副图 + 缩放/平移」，宏观是「单值序列 + 区间 chips」；
//   强行复用会把两套手势和绘制逻辑缠在一起。这里只保留相同的视觉与浮窗习惯。
(function () {
  'use strict';

  const cssVar = (name, fallback) => {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  };

  class MacroChart {
    constructor(root) {
      this.root = root;
      this.canvas = document.createElement('canvas');
      this.canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;cursor:crosshair';
      root.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.bars = [];
      this.mode = 'line';       // line | bar
      this.unit = '';
      this.decimals = 2;
      this.freq = 'D';
      this.name = '';
      this.emptyText = '暂无数据';
      this.hover = -1;
      this._raf = 0;
      this._rect = null;
      this._onMove = this._onMove.bind(this);
      this._onLeave = this._onLeave.bind(this);
      this.canvas.addEventListener('pointermove', this._onMove);
      this.canvas.addEventListener('pointerdown', this._onMove);
      this.canvas.addEventListener('pointerleave', this._onLeave);
      this._ro = new ResizeObserver(() => this.render());
      this._ro.observe(root);
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      this._ro.disconnect();
      this.canvas.removeEventListener('pointermove', this._onMove);
      this.canvas.removeEventListener('pointerdown', this._onMove);
      this.canvas.removeEventListener('pointerleave', this._onLeave);
      this.canvas.remove();
    }

    setData(opts) {
      const o = opts || {};
      this.bars = (Array.isArray(o.bars) ? o.bars : [])
        .map((b) => ({ t: String(b.t || ''), v: Number(b.v) }))
        .filter((b) => b.t && Number.isFinite(b.v));
      this.mode = o.mode === 'bar' ? 'bar' : 'line';
      this.unit = o.unit || '';
      this.decimals = Number.isFinite(o.decimals) ? o.decimals : 2;
      this.freq = o.freq || 'D';
      this.name = o.name || '';
      this.hover = -1;
      this.render();
    }

    /** 空画布文案：加载中 / 暂无数据（由 app.js 在取数前后切换） */
    setEmptyText(text) {
      const next = text || '暂无数据';
      if (this.emptyText === next) return;
      this.emptyText = next;
      if (!this.bars.length) this.render();
    }

    _onMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const n = this.bars.length;
      if (!n) return;
      const pad = this._pad();
      const plotW = Math.max(1, rect.width - pad.l - pad.r);
      const x = e.clientX - rect.left;
      let i;
      if (this.mode === 'bar') {
        i = Math.floor(((x - pad.l) / plotW) * n);
      } else {
        i = n === 1 ? 0 : Math.round(((x - pad.l) / plotW) * (n - 1));
      }
      i = Math.max(0, Math.min(n - 1, i));
      if (i === this.hover) return;
      this.hover = i;
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => this.render());
    }

    _onLeave() {
      if (this.hover < 0) return;
      this.hover = -1;
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => this.render());
    }

    _pad() {
      return { l: 10, r: 62, t: 18, b: 30 };
    }

    render() {
      const root = this.root;
      const w = Math.max(1, root.clientWidth);
      const h = Math.max(1, root.clientHeight);
      const dpr = window.devicePixelRatio || 1;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const pad = this._pad();
      const plotW = Math.max(1, w - pad.l - pad.r);
      const plotH = Math.max(1, h - pad.t - pad.b);
      const n = this.bars.length;

      const ink = cssVar('--ink', '#2b2b2b');
      const faint = cssVar('--ink-faint', '#999');
      const rule = cssVar('--rule', '#e6e2d8');
      const accent = cssVar('--accent', '#8a5a2b');
      const up = cssVar('--up', '#c0392b');
      const down = cssVar('--down', '#1e8449');

      if (!n) {
        ctx.fillStyle = faint;
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(this.emptyText, w / 2, h / 2);
        return;
      }

      // ---- 值域 ----
      let lo = Infinity, hi = -Infinity;
      for (const b of this.bars) { if (b.v < lo) lo = b.v; if (b.v > hi) hi = b.v; }
      if (this.mode === 'bar') { lo = Math.min(0, lo); hi = Math.max(0, hi); }
      if (lo === hi) { const d = Math.abs(lo) * 0.05 || 1; lo -= d; hi += d; }
      else {
        const span = hi - lo;
        lo -= span * 0.08;
        hi += span * 0.08;
        if (this.mode === 'bar') { lo = Math.min(0, lo); hi = Math.max(0, hi); }
      }
      const yOf = (v) => pad.t + plotH - ((v - lo) / (hi - lo)) * plotH;
      const xOf = (i) => (this.mode === 'bar'
        ? pad.l + (plotW * (i + 0.5)) / n
        : (n === 1 ? pad.l + plotW / 2 : pad.l + (plotW * i) / (n - 1)));

      // ---- 横向网格 + 右侧刻度 ----
      ctx.font = '11px system-ui';
      ctx.textAlign = 'left';
      const ticks = 4;
      for (let k = 0; k <= ticks; k++) {
        const v = lo + ((hi - lo) * k) / ticks;
        const y = yOf(v);
        ctx.strokeStyle = rule;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.l, y + 0.5);
        ctx.lineTo(w - pad.r, y + 0.5);
        ctx.stroke();
        ctx.fillStyle = faint;
        ctx.fillText(this._fmtAxis(v), w - pad.r + 6, y + 4);
      }
      // 单位放在轴上方，避免和刻度挤在一起
      if (this.unit) {
        ctx.fillStyle = faint;
        ctx.textAlign = 'right';
        ctx.fillText(this.unit, w - pad.r, pad.t - 5);
      }

      // ---- 数据 ----
      if (this.mode === 'bar') {
        const bw = Math.max(1, (plotW / n) * 0.7);
        const zeroY = yOf(0);
        for (let i = 0; i < n; i++) {
          const v = this.bars[i].v;
          const y = yOf(v);
          ctx.fillStyle = v >= 0 ? up : down;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(xOf(i) - bw / 2, Math.min(y, zeroY), bw, Math.max(1, Math.abs(zeroY - y)));
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = rule;
        ctx.beginPath();
        ctx.moveTo(pad.l, zeroY + 0.5);
        ctx.lineTo(w - pad.r, zeroY + 0.5);
        ctx.stroke();
      } else {
        // 面积
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = xOf(i), y = yOf(this.bars[i].v);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.lineTo(xOf(n - 1), pad.t + plotH);
        ctx.lineTo(xOf(0), pad.t + plotH);
        ctx.closePath();
        ctx.fillStyle = accent;
        ctx.globalAlpha = 0.08;
        ctx.fill();
        ctx.globalAlpha = 1;
        // 折线
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = xOf(i), y = yOf(this.bars[i].v);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        // 点：点少时全部画，点多只画末点
        if (n <= 80) {
          for (let i = 0; i < n; i++) {
            ctx.beginPath();
            ctx.arc(xOf(i), yOf(this.bars[i].v), 2, 0, Math.PI * 2);
            ctx.fillStyle = accent;
            ctx.fill();
          }
        } else {
          ctx.beginPath();
          ctx.arc(xOf(n - 1), yOf(this.bars[n - 1].v), 2.2, 0, Math.PI * 2);
          ctx.fillStyle = accent;
          ctx.fill();
        }
      }

      // ---- 横轴刻度 ----
      ctx.fillStyle = faint;
      ctx.textAlign = 'center';
      const sample = this._fmtTick(this.bars[0].t);
      const labelW = Math.max(ctx.measureText(sample).width, 28);
      const maxLabels = Math.max(2, Math.floor(plotW / (labelW + 18)));
      const tick = Math.max(1, Math.ceil(n / maxLabels));
      let prevLeft = Infinity;
      for (let i = n - 1; i >= 0; i -= tick) {
        const txt = this._fmtTick(this.bars[i].t);
        const tw = ctx.measureText(txt).width;
        const x = Math.max(pad.l + tw / 2, Math.min(w - pad.r - tw / 2, xOf(i)));
        if (x + tw / 2 > prevLeft - 10) continue;
        ctx.fillText(txt, x, h - pad.b / 2 - 3);
        prevLeft = x - tw / 2;
      }

      // ---- 十字光标 + 浮窗 ----
      if (this.hover >= 0 && this.hover < n) {
        const b = this.bars[this.hover];
        const x = xOf(this.hover);
        const y = yOf(b.v);
        ctx.strokeStyle = '#9a9a9a';
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + plotH); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, y, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();

        const prev = this.hover > 0 ? this.bars[this.hover - 1] : null;
        const diff = prev ? b.v - prev.v : null;
        const lines = [
          this._fmtTick(b.t, true),
          `${this._fmtAxis(b.v)}${this.unit}`,
        ];
        if (diff !== null) lines.push(`较上期 ${diff >= 0 ? '+' : ''}${this._fmtAxis(diff)}${this.unit}`);
        ctx.font = '12px system-ui';
        const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 18;
        const th = lines.length * 17 + 12;
        let bx = x + 12;
        if (bx + tw > w - pad.r) bx = Math.max(pad.l, x - tw - 12);
        const by = pad.t + 4;
        ctx.fillStyle = 'rgba(255,255,255,.96)';
        ctx.strokeStyle = '#c9c4b7';
        ctx.fillRect(bx, by, tw, th);
        ctx.strokeRect(bx + 0.5, by + 0.5, tw, th);
        ctx.textAlign = 'left';
        lines.forEach((l, i) => {
          ctx.fillStyle = i === 0 ? '#555' : (i === 2 && diff !== null ? (diff >= 0 ? up : down) : ink);
          ctx.fillText(l, bx + 9, by + 16 + i * 17);
        });
      }
    }

    _fmtAxis(v) {
      const d = this.decimals;
      if (Math.abs(v) >= 1000) return Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
      return Number(v).toFixed(d);
    }

    _fmtTick(t, full) {
      const s = String(t || '');
      if (/^\d{4}-\d{2}$/.test(s)) {
        return full ? `${s.slice(0, 4)}年${Number(s.slice(5, 7))}月` : `${s.slice(2, 4)}-${s.slice(5, 7)}`;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return full ? s : `${s.slice(2, 4)}-${s.slice(5, 10)}`;
      }
      return s;
    }
  }

  window.MacroChart = MacroChart;
})();
