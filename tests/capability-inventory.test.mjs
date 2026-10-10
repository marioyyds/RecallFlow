// 三层形状的**完整性门禁** + 能力清单的**新鲜度门禁**。
//
// ## 为什么最后要有这一条
//
// 二十轮下来，剧本库是靠"每加一类就补齐五件套"长起来的：
// 夹具页 / 剧本（tools 作契约锚点）/ 真浏览器 E2E / 内置技能 / 契约门禁。
// 但这些零件分散在五个文件里，**没有任何一处能一眼看出"某个剧本少了一件"** ——
// 而已有的门禁各自只盯一件（技能覆盖 tools、E2E 指令逐字一致、夹具路由已接线…），
// 谁也管不着"这个剧本的页面判据是不是**空的**"。
//
// 本文件补的正是这一条，并顺带把清单**推导出来**（`docs/capability-inventory.md`），
// 让"能力库现在长什么样"成为一个**可复核、且不会腐烂**的事实 ——
// 产物变了而清单没跟上，`npm test` 就会红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PLAYBOOKS } from './e2e/fixtures/playbooks.mjs';
import { buildInventory, renderInventory } from '../scripts/gen-capability-inventory.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const rows = buildInventory();

test('能力清单必须与产物一致（改了剧本/技能/夹具/规范就重跑生成脚本）', () => {
  const expected = renderInventory(rows);
  const actual = read('docs/capability-inventory.md');
  assert.equal(
    actual,
    expected,
    'docs/capability-inventory.md 与产物不一致 —— 请运行：node scripts/gen-capability-inventory.mjs'
  );
});

test('每个剧本都要有五件套：夹具页 / 工具锚点 / E2E / 技能 / 判据', () => {
  const problems = [];
  for (const r of rows) {
    if (!r.url) problems.push(r.id + '：没有声明夹具页 url');
    else if (!r.routeWired) problems.push(r.id + '：夹具路由没接线（server.mjs 里没有 startsWith(' + r.url + ')）');
    if (!r.tools) problems.push(r.id + '：tools 为空（它就是技能契约的锚点）');
    if (!r.inSpec) problems.push(r.id + '：golden.spec.mjs 里没有引用它的指令');
    if (!r.skill) problems.push(r.id + '：没有技能声明 playbook: \'' + r.id + '\'');
    if (!r.pageChecks && !r.outcome) {
      problems.push(
        r.id + '：既没有页面判据、也没有声明结果在哪（outcome）—— ' +
          '这正是本门禁要拦的"悄悄少了一层"'
      );
    }
  }
  assert.deepEqual(problems, [], '三层形状不完整：\n  ' + problems.join('\n  '));
});

test('页面判据为空时必须显式声明结果所在，且取值受控', () => {
  const allowed = new Set(['page', 'storage', 'payload']);
  for (const r of rows) {
    if (!r.outcome) continue;
    assert.ok(allowed.has(r.outcome), r.id + ' 的 outcome 取值非法：' + r.outcome);
    // 反过来：有页面判据的就不该再声明 storage/payload —— 那是"没判据"时的出口
    if (r.pageChecks > 0) {
      assert.equal(r.outcome, 'page', r.id + ' 有页面判据却又声明 outcome=' + r.outcome);
    }
  }
  // 至少要有剧本用过这个出口，否则这条约束是空转的（当前是知识库那两个）
  assert.ok(rows.some((r) => r.outcome === 'storage'), '应当有剧本声明结果在存储里（知识库类）');
});

test('这条门禁本身有牙齿：少任何一件都必须被认出来', () => {
  const check = (r) => {
    const out = [];
    if (!r.url) out.push('no-url');
    else if (!r.routeWired) out.push('not-wired');
    if (!r.tools) out.push('no-tools');
    if (!r.inSpec) out.push('not-in-spec');
    if (!r.skill) out.push('no-skill');
    if (!r.pageChecks && !r.outcome) out.push('no-criteria');
    return out;
  };
  const ok = { id: 'x', url: '/x', routeWired: true, tools: 2, inSpec: true, skill: 'x', pageChecks: 1, outcome: 'page' };
  assert.deepEqual(check(ok), [], '完整的一条应通过');
  assert.deepEqual(check(Object.assign({}, ok, { routeWired: false })), ['not-wired']);
  assert.deepEqual(check(Object.assign({}, ok, { tools: 0 })), ['no-tools']);
  assert.deepEqual(check(Object.assign({}, ok, { pageChecks: 0, outcome: '' })), ['no-criteria']);
  // 少件也不该被"有 outcome"掩盖
  assert.deepEqual(check(Object.assign({}, ok, { skill: '', pageChecks: 0, outcome: '' })), ['no-skill', 'no-criteria']);
});

test('清单本身是"可复核的证据"，不是散文：数字要能对上产物', () => {
  // 每个剧本都必须在清单里出现，且清单行数与剧本数一致
  const md = read('docs/capability-inventory.md');
  for (const pb of Object.values(PLAYBOOKS)) {
    assert.ok(md.includes('`' + pb.id + '`'), '清单里缺少剧本：' + pb.id);
  }
  const rowCount = md.split('\n').filter((l) => /^\| `/.test(l)).length;
  assert.equal(rowCount, Object.keys(PLAYBOOKS).length, '清单行数应等于剧本数');
  // 合计行里的关键数字要与实测一致（防止"清单看着全，其实少统计了"）
  assert.match(md, new RegExp('夹具路由已接线 ' + rows.length + '/' + rows.length));
  assert.match(md, new RegExp('E2E 已引用 ' + rows.length + '/' + rows.length));
});
