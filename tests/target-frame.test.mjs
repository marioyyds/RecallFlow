// target-frame.js：跨域框架的 ref 解析与目标参数改写（纯函数）。
//
// 为什么值得单独测：这组函数决定"一个动作投递到哪个框架、投递时参数改成什么"，
// 是跨域 iframe 操作能否成立的核心。写错的表现是**动作静默落到错误的框架**
//（或对同一元素执行两次），而不是报错 —— 因此必须把优先级与改写规则直接钉住。
// 此前它们混在 tools.js 的 chrome.* 之间，只能靠真实浏览器碰运气；
// tests/frame-routing.test.mjs 覆盖的是 planFrameBatches，这几个辅助函数没有独立覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseRef, frameIdFromArgs, localTargetArgs, planFrameBatches } from '../lib/assistant/target-frame.js';

test('parseRef：带 f<frameId>: 前缀时拆出框架，无前缀时 frameId 为 null', () => {
  assert.deepEqual(parseRef('f12:rf-3'), { frameId: 12, ref: 'rf-3' });
  assert.deepEqual(parseRef('f0:abc'), { frameId: 0, ref: 'abc' }, 'frameId=0 是合法值，不能被当成"没有前缀"');
  assert.deepEqual(parseRef('rf-3'), { frameId: null, ref: 'rf-3' });
  assert.deepEqual(parseRef(''), { frameId: null, ref: '' });
  // 前缀里必须是纯数字：`f1a:x` 不是框架前缀，应按普通 ref 处理
  assert.deepEqual(parseRef('f1a:x'), { frameId: null, ref: 'f1a:x' });
});

test('frameIdFromArgs：显式 frameId 参数优先于 ref 前缀', () => {
  // 这条优先级是有意的：模型可能从帧列表拿到 frameId 直接传参，
  // 而 ref 仍是顶层形态；若让 ref 前缀覆盖显式参数，动作会落到错误的框架。
  assert.equal(frameIdFromArgs({ frameId: 7, ref: 'f2:rf-1' }), 7, '显式参数必须赢');
  assert.equal(frameIdFromArgs({ ref: 'f2:rf-1' }), 2, '无显式参数时用 ref 前缀');
  assert.equal(frameIdFromArgs({ ref: 'rf-1' }), null, '都没有则 null（交由调用方按顶层处理）');
  assert.equal(frameIdFromArgs({}), null);
  assert.equal(frameIdFromArgs(null), null);
});

test('frameIdFromArgs：frameId 的边界值不被误当成"未提供"', () => {
  assert.equal(frameIdFromArgs({ frameId: 0 }), 0, '0 是合法框架（顶层），不能被当成空值');
  assert.equal(frameIdFromArgs({ frameId: '3' }), 3, '字符串数字应被接受');
  assert.equal(frameIdFromArgs({ frameId: '' }), null, '空串视为未提供');
  assert.equal(frameIdFromArgs({ frameId: -1 }), null, '负数不是合法框架');
  assert.equal(frameIdFromArgs({ frameId: 1.5 }), null, '非整数不是合法框架');
});

test('localTargetArgs：剥掉 ref 前缀，并且**删掉 frameId**', () => {
  // 删 frameId 是必要的：那个字段只对后台有意义。若留着，目标框架的内容脚本
  // 可能据此再转发一次，造成同一动作对同一元素执行两次。
  assert.deepEqual(localTargetArgs({ ref: 'f5:rf-9', frameId: 5, text: 'a' }), { ref: 'rf-9', text: 'a' });
  assert.deepEqual(localTargetArgs({ ref: 'rf-9', frameId: 2 }), { ref: 'rf-9' });
  assert.deepEqual(localTargetArgs({ ref: 'rf-9' }), { ref: 'rf-9' });
  assert.deepEqual(localTargetArgs({}), {});
  assert.deepEqual(localTargetArgs(null), {});
  // 不得修改入参（调用方常复用同一个 args 对象）
  const input = { ref: 'f5:rf-9', frameId: 5 };
  localTargetArgs(input);
  assert.deepEqual(input, { ref: 'f5:rf-9', frameId: 5 }, '必须返回新对象，不能就地改写');
});

test('planFrameBatches：按框架分组，并保留原始下标（回填结果要靠它）', () => {
  const batches = planFrameBatches([
    { ref: 'rf-a' },
    { ref: 'f2:rf-b' },
    { ref: 'f0:rf-c' },
    { ref: 'f2:rf-d' },
  ]);
  const byFrame = Object.fromEntries(batches.map((b) => [b.frameId, b.items]));
  // 顶层（无前缀）与显式 f0 归为同一批
  assert.deepEqual(byFrame[0].map((x) => x.at), [0, 2]);
  assert.deepEqual(byFrame[2].map((x) => x.at), [1, 3]);
  // 每批的 target 都是"本地参数"（前缀已剥离）
  assert.deepEqual(byFrame[2][0].target, { ref: 'rf-b' });
  assert.deepEqual(byFrame[0][1].target, { ref: 'rf-c' });
});

test('planFrameBatches：非数组输入返回空数组，不抛', () => {
  assert.deepEqual(planFrameBatches(null), []);
  assert.deepEqual(planFrameBatches(undefined), []);
  assert.deepEqual(planFrameBatches([]), []);
});
