// eval 基线对比脚本的测试。
//
// 为什么要测一个脚本：它的判定口径**故意很窄**（只有"上轮过、这轮挂"才算回归），
// 窄口径是为了让它真被用起来 —— 但这个口径一旦写错（比如把历史失败也算成回归），
// 它就会每次都红，然后被人删掉。所以口径本身必须有断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { flatten } from '../scripts/eval-compare.mjs';

/** 造一份最小可用的 Playwright json reporter 结构。 */
function report(specs) {
  return {
    suites: [
      {
        title: 'real-model.eval.mjs',
        specs: specs.map((s) => ({
          title: s.title,
          ok: s.ok,
          tests: [{ status: s.ok ? 'expected' : 'unexpected', results: [{ status: s.ok ? 'passed' : 'failed' }] }],
        })),
      },
    ],
  };
}

test('flatten 能抽出用例标题与通过状态（含套件前缀）', () => {
  const got = flatten(report([{ title: 'A', ok: true }, { title: 'B', ok: false }]));
  assert.equal(got.get('real-model.eval.mjs > A'), true);
  assert.equal(got.get('real-model.eval.mjs > B'), false);
});

test('没有任何结果的用例不算通过（否则"跑都没跑"会被记成绿）', () => {
  const got = flatten({
    suites: [
      {
        title: 's',
        specs: [{ title: '空结果', ok: true, tests: [{ status: 'expected', results: [] }] }],
      },
    ],
  });
  assert.equal(got.get('s > 空结果'), false, 'results 为空时必须判为未通过');
});

test('回归口径：只有「上轮过、这轮挂」才算回归', () => {
  // 这段逻辑与脚本里一致，抽出来是为了让口径本身可断言 ——
  // 真模型 eval 有噪声，若把"历史失败"也算回归，这份报告会永远红，然后被删掉。
  const base = new Map([['a', true], ['b', false], ['c', true]]);
  const latest = new Map([['a', false], ['b', false], ['c', true], ['d', true]]);
  const regressions = [...latest].filter(([n, ok]) => base.get(n) === true && ok === false).map(([n]) => n);
  const recoveries = [...latest].filter(([n, ok]) => base.get(n) === false && ok === true).map(([n]) => n);
  assert.deepEqual(regressions, ['a'], '只有 a 是真回归');
  assert.deepEqual(recoveries, [], 'b 上轮就挂，这轮仍挂 —— 不算回归也不算恢复');
  assert.deepEqual([...latest.keys()].filter((n) => !base.has(n)), ['d'], '新增用例不计入回归');
});

test('import 脚本本身不得触发 CLI 行为（否则测试进程会被 process.exit 干掉）', async () => {
  // 反证：这条文件能跑完，就说明 flatten 的导出没有连带执行 CLI 分支。
  // 若将来有人把顶层 I/O 放回去，本条会以"测试进程退出"的形式失败 —— 那正是想抓的。
  const mod = await import('../scripts/eval-compare.mjs?nocli=1');
  assert.equal(typeof mod.flatten, 'function');
  assert.equal(typeof process.exit, 'function');
});

test('eval 配置必须带 json reporter（结果不落盘就没法做基线对比）', () => {
  // 起因：eval 的唯一长期价值是趋势，而趋势的前提是**每轮结果都留得下来**。
  // 此前唯一记录是人工维护的 markdown，改坏了技能文案只能靠人翻表发现。
  // 这个 reporter 一旦被人顺手删掉，scripts/eval-compare.mjs 就会变成永久报"找不到结果"，
  // 于是它会被当成坏脚本删掉 —— 连锁反应必须从源头钉住。
  const cfg = readFileSync('tests/e2e-eval/playwright.config.mjs', 'utf8');
  assert.match(cfg, /'json'/, 'eval 配置缺少 json reporter');
  assert.match(cfg, /EVAL_RESULT_JSON/, '输出路径应可由环境变量覆盖（便于并行跑不同模型）');
});

test('eval 不得重试：重试会让分数变成挑过的好样本', () => {
  const cfg = readFileSync('tests/e2e-eval/playwright.config.mjs', 'utf8');
  assert.match(cfg, /retries:\s*0/, 'eval 的 retries 必须是 0');
});
