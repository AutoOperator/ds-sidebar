// store.js — 轻量状态持久化（窗口位置 + 视图模式）
// 绿色版（打包后）：配置跟 exe 走，放 exe 同目录 config/
// 开发版：userData 目录
const fs = require('fs');
const path = require('path');

let state = null;

function getConfigDir() {
  const { app } = require('electron');
  if (app.isPackaged) {
    const baseDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
    const dir = path.join(baseDir, 'config');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  return app.getPath('userData');
}

function stateFile() {
  return path.join(getConfigDir(), 'state.json');
}

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    state = {};
  }
  // 默认值
  if (state.viewMode == null) state.viewMode = 1;
  if (state.bounds == null) state.bounds = null;
  if (state.settings == null) state.settings = { theme: 'day', opacity: 1 };
  else {
    if (state.settings.theme == null) state.settings.theme = 'day';
    if (state.settings.opacity == null) state.settings.opacity = 1;
  }
  if (state.settings.range == null) state.settings.range = 'today';
  if (state.settings.apiFilter == null) state.settings.apiFilter = 'all';
  if (state.settings.stripApi == null) state.settings.stripApi = 'all';
  if (state.settings.autoSnap == null) state.settings.autoSnap = true;
  if (state.settings.pinned == null) state.settings.pinned = false;
  if (state.settings.demo == null) state.settings.demo = false;
  if (state.settings.triggerSize == null) state.settings.triggerSize = 'small';
  if (state.settings.triggerColor == null) state.settings.triggerColor = '#2563eb';
  if (state.settings.hideDelay == null) state.settings.hideDelay = 3000;
  // userToken 可选：为空时 ds-api 回退到 ds-watch 文件（凭证只用 User Token，不用 API Key）
  return state;
}

function save() {
  try { fs.writeFileSync(stateFile(), JSON.stringify(load())); } catch { /* 忽略写失败 */ }
}

function getState() { return load(); }

function update(partial) {
  state = { ...load(), ...partial };
  save();
  return state;
}

function getSettings() { return load().settings; }

function updateSettings(partial) {
  const s = { ...getSettings(), ...partial };
  update({ settings: s });
  return s;
}

module.exports = { getState, update, getSettings, updateSettings };
