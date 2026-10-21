// manifest 与"本地页支持"的接线：配置即代码，缺一项就整条链路静默失效。
//
// 为什么要用测试钉住三处 matches：它们分属三个不同的机制，缺任何一个的表现都不一样，
// 而且**都不会报错**：
//   · content_scripts.matches 缺 file:///* → 本地页上不注入，没有悬浮球、没有面板；
//   · host_permissions 缺 file:///* → 即使用户开了「允许访问文件网址」，权限也不成立；
//   · web_accessible_resources.matches 缺 file:///* → 面板与 FAB 的图标在本地页上裂图
//     （面板还在，只是那条 chrome-extension:// 请求被挡了）。
//
// 这里断言的是"三处一致"，不是"某个字符串存在"：以后有人加第四类协议时，
// 三条断言会一起提醒他"别忘了本地页属于哪一档"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

const FILE_MATCH = 'file:///*';

test('content_scripts：每个注入脚本都覆盖本地页', () => {
  assert.ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0);
  for (const entry of manifest.content_scripts) {
    assert.ok(
      entry.matches.includes(FILE_MATCH),
      `content_scripts 的一条缺少 ${FILE_MATCH}：${JSON.stringify(entry.js)}`
    );
    assert.ok(entry.matches.includes('http://*/*') && entry.matches.includes('https://*/*'));
  }
});

test('web_accessible_resources：本地页也能取到面板图标', () => {
  const all = (manifest.web_accessible_resources || []).flatMap((r) => r.matches || []);
  assert.ok(all.includes(FILE_MATCH), 'web_accessible_resources.matches 缺少 ' + FILE_MATCH);
});

test('host_permissions：显式申请 file:///*（<all_urls> 不替用户打开那个开关）', () => {
  assert.ok(manifest.host_permissions.includes(FILE_MATCH));
});

test('本地页会被注入的是**同一份**产物（不允许两套代码）', () => {
  // manifest 里出现两套不同的 js，就意味着本地页跑的是另一条链路 ——
  // 那种"网页上好好的、本地页上行为不同"的分裂无法测试，也不该存在。
  const js = manifest.content_scripts.map((e) => (e.js || []).join(','));
  assert.equal(new Set(js).size, js.length, '同一条注入脚本被重复声明了');
  assert.ok(js.includes('content.js'), '主内容脚本必须仍是打包产物 content.js');
});
