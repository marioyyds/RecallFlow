// page-action-verify.js：动作是否生效的判定（纯函数）。
//
// 为什么值得单独测：`verifyPageAction` 产出的 `changed / verified` 会喂给
// agent 的卡死检测与完成校验 —— 它谎报"已生效"会让卡死检测永远认为在推进
//（这正是它此前在 7 处 CDP 路径上被硬编码成 true 的后果）。
// 抽成纯模块的目的就是让这些边界能被直接钉住，而不是只能靠真实页面碰运气。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyPageAction,
  snapshotChanged,
  observedChange,
  buildActionVerification,
} from '../lib/assistant/page-action-verify.js';

const snap = (over = {}) => Object.assign({ version: 2, url: 'https://a.test/', fingerprint: 'fp-1' }, over);

test('snapshotChanged：URL / 指纹 / 滚动位置三类变化都能识别', () => {
  assert.equal(snapshotChanged(snap(), snap(), 'click'), false, '完全相同的快照不算变化');
  assert.equal(snapshotChanged(snap(), snap({ url: 'https://a.test/next' }), 'click'), true, 'URL 变化');
  assert.equal(snapshotChanged(snap(), snap({ fingerprint: 'fp-2' }), 'click'), true, '内容指纹变化');
  // 滚动**只在滚动类命令上**参与判定：其它命令的 scroll 差异不该被当成"动作生效"
  assert.equal(snapshotChanged(snap({ scroll: { x: 0, y: 0 } }), snap({ scroll: { x: 0, y: 500 } }), 'click'), false);
  assert.equal(snapshotChanged(snap({ scroll: { x: 0, y: 0 } }), snap({ scroll: { x: 0, y: 500 } }), 'scroll_by'), true);
  assert.equal(snapshotChanged(null, snap(), 'click'), false, '缺快照时不得声称有变化');
  assert.equal(snapshotChanged(snap(), null, 'click'), false);
});

test('verifyPageAction：点击派发但页面没变时必须如实说「未观察到变化」', () => {
  const v = verifyPageAction('click', snap(), snap(), { ok: true });
  assert.equal(v.executed, true);
  assert.equal(v.changed, false, '没有观察到变化就不能说 changed');
  assert.equal(v.verified, false, '也不能说 verified —— 这正是曾经被硬编码成 true 的字段');
  assert.match(v.reason, /暂未观察到变化/);
});

test('verifyPageAction：视觉标注无法用内容指纹验证，因此 verified 来自「已派发」而非「观测到变化」', () => {
  // 标注层在独立浮层宿主里，页面指纹刻意排除它 —— 这是有意的设计取舍。
  const v = verifyPageAction('highlight', snap(), snap(), { ok: true });
  assert.equal(v.executed, true);
  assert.equal(v.changed, false, '不得因为"已派发"就说页面内容变了');
  assert.equal(v.verified, true, '但"动作已派发"本身是可确认的事实');
  assert.match(v.reason, /不计入内容指纹/);
});

test('verifyPageAction：滚动派发但位置未变 → 明确说明未变化', () => {
  const v = verifyPageAction('scroll_by', snap({ scroll: { x: 0, y: 0 } }), snap({ scroll: { x: 0, y: 0 } }), { ok: true });
  assert.equal(v.scrollChanged, false);
  assert.match(v.reason, /滚动位置未变化/);
});

test('verifyPageAction：type_text 已处于目标状态时理由要说清（而不是含糊的"已执行"）', () => {
  const v = verifyPageAction('type_text', snap(), snap(), { ok: true, alreadySatisfied: true });
  assert.equal(v.verified, true, '目标状态已满足 → 可判通过');
  assert.match(v.reason, /已处于要求状态/);
});

test('verifyPageAction：内容脚本回执失败时 executed/verified 都为 false', () => {
  const v = verifyPageAction('click', snap(), snap(), { ok: false, error: '未找到目标元素' });
  assert.equal(v.executed, false);
  assert.equal(v.verified, false);
  assert.match(v.reason, /失败/);
});

test('verifyPageAction：内容脚本自报 changed/hadEffect 时也算生效（CDP 路径会这样回执）', () => {
  const v = verifyPageAction('click', snap(), snap(), { ok: true, hadEffect: true });
  assert.equal(v.changed, true, '回执说有效果 → 采信，因为它是执行方的一手信息');
  assert.equal(v.verified, true);
});

test('observedChange / buildActionVerification：无法观测时不得声称已验证', () => {
  assert.equal(observedChange({ fingerprint: 'a' }, { fingerprint: 'b' }), 'changed');
  assert.equal(observedChange({ fingerprint: 'a' }, { fingerprint: 'a' }), 'unchanged');
  assert.equal(observedChange(null, { fingerprint: 'a' }), 'unobservable');
  const unknown = buildActionVerification('unobservable', '没有快照可比');
  assert.equal(unknown.verified, false);
  assert.equal(unknown.executed, true);
});
