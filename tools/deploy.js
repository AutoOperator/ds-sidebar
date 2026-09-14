// deploy.js — 把打包产物复制到绿色版目标目录
// 目标目录会整个清空重建，但 config/ 里是绿色版的设置与加密凭证：
// 先挪到旁边、复制完再放回，否则每更新一次都要重新登录一次。
// 被 build.js 调用；也可以单独 require 来做验证。
const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// → { keptConfig: boolean }
function deploy(srcDir, destDir) {
  const cfgDir = path.join(destDir, 'config');
  // 用 basename 拼，避免 deployDir 带结尾斜杠时拼出坏路径
  const cfgStash = path.join(path.dirname(destDir), path.basename(destDir) + '.config-stash');
  let stashed = false;

  if (fs.existsSync(cfgDir)) {
    try {
      fs.rmSync(cfgStash, { recursive: true, force: true });
      fs.renameSync(cfgDir, cfgStash);
      stashed = true;
    } catch (e) {
      console.warn('! config/ 挪不动（应用可能正在运行），本次部署后需要重新登录：' + e.message);
    }
  }

  fs.rmSync(destDir, { recursive: true, force: true });
  copyDir(srcDir, destDir);

  if (stashed) {
    try {
      fs.renameSync(cfgStash, cfgDir);
      console.log('   已保留原有 config/（设置与凭证未丢失）');
    } catch (e) {
      console.warn('! config/ 放回失败，原数据在 ' + cfgStash + '，手动挪回即可：' + e.message);
    }
  }
  return { keptConfig: stashed };
}

module.exports = { deploy };
