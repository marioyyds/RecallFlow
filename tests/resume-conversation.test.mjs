import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasInstructionUserTurn,
  latestInstructionUserIndex,
  pruneResumableAssistantTail,
} from '../lib/ui/page/resume-conversation.ts';

test('续跑识别最近匹配的用户轮次，而不是只看最后一条消息', () => {
  const messages = [
    { role: 'user', content: '创建一个test分支' },
    { role: 'assistant', content: '部分输出', interrupted: true },
  ];
  assert.equal(latestInstructionUserIndex(messages, '创建一个test分支'), 0);
  assert.equal(hasInstructionUserTurn(messages, '创建一个test分支'), true);
});

test('恢复快照时移除将被快照替换的 interrupted/live assistant 尾部', () => {
  const messages = [
    { role: 'user', content: '任务' },
    { role: 'assistant', content: '中断', interrupted: true },
    { role: 'assistant', content: '实时', live: true },
  ];
  const result = pruneResumableAssistantTail(messages, '任务');
  assert.equal(result.alreadyHasUser, true);
  assert.equal(result.changed, true);
  assert.deepEqual(result.messages, [{ role: 'user', content: '任务' }]);
});

test('正式 assistant 消息不被恢复清理误删', () => {
  const messages = [
    { role: 'user', content: '任务' },
    { role: 'assistant', content: '正式答复' },
  ];
  const result = pruneResumableAssistantTail(messages, '任务');
  assert.equal(result.changed, false);
  assert.equal(result.messages.length, 2);
});
