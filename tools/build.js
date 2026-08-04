// build.js — 打包绿色版
// 产物：dist/DS侧栏-win32-x64/
// 可选：设置环境变量 DS_DEPLOY_DIR 后打包完自动复制到该目录
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'src', 'renderer', 'vendor');
const echartsDist = path.join(root, 'node_modules', 'echarts', 'dist', 'echarts.min.js');
const OUT_NAME = 'DS侧栏-win32-x64';
const outDir = path.join(root, 'dist', OUT_NAME);
const deployDir = process.env.DS_DEPLOY_DIR || '';

// 1. 复制 echarts 到 vendor（renderer 本地加载，离线可用）
if (fs.existsSync(echartsDist)) {
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.copyFileSync(echartsDist, path.join(vendorDir, 'echarts.min.js'));
  console.log('[1/3] echarts.min.js 已复制到 renderer/vendor');
} else {
  console.warn('! 未找到 echarts，请先 npm install');
}

// 2. 生成图标
execSync(`node "${path.join(__dirname, 'gen-icons.js')}"`, { stdio: 'inherit' });

// 3. electron-packager 打包（存在 build/app.ico 时作为窗口图标）
const iconFlag = fs.existsSync(path.join(root, 'build', 'app.ico'))
  ? ` --icon="${path.join(root, 'build', 'app.ico')}"`
  : '';
console.log('[2/3] electron-packager 打包中…');
execSync(
  `npx electron-packager . "DS侧栏" --platform=win32 --arch=x64 --out=dist --overwrite --asar${iconFlag}`,
  { stdio: 'inherit', cwd: root }
);

// 4. 可选：部署到 DS_DEPLOY_DIR 指定的目录
if (deployDir) {
  console.log('[3/3] 部署到 ' + deployDir);
  fs.rmSync(deployDir, { recursive: true, force: true });
  fs.mkdirSync(deployDir, { recursive: true });
  const copyDir = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      const d = path.join(dest, name);
      const st = fs.statSync(s);
      if (st.isDirectory()) copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  };
  copyDir(outDir, deployDir);
  console.log('✅ 完成：' + deployDir);
}
