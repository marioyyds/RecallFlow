// 扩展图标门禁。
//
// 这类错误的特点是**静默**：manifest 里把图标声明成 .svg，Chrome 不会报错、
// 扩展照常加载，只是工具栏图标与扩展管理页图标不显示、回退成默认图标 ——
// 很容易一直没人发现。官方文档说得很直接：
//   "They can, however, be in any raster format supported by Blink, including BMP, GIF,
//    ICO, and JPEG. Caution: WebP and SVG files are not supported."
//   https://developer.chrome.com/docs/extensions/mv3/manifest/icons/
//
// 同样的约束也适用于 chrome.notifications 的 iconUrl，所以那条也一并检查。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const RASTER = /\.(png|bmp|gif|ico|jpe?g)$/i;

/** 读 PNG 的 IHDR，用来核对声明尺寸与文件实际尺寸是否一致。 */
function pngSize(file) {
  const b = fs.readFileSync(file);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) throw new Error(file + ' 不是 PNG');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const collect = (obj, label, out = []) => {
  for (const [size, file] of Object.entries(obj || {})) out.push({ label, size, file });
  return out;
};

const declared = [
  ...collect(manifest.icons, 'icons'),
  ...collect(manifest.action && manifest.action.default_icon, 'action.default_icon'),
];

test('manifest 声明了图标（否则 Chrome 用默认图标，品牌完全不出现）', () => {
  assert.ok(declared.length > 0, 'manifest 里没有任何图标声明');
  assert.ok(manifest.icons && manifest.icons['128'], '应提供 128x128 图标（安装与商店用）');
  assert.ok(manifest.icons['48'], '应提供 48x48 图标（扩展管理页用）');
});

test('图标必须是位图，不能是 SVG/WebP', () => {
  for (const d of declared) {
    assert.ok(
      RASTER.test(d.file),
      d.label + '["' + d.size + '"] 指向 ' + d.file + ' —— Chrome 不支持 SVG/WebP 作为扩展图标，' +
        '声明成这样不会报错，只会让图标静默地不显示。用 npm run render:icons 生成 PNG。'
    );
  }
});

test('声明的图标文件都存在，且实际尺寸与声明的档位一致', () => {
  for (const d of declared) {
    const file = path.join(ROOT, d.file);
    assert.ok(fs.existsSync(file), '图标文件不存在：' + d.file);
    const { width, height } = pngSize(file);
    const want = Number(d.size);
    assert.equal(width, want, d.file + ' 宽度是 ' + width + '，manifest 声明的是 ' + want);
    assert.equal(height, want, d.file + ' 高度是 ' + height + '，manifest 声明的是 ' + want);
  }
});

test('128 图标体积合理（避免误把超大图当图标提交）', () => {
  const file = path.join(ROOT, manifest.icons['128']);
  const kb = fs.statSync(file).size / 1024;
  assert.ok(kb < 200, 'icon-128 达到 ' + kb.toFixed(1) + ' KB，图标不该这么大');
});

test('通知图标也必须是位图（chrome.notifications 与 manifest 同一条约束）', () => {
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const m = bg.match(/iconUrl:\s*chrome\.runtime\.getURL\(\s*'([^']+)'/);
  assert.ok(m, 'background.js 里应能找到通知的 iconUrl');
  assert.ok(
    RASTER.test(m[1]),
    '通知的 iconUrl 指向 ' + m[1] + ' —— SVG 会让通知静默地不出图，应改用 PNG'
  );
  assert.ok(fs.existsSync(path.join(ROOT, m[1])), '通知图标文件不存在：' + m[1]);
});

test('品牌 SVG 仍然保留（面板 FAB / 弹窗等网页上下文里用 SVG 是正常的）', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'docs/assets/recallflow-mark.svg')), '源 SVG 不应被删掉');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/render-icons.mjs')), '应保留可复现的图标生成脚本');
});
