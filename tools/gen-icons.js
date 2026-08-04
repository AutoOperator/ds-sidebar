// gen-icons.js — 生成应用/托盘图标 PNG（纯 Node，无外部依赖）
// 设计：透明底 + 蓝色圆角方块 + 左侧白色竖条（侧栏意象）
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makePng(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 圆角方块 + 白色竖条
// colors: [r,g,b,a]
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const MARGIN = Math.max(1, Math.round(size * 0.06));
  const RADIUS = size * 0.22;
  const B = [37, 99, 235, 255];      // #2563eb 主蓝
  const W = [255, 255, 255, 255];    // 白
  const x0 = MARGIN, y0 = MARGIN, x1 = size - MARGIN, y1 = size - MARGIN;

  // 左侧白条宽度
  const barW = Math.max(2, Math.round(size * 0.14));
  const barX = Math.round(size * 0.2);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      // 圆角判断
      const inRound = inRounded(x + 0.5, y + 0.5, x0, y0, x1, y1, RADIUS);
      if (!inRound) continue;
      let c = B;
      // 白条（带轻微抗锯齿处理：直接用竖条边界判断）
      if (x + 0.5 >= barX && x + 0.5 < barX + barW) c = W;
      px[idx] = c[0]; px[idx + 1] = c[1]; px[idx + 2] = c[2]; px[idx + 3] = c[3];
    }
  }
  // 简单抗锯齿：边缘像素混合（对圆角附近透明像素做半透明填充，太复杂就跳过）
  return px;
}

function inRounded(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const cx0 = x0 + r, cy0 = y0 + r, cx1 = x1 - r, cy1 = y1 - r;
  if (px >= cx0 && px <= cx1) return true;
  if (py >= cy0 && py <= cy1) return true;
  // 四个圆角
  const corners = [
    [cx0, cy0], [cx0, cy1], [cx1, cy0], [cx1, cy1],
  ];
  for (const [cx, cy] of corners) {
    const dx = px - cx, dy = py - cy;
    if (dx * dx + dy * dy <= r * r) return true;
  }
  return false;
}

const outDir = path.join(__dirname, '..', 'src', 'renderer', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'app-icon.png'), makePng(256, draw(256)));
fs.writeFileSync(path.join(outDir, 'tray-icon.png'), makePng(32, draw(32)));
console.log('icons generated ->', outDir);

// 生成 .ico（256x256 PNG 直接嵌入，Windows 自动缩放）
function makeIco(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type: icon
  header.writeUInt16LE(1, 4);      // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0;      // 256x256 (0 means 256)
  entry.writeUInt16LE(1, 4);       // planes
  entry.writeUInt16LE(32, 6);      // bitcount
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);     // offset
  return Buffer.concat([header, entry, pngBuf]);
}

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'app.ico'), makeIco(makePng(256, draw(256))));
console.log('ico generated ->', path.join(buildDir, 'app.ico'));
