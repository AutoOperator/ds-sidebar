// snap-manager.js — 侧边吸附 + 自动隐藏 + 悬浮展开（复用文件仓模式）
const { screen } = require('electron');
const store = require('./store');
const {
  getMainWindow,
  getTriggerWindow,
  getTriggerBounds,
  getExpandedBounds,
  createTriggerWindow,
} = require('./window-manager');

const SETTINGS = {
  snapThreshold: 20,
  hideDelay: 3000,
};

// 截图验证模式下禁用吸附/折叠，保持窗口可见
const DISABLE_SNAP = process.argv.includes('--screenshot');

let snapState = {
  edge: null,          // 'top'|'bottom'|'left'|'right'|null
  isHidden: false,     // 是否处于隐藏(触点)状态
  isExpanded: false,   // 是否展开在边缘
  lastWindowSize: null,
  snapPosition: null,
  isSnapping: false,
  isExpanding: false,
  isCollapsing: false,
};

// 视图切换窗口尺寸变化期间抑制吸附判定（仅拖动/鼠标离开触发吸附）
let suppressSnapUntil = 0;
function beginViewSwitch() { suppressSnapUntil = Date.now() + 800; }

let hideTimer = null;
let mouseLeaveTimer = null;
let collapseToken = 0;

function getSnapState() { return { ...snapState }; }
function clearHideTimer() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
function clearMouseLeaveTimer() { if (mouseLeaveTimer) { clearTimeout(mouseLeaveTimer); mouseLeaveTimer = null; } }

// 触点偏好：大小(小/中/大) + 颜色，来自应用设置
function triggerPrefs() {
  const s = store.getSettings();
  return { size: s.triggerSize || 'small', color: s.triggerColor || '#2563eb' };
}

// 吸附是否允许：设置里开关自动吸附 + 固定按钮状态
function snapAllowed() {
  const s = store.getSettings();
  return s.autoSnap !== false && s.pinned !== true;
}

// 固定(pinned)：禁止拖动 + 禁止吸附 + 禁止自动隐藏
function isPinned() { return store.getSettings().pinned === true; }

// 自动隐藏延迟：来自设置，非法值回退 3000ms
function hideDelaySetting() {
  const d = Number(store.getSettings().hideDelay);
  return d > 0 ? d : SETTINGS.hideDelay;
}

// 检测窗口是否贴近屏幕边缘（左右优先）
function detectEdge(bounds) {
  if (!snapAllowed() || DISABLE_SNAP) return null;
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
  if (!win || !edge || snapState.isSnapping || !snapAllowed()) return;
  snapState.isSnapping = true;

  const bounds = win.getBounds();
  snapState.edge = edge;
  snapState.lastWindowSize = { width: bounds.width, height: bounds.height };
  snapState.snapPosition = { x: bounds.x, y: bounds.y };
  // 吸附后保持展开，绝不立刻折叠为触点；自动隐藏只由鼠标离开触发
  snapState.isExpanded = true;

  // 平滑滑入边缘，避免判定吸附时的瞬间位移
  const expandedBounds = getExpandedBounds(edge, snapState.lastWindowSize, bounds);
  if (expandedBounds) {
    animateWindowSlide(win, bounds, expandedBounds, 200, () => {
      snapState.isSnapping = false;
    });
  } else {
    snapState.isSnapping = false;
  }
}

function unsnap() {
  collapseToken++;
  clearHideTimer();
  clearMouseLeaveTimer();
  snapState.edge = null;
  snapState.isHidden = false;
  snapState.isExpanded = false;
  snapState.isCollapsing = false;
  const trigger = getTriggerWindow();
  if (trigger) trigger.hide();
}

// 视图切换导致窗口尺寸变化：更新吸附状态记录，让折叠/展开用新尺寸
function setWindowSize(size) {
  const win = getMainWindow();
  snapState.lastWindowSize = { width: size.width, height: size.height };
  if (win) snapState.snapPosition = { x: win.getBounds().x, y: win.getBounds().y };
}

// 折叠为触点细条：淡出主窗口后隐藏（可被 unsnap/拖动打断）
function collapseToTrigger() {
  const win = getMainWindow();
  if (!win || !snapState.edge) return;
  if (snapState.isExpanding || snapState.isCollapsing) return;
  snapState.isCollapsing = true;
  clearHideTimer();
  clearMouseLeaveTimer();

  const winBounds = snapState.snapPosition
    ? { ...snapState.snapPosition, ...snapState.lastWindowSize }
    : win.getBounds();
  const prefs = triggerPrefs();
  const triggerBounds = getTriggerBounds(snapState.edge, prefs.size, winBounds);

  let trigger = getTriggerWindow();
  if (!trigger) {
    trigger = createTriggerWindow();
    trigger.webContents.once('did-finish-load', () => {
      trigger.webContents.send('trigger-config', { edge: snapState.edge, color: prefs.color, size: prefs.size });
    });
  } else {
    trigger.webContents.send('trigger-config', { edge: snapState.edge, color: prefs.color, size: prefs.size });
  }
  if (triggerBounds) trigger.setBounds(triggerBounds);
  trigger.show();
  if (typeof trigger.moveTop === 'function') trigger.moveTop();

  const token = ++collapseToken;
  const startOpacity = win.getOpacity();
  const DUR = 150, t0 = Date.now();
  const fade = () => {
    if (token !== collapseToken) { win.setOpacity(startOpacity); return; }
    const t = Math.min((Date.now() - t0) / DUR, 1);
    try { win.setOpacity(Math.max(0.01, startOpacity * (1 - t))); } catch { /* 忽略 */ }
    if (t < 1) setTimeout(fade, 16);
    else {
      win.hide();
      win.setOpacity(startOpacity);
      snapState.isHidden = true;
      snapState.isExpanded = false;
      snapState.isCollapsing = false;
    }
  };
  fade();
}

// 触点已隐藏时，设置里改大小/颜色后即时重绘触点
function refreshTriggerConfig() {
  if (!snapState.isHidden || !snapState.edge) return;
  const win = getMainWindow();
  const winBounds = snapState.snapPosition
    ? { ...snapState.snapPosition, ...snapState.lastWindowSize }
    : (win ? win.getBounds() : null);
  const prefs = triggerPrefs();
  const trigger = getTriggerWindow();
  if (!trigger) return;
  const triggerBounds = getTriggerBounds(snapState.edge, prefs.size, winBounds);
  if (triggerBounds) trigger.setBounds(triggerBounds);
  trigger.webContents.send('trigger-config', { edge: snapState.edge, color: prefs.color, size: prefs.size });
}

// 从触点展开窗口：滑动 + 淡入
function expandFromTrigger() {
  const win = getMainWindow();
  if (!win || !snapState.edge) return;
  if (snapState.isExpanding || snapState.isCollapsing) return;
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
  if (isPinned()) return; // 固定后不自动隐藏到侧边
  clearMouseLeaveTimer();
  mouseLeaveTimer = setTimeout(() => {
    if (snapState.edge && snapState.isExpanded) collapseToTrigger();
  }, hideDelaySetting());
}

function cancelMouseLeaveTimer() { clearMouseLeaveTimer(); }

function handleWindowMove() {
  if (Date.now() < suppressSnapUntil) return; // 视图切换期间不判定
  const win = getMainWindow();
  if (!win || snapState.isSnapping || snapState.isExpanding || snapState.isCollapsing) return;
  if (snapState.edge && snapState.isExpanded && !snapState.isHidden) unsnap();
}

function handleWindowMoved() {
  if (Date.now() < suppressSnapUntil) return; // 视图切换期间不判定
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
  collapseToken++;
  clearHideTimer();
  clearMouseLeaveTimer();
  const trigger = getTriggerWindow();
  if (trigger) trigger.hide();
  const win = getMainWindow();
  if (win) win.hide();
  snapState.edge = null;
  snapState.isHidden = false;
  snapState.isExpanded = false;
  snapState.isCollapsing = false;
}

module.exports = {
  getSnapState,
  setWindowSize,
  beginViewSwitch,
  detectEdge,
  snapToEdge,
  unsnap,
  collapseToTrigger,
  refreshTriggerConfig,
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
