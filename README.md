# 宏观资讯台 · Macro News

全球宏观资讯自动采集与归档：**利率 · 汇率 · 政策 · 大宗商品**。

## 核心设计：采集不占用任何 AI 上下文

```
Windows 计划任务（每 30 分钟）
   └─ node src/collect.mjs          ← 纯脚本，0 context
        └─ 写 data/*.json
             └─ git commit & push
                  └─ GitHub Pages 自动更新（约 1-2 分钟）
```

采集是确定性的 IO 任务，跑在系统计划任务里，**不消耗对话窗口**。
AI 只在你主动要求时介入（例如"把这周新闻和我的 6 大类资产对齐"）。

## 数据源（全部经本机实测可用）

| 源 | 覆盖 | 方式 |
|---|---|---|
| 华尔街见闻 | 全球 / 外汇 / 大宗 / 美股 / A股 快讯 | 公开 API，5 频道 |
| 美联储 | 货币政策、利率决议 | 官方 RSS |
| 欧洲央行 | 欧央行政策 | 官方 RSS |
| 国家统计局 | 中国宏观数据（CPI / PPI / PMI） | 官方 RSS |
| 东方财富 | 指数 / 汇率 / 商品实时行情 | 公开行情 API |

> 采集脚本对每个源独立容错：单个源失败不影响其他源，失败原因记录在 `data/_last-run.json`，
> 并在站点的「运行状态」页展示。

## 目录结构

```
macro-news/
├── index.html            站点首页
├── assets/               style.css / app.js / fuse.min.js
├── data/                 采集产物（已入库，Pages 直接读取）
│   ├── quotes.json       宏观行情快照
│   ├── latest.json       最近 200 条（首屏）
│   ├── search.json       全库检索索引
│   ├── index.json        按天归档索引
│   ├── _last-run.json    上次运行状态
│   └── archive/YYYY-MM-DD.json
├── src/
│   ├── collect.mjs       采集主程序（零依赖）
│   └── sources.mjs       各源适配器
├── scripts/
│   ├── collect-and-push.ps1   采集 → 提交 → 推送
│   └── register-task.ps1      注册/取消计划任务
└── logs/                 运行日志（保留 14 天，不入库）
```

## 使用

```powershell
# 手动采集一次
node src\collect.mjs

# 首次使用建议回补 30 天
node src\collect.mjs --since 720

# 注册计划任务（默认 30 分钟）
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1

# 自定义频率
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Minutes 15

# 取消
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Unregister
```

## 采集脚本特性

- **幂等**：按条目 id 去重，重复运行不会产生重复条目
- **增量**：只抓时间窗内的新内容（默认 24h），已入库的自动丢弃
- **容错**：每个源独立 try/catch，全失败才返回非 0
- **零依赖**：只用 Node 内置 `fetch`，不装任何 npm 包
- **有界**：单日归档最多保留 800 条，日志保留 14 天

### 一个踩过的坑

`<![CDATA[...]]>` 包裹的 RSS 内容会被常规的 `<[^>]+>` 标签清理正则**整段吞掉**，
导致国家统计局这类源的标题变空、被静默丢弃（表现为"源成功但 0 条"）。
`src/sources.mjs` 的 `stripTags()` 已先提取 CDATA 内容再清标签。

## 部署

1. 在 GitHub 上新建仓库（建议 `macro-news`）
2. 推送代码：
   ```powershell
   git remote add origin https://github.com/<你的账号>/macro-news.git
   git push -u origin main
   ```
3. 仓库 Settings → Pages → Source 选 `main` 分支、根目录
4. 等待 1-2 分钟生效

## 待办 / 可扩展

- [ ] 接入 FRED API（美债收益率等时间序列，需申请免费 key）
- [ ] 增加更多官方源（IMF / 世界银行 / 中国人民银行）
- [ ] 条目按 6 大类资产打标，关联到 micro-control-finance 的章节
- [ ] 周报自动生成（可选，会引入 AI 调用成本）
