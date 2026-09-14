// ds-api.js — DeepSeek 数据获取（余额 + 按 API Key × 模型 × 天 的用量）
// 只认 User Token，不碰 API Key（API Key 输入框 v1.4.0 已删；旧代码会拿它回退请求余额，
// 但那还要求读 ~/.claude/settings.json 里 Claude 的 ANTHROPIC_AUTH_TOKEN —— 跨项目用凭证，已拆掉）：
//   余额      GET https://platform.deepseek.com/api/v0/users/get_user_summary          (Bearer user_token)
//   用量      GET https://platform.deepseek.com/api/v0/usage/by_api_key/{amount,cost}  (Bearer user_token)
//   密钥列表  GET https://platform.deepseek.com/api/v0/users/get_api_keys              (Bearer user_token)
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('./store');
const { decrypt } = require('./credential-store');
const pricing = require('../shared/pricing');

const DS_WATCH_DIR = path.join(os.homedir(), '.claude', 'ds-watch');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOUR_8 = pricing.HOUR_8;
const DAY = pricing.DAY;
const CACHE_TTL = 60000;

// 纯净模式：设置 DS_CLEAN_MODE=1 时不回退读取 ~/.claude 配置，仅用应用内设置的凭证
const cleanMode = () => !!process.env.DS_CLEAN_MODE;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// ── 凭证：只用 User Token（应用设置 → ds-watch 文件；纯净模式禁用回退）──
function getUserToken() {
  const s = store.getSettings();
  // 应用内保存过就用它；解密失败（换了机器/用户，DPAPI 解不开）再回退 ds-watch 文件
  const saved = s.userToken ? decrypt(s.userToken) : '';
  if (saved) return saved;
  if (cleanMode()) return null;
  try { return fs.readFileSync(path.join(DS_WATCH_DIR, 'user_token'), 'utf8').trim(); } catch { return null; }
}

// 当前模型名：必须原样返回配置里的值，才能和用量接口里的 model 字段对上（不做新旧名归一）。
// 仅在没有任何配置时兜底用官方现名 deepseek-flash（旧名 deepseek-v4-flash 已退役，
// 现已由 deepseek-flash 承载；deepseek-v4-pro 仍在服务）。
function getModel() {
  if (cleanMode()) return 'deepseek-flash';
  const s = readJson(SETTINGS_PATH, {});
  const env = s.env || {};
  return env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'deepseek-flash';
}

// 北京时间（平台按北京日期切天）
const bjParts = () => pricing.bjParts();

// 价格模式：工作日 9-12 / 14-18（北京时间）= 高峰，其余（含周末全天）= 低谷
const getPriceMode = () => pricing.getPriceMode();

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
// User Token 余额：平台 get_user_summary（网页右上角同款接口，只认 User Token）
async function getSummaryBalance(token) {
  const j = await fetchJson('https://platform.deepseek.com/api/v0/users/get_user_summary', {
    ...BROWSER_HEADERS,
    'Authorization': 'Bearer ' + token,
  });
  const wallets = j.data && j.data.biz_data && j.data.biz_data.normal_wallets;
  return (wallets && wallets.length) ? parseFloat(wallets[0].balance) : null;
}
async function getBalance(force) {
  const now = Date.now();
  if (!force && balCache.value !== null && now - balCache.ts < 30000) return balCache.value;
  const token = getUserToken();
  if (token) {
    try {
      const v = await getSummaryBalance(token);
      if (v != null) { balCache = { value: v, ts: now }; return v; }
    } catch { /* 平台余额失败：沿用上次的值，不再回退 API Key */ }
  }
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
  let fileToken = null;
  if (!cleanMode()) {
    try { fileToken = fs.readFileSync(path.join(DS_WATCH_DIR, 'user_token'), 'utf8').trim(); } catch { /* 忽略 */ }
  }
  // 来源按"实际取到的值"报，解密失败（换机器/换用户）时不要谎报成 settings
  const savedToken = decrypt(s.userToken);
  return {
    userToken: savedToken || fileToken || '',
    userTokenSource: savedToken ? 'settings' : (fileToken ? 'ds-watch' : 'none'),
  };
}

module.exports = { getBalance, getStats, getApiKeyList, getPriceMode, getNow, getModel, getCreds };
