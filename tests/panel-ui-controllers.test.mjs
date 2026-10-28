import test from 'node:test';
import assert from 'node:assert/strict';

import { PanelThemeController } from '../lib/ui/panel/theme-controller.ts';
import { PanelProgressController, stateLabel } from '../lib/ui/panel/progress-controller.ts';
import { PanelSessionState } from '../lib/application/panel/session-state.ts';

function fakeButton() {
  return {
    textContent: '',
    title: '',
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = value;
    },
  };
}

test('PanelThemeController：三态覆盖并同步按钮语义', () => {
  const values = new Map();
  const button = fakeButton();
  const panel = { classList: { dark: false, toggle(name, enabled) { assert.equal(name, 'dark'); this.dark = enabled; } } };
  const controller = new PanelThemeController({
    storage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    prefersDark: () => false,
    watchSystem: () => {},
  });
  controller.panel = panel;
  controller.button = button;
  controller.apply();
  assert.equal(panel.classList.dark, false);
  assert.equal(button.textContent, '🌗');

  controller.cycle();
  assert.equal(controller.savedOverride(), 'dark');
  assert.equal(panel.classList.dark, true);
  assert.match(button.title, /主题：深色/);

  controller.cycle();
  assert.equal(controller.savedOverride(), 'light');
  controller.cycle();
  assert.equal(controller.savedOverride(), '');
  assert.equal(button.textContent, '🌗');
});

test('PanelProgressController：停止后清空事实，resume 复用已有时长', () => {
  const classes = new Set();
  const controller = new PanelProgressController();
  controller.el = { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } };
  controller.messageEl = { textContent: '' };
  controller.timeEl = { textContent: '' };
  controller.update({ state: '执行动作', step: 3, max: 8, startedAt: Date.now() - 2000 });
  assert.match(controller.messageEl.textContent, /第 3 \/ 8 步/);
  assert.match(controller.timeEl.textContent, /已用时/);
  controller.resume();
  controller.stop();
  assert.equal(controller.state, '');
  assert.equal(controller.startedAt, 0);
  assert.equal(controller.timer, null);
  assert.equal(classes.has('on'), false);
});

test('stateLabel：未知状态不回显内部标识', () => {
  assert.equal(stateLabel('executing'), '执行动作');
  assert.equal(stateLabel('unknown-internal-state'), '');
});

test('PanelSessionState：保存队列串行执行，失败不会断链', async () => {
  const state = new PanelSessionState();
  const order = [];
  const first = state.enqueueSave(async () => {
    order.push('first');
    throw new Error('failed');
  });
  const second = state.enqueueSave(async () => {
    order.push('second');
    return 'ok';
  });

  await assert.rejects(first, /failed/);
  assert.equal(await second, 'ok');
  assert.deepEqual(order, ['first', 'second']);
});

test('PanelSessionState：会话身份、正文与锁状态集中重置', () => {
  const state = new PanelSessionState();
  state.adoptIdentity('session-1', 7);
  state.replaceConversation([{ role: 'user', content: 'hi' }]);
  state.panelSessionLockHeld = true;
  state.panelSessionLockRunId = 'run-1';
  assert.equal(state.panelSessionId, 'session-1');
  assert.equal(state.panelSessionSeq, 7);
  assert.equal(state.conversation.length, 1);
  state.resetLock();
  assert.equal(state.panelSessionLockHeld, false);
  assert.equal(state.panelSessionLockRunId, '');
});
