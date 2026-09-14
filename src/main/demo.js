// demo.js — 示范模式：展示层数据全部伪造，隐藏真实花销（登录仍可用）
// 5 个示例 API（示例api1~5），花销 ≈ 真实值 ×10 ± 随机抖动；未登录时用合成数据兜底。
// 开启方式：config 里 demo:true，或环境变量 DS_DEMO=1（示范版文件夹）。
const store = require('./store');

const isDemo = () => !!(store.getSettings().demo || process.env.DS_DEMO === '1');

const DEMO_NAMES = ['示例api1', '示例api2', '示例api3', '示例api4', '示例api5'];
const KEY_IDS = ['demo-key-1', 'demo-key-2', 'demo-key-3', 'demo-key-4', 'demo-key-5'];
const MODELS = ['deepseek-flash', 'deepseek-v4-pro'];

// mulberry32 伪随机：固定种子 → 同一日期数据稳定，刷新不跳变
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// 示例 API 的固定占比（示例api1 始终最大，观感稳定）
const KEY_PROFILE = (() => {
  const rand = mulberry32(hashStr('demo-keys'));
  const w = DEMO_NAMES.map(() => 0.08 + rand() * 0.32);
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((x) => x / s);
})();

function dayTotals(d) {
  let cost = 0, tokens = 0, reqs = 0;
  for (const kid of Object.keys(d.cells || {})) {
    for (const m of Object.keys(d.cells[kid])) {
      const c = d.cells[kid][m] || {};
      cost += c.c || 0; tokens += c.t || 0; reqs += c.r || 0;
    }
  }
  return { cost, tokens, reqs };
}

// 某天的伪造数据：真实当日总量 ×10 ± 抖动，摊到 5 示例key × 2 模型
function fakeDay(date, real) {
  const rand = mulberry32(hashStr('demo:' + date));
  const dayScale = 10 + (rand() * 0.8 - 0.4); // ×10 ±40%
  const cost = Math.max(real.cost, 0.01), tokens = Math.max(real.tokens, 0), reqs = Math.max(real.reqs, 0);
  const cells = {};
  for (let i = 0; i < DEMO_NAMES.length; i++) {
    const kf = KEY_PROFILE[i] * (0.85 + rand() * 0.3);
    cells[KEY_IDS[i]] = {
      [MODELS[0]]: {
        c: +(cost * dayScale * kf * 0.6).toFixed(2),
        t: Math.round(tokens * dayScale * kf * 0.6),
        r: Math.round(reqs * dayScale * kf * 0.6),
      },
      [MODELS[1]]: {
        c: +(cost * dayScale * kf * 0.4).toFixed(2),
        t: Math.round(tokens * dayScale * kf * 0.4),
        r: Math.round(reqs * dayScale * kf * 0.4),
      },
    };
  }
  return { date, cells };
}

function aggregate(days) {
  const t = { cost: 0, tokens: 0, requests: 0 };
  for (const d of days) {
    const r = dayTotals(d);
    t.cost += r.cost; t.tokens += r.tokens; t.requests += r.reqs;
  }
  return t;
}

function synthDate(offsetDays) {
  const d = new Date(Date.now() - offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function transform(data) {
  const realDays = (data.days || []).filter((d) => d && d.date);
  let days;
  if (realDays.length) {
    days = realDays.map((d) => fakeDay(d.date, dayTotals(d)));
  } else {
    // 未登录/无数据：合成近30天，金额递增
    const rand = mulberry32(hashStr('demo-synth'));
    let cost = 8, tokens = 200000, reqs = 400;
    days = [];
    for (let i = 29; i >= 0; i--) {
      cost += rand() * 2;
      days.push(fakeDay(synthDate(i), { cost, tokens, reqs }));
      tokens += Math.round(rand() * 40000);
      reqs += Math.round(rand() * 60);
    }
  }

  // 今日：优先用真实今日伪造，否则取最后一天
  let today;
  if (data.today && data.today.date) {
    today = fakeDay(data.today.date, dayTotals(data.today));
  } else if (days.length) {
    today = fakeDay(days[days.length - 1].date, dayTotals(days[days.length - 1]));
  } else {
    today = fakeDay(synthDate(0), { cost: 0.5, tokens: 1000, reqs: 5 });
  }

  // 余额：真实值 ×10 ± 20%，无则用固定演示值
  const balRand = mulberry32(hashStr('demo-balance'));
  const balJit = 10 + (balRand() * 0.4 - 0.2);
  const balance = data.balance != null ? +(data.balance * balJit).toFixed(2) : 1280.66;

  return {
    ...data,
    balance,
    apiKeys: KEY_IDS.map((id, i) => ({ trackingId: id, name: DEMO_NAMES[i], sensitiveId: '…' + (1001 + i), valid: true })),
    models: [...MODELS],
    model: MODELS[0],
    days,
    today,
    totals: aggregate(days),
    error: undefined,
  };
}

module.exports = { isDemo, transform };
