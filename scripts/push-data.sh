#!/usr/bin/env bash
# scripts/push-data.sh —— 四个写数据的 workflow 共用的「提交 + 推送」逻辑
#
# 为什么抽出来（而不是每个 workflow 各写一遍）：
#   1. SSH-443 推送会被随机 reset（实测：连续 4 次失败、第 5 次成功是常态）⇒ 必须重试；
#   2. 四个 workflow 现在**各自独立**（concurrency group 分开，见各 yml 里的说明），
#      同一时刻可能有两条链路同时在推 main ⇒ 每次重试前都要 fetch + rebase，
#      否则永远 non-fast-forward；
#   3. rebase 冲突时**放弃本轮**（数据已经采集到 runner 上，下一轮会重采），
#      绝不用 force push 覆盖别人的提交。
#
# 用法：
#   bash scripts/push-data.sh data
#   bash scripts/push-data.sh data/kline MSG_PREFIX="data: 服务端预生成分钟K"
#
# 退出码恒为 0：推送失败不是作业失败（数据没丢，下一轮会再推），
#   标红只会把真正的问题淹没在噪声里 —— 与 update-kline-minute.mjs 的口径一致。

set -uo pipefail

# ⚠ 参数既支持位置路径、也支持 KEY=VALUE 形式：
#   调用方写的是 `bash push-data.sh data MSG_PREFIX="data: 自动采集"`，
#   如果直接把 "$@" 全当路径，`MSG_PREFIX=...` 会被当成一个不存在的 pathspec，
#   `git add` 报 fatal ⇒ 什么都没暂存 ⇒ 脚本打印「本轮无变化」并 exit 0
#   ⇒ 四个 workflow 全部静默不提交。必须把 KEY=VALUE 挑出来。
STAGE_PATHS=()
for a in "$@"; do
  case "$a" in
    MSG_PREFIX=*) MSG_PREFIX="${a#MSG_PREFIX=}" ;;
    *) STAGE_PATHS+=("$a") ;;
  esac
done
if [ "${#STAGE_PATHS[@]}" -eq 0 ]; then
  STAGE_PATHS=(data)
fi

git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git add -- "${STAGE_PATHS[@]}"
if [ $? -ne 0 ]; then
  echo "❌ git add 失败：${STAGE_PATHS[*]}（路径不存在或不是仓库路径）"
  exit 1   # 配置错误要标红，别像「无变化」那样静默吞掉
fi
if git diff --staged --quiet; then
  echo "本轮无变化（采集器已跳过未变更文件），不提交"
  exit 0
fi

n=$(git diff --staged --name-only | wc -l)
prefix="${MSG_PREFIX:-data: 自动更新}"
stamp=$(date -u '+%Y-%m-%d %H:%M UTC')
git commit -m "${prefix}（${stamp}，${n} 个文件）"

# 推送成功后显式触发一次 Pages 部署。
# ⚠ 为什么必须显式触发：Actions 里推送用的是默认 GITHUB_TOKEN，而
#   「用 GITHUB_TOKEN 产生的 push 事件不会创建新的 workflow run」（GitHub 防递归规则）。
#   2026-11-15 把 Pages 源从「分支构建」切到「自定义 Actions」后，分支构建不再兜底
#   ⇒ 这类推送既不触发 pages.yml、也不会自动发布，站点会停更（当天实测：线上 index.json
#   停在 09:52，仓库已到 10:08）。定时兜底不可靠，所以在推送处直接 dispatch。
#   失败不影响作业（下一轮或 pages.yml 的定时兜底会补）。
notify_pages() {
  if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then return 0; fi
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/pages.yml/dispatches" \
    -d '{"ref":"main"}' 2>/dev/null || echo 000)
  case "$code" in
    204) echo "已触发 Pages 部署" ;;
    *)   echo "⚠ Pages 部署触发失败（HTTP $code），交由 pages.yml 定时兜底" ;;
  esac
  return 0
}

for i in 1 2 3 4 5 6; do
  if git push origin main; then
    echo "已提交 ${n} 个文件（第 ${i} 次推送成功）"
    notify_pages
    exit 0
  fi
  echo "推送失败（第 ${i} 次）：fetch + rebase 后重试"
  git fetch origin main || true
  if ! git rebase origin/main; then
    git rebase --abort || true
    echo "rebase 冲突：本轮放弃（不强推，下一轮会重新采集）"
    exit 0
  fi
  sleep 5
done

echo "连续 6 次推送失败：提交仍保留在本 runner 上，等下一轮再推"
exit 0
