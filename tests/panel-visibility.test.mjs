import test from 'node:test';
import assert from 'node:assert/strict';

import { createPanelVisibilityController } from '../lib/application/panel/visibility.ts';

function fixture({ mounted = false, responses = [] } = {}) {
  let controller = null;
  let isMounted = mounted;
  let opened = 0;
  let closed = 0;
  const sent = [];
  const queue = responses.slice();

  controller = createPanelVisibilityController({
    async send(type, payload) {
      sent.push({ type, payload });
      return queue.length ? queue.shift() : null;
    },
    isMounted: () => isMounted,
    async open() {
      opened += 1;
      isMounted = true;
      await controller.publish(true, 'global');
    },
    async close() {
      closed += 1;
      isMounted = false;
      await controller.publish(false, 'global');
    },
  });

  return {
    controller,
    sent,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
    setMounted(value) {
      isMounted = value;
    },
  };
}

test('远端状态只接受不比当前序号更旧的版本', async () => {
  const app = fixture({
    responses: [{ ok: true, ui: { seq: 5, open: false } }],
  });
  const { controller } = app;
  await controller.syncOnInit();

  assert.equal(await controller.apply({ seq: 4, open: true }), false);
  assert.equal(controller.isOpen, false);
  assert.equal(app.opened, 0);

  assert.equal(await controller.apply({ seq: 6, open: true }), true);
  assert.deepEqual(controller.snapshot(), { seq: 6, open: true });
  assert.equal(app.opened, 1);
});

test('应用远端打开状态时抑制 openPanel 内部广播，只发 membership 回执', async () => {
  const app = fixture();
  await app.controller.apply({ seq: 3, open: true });

  assert.equal(app.opened, 1);
  assert.deepEqual(app.sent, [
    {
      type: 'panel:ui:set',
      payload: { open: true, scope: 'membership' },
    },
  ]);
});

test('应用远端关闭状态时只销毁已挂载面板并发 membership 回执', async () => {
  const app = fixture({ mounted: true });
  await app.controller.apply({ seq: 2, open: false });

  assert.equal(app.closed, 1);
  assert.equal(app.controller.isOpen, false);
  assert.deepEqual(app.sent.at(-1), {
    type: 'panel:ui:set',
    payload: { open: false, scope: 'membership' },
  });
});

test('syncOnInit 缓存同一个 ready Promise，并恢复服务端打开状态', async () => {
  const app = fixture({
    responses: [{ ok: true, ui: { seq: 7, open: true } }],
  });
  const { controller, sent } = app;

  const first = controller.syncOnInit();
  const second = controller.syncOnInit();
  assert.equal(first, second);
  await first;

  assert.equal(controller.isOpen, true);
  assert.equal(controller.snapshot().seq, 7);
  assert.equal(app.opened, 1);
  assert.equal(sent[0].type, 'panel:ui:get');
});

test('较旧的广播响应不能回退本地刚设置的开合意图', async () => {
  const { controller, sent } = fixture({
    responses: [
      { ok: true, ui: { seq: 8, open: true } },
      { ok: true, ui: { seq: 6, open: true } },
    ],
  });

  await controller.publish(false, 'global');
  assert.equal(controller.snapshot().seq, 8);
  assert.equal(controller.isOpen, true);
  await controller.publish(false, 'global');
  assert.equal(controller.snapshot().seq, 8);
  assert.equal(controller.isOpen, false);
  assert.equal(sent.length, 2);
});
