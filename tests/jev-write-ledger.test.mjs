import test from 'node:test';
import assert from 'node:assert/strict';

import { recordCompletedTypeTarget } from '../lib/application/agent/jev-write-ledger.ts';

test('JEV 写入账本只记录成功字段目标，不保存正文', () => {
  const ctx = {};
  recordCompletedTypeTarget(
    ctx,
    'type_text',
    { ref: 'rf-37', selector: 'input.article-bar__title', value: '完整标题内容' },
    {
      ok: true,
      matchesIntent: true,
      selector: 'input.article-bar__title:nth-of-type(1)',
    },
    'https://editor.csdn.net/md/',
    123
  );
  assert.deepEqual(ctx.completedTypeTargets, [
    {
      url: 'https://editor.csdn.net/md/',
      ref: 'rf-37',
      selector: 'input.article-bar__title:nth-of-type(1)',
      valueLength: 6,
      at: 123,
    },
  ]);
  assert.equal('value' in ctx.completedTypeTargets[0], false);
});

test('同 URL 上再次写入同一 ref 或 selector 会更新而不重复累计', () => {
  const ctx = {};
  const url = 'https://editor.csdn.net/md/';
  recordCompletedTypeTarget(
    ctx,
    'type_text',
    { ref: 'rf-37', value: '旧标题' },
    { ok: true, selector: 'input.article-bar__title' },
    url,
    1
  );
  recordCompletedTypeTarget(
    ctx,
    'type_text',
    { ref: 'rf-37', value: '修正后的标题' },
    { ok: true, selector: 'input.article-bar__title' },
    url,
    2
  );
  assert.equal(ctx.completedTypeTargets.length, 1);
  assert.equal(ctx.completedTypeTargets[0].valueLength, 6);
  assert.equal(ctx.completedTypeTargets[0].at, 2);
});

test('失败或回读不一致的 type_text 不进入完成账本', () => {
  const ctx = {};
  recordCompletedTypeTarget(
    ctx,
    'type_text',
    { ref: 'rf-37', value: 'x' },
    { ok: false, selector: 'input.article-bar__title' },
    'https://editor.csdn.net/md/'
  );
  recordCompletedTypeTarget(
    ctx,
    'type_text',
    { ref: 'rf-37', value: 'x' },
    { ok: true, matchesIntent: false, selector: 'input.article-bar__title' },
    'https://editor.csdn.net/md/'
  );
  assert.equal(ctx.completedTypeTargets, undefined);
});
