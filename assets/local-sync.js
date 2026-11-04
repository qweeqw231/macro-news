/* assets/local-sync.js
 * 2.4.17：本机同步兜底状态（localSync）的纯逻辑。
 * 浏览器挂到 window.MacroLocalSync；Node 测试 / 本地写盘脚本可 require（UMD）。
 */
(function (global) {
  'use strict';

  var RESULTS = [
    'up-to-date',
    'ff-only',
    'stash-restored',
    'merge',
    'skipped:fetch-failed',
    'skipped:stash-failed',
    'skipped:ff-only-failed',
    'skipped:stash-pop-conflict',
    'skipped:unmerged',
    'skipped:merge-conflict',
  ];

  var REASON_TEXT = {
    'skipped:fetch-failed': 'git fetch 失败',
    'skipped:stash-failed': '本地改动暂存失败',
    'skipped:ff-only-failed': 'fast-forward 失败',
    'skipped:stash-pop-conflict': 'stash 恢复冲突',
    'skipped:unmerged': '存在未合并文件',
    'skipped:merge-conflict': '合并冲突',
  };

  function isSkipResult(result) {
    return String(result || '').indexOf('skipped:') === 0;
  }

  function reasonOf(result) {
    return isSkipResult(result) ? (REASON_TEXT[result] || String(result)) : '';
  }

  /** 计数：跳过 +1；成功（非 skipped:）重置 0 */
  function nextLocalSync(prev, result, at) {
    var n = Number(prev && prev.consecutiveSkips) || 0;
    var skipped = isSkipResult(result);
    return {
      result: String(result || ''),
      reason: reasonOf(result),
      at: at || new Date().toISOString(),
      consecutiveSkips: skipped ? n + 1 : 0,
    };
  }

  /** 只替换 localSync，云端写入的其它字段原样保留 */
  function mergeLocalSync(doc, sync) {
    var out = Object.assign({}, doc && typeof doc === 'object' ? doc : {});
    out.localSync = sync;
    return out;
  }

  /** 页脚展示：0 隐藏；1~2 琥珀；≥3 红色 */
  function localSyncView(sync) {
    var n = Number(sync && sync.consecutiveSkips) || 0;
    if (n <= 0) return { show: false, level: 'ok', text: '', title: '' };
    var reason = (sync && sync.reason) || reasonOf(sync && sync.result) || '未知原因';
    return {
      show: true,
      level: n >= 3 ? 'bad' : 'warn',
      text: '本机同步跳过 ' + n + ' 轮 · ' + reason,
      title: '本机兜底连续跳过 ' + n + ' 轮；云端主链路可能仍正常；原因：' + reason +
        '；最近：' + (sync && sync.at ? sync.at : '—') +
        '；结果：' + (sync && sync.result ? sync.result : '—'),
    };
  }

  var api = {
    RESULTS: RESULTS,
    REASON_TEXT: REASON_TEXT,
    isSkipResult: isSkipResult,
    reasonOf: reasonOf,
    nextLocalSync: nextLocalSync,
    mergeLocalSync: mergeLocalSync,
    localSyncView: localSyncView,
  };

  global.MacroLocalSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
