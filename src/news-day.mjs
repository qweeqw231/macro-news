// src/news-day.mjs
// 2.4.18：服务端统一入口。实现只有一份（assets/news-day.js），避免两边算法漂移。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ND = require('../assets/news-day.js');

export const DAY_MS = ND.DAY_MS;
export const newsDay = ND.newsDay;
export const newsToday = ND.newsToday;
export const addDays = ND.addDays;
