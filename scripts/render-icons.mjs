// 把品牌 SVG 光栅化成扩展图标所需的 PNG。
//
// 为什么需要这个脚本：Chrome 的 manifest `icons` / `action.default_icon`
// **只接受位图**，官方文档写得很直接 —— "They can, however, be in any raster format
// supported by Blink, including BMP, GIF, ICO, and JPEG. **Caution: WebP and SVG files
// are not supported.**"（https://developer.chrome.com/docs/extensions/mv3/manifest/icons/）
// 声明成 .svg 的后果不是报错，而是图标静默地渲染不出来、回退成默认图标 ——
// 很容易一直没人发现。
//
// 为什么用系统 Chrome 而不是引入渲染库：
// 仓库里已有的 @playwright/test 并没有安装浏览器（node_modules 缺失、ms-playwright 为空），
// 为一次性的图标生成拉一个浏览器不值得。系统上的 Chrome/Edge 就是最忠实的光栅化器 ——
// 它和加载扩展的是同一个引擎，渐变、投影、贝塞尔路径都会按原样呈现。
//
// 用法：npm run icons
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_SVG = path.join(ROOT, 'docs', 'assets', 'recallflow-mark.svg');
const OUT_DIR = path.join(ROOT, 'docs', 'assets');
const SIZES = [16, 32, 48, 128];

const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};

function findBrowser() {
  for (const p of CANDIDATES[process.platform] || CANDIDATES.linux) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('找不到 Chrome/Edge。可自行安装，或把生成的 PNG 放到 docs/assets/ 下。');
}

const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');

/** 读 PNG 尺寸：IHDR 固定在签名后的第 16..23 字节。 */
function pngSize(file) {
  const b = fs.readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (b[i] !== sig[i]) throw new Error(path.basename(file) + ' 不是合法 PNG');
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25], bytes: b.length };
}

function main() {
  if (!fs.existsSync(SRC_SVG)) throw new Error('找不到源 SVG：' + SRC_SVG);
  const browser = findBrowser();
  console.log('渲染器：' + browser);
  console.log('源文件：' + path.relative(ROOT, SRC_SVG));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-icons-'));
  const results = [];

  try {
    for (const size of SIZES) {
      // SVG 自带 width/height=256，直接当文档打开只会被**裁剪**而不是缩放，
      // 所以套一层 HTML 用 <img width/height> 指定目标尺寸。
      const html = path.join(work, 'w' + size + '.html');
      fs.writeFileSync(
        html,
        '<html><body style="margin:0;padding:0;background:transparent">' +
          '<img src="' + toUrl(SRC_SVG) + '" width="' + size + '" height="' + size + '" style="display:block">' +
          '</body></html>',
        'utf8'
      );
      const out = path.join(OUT_DIR, 'icon-' + size + '.png');
      try {
        fs.rmSync(out, { force: true });
        execFileSync(
          browser,
          [
            '--headless=new',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--hide-scrollbars',
            '--default-background-color=00000000', // 透明背景
            '--user-data-dir=' + path.join(work, 'profile'), // 独立 profile：否则会被正在运行的浏览器接管
            '--window-size=' + size + ',' + size,
            '--force-device-scale-factor=1',
            '--screenshot=' + out,
            toUrl(html),
          ],
          { stdio: 'ignore', timeout: 60000 }
        );
      } catch (e) {
        // headless 有时会在写完截图后才以非零码退出，因此以产物为准判断成败
      }
      if (!fs.existsSync(out)) throw new Error('未生成 icon-' + size + '.png');
      const info = pngSize(out);
      if (info.width !== size || info.height !== size) {
        throw new Error('icon-' + size + '.png 尺寸不对：' + info.width + 'x' + info.height);
      }
      results.push({ size, info });
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  for (const r of results) {
    console.log(
      '  icon-' + r.size + '.png  ' + r.info.width + 'x' + r.info.height +
      '  ' + (r.info.colorType === 6 ? 'RGBA' : 'colorType=' + r.info.colorType) +
      '  ' + (r.info.bytes / 1024).toFixed(1) + ' KB'
    );
  }
  console.log('完成。manifest 的 icons / action.default_icon 已指向这些 PNG。');
}

main();
