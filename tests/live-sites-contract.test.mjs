// 真实站点清单（tests/e2e-live/sites.mjs）的**静态契约**门禁。
//
// 为什么需要：脚本化分派是 `userText.includes(trigger)` 的顺序匹配，真实站点的分派块排在
// 夹具剧本之后 —— 于是"指令漏写了自己的触发词"或"指令里混进夹具剧本触发词"都会**静默跑错**。
// 这两类错误在 P1.5 里各踩过一次（arxiv 指令没含「读论文」、维基百科指令含「知识库」），
// 都是 E2E 里"页面对、知识库没写"这种看起来毫不相干的症状。所以在这里钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { LIVE_SITES } from './e2e-live/sites.mjs';
import { PLAYBOOKS } from './e2e/fixtures/playbooks.mjs';

test('真实站点：指令必须含自己的触发词（否则分派永远选不中它）', () => {
  const bad = LIVE_SITES.filter((s) => !String(s.instruction || '').includes(s.trigger));
  assert.deepEqual(
    bad.map((s) => s.id + '（触发词「' + s.trigger + '」不在指令里）'),
    []
  );
});

test('真实站点：触发词互不包含', () => {
  const problems = [];
  for (let i = 0; i < LIVE_SITES.length; i++) {
    for (let j = 0; j < LIVE_SITES.length; j++) {
      if (i !== j && LIVE_SITES[i].trigger.includes(LIVE_SITES[j].trigger)) {
        problems.push('「' + LIVE_SITES[i].trigger + '」包含「' + LIVE_SITES[j].trigger + '」');
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('真实站点：指令不得混入夹具剧本触发词（夹具分派块排在 live 之前，会静默跑错）', () => {
  const playbookTriggers = Object.values(PLAYBOOKS).map((p) => p.trigger);
  const problems = [];
  for (const s of LIVE_SITES) {
    for (const t of playbookTriggers) {
      if (String(s.instruction || '').includes(t)) {
        problems.push('「' + s.id + '」的指令含夹具触发词「' + t + '」');
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('真实站点：server.mjs 必须有对应的分派块（漏接线 = 静默跑成兜底剧本）', () => {
  const src = fs.readFileSync('tests/e2e/fixtures/server.mjs', 'utf8');
  const unwired = LIVE_SITES.filter((s) => !src.includes("s.id === '" + s.id + "'"));
  assert.deepEqual(
    unwired.map((s) => s.id),
    []
  );
});
