# GitHub runner 出网抢跑：统计局源抓取失败的根因记录

## 结论

统计局源（`www.stats.gov.cn`）在 GitHub Actions runner 上的偶发抓取失败，不是源端拦截、也不是 UA/Referer 问题，而是 Node 的 Happy Eyeballs 连接竞速在 runner 网络环境下过早放弃 IPv4 分支：

- runner 同时解析出 IPv4 与 IPv6，`autoSelectFamily` 默认 250ms 作为第一条分支的等待窗口；
- runner 到该站的 IPv6 链路实际不可用（或首包极慢），IPv4 往往需要 >250ms 才建连；
- 结果是在 250ms 处直接判定失败并抛出连接错误，表现为采集轮次的 `fetch failed`。

把 `autoSelectFamilyAttemptTimeout` 放宽到 3000ms 后，同一 runner 上 **0/40 次失败**，说明这不是网络不可达，而是等待窗口过短导致的抢跑。

## 实测方式

临时诊断 workflow 只做只读网络测试、不写 `data/`：

1. 用现行 fetch 路径连续请求 8 次（每次独立进程，模拟生产单轮），记录 `status / bytes / ms`；
2. 用 `net.connect` 人为把 DNS 结果固定成「先 IPv4、后 IPv6」，分别在默认 250ms 与 3000ms 两个 `autoSelectFamilyAttemptTimeout` 下各跑 12 次，统计失败数与耗时分布。

workflow 本身在 GitHub 侧用完即删，本地副本保留在 `tmp/diag-stats.local.yml`（`tmp/` 已在 `.gitignore` 内）。再次需要复现时，把它拷回 `.github/workflows/diag-stats.yml` 触发即可，跑完删除。

## 判据

| 观测 | 250ms（默认） | 3000ms |
|---|---|---|
| 连续请求失败 | 出现 `fetch failed`，`cause.code` 为连接类错误 | 0/40 |
| 失败与源端返回 | 无 HTTP 状态码，连接未建立 | — |

## 影响与边界

- 只影响跑在 GitHub runner 上的采集任务；本机采集链路不复现（本机 IPv6 可达性不同）。
- 该结论不改变「源健康状态」的口径：运维展示层仍按实际成功/失败计数，不需要为 runner 特例开白。
- 若后续把采集迁到自建 runner 或固定出网环境，此条不再适用，需要重新实测。

## 落地情况（2026-11-19 已实现）

`src/collect.mjs` 在采集启动时已设置 `net.setDefaultAutoSelectFamilyAttemptTimeout(3000)`
（见 `src/collect.mjs:306`，随 2.27.1 发布，`CHANGELOG.md` 2.27.1 有记录，
`tests/pbc-fetch.test.mjs` 做了源码锁定防止回退）。

即生产采集**已不再走** Node 默认的 250ms 等待窗口，本记录不再有「待实现」项。
若后续把采集迁到自建 runner 或固定出网环境，需要重新实测后决定是否保留这个值。
