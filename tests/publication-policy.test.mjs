import test from 'node:test';
import assert from 'node:assert/strict';

import {
  captureXhsPublicationEvidence,
  evaluateXhsPublicationGate,
  parseXhsCharacterEvidence,
} from '../lib/application/agent/publication-policy.ts';

const EDITOR_URL = 'https://creator.xiaohongshu.com/new/note';
const HISTORY_URL = 'https://creator.xiaohongshu.com/new/note-manager';

function editorCtx(overrides = {}) {
  return {
    pageUrl: EDITOR_URL,
    lastSnapshot: {
      url: EDITOR_URL,
      text: '标题 正文 0 / 500字 生成图片 发布',
      elements: [
        { ref: 'rf-generate', label: '生成图片', role: 'button' },
        { ref: 'rf-publish', label: '发布', role: 'button' },
      ],
    },
    publicationEvidence: {},
    ...overrides,
  };
}

test('解析小红书 500 字计数与超限提示', () => {
  assert.deepEqual(parseXhsCharacterEvidence('正文 592 / 500字'), {
    current: 592,
    limit: 500,
    overflowWarning: false,
  });
  assert.deepEqual(parseXhsCharacterEvidence('1 / 2 比例\n420 / 500 字'), {
    current: 420,
    limit: 500,
    overflowWarning: false,
  });
  assert.equal(parseXhsCharacterEvidence('最多500字，请删除后重试').overflowWarning, true);
  assert.equal(parseXhsCharacterEvidence('没有字数信息'), null);
});

test('生成图片前必须取得当前 500 字计数且正文不能超限', () => {
  const args = { ref: 'rf-generate' };
  const missing = evaluateXhsPublicationGate('click_element', args, editorCtx());
  assert.equal(missing.kind, 'block');
  assert.match(missing.reason, /get_page_snapshot/);
  assert.match(missing.reason, /未请求审批/);

  const over = editorCtx({
    publicationEvidence: {
      character: { current: 592, limit: 500, overflowWarning: false },
    },
  });
  const overGate = evaluateXhsPublicationGate('click_element', args, over);
  assert.equal(overGate.kind, 'block');
  assert.match(overGate.reason, /当前 592 字/);

  const ok = editorCtx({
    publicationEvidence: {
      character: { current: 420, limit: 500, overflowWarning: false },
    },
  });
  assert.equal(evaluateXhsPublicationGate('click_element', args, ok).kind, 'none');
});

test('历史笔记证据必须来自 /new/note-manager 的有效读取', () => {
  const ctx = editorCtx({
    publicationEvidence: {
      character: { current: 180, limit: 500, overflowWarning: false },
    },
  });
  captureXhsPublicationEvidence(
    ctx,
    'read_current_page',
    HISTORY_URL,
    {
      ok: true,
      result: '笔记管理\n测试笔记标题\n已发布\n审核中\n未通过',
    }
  );
  assert.ok(ctx.publicationEvidence.history);
  const gate = evaluateXhsPublicationGate('click_element', { ref: 'rf-publish' }, ctx);
  assert.equal(gate.kind, 'confirm');
  assert.equal(gate.action, 'publish');

  const noHistory = editorCtx({
    publicationEvidence: {
      character: { current: 180, limit: 500, overflowWarning: false },
    },
  });
  const blocked = evaluateXhsPublicationGate(
    'click_element',
    { ref: 'rf-publish' },
    noHistory
  );
  assert.equal(blocked.kind, 'block');
  assert.match(blocked.reason, /note-manager/);
  assert.match(blocked.reason, /本次未执行/);
});

test('侧栏“发布笔记”和普通页面点击不会误触发布门禁', () => {
  const ctx = editorCtx();
  assert.equal(
    evaluateXhsPublicationGate('click_element', { text: '发布笔记' }, ctx).kind,
    'none'
  );
  assert.equal(
    evaluateXhsPublicationGate(
      'click_element',
      { text: '发布' },
      { ...ctx, pageUrl: HISTORY_URL }
    ).kind,
    'none'
  );
});

test('页面状态变化后旧字数证据失效并重新要求观察', () => {
  const ctx = editorCtx({
    publicationEvidence: {
      character: { current: 100, limit: 500, overflowWarning: false },
    },
  });
  captureXhsPublicationEvidence(ctx, 'type_text', EDITOR_URL, {
    ok: true,
    pageSnapshot: { url: EDITOR_URL, text: '标题 正文' },
    result: '已输入',
  });
  assert.equal(ctx.publicationEvidence.character, undefined);
  const gate = evaluateXhsPublicationGate(
    'click_element',
    { ref: 'rf-generate' },
    ctx
  );
  assert.equal(gate.kind, 'block');
});
