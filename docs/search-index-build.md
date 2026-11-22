# 检索索引的构建与回滚（2.33.1）

> 口径真源：`src/search-index.mjs`（热段）、`scripts/build-search-history.mjs`（月度分片）、
> `scripts/build-search.mjs`（部署期入口）、`.github/workflows/pages.yml`（执行顺序）。
> 本文只写「文件从哪来、怎么验证、出问题怎么退」，不重复字段定义。

## 1. 为什么改

`data/search.json` 每天被采集重写约 96 次，在 git 历史里累计 2,339 次提交，
单独打包占 clone 包 **18.88 MiB**（2026-11-22 实测，见 `2026-11-22/search-out-of-git/`）。
它和 `data/search-history/*`（边际 15.86 MiB）都完全由 `data/archive/` 与
`data/history/` 派生，没有必要进版本库。

2.33.1 起两者改为 **Pages 部署时现算**：

```
采集轮（每 15 分钟）
  src/collect.mjs
    └─ buildHotSearchDoc()  →  data/search.json（本地写一份，已被 .gitignore 忽略）

Pages 部署
  checkout（fetch-depth: 1，data/ 完整在树里）
    → node scripts/build-search.mjs
        ├─ 热段：buildHotSearchDoc()        → data/search.json
        └─ 分片：buildSearchHistory()       → data/search-history/*.json
    → upload-pages-artifact（带上上面两份产物）
    → deploy-pages
```

**产物路径、文件名、字段、gzip 体积与迁移前完全一致**，前端零改动：
`data/search.json` 仍是热段 7 天 + `total/hotDays/hotFrom` 字段；
`search-history/manifest.json` 与 `YYYY-MM.json` 结构不变。

## 2. 本地开发

| 场景 | 做法 |
|---|---|
| 正常采集 | `node src/collect.mjs`：会顺带写 `data/search.json`（本地可用） |
| 只重建索引 | `node scripts/build-search.mjs`：约 **5 秒**（分片 4.4s + 热段 0.5s） |
| 本地预览 | `node scripts/serve.mjs`（或 `start.cmd`）：若 `data/search.json` 不存在会先自动生成 |
| 分片校验 | `node scripts/build-search-history.mjs --check` |
| 测试 | `node --test "tests/*.test.mjs"`（搜索相关测试改为调用构建函数，不读仓库固定文件） |

生成的 `data/search.json` / `data/search-history/` 被 `.gitignore` 忽略，**不要强制 add**；
采集脚本白名单里也已移除 `data/search.json`。

## 3. 部署期日志（核对口径）

`node scripts/build-search.mjs` 每次都会打印：

```
[search] 热段 7410 条（窗口 57010 条 / 62 天，其中 history 13 天）· 524 ms
[search-history] 13 个月 · 208500 条 · raw 53.34 MB · gzip 15.44 MB · manifest 1.1 KB · 热段 …
[search] 分片 13 个月 208500 条 · 4439 ms
[search] 合计 4963 ms · data/search.json + data/search-history/*
```

任何一步非 0 退出都会让整次部署失败（`pages.yml` 不加 `continue-on-error`）：
宁可站点停在上一版，也不发布「页面正常但搜索空白」的版本。

## 4. 迁移验证（2026-11-22 实测）

| 验证项 | 结果 |
|---|---|
| 删除两个路径后从零生成 | 成功，4.57 秒；热段 7,410 条 / 窗口 57,010 条，分片 13 个月 208,500 条 |
| 生成内容与迁移前对比 | 热段字段与条目**逐项相同**（`total=57010`、`hotTotal=7410`、`fromHistory=13`，新增/消失 0 条） |
| 本地静态服务 | 搜索「美联储」命中 149 条；点「在历史中搜索」再追加 1,032 条，热段与分片均可用 |
| Pages artifact | 本地按同内容集打包 **63.35 MiB**，与线上 artifact **63.37 MiB** 一致（未膨胀） |
| 连续两轮 collect | 每轮约 63 秒；两轮后 clone 包均为 **144.61 MiB**（无新提交）；`git status` 不再出现 `data/search.json` |

## 5. 回滚流程（目标 10 分钟内）

适用场景：线上搜索 404 / 空白、部署因生成脚本失败而持续不更新、或索引字段异常。

### 5.1 判断

1. 看最近一次 Pages 部署日志：`生成检索索引（不进 git，只进 artifact）` 是否失败；
2. 看线上 `https://<站点>/data/search.json` 是否 200；
3. 若日志成功但线上 404，多半是 artifact 上传/部署竞态，先重跑一次部署（等待 10 秒的重试已内置）。

### 5.2 退回「从 git 读取」（约 5 分钟操作 + 1~2 分钟部署）

```bash
# 1) 找到迁移前最后一个带索引文件的提交
git log --oneline -1 -- data/search.json        # 记下它前面的那个提交（迁移前）
#    也可以直接用迁移提交的父提交：
#    git rev-parse 63ceb342^   ← 63ceb342 是「移除索引」所在的数据提交

# 2) 撤销代码侧改动（collect 内联构建、workflow 生成步骤、gitignore、白名单）
git revert --no-edit 0555f541                   # 2.33.1 的代码提交

# 3) 把索引文件恢复到索引与工作树
git checkout <迁移前提交> -- data/search.json data/search-history
git commit -m "revert: 检索索引回到 git（部署期生成故障）"

# 4) 普通 push（不强推）
git push origin main
```

推送后 `pages.yml` 会因为「生成步骤已随 revert 删除」而直接打包工作树里的索引文件，
1~2 分钟后线上恢复。验证：`/data/search.json` 返回 200 且 `hotTotal > 0`。

> ⚠ 回滚后 clone 包会重新随采集增长（约 0.6 MiB/天，search.json 历史）。
> 修好生成脚本后可以再做一次迁移，步骤与本次相同。

### 5.3 只想临时止血（不改历史）

若怀疑是生成脚本的具体 bug、但不想整笔 revert，可把 `pages.yml` 的生成步骤临时替换为：

```yaml
      - name: 生成检索索引（临时回退：从历史提交取）
        run: |
          git fetch --depth=1 origin <迁移前提交>
          git checkout FETCH_HEAD -- data/search.json data/search-history
```

这样部署仍能带上索引，但会一直用旧索引（采集不再更新它），只适合几小时的止血；
确认修复后再改回 `node scripts/build-search.mjs`。

### 5.4 回滚后必须核对

- `data/search.json` 的 `hotFrom` 是否随日期前进（停在回滚当天说明生成链路仍未恢复）；
- `pages.yml` 里不应同时存在「生成步骤」和「从 git 读取」两套逻辑；
- `.gitignore` 里 `data/search.json` / `data/search-history/` 两行要一并删除，否则恢复的文件仍不会被提交。

## 6. 已知边界

- 部署期生成依赖 `data/history/index.json`、`data/archive/*.json` 的完整性；
  checkout 是 `fetch-depth: 1`，但**这些文件都在工作树里**，不需要 git 历史。
- 生成脚本只读 `data/`，不写回源数据；即使失败也不会破坏采集产物。
- 索引与页面由同一棵工作树生成，天然同版本；不会再出现「索引旧于站点」。
- `scripts/repair-archive.mjs`、`scripts/backfill-pbc-days.mjs` 仍会各自重建
  `data/search.json`（本地修复用），产物同样被忽略；日常链路不依赖它们。
