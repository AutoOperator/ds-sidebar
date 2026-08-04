// ds-api.js — DeepSeek 数据获取（余额 + 按 API Key × 模型 × 天 的用量）
// 数据源：
//   余额      GET https://api.deepseek.com/user/balance              (Bearer API key)
//   用量      GET https://platform.deepseek.com/api/v0/usage/by_api_key/{amount,cost}  (Bearer user_token)
//   密钥列表  GET https://platform.deepseek.com/api/v0/users/get_api_keys             (Bearer user_token)
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('./store');

const DS_WATCH_DIR = path.join(os.homedir(), '.claude', 'ds-watch');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOUR_8 = 8 * 3600 * 1000;
const DAY = 86400000;
const CACHE_TTL = 60000;

// 纯净模式：设置 DS_CLEAN_MODE=1 时不回退读取 ~/.claude 配置，仅用应用内设置的凭证
const cleanMode = () => !!process.env.DS_CLEAN_MODE;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// ── 凭证：优先应用设置，其次 Claude 配置 / ds-watch（纯净模式禁用回退）──
function getApiKey() {
  const s = store.getSettings();
  if (s.apiKey) return s.apiKey;
  if (cleanMode()) return '';
  const cfg = readJson(SETTINGS_PATH, {});
  return (cfg.env && cfg.env.ANTHROPIC_AUTH_TOKEN) || '';
}

function getUserToken() {
  const s = store.getSettings();
  if (s.userToken) return s.userToken;
  if (cleanMode()) return null;
  try { return fs.readFileSync(path.join(DS_WATCH_DIR, 'user_token'), 'utf8').trim(); } catch { return null; }
}

function getModel() {
  if (cleanMode()) return 'deepseek-v4-flash';
  const s = readJson(SETTINGS_PATH, {});
  const env = s.env || {};
  return env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'deepseek-v4-flash';
}

// 北京时间（平台按北京日期切天）
function bjParts() {
  const d = new Date(Date.now() + HOUR_8);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

// 价格模式：DeepSeek 繁忙时段 9-12 / 14-18（北京时间）= 双倍，其余平价
function getPriceMode() {
  const h = bjParts().h;
  if ((h >= 9 && h < 12) || (h >= 14 && h < 18)) return { mode: '双倍', busy: true };
  return { mode: '平价', busy: false };
}

function getNow() {
  const b = bjParts();
  return `${b.y}-${String(b.m).padStart(2, '0')}-${String(b.day).padStart(2, '0')} ${String(b.h).padStart(2, '0')}:${String(b.min).padStart(2, '0')}:${String(b.s).padStart(2, '0')}`;
}

const BROWSER_HEADERS = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Origin': 'https://platform.deepseek.com',
  'Referer': 'https://platform.deepseek.com/usage',
};

async function fetchJson(url, headers, timeout = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ── 余额（30s 缓存）──
let balCache = { value: null, ts: 0 };
async function getBalance(force) {
  const now = Date.now();
  if (!force && balCache.value !== null && now - balCache.ts < 30000) return balCache.value;
  const key = getApiKey();
  if (!key) return balCache.value;
  try {
    const data = await fetchJson('https://api.deepseek.com/user/balance', {
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + key,
    });
    if (data.is_available && data.balance_infos && data.balance_infos.length) {
      balCache = { value: parseFloat(data.balance_infos[0].total_balance), ts: now };
      return balCache.value;
    }
  } catch { /* 网络失败：返回缓存 */ }
  return balCache.value;
}

// ── 范围 → UTC 午夜 unix 秒（by_api_key 接口只接受 UTC 对齐，与官方网页一致）──
function rangeToSecs(range) {
  const day = 86400;
  const now = new Date();
  const utcToday = Math.floor(Date.now() / DAY) * DAY / 1000;
  const tomorrow = utcToday + day;
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  switch (range) {
    case '7d': return { start: utcToday - 6 * day, end: tomorrow };
    case 'month': return { start: Date.UTC(y, m, 1) / 1000, end: tomorrow };
    case 'lastMonth': {
      let ly = y, lm = m - 1;
      if (lm < 0) { lm = 11; ly -= 1; }
      return { start: Date.UTC(ly, lm, 1) / 1000, end: Date.UTC(y, m, 1) / 1000 };
    }
    case '30d':
    default: return { start: utcToday - 29 * day, end: tomorrow };
  }
}

function bjDate(time) {
  return new Date(time * 1000 + HOUR_8).toISOString().slice(0, 10);
}

// ── 拉取 by_api_key 原始数据 ──
let rawCache = { key: null, ts: 0, data: null };
async function fetchRangeRaw(start, end, cacheKey, force) {
  const now = Date.now();
  if (!force && rawCache.key === cacheKey && rawCache.data && now - rawCache.ts < CACHE_TTL) return rawCache.data;
  const token = getUserToken();
  if (!token) throw new Error('user_token 不存在');
  const headers = { ...BROWSER_HEADERS, 'Authorization': 'Bearer ' + token };
  const [amt, cst] = await Promise.all([
    fetchJson(`https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=${start}&end=${end}`, headers),
    fetchJson(`https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${start}&end=${end}`, headers),
  ]);
  const amtSeries = (amt.data && amt.data.biz_data && amt.data.biz_data.series) || [];
  const cstData = cst.data && cst.data.biz_data && cst.data.biz_data.data;
  const cstSeries = (cstData && cstData[0] && cstData[0].series) || [];
  const data = { amtSeries, cstSeries };
  rawCache = { key: cacheKey, ts: now, data };
  return data;
}

// 合并成 每天 { date, cells: { keyId: { model: {c,t,r} } } }
function buildDays(amtSeries, cstSeries) {
  const map = new Map();
  const ensure = (time) => {
    if (!map.has(time)) map.set(time, { date: bjDate(time), cells: {} });
    return map.get(time);
  };
  for (const s of amtSeries || []) {
    const keyId = s.api_key && s.api_key.tracking_id;
    const model = s.model || 'unknown';
    for (const b of s.buckets || []) {
      const day = ensure(b.time);
      const u = b.usage || {};
      const tokens = (u.PROMPT_CACHE_HIT_TOKEN || 0) + (u.PROMPT_CACHE_MISS_TOKEN || 0) + (u.RESPONSE_TOKEN || 0);
      const req = u.REQUEST || 0;
      const cell = day.cells[keyId] = day.cells[keyId] || {};
      const c = cell[model] = cell[model] || { c: 0, t: 0, r: 0 };
      c.t += tokens;
      c.r += req;
    }
  }
  for (const s of cstSeries || []) {
    const keyId = s.api_key && s.api_key.tracking_id;
    const model = s.model || 'unknown';
    for (const b of s.buckets || []) {
      const day = ensure(b.time);
      const cell = day.cells[keyId] = day.cells[keyId] || {};
      const c = cell[model] = cell[model] || { c: 0, t: 0, r: 0 };
      c.c += parseFloat(b.cost || '0');
    }
  }
  return [...map.values()].sort((a, b2) => (a.date < b2.date ? -1 : 1));
}

function aggregate(days) {
  const totals = { cost: 0, tokens: 0, requests: 0 };
  for (const d of days) {
    for (const kid of Object.keys(d.cells)) {
      for (const m of Object.keys(d.cells[kid])) {
        const cell = d.cells[kid][m];
        totals.cost += cell.c;
        totals.tokens += cell.t;
        totals.requests += cell.r;
      }
    }
  }
  return totals;
}

// ── 统计（范围数据 + 今日数据 + 密钥列表）──
async function getStats(range, force) {
  const { start, end } = rangeToSecs(range);
  const utcToday = Math.floor(Date.now() / DAY) * DAY / 1000;

  const [rangeRaw, todayRaw, apiKeys] = await Promise.all([
    fetchRangeRaw(start, end, 'range:' + range, force),
    fetchRangeRaw(utcToday, utcToday + 86400, 'today', force),
    getApiKeyList(force),
  ]);

  const days = buildDays(rangeRaw.amtSeries, rangeRaw.cstSeries);
  const todayDays = buildDays(todayRaw.amtSeries, todayRaw.cstSeries);
  const today = todayDays[todayDays.length - 1] || { date: null, cells: {} };

  const modelSet = new Set();
  for (const d of days) for (const kid of Object.keys(d.cells)) for (const m of Object.keys(d.cells[kid])) modelSet.add(m);
  const models = [...modelSet].sort();

  return { range, apiKeys, models, days, today, totals: aggregate(days) };
}

// ── API Key 列表（60s 缓存）──
let keysCache = { ts: 0, data: null };
async function getApiKeyList(force) {
  const now = Date.now();
  if (!force && keysCache.data && now - keysCache.ts < CACHE_TTL) return keysCache.data;
  const token = getUserToken();
  if (!token) return keysCache.data || [];
  try {
    const j = await fetchJson('https://platform.deepseek.com/api/v0/users/get_api_keys', {
      ...BROWSER_HEADERS,
      'Authorization': 'Bearer ' + token,
    });
    const keys = (j.data && j.data.biz_data && j.data.biz_data.api_keys) || [];
    keysCache = {
      ts: now,
      data: keys.map((k) => ({ trackingId: k.tracking_id, name: k.name, sensitiveId: k.sensitive_id, valid: k.valid != null ? k.valid : true })),
    };
    return keysCache.data;
  } catch { return keysCache.data || []; }
}

// ── 设置页回显凭证（含来源）──
function getCreds() {
  const s = store.getSettings();
  const claudeKey = !cleanMode() && (readJson(SETTINGS_PATH, {}).env || {}).ANTHROPIC_AUTH_TOKEN || '';
  let fileToken = null;
  if (!cleanMode()) {
    try { fileToken = fs.readFileSync(path.join(DS_WATCH_DIR, 'user_token'), 'utf8').trim(); } catch { /* 忽略 */ }
  }
  return {
    apiKey: s.apiKey || claudeKey,
    apiKeySource: s.apiKey ? 'settings' : (claudeKey ? 'claude' : 'none'),
    userToken: s.userToken || fileToken || '',
    userTokenSource: s.userToken ? 'settings' : (fileToken ? 'ds-watch' : 'none'),
  };
}

module.exports = { getBalance, getStats, getApiKeyList, getPriceMode, getNow, getModel, getCreds };
