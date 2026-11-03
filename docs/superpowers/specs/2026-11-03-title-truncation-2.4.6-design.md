# 2.4.6：标题不再硬截、前端多行省略

日期：2026-11-03
状态：已实施

## 1. 现象

```
今天 14:02  华尔街见闻  A股  科创50跌超5%，创业板指跌近3%，算力硬件股持续下挫，深南电路、景旺电子、光迅
```

原文是 `…深南电路、景旺电子、光迅科技午后跌停，…`，标题把「光迅科技」切成「光迅」，
并丢掉了「午后跌停」及之后全部内容，且没有省略号。

## 2. 根因（逐层定位）

| 层 | 文件 / 位置 | 行为 |
|---|---|---|
| 采集 | `src/sources.mjs` Wallstreetcn 适配器 | `title: rawTitle || text.slice(0, 40)`，硬切 40 字 |
| 归档 / 索引 | `src/collect.mjs` | 原样存 `title`，不做二次处理 |
| 前端 | `assets/app.js` 第 422 行 | `el('div','item-title', it.title)` 原样渲染 |
| 样式 | `assets/style.css` 第 225 行 | `.item-title` 没有 line-clamp，长标题直接换行 |

⇒ 截断发生在**采集层**（写盘前），前端只是忠实显示被截断的结果。

## 3. 修复

1. 新增 `src/news-title.mjs`：
   - `titleFromText(text)`：取正文**第一整句**（到 `。！？；` 为止）作为标题；
     第一句超过 200 字才退化为短版。
   - `shortenTitle(text, max)`：从 `max` 向前找标点——先句末 `。！？；`，再分句 `，、`，
     命中即断并加 `…`；窗口内没有标点 ⇒ 返回全文，**不硬切**。
2. `sources.mjs` 改为 `title: rawTitle || titleFromText(text)`，真实标题（`rawTitle`）不处理。
3. `assets/style.css` 的 `.item-title` 增加
   `display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden`，
   超长标题由浏览器做多行省略，读者能看到「被截了」。
4. 历史回填：`scripts/repair-archive.mjs`
   - 识别特征：`title.length === 40 && content.length > 40 && content.startsWith(title)`；
   - 用 `titleFromText(content)` 回填；真实标题不受影响；
   - 同一遍复用 `dedupeItems`（2.4.5）清重复；
   - 最后重建 `data/index.json`、`data/latest.json`、`data/search.json`。

## 4. 回填范围与限制

- 实测：63 个归档 / 20,864 条 ⇒ 合并重复 **-274**，回填标题 **2,444**，改写 **32** 个文件。
- 当天 `2026-11-03`：`782 → 755` 条；事故标题从 40 字恢复为 **99 字完整句**：
  `科创50跌超5%，创业板指跌近3%，算力硬件股持续下挫，深南电路、景旺电子、光迅科技午后跌停，蘅东光跌超23%，杰普特、联特科技、长芯博创、光库科技、天孚通信、中际旭创、联讯仪器等十余股跌超10%。`
- **能回填的前提**是 `content` 里有原文（采集时完整保留了 4000 字）；若某条的 `content`
  也被上游截断，则只能保留现有标题，脚本不会伪造。
- 比 40 字更早的历史条目（若存在其他截断策略）不在识别特征内，不会被误改。

## 5. 测试

`tests/news-title.test.mjs`（7 项）：

- 真实事故：标题等于完整第一句（>40 字、含「光迅科技午后跌停」、以 `。` 结尾）；
- 两句只取第一句；
- 短版截断点落在标点后并带 `…`；
- 无标点时返回全文（不硬切）；
- 空输入安全；
- `sources.mjs` 使用 `titleFromText` 且无 `text.slice(0, 40)`；
- CSS 有 line-clamp 2，前端不对标题做 `slice/substring`。
