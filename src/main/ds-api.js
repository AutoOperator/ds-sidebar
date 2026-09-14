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
const models = require('../shared/models');

const DS_WATCH_DIR = path.join(os.homedir(), '.claude', 'ds-watch');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
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

// 给界面用的模型名：用量数据里的模型已归一到现役两个，配置里的名字也得跟着归一，
// 否则"当前模型"过滤会匹配不上任何一条用量（细条今日就会显示 0）。
const getCanonicalModel = () => models.canonicalModel(getModel());

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

// ── 时间范围 ──
// 平台的桶网格锚定在请求的 start 上：跨度 ≤24h 给小时桶，≥48h 给天桶。
// start 必须取北京日 00:00（= UTC 前一日 16:00）——之前按 UTC 日对齐，比北京日早 8 小时，
// 于是"今天"的 24 个小时桶横跨了今天 08:00 → 明天 08:00，被切成两段，取最后一段就成了空数据。
const BJ_OFFSET = 8 * 3600;
const HOUR = 3600;
const DAY_SEC = 86400;

// 北京日 00:00 的 unix 秒
function bjMidnightSec(ms) {
  const b = pricing.bjParts(ms == null ? Date.now() : ms);
  return Date.UTC(b.y, b.m - 1, b.day) / 1000 - BJ_OFFSET;
}
// unix 秒 → 北京日期 YYYY-MM-DD
function bjDateStr(sec) {
  return new Date((sec + BJ_OFFSET) * 1000).toISOString().slice(0, 10);
}
// 'YYYY-MM-DD' → 该北京日 00:00 的 unix 秒
function parseBjDate(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000 - BJ_OFFSET : null;
}

// 把筛选条件解析成实际查询区间 + 展示标签
function resolveRange(sel) {
  const cfg = sel || {};
  const kind = cfg.range || 'today';
  const todayStart = bjMidnightSec();
  const tomorrow = todayStart + DAY_SEC;

  if (kind === 'custom') {
    let s = parseBjDate(cfg.start);
    let e = parseBjDate(cfg.end);
    if (s == null) s = todayStart;
    if (e == null) e = todayStart;
    if (e < s) { const t = s; s = e; e = t; }
    const today0 = todayStart;
    if (s > today0) s = today0;          // 不允许选未来
    if (e > today0) e = today0;
    const a = bjDateStr(s), b2 = bjDateStr(e);
    return { kind, start: s, end: e + DAY_SEC, label: a === b2 ? a : a + ' ~ ' + b2 };
  }

  if (kind === 'month') {
    const b = pricing.bjParts();
    return { kind, start: Date.UTC(b.y, b.m - 1, 1) / 1000 - BJ_OFFSET, end: tomorrow, label: '本月' };
  }
  if (kind === 'lastMonth') {
    const b = pricing.bjParts();
    let ly = b.y, lm = b.m - 1;
    if (lm < 1) { lm = 12; ly -= 1; }
    return { kind, start: Date.UTC(ly, lm - 1, 1) / 1000 - BJ_OFFSET, end: Date.UTC(ly, lm, 1) / 1000 - BJ_OFFSET, label: '上月' };
  }
  return { kind: 'today', start: todayStart, end: tomorrow, label: '今日' };
}

// 只解析范围、不取数：取数失败时也要让界面知道当前选的是哪个范围
function rangeMeta(sel) {
  const r = resolveRange(sel);
  return {
    range: r.kind,
    rangeLabel: r.label,
    rangeStart: bjDateStr(r.start),
    rangeEnd: bjDateStr(r.end - DAY_SEC),
    granularity: r.end - r.start <= DAY_SEC ? 'hour' : 'day',
  };
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

// 按桶时间归集成 { 桶: { keyId: { model: {c,t,r} } } }，模型名归一到现役两个
function buildCells(amtSeries, cstSeries) {
  const map = new Map();
  const ensure = (time) => {
    if (!map.has(time)) map.set(time, {});
    return map.get(time);
  };
  for (const s of amtSeries || []) {
    const keyId = (s.api_key && s.api_key.tracking_id) || 'unknown';
    const model = models.canonicalModel(s.model);
    for (const b of s.buckets || []) {
      const cells = ensure(b.time);
      const u = b.usage || {};
      const tokens = (u.PROMPT_CACHE_HIT_TOKEN || 0) + (u.PROMPT_CACHE_MISS_TOKEN || 0) + (u.RESPONSE_TOKEN || 0);
      const req = u.REQUEST || 0;
      const cell = cells[keyId] = cells[keyId] || {};
      const c = cell[model] = cell[model] || { c: 0, t: 0, r: 0 };
      c.t += tokens;
      c.r += req;
    }
  }
  for (const s of cstSeries || []) {
    const keyId = (s.api_key && s.api_key.tracking_id) || 'unknown';
    const model = models.canonicalModel(s.model);
    for (const b of s.buckets || []) {
      const cells = ensure(b.time);
      const cell = cells[keyId] = cells[keyId] || {};
      const c = cell[model] = cell[model] || { c: 0, t: 0, r: 0 };
      c.c += parseFloat(b.cost || '0');
    }
  }
  return map;
}

// 铺满整个区间的桶网格（接口只按已有数据给桶，未来/空桶可能缺，自己补齐保证图上不缺柱）
function buildBuckets(cellsByTime, start, end) {
  const step = end - start <= DAY_SEC ? HOUR : DAY_SEC;
  const hourMode = step === HOUR;
  const out = [];
  for (let t = start; t < end; t += step) {
    const cells = cellsByTime.get(t) || {};
    const d = new Date((t + BJ_OFFSET) * 1000).toISOString();
    out.push({
      t,
      label: hourMode ? d.slice(11, 16) : d.slice(5, 10),   // 小时桶显示 HH:MM，天桶显示 MM-DD
      full: hourMode ? d.slice(5, 16).replace('T', ' ') : d.slice(0, 10),
      cells,
    });
  }
  return out;
}

// 把多个桶的 cells 合成一份（今日总量用）
function mergeCells(list) {
  const out = {};
  for (const cells of list) {
    for (const kid of Object.keys(cells)) {
      for (const m of Object.keys(cells[kid])) {
        const src = cells[kid][m];
        const dst = ((out[kid] = out[kid] || {})[m] = out[kid][m] || { c: 0, t: 0, r: 0 });
        dst.c += src.c; dst.t += src.t; dst.r += src.r;
      }
    }
  }
  return out;
}

function aggregate(buckets) {
  const totals = { cost: 0, tokens: 0, requests: 0 };
  for (const b of buckets) {
    for (const kid of Object.keys(b.cells)) {
      for (const m of Object.keys(b.cells[kid])) {
        const cell = b.cells[kid][m];
        totals.cost += cell.c;
        totals.tokens += cell.t;
        totals.requests += cell.r;
      }
    }
  }
  return totals;
}

// ── 统计（范围数据 + 今日数据 + 密钥列表）──
async function getStats(rangeSel, force) {
  const r = resolveRange(rangeSel);
  const todayStart = bjMidnightSec();
  const needTodayFetch = !(r.kind === 'today');

  const jobs = [
    fetchRangeRaw(r.start, r.end, 'range:' + r.kind + ':' + r.start + ':' + r.end, force),
    needTodayFetch ? fetchRangeRaw(todayStart, todayStart + DAY_SEC, 'today:' + todayStart, force) : Promise.resolve(null),
    getApiKeyList(force),
  ];
  const [rangeRaw, todayRaw, apiKeys] = await Promise.all(jobs);

  const rangeCells = buildCells(rangeRaw.amtSeries, rangeRaw.cstSeries);
  const buckets = buildBuckets(rangeCells, r.start, r.end);

  // 今日：北京日 00:00-24:00（小时桶），与当前选中范围无关，细条一直看"今天"
  const todayCells = todayRaw ? buildCells(todayRaw.amtSeries, todayRaw.cstSeries) : rangeCells;
  const todayBucketList = [];
  for (let t = todayStart; t < todayStart + DAY_SEC; t += HOUR) {
    if (todayCells.has(t)) todayBucketList.push(todayCells.get(t));
  }
  const today = { label: bjDateStr(todayStart), cells: mergeCells(todayBucketList) };

  const modelSet = new Set();
  for (const b of buckets) for (const kid of Object.keys(b.cells)) for (const m of Object.keys(b.cells[kid])) modelSet.add(m);
  const models = [...modelSet].sort();

  return {
    range: r.kind,
    rangeStart: bjDateStr(r.start),
    rangeEnd: bjDateStr(r.end - DAY_SEC),
    rangeLabel: r.label,
    granularity: buckets.length > 1 && buckets[1].t - buckets[0].t === HOUR ? 'hour' : 'day',
    apiKeys,
    models,
    buckets,
    today,
    totals: aggregate(buckets),
  };
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

module.exports = { getBalance, getStats, getApiKeyList, getPriceMode, getNow, getModel, getCanonicalModel, getCreds, rangeMeta };
