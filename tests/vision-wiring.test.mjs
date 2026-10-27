// 视觉接线：截图结果必须**在开关之后**接到 messages（今天仍是零行为变化）。
//
// ## 为什么值得一道门禁
//
// ① 多模态的接线是**唯一**还没做的核心步骤，而它最容易做错的地方有三处：
//   1. 把图片塞进 **tool 消息**（工具消息只能放文本 ✗ —— 会直接被接口拒绝或静默丢掉）；
//   2. 忘了**经过开关** ⇒ 开关关着也把图片送出去（那就变成"没测量就改模型输入"✗，
//      正是第 26 轮踩过的坑：见 docs/regression-red-flag.md）；
//   3. 只在**前端**显示截图、却以为模型也看得到（用户会话里就出现过这种误解 ✗）。
//
// 本门禁用**源码级断言**钉住接线方式（行为已由 tests/vision-messages.test.mjs 覆盖 ✓）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const AGENT = fs.readFileSync('lib/assistant/agent.ts', 'utf8');

test('agent.js 必须导入并调用 visionMessagesFor（接线真的接上了，而不是只写了个模块）', () => {
  assert.match(AGENT, /import \{ visionMessagesFor \} from '\.\/vision\.(?:js|ts)'/, '要导入装配函数');
  assert.match(AGENT, /visionMessagesFor\(\[res\.screenshot\]/, '要在截图结果处调用它');
});

test('图片消息必须是**追加到 messages**（而不是塞进 tool 消息）', () => {
  // 取调用点附近的一小段，断言它 push 的是 vision 消息、且与 tool 消息是**分开的两条**
  const at = AGENT.indexOf('visionMessagesFor([res.screenshot]');
  assert.ok(at > 0, '找不到接线点');
  const near = AGENT.slice(Math.max(0, at - 900), at + 200);
  assert.match(near, /messages\.push\(\{ role: 'tool', tool_call_id: tc\.id, content: res\.result \}\)/, 'tool 消息仍只放文本');
  assert.match(near, /messages\.push\(vm\)/, '视觉消息是另起一条 push');
  assert.ok(!/content:\s*\[\s*\{\s*type: 'image_url'/.test(near), '不许把图片数组塞进 tool 消息 ✗');
});

test('接线必须受开关约束（开关**打开**时才产出；关着时一律空数组）', () => {
  // 装配函数本身在开关关闭时返回 []；这里再确认 agent 侧没有绕过它自己拼图片。
  // ⚠ 第 6 步已把开关打开 ⇒ 现在这段**真的会产出图片消息**；"关着就不产出"由
  //    tests/vision-messages.test.mjs 的 `visionEnabled:false` override 钉住 ✓
  assert.ok(!/image_url/.test(AGENT), 'agent.js 里不该自己拼 image_url（必须走 vision.js）');
  const vision = fs.readFileSync('lib/assistant/vision.ts', 'utf8');
  assert.match(vision, /if \(!enabled\) return \[\];/, 'vision.js 里开关关闭时一律返回空');
});

test('这条门禁本身有牙齿：把图片塞进 tool 消息就该红', () => {
  const guilty = (src) => /messages\.push\(\{\s*role: 'tool',[\s\S]{0,120}image_url/.test(src);
  assert.equal(guilty("messages.push({ role: 'tool', tool_call_id: id, content: [{ type: 'image_url', image_url: {} }] });"), true, '塞进 tool 要被抓');
  assert.equal(guilty(AGENT), false, '当前实现不该被抓');
});
