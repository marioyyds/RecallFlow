// dev-paths 单元测试：源码 URL → 磁盘路径的归一化。
// 重点是**反例**：依据不足时必须原样返回，绝不能把接口 URL 误改成磁盘路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  toDiskPath,
  joinProjectPath,
  normalizeElementSource,
  rewriteSourceUrls,
  normalizePickedElement,
  normalizationHint,
} from '../lib/shared/dev-paths.js';

// 平台无关的项目根（Windows 上为盘符绝对路径，POSIX 上为 /…）。
const ROOT = path.resolve('proj-root');
const CTX = { projectRoot: ROOT, devUrl: 'http://localhost:5173' };
const disk = (...segs) => path.join(ROOT, ...segs);

test('toDiskPath: Vite 开发服务器 URL → 磁盘路径', () => {
  assert.equal(
    toDiskPath('http://localhost:5173/src/components/Button.tsx', CTX),
    disk('src', 'components', 'Button.tsx')
  );
});

test('toDiskPath: 保留 :行:列 后缀', () => {
  assert.equal(
    toDiskPath('http://localhost:5173/src/App.tsx:42:7', CTX),
    disk('src', 'App.tsx') + ':42:7'
  );
});

test('toDiskPath: 剥掉 Vite 的 ?t= 缓存串后再转换', () => {
  assert.equal(
    toDiskPath('http://localhost:5173/src/App.tsx?t=1712345678', CTX),
    disk('src', 'App.tsx')
  );
  // 缓存串与行列同时存在
  assert.equal(
    toDiskPath('http://localhost:5173/src/App.tsx?t=1712345678:12:3', CTX),
    disk('src', 'App.tsx') + ':12:3'
  );
});

test('toDiskPath: 不把 URL 端口号当成行号', () => {
  // 只有主机名 + 端口，没有源码路径 → 无依据，原样返回
  assert.equal(toDiskPath('http://localhost:5173', CTX), 'http://localhost:5173');
});

test('toDiskPath: 根相对路径拼到 projectRoot', () => {
  assert.equal(toDiskPath('/src/main.ts', CTX), disk('src', 'main.ts'));
});

test('toDiskPath: webpack:// 去掉 scheme 与 host', () => {
  assert.equal(toDiskPath('webpack:///./src/App.tsx', CTX), disk('src', 'App.tsx'));
  assert.equal(toDiskPath('webpack://myapp/./src/App.tsx', CTX), disk('src', 'App.tsx'));
});

test('toDiskPath: file:// 视为已绝对，不拼 projectRoot', () => {
  const out = toDiskPath('file:///srv/app/src/App.tsx', CTX);
  assert.ok(out.includes('App.tsx'), 'out=' + out);
  assert.ok(!out.startsWith(ROOT), '不应拼上 projectRoot：' + out);
});

test('toDiskPath: 已是盘符绝对路径则原样返回', () => {
  const win = 'D:\\proj\\src\\a.tsx';
  assert.equal(toDiskPath(win, CTX), win);
});

test('toDiskPath: blob:/data: 不处理', () => {
  assert.equal(toDiskPath('blob:http://localhost:5173/abc', CTX), '');
  assert.equal(toDiskPath('data:text/javascript,1', CTX), '');
});

test('toDiskPath: 无 projectRoot 时保留服务器根相对形态，不臆造磁盘路径', () => {
  assert.equal(toDiskPath('http://localhost:5173/src/App.tsx', {}), '/src/App.tsx');
});

test('joinProjectPath: 空路径返回空串', () => {
  assert.equal(joinProjectPath(ROOT, ''), '');
  assert.equal(joinProjectPath(ROOT, '/'), '');
});

test('rewriteSourceUrls: 同源源码 URL 被改写为磁盘路径', () => {
  const text = '    at Button (http://localhost:5173/src/components/Button.tsx:42:7)';
  const out = rewriteSourceUrls(text, CTX);
  assert.ok(out.includes(disk('src', 'components', 'Button.tsx') + ':42:7'), 'out=' + out);
  assert.ok(!out.includes('localhost:5173'), 'out=' + out);
});

test('rewriteSourceUrls: 接口 URL 不被改写（关键反例）', () => {
  const text = 'fetch http://localhost:5173/api/cart 失败';
  assert.equal(rewriteSourceUrls(text, CTX), text);
});

test('rewriteSourceUrls: 跨源 URL 不被改写（关键反例）', () => {
  const text = 'at https://cdn.example.com/src/vendor.tsx:1:1';
  assert.equal(rewriteSourceUrls(text, CTX), text);
});

test('rewriteSourceUrls: 未配置 devUrl 时完全不动', () => {
  const text = 'at http://localhost:5173/src/App.tsx:1:1';
  assert.equal(rewriteSourceUrls(text, { projectRoot: ROOT }), text);
});

test('rewriteSourceUrls: 非源码扩展名（.css 之外）不被误改', () => {
  const text = 'GET http://localhost:5173/logo.png 200';
  assert.equal(rewriteSourceUrls(text, CTX), text);
});

test('normalizeElementSource: 转换 file 并保留其余字段与 originalFile', () => {
  const src = {
    framework: 'react',
    file: 'http://localhost:5173/src/components/Button.tsx',
    line: 42,
    column: 7,
    component: 'Button',
  };
  const out = normalizeElementSource(src, CTX);
  assert.equal(out.file, disk('src', 'components', 'Button.tsx'));
  assert.equal(out.originalFile, 'http://localhost:5173/src/components/Button.tsx');
  assert.equal(out.line, 42);
  assert.equal(out.column, 7);
  assert.equal(out.framework, 'react');
  assert.equal(out.component, 'Button');
  // 不得修改入参
  assert.equal(src.file, 'http://localhost:5173/src/components/Button.tsx');
});

test('normalizeElementSource: 无 projectRoot 时原样返回副本', () => {
  const out = normalizeElementSource({ file: 'http://localhost:5173/src/App.tsx', line: 1 }, {});
  assert.equal(out.file, 'http://localhost:5173/src/App.tsx');
  assert.equal(out.originalFile, undefined);
});

test('normalizeElementSource: 已是磁盘绝对路径时不改动', () => {
  const win = 'D:\\proj\\src\\a.tsx';
  const out = normalizeElementSource({ file: win, line: 3 }, CTX);
  assert.equal(out.file, win);
  assert.equal(out.originalFile, undefined);
});

test('normalizeElementSource: 非法入参返回 null', () => {
  assert.equal(normalizeElementSource(null, CTX), null);
  assert.equal(normalizeElementSource({}, CTX), null);
  assert.equal(normalizeElementSource({ file: '' }, CTX), null);
  assert.equal(normalizeElementSource('text', CTX), null);
});

test('normalizeElementSource: 只看 file 字段，不依赖任何展示文案', () => {
  // 这是替代「解析元素源码位置：文案」的关键性质：扩展改措辞不会影响归一化。
  const out = normalizeElementSource({ file: 'http://localhost:5173/src/A.tsx', note: '元素源码位置：随便怎么写' }, CTX);
  assert.equal(out.file, disk('src', 'A.tsx'));
});

test('normalizePickedElement: 归一化 picked 与 list，并保留 originalFile', () => {
  const input = {
    found: true,
    picked: { selector: '#a', source: { framework: 'react', file: 'http://localhost:5173/src/A.tsx', line: 3 } },
    list: [{ selector: '#b', source: { framework: 'vue', file: 'http://localhost:5173/src/B.vue' } }],
  };
  const out = normalizePickedElement(input, CTX);
  assert.equal(out.picked.source.file, disk('src', 'A.tsx'));
  assert.equal(out.picked.source.originalFile, 'http://localhost:5173/src/A.tsx');
  assert.equal(out.picked.source.line, 3, '其他字段应保留');
  assert.equal(out.list[0].source.file, disk('src', 'B.vue'));
  // 原始输入不被修改
  assert.equal(input.picked.source.file, 'http://localhost:5173/src/A.tsx');
});

test('normalizePickedElement: 无 projectRoot 或字段缺失时安全返回', () => {
  const input = { found: true, picked: { selector: '#a', source: { file: 'http://x/A.tsx' } } };
  assert.deepEqual(normalizePickedElement(input, {}), input);
  assert.deepEqual(normalizePickedElement(null, CTX), null);
  assert.deepEqual(normalizePickedElement({ found: false }, CTX), { found: false });
});

test('normalizationHint: 缺字段时给出可操作提示，齐全时为空', () => {
  assert.equal(normalizationHint(CTX), '');
  assert.ok(normalizationHint({}).includes('projectRoot'));
  assert.ok(normalizationHint({}).includes('devUrl'));
  const onlyRoot = normalizationHint({ projectRoot: ROOT });
  assert.ok(onlyRoot.includes('devUrl') && !onlyRoot.includes('projectRoot /'), 'onlyRoot=' + onlyRoot);
});
