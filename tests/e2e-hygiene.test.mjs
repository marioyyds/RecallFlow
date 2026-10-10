// E2E 目录的**结构门禁**：防止这套沉淀悄悄腐烂。
//
// 起因：E2E 的经验大多以「约定 + 注释」的形式存在，而约定没有任何东西强制 ——
// 新人（或几个月后的自己）很容易：
//   · 又把启动/设置样板复制回 spec（重复一旦回来，helpers 就没人维护了）；
//   · 在 spec 里用 document.querySelector 查面板（穿透不了 shadow DOM，静默失准）；
//   · 加了新 spec 文件但忘了加进 run-e2e.mjs 的阶段表 → **那条测试永远不会跑**；
//   · 在 helpers 里留没人调用的死函数（没被用过的代码等于没验证过的代码）。
//
// 这些都不会报错，只会让"看起来有测试"和"实际有覆盖"越差越远。所以在这里钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const E2E_DIR = 'tests/e2e';
const GUIDE = 'docs/e2e-testing-guide.md';
const README = E2E_DIR + '/README.md';
const RUNNER = 'scripts/run-e2e.mjs';

const read = (p) => fs.readFileSync(p, 'utf8');
const specFiles = fs.readdirSync(E2E_DIR).filter((f) => f.endsWith('.spec.mjs')).sort();

test('E2E 经验文档存在，且两处互相指路', () => {
  assert.ok(fs.existsSync(README), '缺少 ' + README);
  assert.ok(fs.existsSync(GUIDE), '缺少 ' + GUIDE);
  // 互相指路：从任一入口进来的人都能找到另一份（目录速查 vs 完整指南）
  assert.match(read(README), /e2e-testing-guide\.md/, README + ' 应指向完整指南');
  assert.match(read(GUIDE), /tests\/e2e\/README\.md/, GUIDE + ' 应指回目录速查');
});

test('每个 spec 都真的被 run-e2e.mjs 跑（没接线的测试等于不存在）', () => {
  const runner = read(RUNNER);
  const missing = specFiles.filter((f) => !runner.includes("'" + f + "'"));
  assert.deepEqual(
    missing,
    [],
    '这些 spec 没有被 run-e2e.mjs 的阶段表引用，永远不会被执行：\n  ' + missing.join('\n  ')
  );
  // 反向：阶段表里引用的 spec 必须真的存在（防止改名后留下一条空跑的阶段）
  const referenced = [...runner.matchAll(/spec:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 2, '阶段表应至少引用两个 spec（黄金任务 + 断线恢复）');
  for (const r of referenced) {
    assert.ok(fs.existsSync(path.join(E2E_DIR, r)), 'run-e2e.mjs 引用了不存在的 spec：' + r);
  }
});

test('两个 spec 都通过 helpers 启动，且没有把样板复制回来', () => {
  for (const f of specFiles) {
    const src = read(path.join(E2E_DIR, f));
    assert.match(src, /from '\.\/helpers\.mjs'/, f + ' 应从 ./helpers.mjs 引入共用工具');
    // 重复一旦回来，helpers 就会被绕过 → 两处慢慢分叉
    for (const dup of ['function baseSettings', 'async function configure', 'launchPersistentContext']) {
      assert.ok(!src.includes(dup), f + ' 里又出现了样板「' + dup + '」——请用 helpers.mjs，不要复制');
    }
  }
});

test('spec 里不得用 document.querySelector 查面板（穿透不了 shadow DOM）', () => {
  // 面板在 shadow root 里：page.evaluate 里的原生查询拿到 null / 空数组，
  // 症状看起来像"面板里没有这个元素"，实际是查错了树。必须走 helpers。
  const offenders = [];
  for (const f of specFiles) {
    const src = read(path.join(E2E_DIR, f));
    if (/document\.querySelector/.test(src)) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    '这些 spec 直接用了 document.querySelector，应改用 helpers 的 flowOrder / panelText / panelStyle：\n  ' +
      offenders.join('\n  ')
  );
});

test('helpers.mjs 里没有死代码：每个导出都被至少一处引用', () => {
  // 「没被用过的 helper」= 没被验证过的 helper（它可能根本跑不通）。
  const helpersSrc = read(E2E_DIR + '/helpers.mjs');
  const exported = [...helpersSrc.matchAll(/^export (?:async )?function ([A-Za-z0-9_$]+)|^export const ([A-Za-z0-9_$]+)/gm)].map(
    (m) => m[1] || m[2]
  );
  assert.ok(exported.length > 5, '应能解析出 helpers 的导出（为 0 说明解析规则失效，门禁会空转通过）');

  // 收集所有 e2e 文件里对它们的引用（含 helpers 自己内部使用）
  const allSrc = fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => read(path.join(E2E_DIR, f)))
    .join('\n');

  const unused = exported.filter((name) => {
    const uses = allSrc.match(new RegExp('\\b' + name + '\\b', 'g')) || [];
    return uses.length <= 1; // 只有声明那一处
  });
  assert.deepEqual(unused, [], 'helpers.mjs 里这些导出无人使用，请删掉或让某个 spec 真的用它：\n  ' + unused.join('\n  '));
});

test('这条结构门禁本身有牙齿：能识别出"没接线"与"直接查 DOM"', () => {
  // 用内联样例验证判定逻辑，避免门禁永远通过。
  const runnerLike = "const phases = [{ name: 'a', spec: 'golden.spec.mjs' }];";
  assert.ok(!runnerLike.includes("'resume.spec.mjs'"), '未接线判定：不在阶段表里的 spec 应被发现');
  assert.match('await page.evaluate(() => document.querySelector(".x"))', /document\.querySelector/, '直接查 DOM 应被识别');
  assert.ok(!/document\.querySelector/.test('helpers 里已收好'), '走 helpers 的写法不该被误报');
});
