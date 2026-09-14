// window-manager.js — 主窗口 + 触点窗口创建与位置计算（复用文件仓模式）
const { BrowserWindow, screen, nativeImage } = require('electron');
const path = require('path');
const iconManager = require('./icon-manager');

let mainWindow = null;
let triggerWindow = null;

// 窗口尺寸：细条模式（一条文字）与图表模式（横向展开成更宽的矩形）
// 图表宽度从 800 提到 900：表头挤了三张统计卡，800 下"16.24亿"这类数值会被截断
const STRIP_SIZE = { width: 600, height: 40 };
const CHART_SIZE = { width: 900, height: 420 };

function getStripSize() { return { ...STRIP_SIZE }; }
function getChartSize() { return { ...CHART_SIZE }; }

// 缩放窗口并尽量保持当前吸附的屏幕边缘（未吸附时保持非边缘方向位置）
function resizeToSize(win, size) {
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const wa = display.workArea;
  const nearRight = Math.abs((bounds.x + bounds.width) - (wa.x + wa.width)) < 40;
  const nearLeft = Math.abs(bounds.x - wa.x) < 40;
  const nearBottom = Math.abs((bounds.y + bounds.height) - (wa.y + wa.height)) < 40;
  const nearTop = Math.abs(bounds.y - wa.y) < 40;

  let x = bounds.x, y = bounds.y;
  if (nearRight) x = wa.x + wa.width - size.width;
  else if (nearLeft) x = wa.x;
  if (nearBottom) y = wa.y + wa.height - size.height;
  else if (nearTop) y = wa.y;

  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - size.width);
  y = Math.min(Math.max(y, wa.y), wa.y + wa.height - size.height);
  win.setBounds({ x, y, width: size.width, height: size.height });
  return { x, y, ...size };
}

// 按视图模式限制手动拉伸方向：短条=高度锁死只横向可拉，图表=双向自由
function applyResizeConstraints(win, mode) {
  if (!win || win.isDestroyed()) return;
  if (mode === 2) {
    win.setMinimumSize(380, 40);
    win.setMaximumSize(10000, 10000);
  } else {
    win.setMinimumSize(380, 40);
    win.setMaximumSize(10000, 40);
  }
}

// 触点尺寸配置（3 档，小=当前默认 50；左上角锚点不变）
const TRIGGER_SIZES = {
  small:  { length: 50,  thickness: 5 },
  medium: { length: 75,  thickness: 6 },
  large:  { length: 100, thickness: 7 },
};

const ALWAYS_ON_TOP_LEVEL = 'screen-saver';

function getMainWindow() { return mainWindow; }
function getTriggerWindow() { return triggerWindow; }

function createMainWindow() {
  const icon = iconManager.getWindowIcon();
  mainWindow = new BrowserWindow({
    width: STRIP_SIZE.width,
    height: STRIP_SIZE.height,
    minWidth: 380,
    minHeight: 40,
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    icon,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  return mainWindow;
}

function createTriggerWindow() {
  triggerWindow = new BrowserWindow({
    width: 5,
    height: 100,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  triggerWindow.setAlwaysOnTop(true, ALWAYS_ON_TOP_LEVEL);
  triggerWindow.loadFile(path.join(__dirname, '..', 'renderer', 'trigger.html'));
  triggerWindow.setIgnoreMouseEvents(false);

  triggerWindow.on('closed', () => { triggerWindow = null; });

  return triggerWindow;
}

// 触点位置：默认居中，若给了窗口当前位置则跟随窗口（偏中上/中左）
function getTriggerBounds(edge, sizeName, currentBounds) {
  const size = TRIGGER_SIZES[sizeName] || TRIGGER_SIZES.small;
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  const { x: wx, y: wy } = display.workArea;

  let posX = wx + (sw - size.length) / 2;
  let posY = wy + (sh - size.length) / 2;

  if (currentBounds) {
    posY = currentBounds.y + (currentBounds.height || 0) * 0.25;
    posX = currentBounds.x + (currentBounds.width || 0) * 0.25;
  }

  posX = Math.min(Math.max(posX, wx), wx + sw - size.length);
  posY = Math.min(Math.max(posY, wy), wy + sh - size.length);

  switch (edge) {
    case 'top':    return { x: posX, y: wy, width: size.length, height: size.thickness };
    case 'bottom': return { x: posX, y: wy + sh - size.thickness, width: size.length, height: size.thickness };
    case 'left':   return { x: wx, y: posY, width: size.thickness, height: size.length };
    case 'right':  return { x: wx + sw - size.thickness, y: posY, width: size.thickness, height: size.length };
    default: return null;
  }
}

// 主窗口吸附后展开位置：贴齐边缘，保持非吸附方向当前位置
function getExpandedBounds(edge, windowSize, currentBounds) {
  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  const { x: wx, y: wy } = display.workArea;
  const w = windowSize.width || STRIP_SIZE.width;
  const h = windowSize.height || STRIP_SIZE.height;

  let keepX = wx + (sw - w) / 2;
  let keepY = wy + (sh - h) / 2;
  if (currentBounds) {
    keepX = currentBounds.x;
    keepY = currentBounds.y;
  }
  const clampX = Math.min(Math.max(keepX, wx), wx + sw - w);
  const clampY = Math.min(Math.max(keepY, wy), wy + sh - h);

  switch (edge) {
    case 'top':    return { x: clampX, y: wy, width: w, height: h };
    case 'bottom': return { x: clampX, y: wy + sh - h, width: w, height: h };
    case 'left':   return { x: wx, y: clampY, width: w, height: h };
    case 'right':  return { x: wx + sw - w, y: clampY, width: w, height: h };
    default: return null;
  }
}

module.exports = {
  createMainWindow,
  createTriggerWindow,
  getMainWindow,
  getTriggerWindow,
  getTriggerBounds,
  getExpandedBounds,
  resizeToSize,
  applyResizeConstraints,
  getStripSize,
  getChartSize,
  TRIGGER_SIZES,
  ALWAYS_ON_TOP_LEVEL,
};
