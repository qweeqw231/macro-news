// assets/macro-chart.js
// 宏观折线/柱状图（2.36.0）：Canvas 手绘、零依赖，交互与 K 线一致（十字线 + 浮窗）。
// 2.36.2：把缩放/平移补齐到与 K 线同一套手感 ——
//   滚轮上滚放大、下滚缩小，Ctrl+滚轮档位更细（0.08 vs 0.2），以光标为锚点、160ms 缓动；
//   按住画布拖动平移；双击回到最新；←/→ 平移、+/- 缩放。
//   视窗语义与 kline.js 完全一致：barsShown=可见点数、offset=右侧回看点数，
//   边界钳在数据范围内（不会拖出空白、最少 20 个点），横轴/纵轴/浮窗都按可见窗口重算。
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
      // 2.36.2：视窗状态，语义与 kline.js 一致：
      //   barsShown = 可见点数（0 = 尚未初始化，首帧按全部显示）
      //   offset    = 右侧回看的点数（0 = 显示到最新）
      this.barsShown = 0;
      this.offset = 0;
      this.dragging = false;
      this._anim = 0;           // 缩放动画的 requestAnimationFrame id
      this._animEnd = 0;        // 缩放动画兜底定时器
      this._zoomTarget = 0;     // 连续缩放时的目标点数（避免动画中反复重算基准）
      this._dragX = 0;
      this._dragOffset = 0;
      this._raf = 0;
      this._rect = null;
      this._onMove = this._onMove.bind(this);
      this._onLeave = this._onLeave.bind(this);
      this.canvas.addEventListener('pointermove', this._onMove);
      this.canvas.addEventListener('pointerdown', this._onMove);
      this.canvas.addEventListener('pointerleave', this._onLeave);
      this._bind();
      this._ro = new ResizeObserver(() => this.render());
      this._ro.observe(root);
    }

    destroy() {
      cancelAnimationFrame(this._raf);
      cancelAnimationFrame(this._anim);
      clearTimeout(this._animEnd);
      this._ro.disconnect();
      document.removeEventListener('mousemove', this._onDocMove);
      document.removeEventListener('mouseup', this._onDocUp);
      this.canvas.removeEventListener('pointermove', this._onMove);
      this.canvas.removeEventListener('pointerdown', this._onMove);
      this.canvas.removeEventListener('pointerleave', this._onLeave);
      this.canvas.remove();
    }

    setData(opts) {
      const o = opts || {};
      cancelAnimationFrame(this._anim);
      clearTimeout(this._animEnd);
      this.bars = (Array.isArray(o.bars) ? o.bars : [])
        .map((b) => ({ t: String(b.t || ''), v: Number(b.v) }))
        .filter((b) => b.t && Number.isFinite(b.v));
      this.mode = o.mode === 'bar' ? 'bar' : 'line';
      this.unit = o.unit || '';
      this.decimals = Number.isFinite(o.decimals) ? o.decimals : 2;
      this.freq = o.freq || 'D';
      this.name = o.name || '';
      this.hover = -1;
      const total = this.bars.length;
      if (total) {
        // 与 K 线一致：新数据沿用当前可见点数，只做上下限钳制；
        // 首帧（barsShown=0）按全部显示。区间切换时保留缩放，换指标由 reset() 复位。
        const lim = this._zoomLimits();
        this.barsShown = this.barsShown > 0
          ? Math.max(lim.min, Math.min(lim.max, this.barsShown))
          : total;
        this.offset = Math.max(0, Math.min(this.offset, this._maxOffset()));
        this._zoomTarget = this.barsShown;
      } else {
        this.offset = 0;
      }
      this.render();
    }

    /** 与 K 线 reset() 同义：切换指标时清空画布并复位视图，避免带着上一个指标的缩放 */
    reset() {
      cancelAnimationFrame(this._anim);
      clearTimeout(this._animEnd);
      this.bars = [];
      this.barsShown = 0;
      this.offset = 0;
      this.hover = -1;
      this.dragging = false;
      this._zoomTarget = 0;
      this.render();
    }

    /** 空画布文案：加载中 / 暂无数据（由 app.js 在取数前后切换） */
    setEmptyText(text) {
      const next = text || '暂无数据';
      if (this.emptyText === next) return;
      this.emptyText = next;
      if (!this.bars.length) this.render();
    }

    // ---- 视窗（2.36.2）：与 kline.js 的 _barsShown/_maxOffset/_zoomLimits 同构 ----

    _barsShown() {
      const total = this.bars.length;
      return Math.max(1, Math.min(Math.round(this.barsShown || total), total));
    }

    _maxOffset() {
      return Math.max(0, this.bars.length - this._barsShown());
    }

    // 缩放限幅：最少 20 个点（再少就看不出趋势），最多显示全部
    _zoomLimits() {
      const total = this.bars.length;
      return { min: Math.max(1, Math.min(20, total)), max: total };
    }

    /**
     * 以某个横向位置为锚点缩放（锚点下的那个点在缩放前后保持不动）
     * @param {number} target      目标显示点数
     * @param {number} anchorRatio 锚点位置占绘图区宽度比例 0(左)~1(右)
     * @param {boolean} animate    是否平滑过渡
     */
    zoomTo(target, anchorRatio, animate = true) {
      if (!this.bars.length) return;
      const { min, max } = this._zoomLimits();
      const next = Math.max(min, Math.min(max, target));
      const from = this._barsShown();
      if (Math.abs(next - from) < 0.5) { this._zoomTarget = next; return; }

      const r = anchorRatio == null ? 0.5 : Math.max(0, Math.min(1, anchorRatio));
      const len = this.bars.length;
      // 锚点处数据的绝对索引（缩放过程中保持不变）
      const anchorIdx = (len - this.offset - from) + r * from;

      const apply = (n) => {
        this.barsShown = n;
        const startIdx = anchorIdx - r * n;
        const off = len - Math.round(n) - startIdx;
        this.offset = Math.max(0, Math.min(Math.max(0, len - Math.round(n)), Math.round(off)));
        this.hover = -1;
        this.render();
      };

      cancelAnimationFrame(this._anim);
      clearTimeout(this._animEnd);
      this._zoomTarget = next;
      // 后台标签页 rAF 会被节流，直接落终值
      if (!animate || document.hidden) { apply(next); return; }

      const t0 = performance.now();
      const dur = 160;                       // 与 K 线相同的 120~200ms 过渡
      const tick = (t) => {
        const k = Math.min(1, (t - t0) / dur);
        const e = 1 - Math.pow(1 - k, 3);    // easeOutCubic
        apply(from + (next - from) * e);
        if (k < 1) this._anim = requestAnimationFrame(tick);
        else clearTimeout(this._animEnd);
      };
      this._anim = requestAnimationFrame(tick);
      // 兜底：即便 rAF 不触发，也在过渡时长后落到终值，绝不会「按了没反应」
      this._animEnd = setTimeout(() => {
        cancelAnimationFrame(this._anim);
        apply(next);
      }, dur + 60);
    }

    // 按倍率缩放（factor<1 放大、>1 缩小），供滚轮/键盘调用
    zoomBy(factor, anchorRatio) {
      const base = this._zoomTarget > 0 ? this._zoomTarget : this._barsShown();
      this.zoomTo(base * factor, anchorRatio);
    }

    // 键盘平移：delta>0 表示回看更早，<0 表示回到更近
    panBy(delta) {
      if (!this.bars.length) return;
      const next = Math.max(0, Math.min(this._maxOffset(), this.offset + delta));
      if (next === this.offset) return;
      this.offset = next;
      this.hover = -1;
      this.render();
    }

    _bind() {
      const cvs = this.canvas;

      // —— 拖动平移：与 K 线同样的写法 ——
      // 从整个弹窗表面按下（不限于画布），document 上移动/松开，
      // 这样鼠标移出画布也不会中断；按钮/链接不抢事件。
      const surface = cvs.closest('.kline-modal') || cvs;
      surface.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (e.target && e.target.closest && e.target.closest('button, a, input, textarea, select')) return;
        if (this._startDrag(e.clientX)) e.preventDefault();
      });
      this._onDocMove = (e) => this._moveDrag(e.clientX);
      this._onDocUp = () => this._endDrag();
      document.addEventListener('mousemove', this._onDocMove);
      document.addEventListener('mouseup', this._onDocUp);

      // —— 滚轮缩放：与 K 线同一方向与幅度 ——
      // 上滚放大、下滚缩小；Ctrl+滚轮档位更细，并阻止浏览器整页缩放。
      cvs.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (!this.bars.length) return;
        const pad = this._pad();
        const rect = cvs.getBoundingClientRect();
        const plotW = Math.max(1, rect.width - pad.l - pad.r);
        const anchor = Math.max(0, Math.min(1, (e.clientX - rect.left - pad.l) / plotW));
        const step = e.ctrlKey ? 0.08 : 0.2;
        const factor = 1 + (e.deltaY > 0 ? step : -step); // >1 显示更多点（缩小）
        this.zoomBy(factor, anchor);
      }, { passive: false });

      // 双击回到最新（与 K 线一致：只复位平移，不改变缩放）
      cvs.addEventListener('dblclick', () => {
        if (!this.bars.length) return;
        this.offset = 0;
        this.render();
      });
    }

    _startDrag(clientX) {
      if (!this.bars.length || this._maxOffset() <= 0) return false;
      const rect = this.canvas.getBoundingClientRect();
      this.dragging = true;
      this._dragX = clientX - rect.left;
      this._dragOffset = this.offset;
      this.hover = -1;
      this.canvas.style.cursor = 'grabbing';
      this.render();
      return true;
    }

    _moveDrag(clientX) {
      if (!this.dragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const pad = this._pad();
      const plotW = Math.max(1, rect.width - pad.l - pad.r);
      const bw = plotW / this._barsShown();
      const x = clientX - rect.left;
      const delta = Math.round((this._dragX - x) / bw);
      const next = Math.max(0, Math.min(this._maxOffset(), this._dragOffset + delta));
      if (next !== this.offset) {
        this.offset = next;
        this.hover = -1;
        this.render();
      }
    }

    _endDrag() {
      if (!this.dragging) return;
      this.dragging = false;
      this.render();
    }

    _onMove(e) {
      if (this.dragging) return;
      const rect = this.canvas.getBoundingClientRect();
      const n = this._barsShown();
      if (!n || !this.bars.length) return;
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
      this.hover = i;    // 相对当前可见窗口的索引（view 下标）
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => this.render());
    }

    _onLeave() {
      if (this.dragging) return;
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
      const total = this.bars.length;

      const ink = cssVar('--ink', '#2b2b2b');
      const faint = cssVar('--ink-faint', '#999');
      const rule = cssVar('--rule', '#e6e2d8');
      const accent = cssVar('--accent', '#8a5a2b');
      const up = cssVar('--up', '#c0392b');
      const down = cssVar('--down', '#1e8449');

      if (!total) {
        ctx.fillStyle = faint;
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(this.emptyText, w / 2, h / 2);
        return;
      }

      // ---- 视窗（2.36.2）：只画 bars[start, end)，缩放/平移后坐标轴与浮窗都跟着重算 ----
      const n = this._barsShown();
      this.offset = Math.max(0, Math.min(this.offset, this._maxOffset()));
      const end = total - this.offset;
      const start = end - n;
      const view = this.bars.slice(start, end);

      // ---- 值域（按可见窗口算，和 K 线缩放后纵轴自适应一致） ----
      let lo = Infinity, hi = -Infinity;
      for (const b of view) { if (b.v < lo) lo = b.v; if (b.v > hi) hi = b.v; }
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
          const v = view[i].v;
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
          const x = xOf(i), y = yOf(view[i].v);
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
          const x = xOf(i), y = yOf(view[i].v);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = accent;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        // 点：点少时全部画，点多只画末点
        if (n <= 80) {
          for (let i = 0; i < n; i++) {
            ctx.beginPath();
            ctx.arc(xOf(i), yOf(view[i].v), 2, 0, Math.PI * 2);
            ctx.fillStyle = accent;
            ctx.fill();
          }
        } else {
          ctx.beginPath();
          ctx.arc(xOf(n - 1), yOf(view[n - 1].v), 2.2, 0, Math.PI * 2);
          ctx.fillStyle = accent;
          ctx.fill();
        }
      }

      // ---- 横轴刻度 ----
      ctx.fillStyle = faint;
      ctx.textAlign = 'center';
      const sample = this._fmtTick(view[0].t);
      const labelW = Math.max(ctx.measureText(sample).width, 28);
      const maxLabels = Math.max(2, Math.floor(plotW / (labelW + 18)));
      const tick = Math.max(1, Math.ceil(n / maxLabels));
      let prevLeft = Infinity;
      for (let i = n - 1; i >= 0; i -= tick) {
        const txt = this._fmtTick(view[i].t);
        const tw = ctx.measureText(txt).width;
        const x = Math.max(pad.l + tw / 2, Math.min(w - pad.r - tw / 2, xOf(i)));
        if (x + tw / 2 > prevLeft - 10) continue;
        ctx.fillText(txt, x, h - pad.b / 2 - 3);
        prevLeft = x - tw / 2;
      }

      // ---- 回看提示 + 光标（与 K 线同一套文案节奏） ----
      ctx.textAlign = 'left';
      ctx.font = '11px system-ui';
      const canPan = this._maxOffset() > 0;
      let hint;
      if (this.offset > 0) hint = `← 已回看 ${this.offset} 点 · 双击回到最新`;
      else if (canPan) hint = `共 ${total} 点 · 拖动平移 · 滚轮/Ctrl+滚轮缩放`;
      else hint = `共 ${total} 点 · 滚轮/Ctrl+滚轮缩放`;
      if (ctx.measureText(hint).width > plotW - 70) {
        hint = this.offset > 0 ? `← 回看 ${this.offset} 点` : `共 ${total} 点`;
      }
      ctx.fillStyle = this.offset > 0 ? '#8b5a2b' : '#b9b3a4';
      ctx.fillText(hint, pad.l, pad.t - 5);
      // 可拖动时显示抓手，提示「这里能拖」
      this.canvas.style.cursor = this.dragging ? 'grabbing' : (canPan ? 'grab' : 'crosshair');

      // ---- 十字光标 + 浮窗 ----
      if (this.hover >= 0 && this.hover < n) {
        const b = view[this.hover];
        const abs = start + this.hover;          // 绝对索引：用于「较上期」取真实上一期
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

        const prev = abs > 0 ? this.bars[abs - 1] : null;
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
