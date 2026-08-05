// renderer.js — 视图1（细条：模型|余额|双倍/平价|今日消费）+ 视图2（分层条形统计图）
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    app: $('app'),
    stripInfo: $('strip-info'), chartHeader: $('chart-header'), chartArea: $('chart-area'),
    viewBtn: $('view-btn'), pinBtn: $('pin-btn'),
    siModel: $('si-model'), siBalance: $('si-balance'), siPrice: $('si-price'), siToday: $('si-today'),
    siDemo: $('si-demo'), siLogin: $('si-login'),
    v2Title: $('v2-title'), v2Cost: $('v2-cost'), v2Requests: $('v2-requests'), v2Tokens: $('v2-tokens'),
    v2Demo: $('v2-demo'),
    v2Foot: $('v2-foot'), mainChart: $('main-chart'),
    rangeSeg: $('range-seg'), metricSeg: $('metric-seg'), groupSeg: $('group-seg'),
  };

  let data = null;
  let viewMode = 1;
  let settings = { theme: 'day', opacity: 1, apiFilter: 'all' };
  // 细条所选范围：model=null 表示当前模型，api='all' 表示全部密钥
  let stripSel = { model: null, api: 'all' };
  let chartSel = { range: '30d', groupBy: 'model', metric: 'cost' };
  let charts = [];

  const PALETTE = ['#0c70f3', '#8b5cf6', '#0f9d58', '#e5a50a', '#f2645f', '#00b8d9', '#e64ab6', '#5ac8fa'];

  // ── 格式化 ──
  const fmtMoney = (v) => (v == null || isNaN(v) ? '¥--' : '¥' + Number(v).toFixed(2));
  function fmtTokens(n) {
    if (n == null || isNaN(n)) return '--';
    n = Number(n);
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + 'W';
    return String(n);
  }
  const fmtReq = (n) => (n == null || isNaN(n) ? '--' : (Number(n) >= 1e4 ? (Number(n) / 1e4).toFixed(1) + 'W' : String(n)));
  const fmtDateShort = (d) => (d ? d.slice(5) : '--');
  function timeAgo(ts) {
    if (!ts) return '--';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + '秒前';
    if (s < 3600) return Math.floor(s / 60) + '分前';
    if (s < 86400) return Math.floor(s / 3600) + '时前';
    return Math.floor(s / 86400) + '天前';
  }
  const shortModel = (m) => String(m || '--').replace(/^deepseek-/i, '').replace(/\s*&\s*/g, '+');
  const shortName = (n) => {
    n = String(n || '');
    return n.length > 8 ? n.slice(0, 7) + '…' : n;
  };

  // ── 北京时间 + 价格模式 ──
  function bjParts() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate(), h: d.getUTCHours(), min: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  const localPriceMode = () => {
    const h = bjParts().h;
    return (h >= 9 && h < 12) || (h >= 14 && h < 18) ? { mode: '双倍', busy: true } : { mode: '平价', busy: false };
  };
  function renderPrice(pm) {
    const p = pm || localPriceMode();
    els.siPrice.textContent = p.mode;
    els.siPrice.className = 'si-price ' + (p.busy ? 'busy' : 'free');
  }
  setInterval(() => renderPrice(), 30000);

  const cssVar = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();

  // ── 细条：所选范围的今日消费 ──
  function scopedToday() {
    if (!data || !data.today || !data.today.cells) return { c: 0, t: 0, r: 0 };
    const cells = data.today.cells;
    const mKey = stripSel.model === 'all' ? null : (stripSel.model || data.model || null);
    const aKey = stripSel.api;
    if (mKey && aKey !== 'all') return (cells[aKey] && cells[aKey][mKey]) || { c: 0, t: 0, r: 0 };
    let c = 0, t = 0, r = 0;
    for (const kid of Object.keys(cells)) {
      if (aKey !== 'all' && kid !== aKey) continue;
      for (const model of Object.keys(cells[kid])) {
        if (mKey && model !== mKey) continue;
        c += cells[kid][model].c; t += cells[kid][model].t; r += cells[kid][model].r;
      }
    }
    return { c, t, r };
  }

  // 凭证缺失/失效 → 需要重新登录
  const loginError = () => data && data.error && /token|401|未登录/i.test(String(data.error));

  function renderStrip() {
    if (!data) return;
    els.siDemo.classList.toggle('hidden', !data.demo);
    els.siLogin.classList.toggle('hidden', !loginError());
    const m = stripSel.model || data.model || '全部';
    els.siModel.textContent = m === 'all' ? '全部' : shortModel(m);
    els.siBalance.innerHTML = '余额 <span class="green">' + fmtMoney(data.balance) + '</span>';
    renderPrice(data.priceMode);
    const s = scopedToday();
    let label = '今日';
    if (stripSel.api !== 'all') {
      const k = (data.apiKeys || []).find((x) => x.trackingId === stripSel.api);
      if (k) label = '今日[' + shortName(k.name) + ']';
    }
    els.siToday.innerHTML = label + ' <span class="cost">' + (isNaN(s.c) ? '¥--' : '¥' + s.c.toFixed(2)) + '</span>' +
      ' <span class="tokens">· ' + fmtTokens(s.t) + '</span>';
  }

  function nextModel() {
    const models = (data && data.models) || [];
    const list = ['all', ...models];
    const cur = stripSel.model || (data && data.model) || 'all';
    let idx = list.indexOf(cur);
    if (idx < 0) idx = 0;
    stripSel.model = list[(idx + 1) % list.length];
    renderStrip();
  }
  function nextApi() {
    const keys = (data && data.apiKeys) || [];
    const list = ['all', ...keys.map((k) => k.trackingId)];
    let idx = list.indexOf(stripSel.api);
    if (idx < 0) idx = 0;
    stripSel.api = list[(idx + 1) % list.length];
    renderStrip();
  }

  // ── 渲染 ──
  function render(d) {
    data = d || data;
    if (!data) return;
    els.v2Demo.classList.toggle('hidden', !data.demo);
    if (data.range) chartSel.range = data.range;
    renderStrip();
    const totals = data.totals || { cost: 0, tokens: 0, requests: 0 };
    els.v2Cost.textContent = '¥' + Number(totals.cost).toFixed(2);
    els.v2Requests.textContent = fmtReq(totals.requests);
    els.v2Tokens.textContent = fmtTokens(totals.tokens);
    els.v2Title.textContent = chartSel.metric === 'tokens' ? 'Tokens' : '消费金额';
    els.v2Foot.textContent = '共 ¥' + Number(totals.cost).toFixed(2) + ' · ' + fmtTokens(totals.tokens) + ' · ' + fmtReq(totals.requests) + ' 次 · 更新于 ' + timeAgo(data.updatedAt);
    if (loginError()) els.v2Foot.textContent = '未登录 · 点击左上角 ≡ 打开设置登录';
    syncControlUI();
    if (viewMode === 2) renderCharts();
  }

  // ── 图表：按模型/按API 分层堆叠，tooltip 显示各层金额+tokens ──
  function disposeCharts() {
    charts.forEach((c) => c.dispose());
    charts = [];
  }

  function activeKeys() {
    const filter = settings.apiFilter;
    const all = (data.apiKeys || []).map((k) => k.trackingId);
    if (!filter || filter === 'all') return all;
    return all.filter((id) => filter.includes(id));
  }

  function modelColor(m) {
    const map = {
      'deepseek-v4-flash': cssVar('--accent'),
      'deepseek-v4-pro': '#8b5cf6',
      'deepseek-chat & deepseek-reasoner': '#0f9d58',
    };
    if (map[m]) return map[m];
    let h = 0;
    for (const ch of m) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function stackedBarOption() {
    const days = data.days || [];
    const metric = chartSel.metric;
    const text2 = cssVar('--text-2');
    const gridColor = cssVar('--panel-border');
    const accent = cssVar('--accent');
    const layers = [];

    if (chartSel.groupBy === 'model') {
      for (const model of data.models || []) {
        const arr = days.map((d) => {
          let cost = 0, tokens = 0;
          for (const kid of activeKeys()) {
            const cell = (d.cells[kid] || {})[model];
            if (cell) { cost += cell.c; tokens += cell.t; }
          }
          return { value: metric === 'tokens' ? tokens : cost, cost, tokens };
        });
        if (arr.some((p) => p.value > 0)) layers.push({ name: shortModel(model), data: arr, color: modelColor(model) });
      }
    } else {
      const apiMap = new Map((data.apiKeys || []).map((k) => [k.trackingId, k.name]));
      activeKeys().forEach((kid, i) => {
        const arr = days.map((d) => {
          let cost = 0, tokens = 0;
          const cm = d.cells[kid] || {};
          for (const model of Object.keys(cm)) {
            cost += cm[model].c; tokens += cm[model].t;
          }
          return { value: metric === 'tokens' ? tokens : cost, cost, tokens };
        });
        if (arr.some((p) => p.value > 0)) layers.push({ name: shortName(apiMap.get(kid) || kid), data: arr, color: PALETTE[i % PALETTE.length] });
      });
    }

    const series = layers.map((l) => ({
      name: l.name, type: 'bar', stack: 'total', barMaxWidth: 16,
      itemStyle: { color: l.color },
      emphasis: { focus: 'series' },
      data: l.data,
    }));
    if (!series.length) {
      series.push({
        name: metric === 'tokens' ? 'Tokens' : '消费', type: 'bar', stack: 'total', barMaxWidth: 16,
        itemStyle: { color: accent },
        data: days.map(() => ({ value: 0, cost: 0, tokens: 0 })),
      });
    }

    return {
      grid: { left: 6, right: 10, top: 30, bottom: 20, containLabel: true },
      legend: {
        top: 2, left: 2, type: 'scroll', icon: 'roundRect',
        textStyle: { color: text2, fontSize: 10 },
        itemWidth: 12, itemHeight: 8, itemGap: 10,
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: 'rgba(20,24,36,0.94)',
        borderWidth: 0,
        textStyle: { color: '#fff', fontSize: 11 },
        formatter: (params) => {
          const date = params[0].axisValue;
          let html = '<b>' + date + '</b>';
          let tCost = 0, tTok = 0;
          for (const p of params) {
            const cost = Number(p.data.cost);
            const tok = Number(p.data.tokens);
            if (cost > 0 || tok > 0) {
              tCost += cost; tTok += tok;
              html += '<br/>' + p.marker + p.seriesName +
                ' <b style="color:#ffd76a">¥' + cost.toFixed(2) + '</b>' +
                ' <span style="color:#a5b4d0">' + fmtTokens(tok) + '</span>';
            }
          }
          if (tCost > 0 || tTok > 0) html += '<br/><b>合计 ¥' + tCost.toFixed(2) + ' · ' + fmtTokens(tTok) + '</b>';
          return html;
        },
      },
      xAxis: {
        type: 'category',
        data: days.map((d) => fmtDateShort(d.date)),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: text2, fontSize: 10, hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: gridColor, type: 'dashed', opacity: 0.7 } },
        axisLabel: { color: text2, fontSize: 10, formatter: (v) => (v >= 10000 ? (v / 10000).toFixed(0) + 'W' : v) },
      },
      series,
    };
  }

  function renderCharts() {
    if (!window.echarts || !data) return;
    disposeCharts();
    const main = echarts.init(els.mainChart);
    main.setOption(stackedBarOption());
    charts.push(main);
  }

  // ── 控制条 ──
  function syncControlUI() {
    document.querySelectorAll('#range-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === chartSel.range));
    document.querySelectorAll('#metric-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.metric === chartSel.metric));
    document.querySelectorAll('#group-seg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.group === chartSel.groupBy));
  }
  els.rangeSeg.addEventListener('click', (e) => {
    const r = e.target.dataset.range;
    if (!r || r === chartSel.range) return;
    chartSel.range = r;
    syncControlUI();
    window.api.stats.setRange(r);
  });
  els.metricSeg.addEventListener('click', (e) => {
    const m = e.target.dataset.metric;
    if (!m || m === chartSel.metric) return;
    chartSel.metric = m;
    render(data);
  });
  els.groupSeg.addEventListener('click', (e) => {
    const g = e.target.dataset.group;
    if (!g || g === chartSel.groupBy) return;
    chartSel.groupBy = g;
    render(data);
  });

  // ── 视图切换 ──
  function setView(mode) {
    if (mode === viewMode) return;
    viewMode = mode;
    if (mode === 2) {
      els.stripInfo.classList.add('hidden');
      els.chartHeader.classList.remove('hidden');
      els.chartArea.classList.remove('hidden');
      setTimeout(() => {
        if (viewMode === 2) { disposeCharts(); renderCharts(); }
      }, 60);
    } else {
      els.stripInfo.classList.remove('hidden');
      els.chartHeader.classList.add('hidden');
      els.chartArea.classList.add('hidden');
      disposeCharts();
    }
    window.api.window.setView(mode);
  }

  // ── 设置 ──
  function applyTheme(theme) {
    document.body.setAttribute('data-theme', theme || 'day');
    if (viewMode === 2) { disposeCharts(); renderCharts(); }
  }
  function applySettings(s) {
    settings = { ...settings, ...s };
    applyTheme(settings.theme);
    els.pinBtn.classList.toggle('active', settings.pinned === true);
    els.app.classList.toggle('pinned', settings.pinned === true); // 固定：禁止拖动
  }
  window.api.settings.onChanged((s) => applySettings(s));

  // ── 菜单：≡ 按钮 或 右键 ──
  els.viewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = els.viewBtn.getBoundingClientRect();
    window.api.menu.open(Math.round(r.left), Math.round(r.bottom) + 2);
  });

  // ── 固定按钮：禁止拖动 + 禁止吸附 + 禁止自动隐藏 ──
  els.pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    applySettings({ pinned: !(settings.pinned === true) });
    window.api.settings.update({ pinned: settings.pinned });
  });
  document.getElementById('app').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.api.menu.open(Math.round(e.clientX), Math.round(e.clientY));
  });
  document.getElementById('app').addEventListener('mousedown', () => window.api.menu.close());

  // 细条交互：模型 / 今日消费 点击循环
  els.siModel.addEventListener('click', (e) => { e.stopPropagation(); nextModel(); });
  els.siToday.addEventListener('click', (e) => { e.stopPropagation(); nextApi(); });

  // 未登录提示 → 打开设置菜单（含凭证填写与一键登录）
  els.siLogin.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = els.siLogin.getBoundingClientRect();
    window.api.menu.open(Math.round(r.left), Math.round(r.bottom) + 2);
  });

  window.api.window.onSetView((mode) => setView(mode === 2 ? 2 : 1));

  document.getElementById('app').addEventListener('mouseenter', () => window.api.window.mouseEnter());
  document.getElementById('app').addEventListener('mouseleave', () => window.api.window.mouseLeave());
  window.addEventListener('resize', () => charts.forEach((c) => c.resize()));

  window.api.data.onUpdate((d) => render(d));

  async function init() {
    renderPrice();
    const st = await window.api.window.getState().catch(() => ({ viewMode: 1 }));
    viewMode = st.viewMode === 2 ? 2 : 1;
    const cfg = await window.api.settings.get().catch(() => ({ theme: 'day', opacity: 1 }));
    applySettings(cfg);
    if (viewMode === 2) setView(2);
    const d = await window.api.data.get().catch(() => null);
    render(d);
  }
  init();
})();
