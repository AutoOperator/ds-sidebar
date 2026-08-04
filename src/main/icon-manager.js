// icon-manager.js — 加载应用/托盘图标
const { nativeImage } = require('electron');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'renderer', 'assets');

function load(name) {
  try {
    const img = nativeImage.createFromPath(path.join(ASSETS, name));
    if (!img.isEmpty()) return img;
  } catch { /* 图标缺失时返回空 */ }
  return nativeImage.createEmpty();
}

function getWindowIcon() { return load('app-icon.png'); }
function getTrayIcon() { return load('tray-icon.png'); }

module.exports = { getWindowIcon, getTrayIcon };
