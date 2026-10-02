// assets/config.js
// 站点配置
//
// ★ Cloudflare Worker 代理（可选）★
// 把你部署 Worker 后拿到的地址填到 WORKER_URL，例如：
//   https://macro-news-proxy.你的子域.workers.dev
// 留空则自动降级为「读取本地采集的 data/quotes.json 与 data/kline/*.json」，
// 此时行情延迟等于采集间隔（约 30 分钟），K线只有日K。
window.MACRO_CONFIG = {
  WORKER_URL: '',
  POLL_SECONDS: 15,        // 前端轮询间隔（仅在有市场开盘时）
  DEFAULT_PERIOD: '1d',
};
