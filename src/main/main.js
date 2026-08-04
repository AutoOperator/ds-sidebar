// 主进程入口 — DS侧栏（横向细条 + 图表展开）
const { app, screen, ipcMain } = require('electron');
const path = require('path');

if (process.platform === 'linux' && process.getuid && process.getuid() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

const {
  createMainWindow,
  getMainWindow,
  createTriggerWindow,
  resizeToSize,
  getStripSize,
  getChartSize,
} = require('./window-manager');
const { createTray, destroyTray } = require('./tray-manager');
const store = require('./store');
const snapManager = require('./snap-manager');
const menuManager = require('./menu-manager');
const dsApi = require('./ds-api');

// 单实例：未拿到锁说明已有实例在跑（或残留锁），不创建窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

app.on('second-instance', () => {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) showAndReSnap();
});

let isQuitting = false;
let refreshTimer = null;

process.on('uncaughtException', (e) => console.log('[MAIN-ERR]', e));
process.on('unhandledRejection', (e) => console.log('[MAIN-REJ]', e));

// 聚合数据：余额 + 按范围用量统计
async function collectData(force) {
  try {
    const range = store.getSettings().range || '30d';
    const [balance, stats] = await Promise.all([
      dsApi.getBalance(force),
      dsApi.getStats(range, force),
    ]);
    return { ...stats, balance, model: dsApi.getModel(), priceMode: dsApi.getPriceMode(), now: dsApi.getNow(), updatedAt: Date.now() };
  } catch (err) {
    return { balance: null, error: String((err && err.message) || err) };
  }
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
    const s = store.updateSettings(partial || {});
    applyOpacity();
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('settings:updated', s);
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
    menuManager.openMenuAt(b.x + (p.x || 0), b.y + (p.y || 0));
  });
  ipcMain.on('menu:close', () => menuManager.hideMenu());
  ipcMain.on('menu:fit', (e, size) => menuManager.fitMenu(size));

  // 外部切换视图（主进程发给渲染进程）
  ipcMain.on('view:set', (e, mode) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send('view:set', mode === 2 ? 2 : 1);
  });

  // 统计：切换时间范围
  ipcMain.handle('stats:setRange', (e, range) => {
    const r = ['7d', '30d', 'month', 'lastMonth'].includes(range) ? range : '30d';
    store.updateSettings({ range: r });
    refreshAndBroadcast();
    return true;
  });
  ipcMain.handle('stats:getApiKeys', () => dsApi.getApiKeyList(true));
  ipcMain.handle('stats:getCreds', () => dsApi.getCreds());
}

app.whenReady().then(() => {
  if (!gotTheLock) return;
  registerIpc();

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
    const shotsDir = path.join(__dirname, '..', '..', 'shots');
    fs.mkdirSync(shotsDir, { recursive: true });
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
        resizeToSize(win, getStripSize());
        await new Promise((r) => setTimeout(r, 1500));
        const v1 = await win.webContents.executeJavaScript(`(() => ({
          model: document.getElementById('si-model').textContent,
          price: document.getElementById('si-price').textContent,
          today: document.getElementById('si-today').textContent,
          balance: document.getElementById('si-balance').textContent,
          w: window.innerWidth, h: window.innerHeight,
        }))()`);
        console.log('[V1-STRIP]', JSON.stringify(v1));
        await cap('view1.png');

        win.webContents.send('view:set', 2);
        resizeToSize(win, getChartSize());
        await new Promise((r) => setTimeout(r, 1500));
        const v2 = await win.webContents.executeJavaScript(`(() => ({
          w: window.innerWidth, h: window.innerHeight,
          rangeBtns: document.querySelectorAll('#range-seg .seg-btn').length,
          groupBtns: document.querySelectorAll('#group-seg .seg-btn').length,
          title: document.getElementById('v2-title').textContent,
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
        await cap('view2.png');
        snapManager.unsnap();
        win.show();
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
