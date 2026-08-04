// menu-manager.js — 右键/≡ 菜单独立小窗（细条窗口太矮放不下菜单，故用独立置顶透明窗）
const { BrowserWindow, screen } = require('electron');
const path = require('path');

let menuWindow = null;
let readyPromise = null;
let lastShownAt = 0;

function getMenuWindow() { return menuWindow; }

function createMenuWindow() {
  menuWindow = new BrowserWindow({
    width: 220,
    height: 220,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  menuWindow.setAlwaysOnTop(true, 'screen-saver');
  menuWindow.loadFile(path.join(__dirname, '..', 'renderer', 'menu.html'));

  // 失焦（点到别处）→ 收起；刚显示时的瞬时失焦要忽略
  menuWindow.on('blur', () => {
    if (Date.now() - lastShownAt < 400) return;
    if (menuWindow && !menuWindow.isDestroyed()) menuWindow.hide();
  });

  menuWindow.on('closed', () => { menuWindow = null; readyPromise = null; });

  readyPromise = new Promise((resolve) => {
    menuWindow.webContents.once('did-finish-load', () => resolve(menuWindow));
  });

  return menuWindow;
}

function ensureMenuWindow() {
  if (menuWindow && !menuWindow.isDestroyed()) return Promise.resolve(menuWindow);
  return createMenuWindow() ? readyPromise : Promise.resolve(null);
}

// 在屏幕坐标处打开菜单；位置先用鼠标点，等内容量出后再收紧
async function openMenuAt(x, y) {
  const w = await ensureMenuWindow();
  if (!w) return;
  w.setPosition(Math.round(x), Math.round(y));
  lastShownAt = Date.now();
  w.show();
  w.focus();
  w.webContents.send('menu:show');
}

function hideMenu() {
  if (menuWindow && !menuWindow.isDestroyed()) menuWindow.hide();
}

// 菜单内容量出实际尺寸后：设定窗口大小并把位置收进工作区
function fitMenu(size) {
  const w = menuWindow;
  if (!w || w.isDestroyed()) return;
  const cw = Math.max(180, Math.round(size.width));
  const ch = Math.max(120, Math.round(size.height));
  w.setContentSize(cw, ch);
  const bounds = w.getBounds();
  const wa = screen.getDisplayMatching(bounds).workArea;
  const x = Math.min(Math.max(bounds.x, wa.x), wa.x + wa.width - bounds.width);
  const y = Math.min(Math.max(bounds.y, wa.y), wa.y + wa.height - bounds.height);
  w.setPosition(Math.round(x), Math.round(y));
}

module.exports = { openMenuAt, hideMenu, fitMenu, getMenuWindow };
