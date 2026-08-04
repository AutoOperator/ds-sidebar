// tray-manager.js — 系统托盘（仅托盘，无任务栏）
const { Tray, Menu, app } = require('electron');
const iconManager = require('./icon-manager');

let tray = null;

function createTray(callbacks = {}) {
  tray = new Tray(iconManager.getTrayIcon());
  tray.setToolTip('DS侧栏 - DeepSeek 用量监控');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示侧栏',
      click: () => callbacks.showWindow?.(),
    },
    { type: 'separator' },
    {
      label: '刷新数据',
      click: () => callbacks.refresh?.(),
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => callbacks.showWindow?.());
  return tray;
}

function destroyTray() {
  if (tray) { tray.destroy(); tray = null; }
}

module.exports = { createTray, destroyTray };
