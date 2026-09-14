// 主进程入口 — DS侧栏（横向细条 + 图表展开）
const { app, screen, ipcMain } = require('electron');
const path = require('path');

if (process.platform === 'linux' && process.getuid && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

// 多实例：按 exe 所在文件夹名区分 userData，让纯净版/示范版可同时运行
if (app.isPackaged) {
  const exeDir = path.dirname(app.getPath('exe'));
  app.setPath('userData', path.join(app.getPath('appData'), 'DS侧栏', path.basename(exeDir)));
}

const {
  createMainWindow,
  getMainWindow,
  createTriggerWindow,
  resizeToSize,
  applyResizeConstraints,
  getStripSize,
  getChartSize,
} = require('./window-manager');
const { createTray, destroyTray } = require('./tray-manager');
const store = require('./store');
const snapManager = require('./snap-manager');
const menuManager = require('./menu-manager');
const dsApi = require('./ds-api');
const tokenCapture = require('./token-capture');
const demo = require('./demo');
const { encrypt, decrypt, isEncrypted } = require('./credential-store');

// 单实例：未拿到锁说明已有实例在跑（或残留锁），不创建窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

app.on('second-instance', () => {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) showAndReSnap();
});

let isQuitting = false;
let refreshTimer = null;
let lastData = null; // 最近一次聚合结果；API 选择列表直接用它，省一次网络往返（点开即出）

process.on('uncaughtException', (e) => console.log('[MAIN-ERR]', e));
process.on('unhandledRejection', (e) => console.log('[MAIN-REJ]', e));

// 聚合数据：余额 + 按范围用量统计（余额/用量互不拖累，缺一个另一个照常显示）
async function collectData(force) {
  const s = store.getSettings();
  const sel = { range: s.range || 'today', start: s.rangeStart, end: s.rangeEnd };
  const [balanceRes, statsRes] = await Promise.allSettled([
    dsApi.getBalance(force),
    dsApi.getStats(sel, force),
  ]);
  const base = statsRes.status === 'fulfilled' ? statsRes.value : {};
  const data = {
    ...dsApi.rangeMeta(sel), // 取数失败时也保证界面知道当前选的范围
    ...base,
    balance: balanceRes.status === 'fulfilled' ? balanceRes.value : null,
    model: dsApi.getCanonicalModel(), // 归一过，才能和用量数据里的模型名对上
    priceMode: dsApi.getPriceMode(),
    now: dsApi.getNow(),
    updatedAt: Date.now(),
    demo: demo.isDemo(),
    error: statsRes.status === 'fulfilled' ? undefined : String((statsRes.reason && statsRes.reason.message) || statsRes.reason),
  };
  const out = demo.isDemo() ? demo.transform(data) : data;
  lastData = out;
  return out;
}

// 刷新并广播到渲染进程
async function refreshAndBroadcast() {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const data = await collectData(true);
  win.webContents.send('data:update', data);
}

function showAndReSnap() {
  const win = getMainWindow();
  if (!win) return;
  if (win.isVisible() && snapManager.getSnapState().edge) {
    snapManager.expandFromTrigger();
    return;
  }
  win.show();
  win.focus();
  const edge = snapManager.detectEdge(win.getBounds());
  snapManager.snapToEdge(edge || 'right');
}

function applyOpacity() {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.setOpacity(Math.max(0.35, Math.min(1, store.getSettings().opacity)));
  }
}

// 一次性迁移：v1.4 及更早落盘的 userToken 其实是明文（加密是后来才加的，老数据没被动过）。
// 升级为密文；加密不可用或往返校验不通过就原样保留，不会弄丢凭证。
// settings 里若残留 apiKey 字段不再处理——应用已不读它（见 ds-api.js 的说明）。
function migrateCredentialEncryption() {
  const plain = store.getSettings().userToken;
  if (!plain || isEncrypted(plain)) return;
  const enc = encrypt(plain);
  if (enc !== plain && decrypt(enc) === plain) store.updateSettings({ userToken: enc });
}

function registerIpc() {
  ipcMain.handle('data:get', async () => collectData(true));
  ipcMain.handle('data:refresh', async () => {
    await refreshAndBroadcast();
    return true;
  });
  ipcMain.handle('window:close', () => {
    snapManager.hideToTray();
    return true;
  });
  ipcMain.handle('window:setView', (e, mode) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      snapManager.beginViewSwitch(); // 切换期间抑制吸附判定，避免误折叠/误吸附
      applyResizeConstraints(win, mode); // 先解锁/锁高度，再改尺寸
      const size = mode === 2 ? getChartSize() : getStripSize();
      resizeToSize(win, size);
      snapManager.setWindowSize(size);
      win.webContents.send('view:set', mode === 2 ? 2 : 1);
    }
    store.update({ viewMode: mode === 2 ? 2 : 1 });
    return true;
  });
  ipcMain.handle('window:getState', () => store.getState());
  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:update', (e, partial) => {
    const p = { ...(partial || {}) };
    if (p.userToken !== undefined) p.userToken = encrypt(p.userToken); // 凭证落盘前 DPAPI 加密
    const s = store.updateSettings(p);
    applyOpacity();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('settings:updated', s);
    if (partial && (partial.triggerSize !== undefined || partial.triggerColor !== undefined)) {
      snapManager.refreshTriggerConfig(); // 触点已隐藏时即时重绘大小/颜色
    }
    if (partial && partial.pinned === true) snapManager.cancelMouseLeaveTimer(); // 固定后取消待触发的自动隐藏
    return s;
  });
  ipcMain.on('window:mouseEnter', () => snapManager.onMainWindowMouseEnter());
  ipcMain.on('window:mouseLeave', () => snapManager.onMainWindowMouseLeave());
  ipcMain.handle('snap:getState', () => snapManager.getSnapState());
  ipcMain.handle('snap:expand', () => snapManager.expandFromTrigger());
  ipcMain.on('trigger:mouseEnter', () => snapManager.onTriggerActivated());
  ipcMain.on('trigger:mouseClick', () => snapManager.onTriggerActivated());

  // 菜单窗口
  ipcMain.on('menu:open', (e, p) => {
    const win = getMainWindow();
    if (!win || win.isDestroyed() || !p) return;
    const b = win.getBounds();
    menuManager.openMenuAt(b.x + (p.x || 0), b.y + (p.y || 0), p.mode || 'menu');
  });
  ipcMain.on('menu:close', () => menuManager.hideMenu());
  ipcMain.on('menu:fit', (e, size) => menuManager.fitMenu(size));

  // 细条上选了哪个 API（选择器在菜单窗口里，选完回传主窗口）
  ipcMain.on('strip:setApi', (e, trackingId) => {
    const id = String(trackingId || 'all');
    store.updateSettings({ stripApi: id }); // 记住选择，重启后还在
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('strip:setApi', id);
  });

  // 外部切换视图（主进程发给渲染进程）
  ipcMain.on('view:set', (e, mode) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('view:set', mode === 2 ? 2 : 1);
  });

  // 统计：切换时间范围（today / custom(带起止日期) / month / lastMonth）
  ipcMain.handle('stats:setRange', (e, sel) => {
    const KNOWN = ['today', 'custom', 'month', 'lastMonth'];
    const r = KNOWN.includes(sel && sel.range) ? sel.range : 'today';
    const patch = { range: r };
    if (r === 'custom') {
      const okDate = (v) => (typeof v === 'string' && /^\d{4}-\d{1,2}-\d{1,2}$/.test(v) ? v : null);
      patch.rangeStart = okDate(sel && sel.start);
      patch.rangeEnd = okDate(sel && sel.end);
    }
    store.updateSettings(patch);
    refreshAndBroadcast();
    return true;
  });
  ipcMain.handle('stats:getRange', () => {
    const s = store.getSettings();
    return { range: s.range || 'today', start: s.rangeStart || null, end: s.rangeEnd || null };
  });
  ipcMain.handle('stats:getApiKeys', () => dsApi.getApiKeyList(true));
  // API 选择列表的数据：复用最近一次聚合结果（已含示范模式的伪装），点开即出
  ipcMain.handle('stats:getPicker', () => {
    const d = lastData || {};
    return {
      apiKeys: d.apiKeys || [],
      today: (d.today && d.today.cells) || {},
      current: store.getSettings().stripApi || 'all',
    };
  });
  ipcMain.handle('stats:getCreds', () => dsApi.getCreds());

  // 一键获取 User Token：内嵌登录平台，抓到 token 后保存并刷新
  ipcMain.handle('token:capture', async () => {
    try {
      const token = await tokenCapture.captureUserToken();
      refreshAndBroadcast();
      return { ok: true, token };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

app.whenReady().then(() => {
  if (!gotTheLock) return;
  registerIpc();
  migrateCredentialEncryption();

  const win = createMainWindow();

  // 恢复位置或默认右中
  const state = store.getState();
  if (state.bounds) {
    win.setBounds(state.bounds);
  } else {
    const s = getStripSize();
    const d = screen.getPrimaryDisplay();
    win.setPosition(d.workArea.x + d.workArea.width - s.width, Math.round((d.workArea.height - s.height) / 2));
  }

  win.setSkipTaskbar(true);
  applyResizeConstraints(win, store.getState().viewMode === 2 ? 2 : 1);
  applyOpacity();
  win.on('closed', () => {});

  createTray({
    showWindow: showAndReSnap,
    refresh: refreshAndBroadcast,
  });

  // 关闭 → 隐藏到托盘
  win.on('close', (e) => {
    if (isQuitting) return;
    e.preventDefault();
    snapManager.hideToTray();
  });

  // 保存位置 + 吸附检测
  let moveEndTimer = null;
  win.on('resize', () => store.update({ bounds: win.getBounds() }));
  win.on('move', () => {
    store.update({ bounds: win.getBounds() });
    snapManager.handleWindowMove();
    clearTimeout(moveEndTimer);
    moveEndTimer = setTimeout(() => snapManager.handleWindowMoved(), 300);
  });

  // 数据定时刷新
  refreshTimer = setInterval(refreshAndBroadcast, 60000);

  // 首屏数据
  win.webContents.on('did-finish-load', () => {
    collectData(true).then((data) => win.webContents.send('data:update', data));
  });

  // 自动验证 + 截图模式（--screenshot）：保持窗口可见，检查后退出
  if (process.argv.includes('--screenshot')) {
    const fs = require('fs');
    // 打包后 __dirname 在 app.asar 里（只读），回退到临时目录，让打包版也能自检
    const shotsDir = (() => {
      const local = path.join(__dirname, '..', '..', 'shots');
      try { fs.mkdirSync(local, { recursive: true }); return local; }
      catch {
        const tmp = path.join(app.getPath('temp'), 'ds-sidebar-shots');
        fs.mkdirSync(tmp, { recursive: true });
        return tmp;
      }
    })();
    const probe = {};
    console.log('[SHOTS]', shotsDir);
    // 截图会改窗口尺寸/视图，这里先存档、跑完还原，避免污染真实配置
    const prevState = JSON.parse(JSON.stringify(store.getState()));
    win.setOpacity(1);
    win.webContents.on('console-message', (e, level, msg) => {
      if (level >= 2) console.log('[RENDERER]', msg);
    });
    const cap = async (name) => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(shotsDir, name), img.toPNG());
      console.log('saved', name);
    };
    // 强制从细条视图开始，保证验证结果确定
    store.update({ viewMode: 1 });
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        win.webContents.send('view:set', 1);
        applyResizeConstraints(win, 1);
        resizeToSize(win, getStripSize());
        await new Promise((r) => setTimeout(r, 1500));
        const v1 = await win.webContents.executeJavaScript(`(async () => ({
          model: document.getElementById('si-model').textContent,
          price: document.getElementById('si-price').textContent,
          priceTip: document.getElementById('si-price').title,
          pricingLoaded: typeof window.Pricing,
          today: document.getElementById('si-today').textContent,
          caret: !!document.getElementById('si-api-btn'),
          balance: document.getElementById('si-balance').textContent,
          creds: await window.api.stats.getCreds().then((c) => ({
            tokenOk: (c.userToken || '').length > 10, tokenSource: c.userTokenSource,
            leaksApiKey: 'apiKey' in c, // 必须为 false：应用只认 User Token
          })).catch((e) => 'ERR:' + e.message),
          w: window.innerWidth, h: window.innerHeight,
        }))()`);
        console.log('[V1-STRIP]', JSON.stringify(v1));
        probe.v1 = v1;
        await cap('view1.png');

        win.webContents.send('view:set', 2);
        applyResizeConstraints(win, 2);
        resizeToSize(win, getChartSize());
        await new Promise((r) => setTimeout(r, 1500));
        const v2 = await win.webContents.executeJavaScript(`(() => ({
          w: window.innerWidth, h: window.innerHeight,
          rangeBtns: [...document.querySelectorAll('#range-seg .seg-btn')].map((b) => b.textContent + (b.classList.contains('active') ? '*' : '')),
          groupBtns: document.querySelectorAll('#group-seg .seg-btn').length,
          title: document.getElementById('v2-title').textContent,
          datePanelHidden: document.getElementById('date-picker').classList.contains('hidden'),
          axisPoints: (() => {
            const inst = window.echarts && window.echarts.getInstanceByDom(document.getElementById('main-chart'));
            const d = inst && inst.getOption().xAxis && inst.getOption().xAxis[0] && inst.getOption().xAxis[0].data;
            return d ? d.length + ':' + d.slice(0, 3).join(',') + '…' + d[d.length - 1] : -1;
          })(),
          statBoxes: [...document.querySelectorAll('.mini-stat')].map((e) => {
            const v = e.querySelector('.ms-value');
            return { text: v.textContent, w: v.clientWidth, need: v.scrollWidth, truncated: v.scrollWidth > v.clientWidth };
          }),
          mainChartPixels: (() => {
            const c = document.querySelector('#main-chart canvas');
            if (!c) return -1;
            const ctx = c.getContext('2d');
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let nz = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nz++;
            return nz;
          })(),
        }))()`);
        console.log('[V2-CHART]', JSON.stringify(v2));
        probe.v2 = v2;
        await cap('view2.png');

        // 自选日期：点开面板（先截图，面板此时是打开的）→ 选最近 3 天 → 确定 → 看图表是否变成天级
        const dp = await win.webContents.executeJavaScript(`(() => {
          document.querySelector('#range-seg [data-range="custom"]').click();
          const el = document.getElementById('date-picker');
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            visible: !el.classList.contains('hidden'),
            rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            style: cs.display + '/' + cs.visibility + '/z' + cs.zIndex,
            start: document.getElementById('dp-start').value,
            end: document.getElementById('dp-end').value,
            max: document.getElementById('dp-end').max,
          };
        })()`);
        console.log('[V2-DATEPICK]', JSON.stringify(dp));
        probe.datepick = dp;
        await new Promise((r) => setTimeout(r, 600)); // 等一帧绘制再截图
        // 命中测试：这一点若返回面板内的元素，说明面板确实在最上层且可见
        const hit = await win.webContents.executeJavaScript(`(() => {
          const el = document.elementFromPoint(300, 80);
          return el ? (el.closest('#date-picker') ? 'inside-date-picker:' + el.tagName + (el.id ? '#' + el.id : '') : 'other:' + el.tagName + (el.id ? '#' + el.id : '')) : 'null';
        })()`);
        console.log('[V2-DATEPICK-HIT]', hit);
        probe.datepickHit = hit;
        await cap('view3-datepicker.png');

        const applied = await win.webContents.executeJavaScript(`(() => {
          const b = window.Pricing.bjParts();
          const s = new Date(Date.UTC(b.y, b.m - 1, b.day) - 2 * 86400000).toISOString().slice(0, 10);
          document.getElementById('dp-start').value = s;
          document.getElementById('dp-apply').click();
          return { start: s, panelHiddenAfter: document.getElementById('date-picker').classList.contains('hidden') };
        })()`);
        probe.applied = applied;
        await new Promise((r) => setTimeout(r, 2500)); // 等数据刷新回来
        const v3 = await win.webContents.executeJavaScript(`(() => {
          const inst = window.echarts && window.echarts.getInstanceByDom(document.getElementById('main-chart'));
          const d = inst && inst.getOption().xAxis && inst.getOption().xAxis[0].data;
          return {
            title: document.getElementById('v2-title').textContent,
            datePanelHidden: document.getElementById('date-picker').classList.contains('hidden'),
            axisPoints: d ? d.length + ':' + d.join(',') : -1,
          };
        })()`);
        console.log('[V3-CUSTOM]', JSON.stringify(v3));
        probe.custom = v3;
        await cap('view4-custom.png');

        // API 选择列表（在菜单窗口里）
        await win.webContents.executeJavaScript(`document.getElementById('si-api-btn').click()`);
        const menuWin = menuManager.getMenuWindow();
        if (menuWin && !menuWin.isDestroyed()) {
          menuWin.webContents.on('console-message', (e, level, msg) => {
            if (level >= 2) console.log('[MENU-RENDERER]', msg);
          });
          let pick = null;
          for (let i = 0; i < 12; i++) {           // 数据走内存，正常一两轮就出
            await new Promise((r) => setTimeout(r, 300));
            pick = await menuWin.webContents.executeJavaScript(`(() => ({
              pickerVisible: !document.getElementById('api-picker').classList.contains('hidden'),
              menuHidden: document.getElementById('menu').classList.contains('hidden'),
              items: document.querySelectorAll('.api-item').length,
              first: [...document.querySelectorAll('.api-item')].slice(0, 3).map((b) => b.textContent),
            }))()`).catch((e) => 'ERR:' + e.message);
            if (pick && pick.items > 0) break;
          }
          console.log('[PICKER]', JSON.stringify(pick));
          probe.picker = pick;
          const img = await menuWin.webContents.capturePage();
          fs.writeFileSync(path.join(shotsDir, 'view5-apipicker.png'), img.toPNG());
          await win.webContents.executeJavaScript(`document.getElementById('app').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
          await new Promise((r) => setTimeout(r, 300));
        }
        snapManager.unsnap();
        win.show();
        // 打包版 stdout 不接控制台，把探针结果落盘，两种形态都能核对
        fs.writeFileSync(path.join(shotsDir, 'probe.json'), JSON.stringify(probe, null, 2));
        store.update(prevState); // 最后还原，确保截图过程写下的窗口位置/视图不落盘
        setTimeout(() => app.quit(), 300);
      }, 500);
    });
    return;
  }

  // 启动即吸附到右边缘（自动隐藏为触点）
  setTimeout(() => snapManager.snapToEdge('right'), 300);
});

app.on('window-all-closed', () => {});

app.on('before-quit', () => {
  isQuitting = true;
  if (refreshTimer) clearInterval(refreshTimer);
  destroyTray();
});

app.on('will-quit', () => { isQuitting = true; });
