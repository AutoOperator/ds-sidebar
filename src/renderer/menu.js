// menu.js — 菜单窗口：视图切换 / 刷新 / 设置(主题、透明度、自动吸附、触点大小/颜色、示范模式、凭证)
(() => {
  const api = window.api;
  const $ = (id) => document.getElementById(id);

  let settingsState = { theme: 'day', opacity: 1, autoSnap: true, range: 'today', hideDelay: 3000 };
  let picker = { apiKeys: [], today: {}, current: 'all' };

  const TRIGGER_COLORS = ['#2563eb', '#8b5cf6', '#0f9d58', '#f59e0b', '#f2645f', '#00b8d9', '#e64ab6'];

  function measure() {
    const r = $('menu').getBoundingClientRect();
    api.menu.fit(Math.ceil(r.width), Math.ceil(r.height));
  }

  async function refresh() {
    const st = await api.window.getState().catch(() => ({ viewMode: 1 }));
    const s = await api.settings.get().catch(() => ({ theme: 'day', opacity: 1 }));
    settingsState = { ...settingsState, ...s };
    $('view-label').textContent = st.viewMode === 2 ? '切换为文字条' : '切换为图表';
    $('theme-day').classList.toggle('active', s.theme !== 'night');
    $('theme-night').classList.toggle('active', s.theme === 'night');
    document.body.dataset.theme = s.theme === 'night' ? 'night' : 'day';
    const pct = Math.round((s.opacity || 1) * 100);
    $('opacity-slider').value = pct;
    $('opacity-val').textContent = pct + '%';
    $('snap-on').classList.toggle('active', s.autoSnap !== false);
    $('snap-off').classList.toggle('active', s.autoSnap === false);
    const hd = s.hideDelay || 3000;
    document.querySelectorAll('#hide-delay-seg .seg-btn').forEach((b) => b.classList.toggle('active', Number(b.dataset.delay) === hd));
    const curSize = s.triggerSize || 'small';
    const curColor = s.triggerColor || '#2563eb';
    document.querySelectorAll('#settings-sub [data-size]').forEach((b) => b.classList.toggle('active', b.dataset.size === curSize));
    document.querySelectorAll('#trig-color-swatches .swatch').forEach((b) => b.classList.toggle('active', b.dataset.color === curColor));

    const creds = await api.stats.getCreds().catch(() => null);
    if (creds) {
      $('user-token-input').value = creds.userToken || '';
      $('user-token-src').textContent = creds.userTokenSource === 'settings' ? '· 应用设置' : (creds.userTokenSource === 'ds-watch' ? '· ds-watch' : '');
    }
    measure();
  }

  api.menu.onShow(async (mode) => {
    if (mode === 'api') { await showApiPicker(); return; }
    $('api-picker').classList.add('hidden');
    $('menu').classList.remove('hidden');
    refresh();
  });

  // ── API 选择列表：按今日消费从高到低排，带搜索，直接选不用挨个点 ──
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTok = (n) => (n >= 1e8 ? (n / 1e8).toFixed(2) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + 'W' : String(n));

  function keyToday(id) {
    const cells = (picker.today && picker.today[id]) || {};
    let c = 0, t = 0;
    for (const m of Object.keys(cells)) { c += cells[m].c || 0; t += cells[m].t || 0; }
    return { c, t };
  }

  async function showApiPicker() {
    $('menu').classList.add('hidden');
    $('api-picker').classList.remove('hidden');
    $('api-search').value = '';
    picker = await api.stats.getPicker().catch(() => picker);
    renderApiList();
    $('api-search').focus();
  }

  function renderApiList() {
    const q = $('api-search').value.trim().toLowerCase();
    const box = $('api-list');
    box.innerHTML = '';
    const rows = [{ id: 'all', name: '全部 API', ...(() => {
      let c = 0, t = 0;
      for (const k of picker.apiKeys || []) { const v = keyToday(k.trackingId); c += v.c; t += v.t; }
      return { c, t };
    })() }];
    const per = (picker.apiKeys || []).map((k) => ({ id: k.trackingId, name: k.name || k.trackingId, ...keyToday(k.trackingId) }));
    per.sort((a, b) => b.c - a.c || a.name.localeCompare(b.name));
    rows.push(...per);

    let shown = 0;
    for (const r of rows) {
      if (q && r.id !== 'all' && !r.name.toLowerCase().includes(q)) continue;
      shown++;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'menu-item api-item' + (picker.current === r.id ? ' active' : '');
      b.innerHTML = '<span class="api-name">' + esc(r.name) + '</span>' +
        '<span class="api-cost">' + (r.c > 0 ? '¥' + r.c.toFixed(2) : r.t > 0 ? fmtTok(r.t) : '') + '</span>';
      b.addEventListener('click', () => { api.strip.setApi(r.id); api.menu.close(); });
      box.appendChild(b);
    }
    if (!shown) {
      const d = document.createElement('div');
      d.className = 'sub-hint';
      d.textContent = '没有匹配的 API';
      box.appendChild(d);
    }
    measure();
  }

  $('api-search').addEventListener('input', renderApiList);

  $('view-item').addEventListener('click', async () => {
    const st = await api.window.getState().catch(() => ({ viewMode: 1 }));
    await api.window.setView(st.viewMode === 2 ? 1 : 2);
    api.menu.close();
  });

  $('refresh-item').addEventListener('click', () => {
    api.data.refresh();
    api.menu.close();
  });

  $('close-item').addEventListener('click', () => {
    api.window.close();
    api.menu.close();
  });

  // 设置：手风琴子面板
  $('settings-item').addEventListener('click', () => {
    $('settings-sub').classList.toggle('hidden');
    measure();
  });
  $('settings-sub').addEventListener('click', (e) => e.stopPropagation());

  $('theme-day').addEventListener('click', async () => { await api.settings.update({ theme: 'day' }); refresh(); });
  $('theme-night').addEventListener('click', async () => { await api.settings.update({ theme: 'night' }); refresh(); });
  $('opacity-slider').addEventListener('input', () => {
    $('opacity-val').textContent = $('opacity-slider').value + '%';
  });
  $('opacity-slider').addEventListener('change', async () => {
    await api.settings.update({ opacity: $('opacity-slider').value / 100 });
  });

  // 自动吸附开关
  $('snap-on').addEventListener('click', async () => { await api.settings.update({ autoSnap: true }); refresh(); });
  $('snap-off').addEventListener('click', async () => { await api.settings.update({ autoSnap: false }); refresh(); });

  // 自动隐藏延迟（鼠标离开后隐藏到侧边的时间）
  document.querySelectorAll('#hide-delay-seg .seg-btn').forEach((b) => {
    b.addEventListener('click', async () => { await api.settings.update({ hideDelay: Number(b.dataset.delay) }); refresh(); });
  });

  // 触点大小（小/中/大）
  document.querySelectorAll('#settings-sub [data-size]').forEach((b) => {
    b.addEventListener('click', async () => { await api.settings.update({ triggerSize: b.dataset.size }); refresh(); });
  });

  // 触点颜色（7 色板）
  const swatchBox = $('trig-color-swatches');
  TRIGGER_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', async () => { await api.settings.update({ triggerColor: c }); refresh(); });
    swatchBox.appendChild(b);
  });

  $('token-capture').addEventListener('click', async () => {
    const btn = $('token-capture');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '等待登录…';
    const res = await api.token.capture().catch(() => ({ ok: false, error: '调用失败' }));
    if (res && res.ok) {
      $('user-token-input').value = res.token || '';
      btn.textContent = '已获取 ✓';
      const creds = await api.stats.getCreds().catch(() => null);
      if (creds) $('user-token-src').textContent = creds.userTokenSource === 'settings' ? '· 应用设置' : '';
    } else {
      btn.textContent = '获取失败';
    }
    setTimeout(() => { btn.textContent = '一键登录获取'; btn.disabled = false; }, 2000);
  });

  $('creds-save').addEventListener('click', async () => {
    const userToken = $('user-token-input').value.trim();
    await api.settings.update({ userToken: userToken });
    const btn = $('creds-save');
    btn.textContent = '已保存';
    setTimeout(() => { btn.textContent = '保存'; }, 1200);
    const creds = await api.stats.getCreds().catch(() => null);
    if (creds) {
      $('user-token-src').textContent = creds.userTokenSource === 'settings' ? '· 应用设置' : (creds.userTokenSource === 'ds-watch' ? '· ds-watch' : '');
    }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.menu.close(); });
  window.addEventListener('blur', () => api.menu.close());

  refresh();
})();
