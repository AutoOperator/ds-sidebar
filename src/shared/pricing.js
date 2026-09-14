// pricing.js — DeepSeek 峰谷计费规则（主进程与渲染层共用，避免两份实现各自走偏）
// 官方口径：高峰 = 工作日（周一至周五）北京时间 09:00-12:00、14:00-18:00；
//          其余全部时段（含周六、周日全天）为低谷。低谷单价 = 高峰的一半。
// 既可在 Node 里 require（主进程），也可直接 <script> 引入（渲染层）。
(function (factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (typeof window !== 'undefined' ? window : globalThis).Pricing = factory();
})(function () {
  const HOUR_8 = 8 * 3600 * 1000;
  const DAY = 86400000;
  // 高峰时段（北京时间整点区间，左闭右开）
  const PEAK_WINDOWS = [[9, 12], [14, 18]];

  // 北京时间各字段；w: 0=周日 … 6=周六
  function bjParts(ts) {
    const d = new Date((ts == null ? Date.now() : ts) + HOUR_8);
    return {
      y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate(),
      w: d.getUTCDay(), h: d.getUTCHours(), min: d.getUTCMinutes(), s: d.getUTCSeconds(),
    };
  }

  const isWeekday = (w) => w >= 1 && w <= 5;
  const isPeakHour = (h) => PEAK_WINDOWS.some(([a, b]) => h >= a && h < b);

  // 北京时间「基准日 + dayOffset 天的 hour 点」对应的真实时间戳
  function bjStamp(ts, dayOffset, hour) {
    const b = bjParts(ts);
    return Date.UTC(b.y, b.m - 1, b.day) + dayOffset * DAY + hour * 3600000 - HOUR_8;
  }

  // 下一次峰谷切换的时间戳（当前位于高峰 → 本窗口结束；低谷 → 下一个工作日高峰起点）
  function nextSwitch(ts, busy) {
    const b = bjParts(ts);
    if (busy) {
      const win = PEAK_WINDOWS.find(([a, e]) => b.h >= a && b.h < e);
      if (win) return bjStamp(ts, 0, win[1]);
    }
    for (let d = 0; d <= 7; d++) {
      for (const [start] of PEAK_WINDOWS) {
        const t = bjStamp(ts, d, start);
        if (t > ts && isWeekday(bjParts(t).w)) return t;
      }
    }
    return null;
  }

  function fmtGap(ms) {
    const min = Math.max(0, Math.round(ms / 60000));
    if (min < 60) return min + '分';
    const h = Math.floor(min / 60);
    if (h < 24) return h + '小时' + (min % 60 ? (min % 60) + '分' : '');
    return Math.floor(h / 24) + '天' + (h % 24 ? (h % 24) + '小时' : '');
  }

  function tip(ts, busy) {
    const nxt = nextSwitch(ts, busy);
    const left = nxt == null ? '' : ' · ' + fmtGap(nxt - ts) + '后转' + (busy ? '低谷' : '高峰');
    const rule = busy
      ? '高峰时段：工作日 9:00-12:00 / 14:00-18:00（北京时间）'
      : '低谷时段：高峰以外全时段（含周末全天），单价为高峰的一半';
    return rule + left;
  }

  // → { mode: '高峰' | '低谷', busy: boolean, tip: string }
  function getPriceMode(ts) {
    const b = bjParts(ts);
    const busy = isWeekday(b.w) && isPeakHour(b.h);
    return { mode: busy ? '高峰' : '低谷', busy, tip: tip(ts == null ? Date.now() : ts, busy) };
  }

  return { HOUR_8, DAY, PEAK_WINDOWS, bjParts, isWeekday, isPeakHour, getPriceMode };
});
