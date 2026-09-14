// credential-store.js — 凭证加密（Windows DPAPI / macOS Keychain）
// 用 Electron safeStorage 加密后落盘，避免 User Token 以明文出现在 config/state.json。
// 存储格式：enc:v1:<base64>。系统钥匙串不可用时回退明文，兼容旧数据。
const { safeStorage } = require('electron');

const PREFIX = 'enc:v1:';

function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

// 幂等加密：空值/已是密文原样返回
function encrypt(plain) {
  if (!plain || typeof plain !== 'string') return plain;
  if (plain.startsWith(PREFIX)) return plain;
  if (!canEncrypt()) return plain;
  try {
    return PREFIX + safeStorage.encryptString(plain).toString('base64');
  } catch { return plain; }
}

// 解密：非密文（旧明文）原样返回；解密失败视为凭证失效返回空串
function decrypt(stored) {
  if (!stored || typeof stored !== 'string') return stored;
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'));
  } catch { return ''; }
}

module.exports = { encrypt, decrypt, isEncrypted };
