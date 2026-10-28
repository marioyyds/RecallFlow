// 截图跨会话同步：会话正文只带元数据，图片本体按 id 共享落盘。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  saveScreenshot,
  loadScreenshot,
  removeSessionScreenshots,
  SHOT_KEY,
  SHOT_INDEX_KEY,
  shotStorageKey,
  MAX_SHOTS_PER_SESSION,
  MAX_SHOT_STORE_CHARS,
} from '../lib/shared/screenshot-store.ts';
import { applyRunEvent, createRunState, runStateToAssistantMessage } from '../lib/application/agent/run-hub.ts';

function mkStorage(initial = {}) {
  const data = Object.assign({}, initial);
  const removed = [];
  return {
    data,
    removed,
    async get(keys) {
      if (keys == null) return Object.assign({}, data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = data[key];
      }
      return out;
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        removed.push(key);
        delete data[key];
      }
    },
  };
}

function mkChrome(storage) {
  return { storage: { local: storage } };
}

test('截图按 id 共享落盘：另一个标签页/历史会话能读回同一张图', async () => {
  const storage = mkStorage();
  const chrome = mkChrome(storage);
  const shot = {
    id: 'shot-1',
    dataUrl: 'data:image/png;base64,AAA',
    label: '首屏',
    width: 800,
    height: 600,
    bytes: 3,
  };

  assert.equal(await saveScreenshot(chrome, shot, 'S-1'), true);
  assert.equal(storage.data[shotStorageKey('shot-1')].sessionId, 'S-1');
  assert.equal(storage.data[SHOT_KEY].length, 1, '旧归档也要继续维护');

  // 模拟另一个标签页：只拿 storage，不共享内存缓存。
  const got = await loadScreenshot(mkChrome(storage), 'shot-1');
  assert.equal(got.dataUrl, shot.dataUrl);
  assert.equal(got.label, '首屏');
});

test('旧版只写在 SHOT_KEY 里的截图仍可回退读取', async () => {
  const storage = mkStorage({
    [SHOT_KEY]: [{ id: 'legacy-1', dataUrl: 'data:image/jpeg;base64,OLD' }],
  });
  const got = await loadScreenshot(mkChrome(storage), 'legacy-1');
  assert.equal(got.dataUrl, 'data:image/jpeg;base64,OLD');
});

test('单会话超过上限时只淘汰最旧的截图，不删除会话正文', async () => {
  const storage = mkStorage();
  const chrome = mkChrome(storage);
  for (let i = 0; i < MAX_SHOTS_PER_SESSION + 2; i++) {
    await saveScreenshot(
      chrome,
      {
        id: 'shot-' + i,
        dataUrl: 'data:image/png;base64,' + i,
        createdAt: 1000 + i,
      },
      'S-1'
    );
  }

  assert.equal(storage.data[shotStorageKey('shot-0')], undefined);
  assert.equal(storage.data[shotStorageKey('shot-1')], undefined);
  assert.ok(storage.data[shotStorageKey('shot-' + (MAX_SHOTS_PER_SESSION + 1))]);
  assert.equal(Object.keys(storage.data[SHOT_INDEX_KEY]).length, MAX_SHOTS_PER_SESSION);
  assert.ok(storage.removed.includes(shotStorageKey('shot-0')), '淘汰时必须删掉图片本体');
});

test('删除会话时只清理该会话的截图', async () => {
  const storage = mkStorage();
  const chrome = mkChrome(storage);
  await saveScreenshot(chrome, { id: 'a', dataUrl: 'data:image/png;base64,A' }, 'S-1');
  await saveScreenshot(chrome, { id: 'b', dataUrl: 'data:image/png;base64,B' }, 'S-2');

  assert.equal(await removeSessionScreenshots(chrome, 'S-1'), true);
  assert.equal(await loadScreenshot(chrome, 'a'), null);
  assert.ok(await loadScreenshot(chrome, 'b'));
});

test('截图过大时明确不落盘（面板本轮仍可显示）', async () => {
  const storage = mkStorage();
  const chrome = mkChrome(storage);
  const tooLarge = 'x'.repeat(MAX_SHOT_STORE_CHARS + 1);
  assert.equal(await saveScreenshot(chrome, { id: 'huge', dataUrl: tooLarge }, 'S-1'), false);
  assert.equal(Object.keys(storage.data).length, 0);
});

test('跟随标签页收到的是截图步骤，不是一条「已生成截图」通知', () => {
  const state = createRunState({ runId: 'run-1', sessionId: 'S-1', ownerTabId: 1, instruction: '截图' });
  applyRunEvent(state, {
    type: 'screenshot',
    id: 'shot-1',
    label: '首屏',
    width: 800,
    height: 600,
    bytes: 1234,
    dataUrl: 'data:image/png;base64,SHOULD_NOT_BE_BROADCAST',
  });

  const msg = runStateToAssistantMessage(state);
  const part = msg.parts.find((p) => p.type === 'screenshot');
  assert.ok(part, '跟随页应得到可渲染的截图步骤');
  assert.equal(part.id, 'shot-1');
  assert.equal(part.label, '首屏');
  assert.equal(part.width, 800);
  assert.equal(part.height, 600);
  assert.ok(!Object.prototype.hasOwnProperty.call(part, 'dataUrl'), '广播里不得带 base64');
  assert.ok(
    !msg.parts.some((p) => p.type === 'notice' && /已生成截图/.test(p.text || '')),
    '不应再退化成只有文字通知'
  );
});
