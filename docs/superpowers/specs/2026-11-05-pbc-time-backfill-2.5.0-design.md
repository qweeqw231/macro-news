# 2.5.0 PBOC 时间与错日回填 · 设计

> 中版本依据：修复会造成用户可见错误数据——54 条 PBOC 条目被归到前一个新闻日，
> 11-05 文件看起来完全没有 PBOC，而 11-04 多了当天发布的条目。
> 按 CHANGELOG 版本规则「修复会造成用户可见错误数据、数据丢失、无法使用的缺陷」进中版本。

## 1. PBOC 时间戳（P0）

`src/pbc-time.mjs` 从详情页 URL 提取 14 位 `YYYYMMDDHHMMSS`：

```
/goutongjiaoliu/113456/113469/2026110516262373524/index.html
                                └──────┬──────┘
                                  2026-11-05 16:26:23 +08:00
```

- 按北京时间解释，输出 `ts` / `time`（`+08:00`）/ `day`（UTC 日期，即新闻日）。
- 校验月/日/时/分/秒，2 月 30 日这类非法日期回读校验后返回 `null`。
- `src/sources.mjs` 优先用精确时间；`null` 时回退到原来的 `YYYY-MM-DDT00:00:00+08:00`，
  不抛错、不让源整体失败。
- 73/73 条历史 PBOC URL 均可解析，作为可靠字段。

## 2. 页脚文案（P1）

`assets/app.js` 的 `x/y 源失败` 分子是**成功源数**，文案写反。改为 `x/y 源正常`。
悬停标题仍逐源列出失败原因；来源状态表仍按源显示“失败”，语义正确。
2.4.17 验收文档中的「7/8 源失败」同步改为「7/8 源正常」。

## 3. 失败原因（P1）

`src/source-error.mjs` 的 `describeSourceError(err)`：

- 取根错误或 `cause` 链上第一个非空 `code`；
- `code` 与 `message` 取同一层，避免错配；
- 支持 `AggregateError.errors[]`，最多 8 层，防循环；
- 输出可选字段 `causeCode` / `causeMessage`，写入 `_last-run.json` 的源状态。
- 旧快照没有这两个字段；页面只读 `ok/label/count/ms/error`，向后兼容。

## 4. 错日回填（中版本）

`scripts/backfill-pbc-days.mjs`：

- **显式路径**：必须 `--root <仓库根>`，无默认根路径。
- 扫描 `data/archive/*.json`，只处理 `source === '中国人民银行'` 且 URL 可解析的条目。
- 按 URL 真实时间重算 `ts/time/day`，从原文件移到目标文件；目标文件不存在则新建。
- 目标日已有同 id 的副本（旧版重复写盘）时：用真实时间覆盖目标副本，删除错日副本。
- 不调用 `selectDayItems`，不补空位、不裁剪；目标日超过 800 时只报告。
- 重算 `index.json`（保留 `hasBriefing/briefLine/source`）、`latest.json`、`search.json`。
- 幂等：第二次运行 `moved=updated=merged=0`，不写盘。
- 守恒校验：PBOC **唯一文章数**不变；归档总条数只减少“同 id 重复副本”的数量。

### 实测结果

- 73 条 PBOC 归档 = **54 篇唯一文章 + 19 份同 id 重复副本**。
- 跨日移动 54 条；仅更新时间（已在对日的重复副本）19 条；合并重复 19 对。
- PBOC 条目 73 → 54，唯一文章 54 → 54。
- 总归档 22,261 → 22,242（减少的 19 条全部是重复副本，不是文章丢失）。
- 11-04 800 → 797；11-05 800 → 804；11-03 800 → 802。
- 11-03/11-05 超过 800，脚本**不裁剪**；下一轮采集按 2.4.21 配额自然回到 800。
- 未重跑配额选材。

## 5. 测试

- `tests/pbc-time.test.mjs`：合法/午夜边界/畸形/缺失回退/静态接线。
- `tests/footer-source-ratio.test.mjs`：页脚与 2.4.17 文档语义。
- `tests/source-error.test.mjs`：无 cause、单层、嵌套、AggregateError、循环、旧快照兼容。
- `tests/backfill-pbc.test.mjs`：跨日、重复合并、唯一文章守恒、幂等、仅更新时间、缺少 `--root`。
