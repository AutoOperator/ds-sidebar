// menu.js — 菜单窗口：视图切换 / 刷新 / 统计筛选(搜索+全部+各API) / 设置(主题、透明度、凭证)
(() => {
  const api = window.api;
  const $ = (id) => document.getElementById(id);

  let settingsState = { theme: 'day', opacity: 1, apiFilter: 'all', range: '30d' };
  let apiKeys = [];

  function measure() {
    const r = $('menu').getBoundingClientRect();
    api.menu.fit(Math.ceil(r.width), Math.ceil(r.height));
  }

  function shortSensitive(s) { return s ? '…' + s.slice(-4) : ''; }

  function renderFilterList() {
    const filter = settingsState.apiFilter; // 'all' 或 [trackingId]
    const q = ($('filter-search').value || '').trim().toLowerCase();
    const listEl = $('filter-list');
    listEl.innerHTML = '';

    const addRow = (label, suffix, checked, onClick) => {
      const row = document.createElement('div');
      row.className = 'filter-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.className = 'filter-cb';
      const span = document.createElement('span');
      span.className = 'filter-name';
      span.textContent = label;
      const suf = document.createElement('span');
      suf.className = 'filter-suf';
      suf.textContent = suffix;
      row.appendChild(cb);
      row.appendChild(span);
      row.appendChild(suf);
      row.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
      listEl.appendChild(row);
    };

    addRow('全部', '', filter === 'all', () => setFilter('all'));

    for (const k of apiKeys) {
      if (q && !k.name.toLowerCase().includes(q)) continue;
      const checked = filter !== 'all' && Array.isArray(filter) && filter.includes(k.trackingId);
      addRow(k.name, shortSensitive(k.sensitiveId), checked, () => toggleKey(k.trackingId));
    }
  }

  function toggleKey(id) {
    let cur = settingsState.apiFilter;
    let list;
    if (cur === 'all') list = apiKeys.map((k) => k.trackingId);
    else if (Array.isArray(cur)) list = [...cur];
    else list = apiKeys.map((k) => k.trackingId);

    if (list.includes(id)) {
      list = list.filter((x) => x !== id);
    } else {
      list = [...list, id];
    }
    if (!list.length) list = 'all';
    else if (list.length === apiKeys.length) list = 'all';
    setFilter(list);
  }

  function setFilter(v) {
    settingsState.apiFilter = v;
    api.settings.update({ apiFilter: v });
    renderFilterList();
    $('filter-label').textContent = v === 'all' ? '统计筛选' : '统计筛选 · ' + (Array.isArray(v) ? v.length : 0) + '项';
    measure();
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
    $('filter-label').textContent = (!s.apiFilter || s.apiFilter === 'all') ? '统计筛选' : '统计筛选 · ' + (Array.isArray(s.apiFilter) ? s.apiFilter.length : 0) + '项';
    renderFilterList();

    const keys = await api.stats.getApiKeys().catch(() => []);
    if (keys && keys.length) { apiKeys = keys; renderFilterList(); measure(); }

    const creds = await api.stats.getCreds().catch(() => null);
    if (creds) {
      $('api-key-input').value = creds.apiKey || '';
      $('user-token-input').value = creds.userToken || '';
      $('api-key-src').textContent = creds.apiKeySource === 'settings' ? '· 应用设置' : (creds.apiKeySource === 'claude' ? '· Claude配置' : '');
      $('user-token-src').textContent = creds.userTokenSource === 'settings' ? '· 应用设置' : (creds.userTokenSource === 'ds-watch' ? '· ds-watch' : '');
    }
    measure();
  }

  api.menu.onShow(refresh);

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

  // 统计筛选：手风琴子面板
  $('filter-item').addEventListener('click', () => {
    $('filter-sub').classList.toggle('hidden');
    measure();
  });
  $('filter-sub').addEventListener('click', (e) => e.stopPropagation());
  $('filter-search').addEventListener('input', () => { renderFilterList(); measure(); });

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

  $('creds-save').addEventListener('click', async () => {
    const apiKey = $('api-key-input').value.trim();
    const userToken = $('user-token-input').value.trim();
    await api.settings.update({ apiKey: apiKey, userToken: userToken });
    const btn = $('creds-save');
    btn.textContent = '已保存';
    setTimeout(() => { btn.textContent = '保存'; }, 1200);
    const creds = await api.stats.getCreds().catch(() => null);
    if (creds) {
      $('api-key-src').textContent = creds.apiKeySource === 'settings' ? '· 应用设置' : (creds.apiKeySource === 'claude' ? '· Claude配置' : '');
      $('user-token-src').textContent = creds.userTokenSource === 'settings' ? '· 应用设置' : (creds.userTokenSource === 'ds-watch' ? '· ds-watch' : '');
    }
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.menu.close(); });
  window.addEventListener('blur', () => api.menu.close());

  refresh();
})();
