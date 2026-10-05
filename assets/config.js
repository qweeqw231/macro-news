// assets/config.js
// 站点配置
//
// 行情与 K 线由浏览器直连东方财富公开接口获取（接口带 CORS 头，国内可直连），
// 无需任何服务器或代理；接口不可达时自动回退到 data/ 下采集器生成的快照。
window.MACRO_CONFIG = {
  POLL_SECONDS: 15,       // 行情轮询间隔（仅在有市场处于交易时段时）
  REFRESH_SECONDS: 20,    // K线弹窗打开且处于交易时段时的自动刷新间隔
  DEFAULT_PERIOD: '1d',   // K线弹窗默认周期
};
