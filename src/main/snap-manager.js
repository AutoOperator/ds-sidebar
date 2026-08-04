// snap-manager.js — 侧边吸附 + 自动隐藏 + 悬浮展开（复用文件仓模式）
const { screen } = require('electron');
const {
  getMainWindow,
  getTriggerWindow,
  getTriggerBounds,
  getExpandedBounds,
  createTriggerWindow,
} = require('./window-manager');

const SETTINGS = {
  snapEnabled: true,
  snapThreshold: 20,
  autoHideOnSnap: true,
  triggerSize: 'medium',
  triggerColor: '#2563eb',
  triggerAction: 'hover',
  hideDelay: 3000,
};

// 截图验证模式下禁用吸附/折叠，保持窗口可见
const DISABLE_SNAP = process.argv.includes('--screenshot');

let snapState = {
  edge: null,          // 'top'|'bottom'|'left'|'right'|null
  isHidden: false,     // 是否处于隐藏(触点)状态
  isExpanded: false,   // 是否从触点展开
  lastWindowSize: null,
  snapPosition: null,
  isSnapping: false,
  isExpanding: false,
};

let hideTimer = null;
let mouseLeaveTimer = null;

function getSnapState() { return { ...snapState }; }
function clearHideTimer() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
function clearMouseLeaveTimer() { if (mouseLeaveTimer) { clearTimeout(mouseLeaveTimer); mouseLeaveTimer = null; } }

// 检测窗口是否贴近屏幕边缘（左右优先）
function detectEdge(bounds) {
  if (!SETTINGS.snapEnabled || DISABLE_SNAP) return null;
  const threshold = SETTINGS.snapThreshold;
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const nearTop = Math.abs(bounds.y - workArea.y) < threshold;
  const nearBottom = Math.abs((bounds.y + bounds.height) - (workArea.y + workArea.height)) < threshold;
  const nearLeft = Math.abs(bounds.x - workArea.x) < threshold;
  const nearRight = Math.abs((bounds.x + bounds.width) - (workArea.x + workArea.width)) < threshold;
  if (nearLeft) return 'left';
  if (nearRight) return 'right';
  if (nearTop) return 'top';
  if (nearBottom) return 'bottom';
  return null;
}

function snapToEdge(edge) {
  const win = getMainWindow();
  if (!win || !edge || snapState.isSnapping) return;
  snapState.isSnapping = true;

  const bounds = win.getBounds();
  snapState.edge = edge;
  snapState.lastWindowSize = { width: bounds.width, height: bounds.height };
  snapState.snapPosition = { x: bounds.x, y: bounds.y };

  const expandedBounds = getExpandedBounds(edge, snapState.lastWindowSize, bounds);
  if (expandedBounds) win.setBounds(expandedBounds);

  if (SETTINGS.autoHideOnSnap) {
    clearHideTimer();
    hideTimer = setTimeout(() => { collapseToTrigger(); }, 500);
  }

  setTimeout(() => { snapState.isSnapping = false; }, 500);
}

function unsnap() {
  clearHideTimer();
  clearMouseLeaveTimer();
  snapState.edge = null;
  snapState.isHidden = false;
  snapState.isExpanded = false;
  const trigger = getTriggerWindow();
  if (trigger) trigger.hide();
}

// 视图切换导致窗口尺寸变化：更新吸附状态记录，让折叠/展开用新尺寸
function setWindowSize(size) {
  const win = getMainWindow();
  snapState.lastWindowSize = { width: size.width, height: size.height };
  if (win) snapState.snapPosition = { x: win.getBounds().x, y: win.getBounds().y };
}

// 折叠为触点细条
function collapseToTrigger() {
  const win = getMainWindow();
  if (!win || !snapState.edge) return;
  if (snapState.isExpanding) return;

  const winBounds = snapState.snapPosition
    ? { ...snapState.snapPosition, ...snapState.lastWindowSize }
    : win.getBounds();
  const triggerBounds = getTriggerBounds(snapState.edge, SETTINGS.triggerSize, winBounds);

  let trigger = getTriggerWindow();
  if (!trigger) {
    trigger = createTriggerWindow();
    trigger.webContents.once('did-finish-load', () => {
      trigger.webContents.send('trigger-config', {
        edge: snapState.edge,
        color: SETTINGS.triggerColor,
        size: SETTINGS.triggerSize,
      });
    });
  } else {
    trigger.webContents.send('trigger-config', {
      edge: snapState.edge,
      color: SETTINGS.triggerColor,
      size: SETTINGS.triggerSize,
    });
  }

  if (triggerBounds) trigger.setBounds(triggerBounds);
  trigger.show();
  if (typeof trigger.moveTop === 'function') trigger.moveTop();
  win.hide();

  snapState.isHidden = true;
  snapState.isExpanded = false;
}

// 从触点展开窗口：滑动 + 淡入
function expandFromTrigger() {
  const win = getMainWindow();
  if (!win || !snapState.edge) return;
  if (snapState.isExpanding) return;
  snapState.isExpanding = true;

  const trigger = getTriggerWindow();
  const size = snapState.lastWindowSize || { width: 600, height: 40 };
  const finalBounds = getExpandedBounds(snapState.edge, size, snapState.snapPosition);
  if (!finalBounds) {
    win.show();
    win.focus();
    if (trigger) trigger.hide();
    snapState.isHidden = false;
    snapState.isExpanded = true;
    snapState.isExpanding = false;
    clearMouseLeaveTimer();
    return;
  }

  const startBounds = computeSlideStart(snapState.edge, finalBounds);
  win.setBounds(startBounds);
  win.setOpacity(0);
  win.show();
  win.focus();

  setTimeout(() => {
    if (!snapState.isExpanding || win.isDestroyed()) {
      snapState.isExpanding = false;
      return;
    }
    win.setOpacity(1);
    if (trigger && !trigger.isDestroyed()) trigger.hide();
    animateWindowSlide(win, startBounds, finalBounds, 260, () => {
      snapState.isExpanding = false;
    });
  }, 16);

  snapState.isHidden = false;
  snapState.isExpanded = true;
  clearMouseLeaveTimer();
}

function computeSlideStart(edge, final) {
  switch (edge) {
    case 'left':   return { x: final.x - final.width, y: final.y, width: final.width, height: final.height };
    case 'right':  return { x: final.x + final.width, y: final.y, width: final.width, height: final.height };
    case 'top':    return { x: final.x, y: final.y - final.height, width: final.width, height: final.height };
    case 'bottom': return { x: final.x, y: final.y + final.height, width: final.width, height: final.height };
    default: return final;
  }
}

function animateWindowSlide(win, startBounds, finalBounds, duration, onDone) {
  const startTime = Date.now();
  const dx = finalBounds.x - startBounds.x;
  const dy = finalBounds.y - startBounds.y;
  const w = finalBounds.width;
  const h = finalBounds.height;

  function step() {
    const t = Math.min((Date.now() - startTime) / duration, 1);
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    const x = Math.round(startBounds.x + dx * e);
    const y = Math.round(startBounds.y + dy * e);
    try {
      win.setBounds({ x, y, width: w, height: h });
    } catch { if (onDone) onDone(); return; }
    if (t < 1) setTimeout(step, 16);
    else if (onDone) onDone();
  }
  step();
}

function startMouseLeaveTimer() {
  clearMouseLeaveTimer();
  mouseLeaveTimer = setTimeout(() => {
    if (snapState.edge && snapState.isExpanded) collapseToTrigger();
  }, SETTINGS.hideDelay);
}

function cancelMouseLeaveTimer() { clearMouseLeaveTimer(); }

function handleWindowMove() {
  const win = getMainWindow();
  if (!win || snapState.isSnapping || snapState.isExpanding) return;
  if (snapState.edge && snapState.isExpanded && !snapState.isHidden) unsnap();
}

function handleWindowMoved() {
  const win = getMainWindow();
  if (!win || snapState.isSnapping || snapState.isExpanding) return;
  if (snapState.isHidden) return;

  const bounds = win.getBounds();
  const edge = detectEdge(bounds);
  if (edge && edge !== snapState.edge) {
    if (snapState.edge) unsnap();
    snapToEdge(edge);
  } else if (!edge && snapState.edge) {
    unsnap();
  }
}

function onTriggerActivated() { expandFromTrigger(); }
function onMainWindowMouseEnter() { if (snapState.edge && snapState.isExpanded) cancelMouseLeaveTimer(); }
function onMainWindowMouseLeave() { if (snapState.edge && snapState.isExpanded) startMouseLeaveTimer(); }

// 完全隐藏到托盘（X 按钮 / 托盘菜单）
function hideToTray() {
  clearHideTimer();
  clearMouseLeaveTimer();
  const trigger = getTriggerWindow();
  if (trigger) trigger.hide();
  const win = getMainWindow();
  if (win) win.hide();
  snapState.edge = null;
  snapState.isHidden = false;
  snapState.isExpanded = false;
}

module.exports = {
  getSnapState,
  setWindowSize,
  detectEdge,
  snapToEdge,
  unsnap,
  collapseToTrigger,
  expandFromTrigger,
  handleWindowMove,
  handleWindowMoved,
  onTriggerActivated,
  onMainWindowMouseEnter,
  onMainWindowMouseLeave,
  startMouseLeaveTimer,
  cancelMouseLeaveTimer,
  hideToTray,
};
