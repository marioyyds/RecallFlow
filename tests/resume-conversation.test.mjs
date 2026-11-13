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

test('正文为空、只剩 parts 的半截 assistant 也要清掉（跳转后续跑会重复显示）', () => {
  // 实测：旧文档在跑的过程中落下一份只有 parts、没有 content 的 assistant，
  // 新页面把它当正式消息渲染了一遍，于是正文里同时出现"半截回答"和"正在输出的回答"。
  // 收尾入库的 assistant 一定有 content（哪怕只有错误文案），所以"没有 content"就是半截。
  const messages = [
    { role: 'user', content: '任务' },
    {
      role: 'assistant',
      content: '',
      parts: [
        { type: 'notice', text: '🧭 意图识别：浏览器操作' },
        { type: 'narration', text: '第 1 段流式内容…' },
      ],
    },
  ];
  const result = pruneResumableAssistantTail(messages, '任务');
  assert.equal(result.changed, true);
  assert.deepEqual(result.messages, [{ role: 'user', content: '任务' }]);
});

test('前面几轮的正式回答不受影响 —— 只清当前指令之后的尾部', () => {
  const messages = [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '第一轮答复' },
    { role: 'user', content: '第二轮' },
    { role: 'assistant', content: '', parts: [{ type: 'narration', text: '半截' }] },
  ];
  const result = pruneResumableAssistantTail(messages, '第二轮');
  assert.equal(result.changed, true);
  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[1].content, '第一轮答复');
});
