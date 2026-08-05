// preload.js — 安全的 IPC 桥接
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  data: {
    get: () => ipcRenderer.invoke('data:get'),
    refresh: () => ipcRenderer.invoke('data:refresh'),
    onUpdate: (cb) => {
      const h = (e, data) => cb(data);
      ipcRenderer.on('data:update', h);
      return () => ipcRenderer.removeListener('data:update', h);
    },
  },
  window: {
    close: () => ipcRenderer.invoke('window:close'),
    setView: (mode) => ipcRenderer.invoke('window:setView', mode),
    getState: () => ipcRenderer.invoke('window:getState'),
    mouseEnter: () => ipcRenderer.send('window:mouseEnter'),
    mouseLeave: () => ipcRenderer.send('window:mouseLeave'),
    onSetView: (cb) => {
      const h = (e, mode) => cb(mode);
      ipcRenderer.on('view:set', h);
      return () => ipcRenderer.removeListener('view:set', h);
    },
  },
  menu: {
    open: (x, y) => ipcRenderer.send('menu:open', { x, y }),
    close: () => ipcRenderer.send('menu:close'),
    fit: (width, height) => ipcRenderer.send('menu:fit', { width, height }),
    onShow: (cb) => {
      const h = () => cb();
      ipcRenderer.on('menu:show', h);
      return () => ipcRenderer.removeListener('menu:show', h);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (partial) => ipcRenderer.invoke('settings:update', partial),
    onChanged: (cb) => {
      const h = (e, settings) => cb(settings);
      ipcRenderer.on('settings:updated', h);
      return () => ipcRenderer.removeListener('settings:updated', h);
    },
  },
  stats: {
    setRange: (range) => ipcRenderer.invoke('stats:setRange', range),
    getApiKeys: () => ipcRenderer.invoke('stats:getApiKeys'),
    getCreds: () => ipcRenderer.invoke('stats:getCreds'),
  },
  token: {
    capture: () => ipcRenderer.invoke('token:capture'),
  },
  snap: {
    getState: () => ipcRenderer.invoke('snap:getState'),
    expand: () => ipcRenderer.invoke('snap:expand'),
  },
  trigger: {
    mouseEnter: () => ipcRenderer.send('trigger:mouseEnter'),
    mouseClick: () => ipcRenderer.send('trigger:mouseClick'),
    onConfig: (cb) => {
      const h = (e, config) => cb(config);
      ipcRenderer.on('trigger-config', h);
      return () => ipcRenderer.removeListener('trigger-config', h);
    },
  },
});
