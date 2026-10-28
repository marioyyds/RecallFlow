import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRunContext } from '../lib/application/agent/run-context.ts';

const settings = { model: 'test', apiKey: 'x' };
const budget = {
  maxOpenedTabs: 8,
  maxTabSwitches: 6,
};

test('新任务读取本次 payload，不继承旧运行的页面和轨迹', () => {
  const ctx = createAgentRunContext({
    book: {},
    settings,
    budget,
    browserMode: true,
    canResume: false,
    tabId: 12,
    payload: {
      sessionId: 's1',
      page: 'new page',
      pageUrl: 'https://new.test',
      pageTitle: 'New',
    },
    persisted: {
      page: 'old page',
      trace: [{ phase: 'old' }],
      plan: [{ text: 'old', status: 'done' }],
    },
  });

  assert.equal(ctx.page, 'new page');
  assert.equal(ctx.pageUrl, 'https://new.test');
  assert.equal(ctx.originalTabId, 12);
  assert.deepEqual(ctx.trace, []);
  assert.deepEqual(ctx.plan, []);
  assert.equal(ctx.browsingMode, 'shared');
});

test('恢复任务沿用落盘的页面、标签页、计划和轨迹，并复制数组', () => {
  const persisted = {
    page: 'saved page',
    pageUrl: 'https://saved.test',
    pageTitle: 'Saved',
    tabId: 5,
    originalTabId: 3,
    openedTabs: [7, 8],
    openedTabCount: 2,
    tabSwitchCount: 1,
    failedUrls: ['https://bad.test'],
    agentWindowId: 44,
    trace: [{ phase: 'start' }],
    plan: [{ text: 'finish', status: 'in_progress' }],
    resultIds: ['r1'],
  };
  const ctx = createAgentRunContext({
    book: {},
    settings,
    budget,
    browserMode: false,
    canResume: true,
    payload: { page: 'ignored' },
    persisted,
  });

  assert.equal(ctx.page, 'saved page');
  assert.equal(ctx.tabId, 5);
  assert.equal(ctx.originalTabId, 3);
  assert.equal(ctx.agentWindowId, 44);
  assert.equal(ctx.browsingMode, 'isolated');
  assert.deepEqual(ctx.openedTabs, [7, 8]);
  assert.deepEqual(ctx.trace, [{ phase: 'start' }]);
  assert.deepEqual(ctx.plan, [{ text: 'finish', status: 'in_progress' }]);
  assert.deepEqual([...ctx.resultIds], ['r1']);

  ctx.openedTabs.push(9);
  ctx.trace.push({ phase: 'new' });
  assert.deepEqual(persisted.openedTabs, [7, 8]);
  assert.deepEqual(persisted.trace, [{ phase: 'start' }]);
});
