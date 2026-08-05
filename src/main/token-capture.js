// token-capture.js — 一键获取 User Token
// 内嵌一个登录窗口加载 platform.deepseek.com，登录后平台的 SPA 会给 /api/v0 请求加上
// Authorization: Bearer <token>，这里用 webRequest.onBeforeSendHeaders 拦下这个 token，
// 存入应用设置（userToken）。这样用户只需登录一次，连 API Key 都不用填。
const { BrowserWindow, session } = require('electron');
const store = require('./store');
const { encrypt } = require('./credential-store');

const PARTITION = 'persist:ds-login';
const LOGIN_URL = 'https://platform.deepseek.com/';
const TIMEOUT_MS = 5 * 60 * 1000;

function captureUserToken() {
  const ses = session.fromPartition(PARTITION);

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 430,
      height: 680,
      title: '登录 DeepSeek 平台',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let captured = false;
    const timeout = setTimeout(() => {
      cleanup();
      if (!win.isDestroyed()) win.close();
      reject(new Error('等待登录超时'));
    }, TIMEOUT_MS);

    const onHeaders = (details, cb) => {
      const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization'] || '';
      if (!captured && /^Bearer\s+/i.test(auth)) {
        captured = true;
        const token = auth.replace(/^Bearer\s+/i, '').trim();
        if (token) {
          store.updateSettings({ userToken: encrypt(token) });
          setTimeout(() => {
            if (!win.isDestroyed()) win.close();
            resolve(token);
          }, 200);
        }
      }
      cb({});
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ses.webRequest.onBeforeSendHeaders(null);
    };

    ses.webRequest.onBeforeSendHeaders(onHeaders);

    win.on('closed', () => {
      cleanup();
      if (!captured) reject(new Error('用户取消登录'));
    });

    win.loadURL(LOGIN_URL);
    win.once('ready-to-show', () => win.show());
  });
}

module.exports = { captureUserToken };
