// 工作树行尾守卫（scripts/check-worktree-eol.mjs）的自检。
//
// 这条门禁解决的是**误归因**：CRLF 检出上的整文件行尾差异会被算成「门禁把源码改成了 CRLF」。
// 所以它必须做到两件事，缺一条就没意义：
//   ① 能认出「索引与工作树行尾不一致」这种真实脏状态（不是只看 git status 的条数）；
//   ② 只报**跑前没有、跑后新增**的项 —— 否则开发者带着未提交改动跑门禁就会永远红。
//
// 按 L-25：这些用例本身就是检测器的"合成坏样本"，坏样本必须红、好样本必须绿。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEolListing,
  findEolMismatches,
  findEolOnlyDiffs,
  collectState,
  compareStates,
} from '../scripts/check-worktree-eol.mjs';

const row = (path, indexEol, worktreeEol, attr = '') => ({ path, indexEol, worktreeEol, attr });

test('解析 git ls-files --eol：容忍补齐空格，按 -z 记录切分', () => {
  const out = 'i/lf    w/lf    attr/                 \ta.ts\0i/crlf  w/crlf  attr/-text           \tb.bin\0';
  assert.deepEqual(parseEolListing(out), [
    { indexEol: 'lf', worktreeEol: 'lf', attr: '', path: 'a.ts' },
    { indexEol: 'crlf', worktreeEol: 'crlf', attr: '-text', path: 'b.bin' },
  ]);
});

test('行尾不一致：i/lf + w/crlf 必须被认出（这是 CRLF 检出的典型形态）', () => {
  const bad = findEolMismatches([row('lib/a.ts', 'lf', 'crlf')]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].path, 'lib/a.ts');
  assert.equal(bad[0].reason, '索引与工作树行尾不一致');
});

test('行尾不一致：反向（i/crlf + w/lf）同样要红', () => {
  assert.equal(findEolMismatches([row('lib/a.ts', 'crlf', 'lf')]).length, 1);
});

test('工作树内混合行尾必须红（比"全是 CRLF"更坏，它说明有人只改了一部分）', () => {
  const bad = findEolMismatches([row('lib/a.ts', 'lf', 'mixed')]);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].reason, '工作树内混合行尾');
});

test('好样本必须绿：索引与工作树一致（含两边都是 crlf），以及二进制文件', () => {
  const ok = [
    row('lib/lf.ts', 'lf', 'lf'),
    // autocrlf=true 的检出：两边都是 crlf，git 归一化后比较，是合法形态
    row('lib/crlf.ts', 'crlf', 'crlf'),
    row('img/logo.png', '-text', '-text'),
    row('vendor/b.bin', 'lf', 'crlf', '-text'),
  ];
  assert.deepEqual(findEolMismatches(ok), []);
});

test('纯行尾差异：diff 有、ignore-cr-at-eol 没有 ⇒ 命中', () => {
  assert.deepEqual(findEolOnlyDiffs(['a.ts', 'b.ts', 'c.ts'], ['c.ts']), ['a.ts', 'b.ts']);
  assert.deepEqual(findEolOnlyDiffs(['a.ts'], ['a.ts']), [], '内容差异不算行尾差异');
});

test('autocrlf=true/input：只跳过行尾判定，磁盘 CRLF 不算差异', () => {
  const state = collectState({
    autocrlf: 'true',
    eolRows: [row('lib/a.ts', 'lf', 'crlf')],
    dirty: [],
    plainDiff: ['lib/a.ts'],
    ignoringCrDiff: [],
  });
  assert.equal(state.enforced, false);
  const r = compareStates(null, state);
  assert.equal(r.ok, true);
  assert.equal(r.eolSkipped, true);
  assert.deepEqual(r.newEol, []);
});

test('R1：**未设置** core.autocrlf 必须判定（CI ubuntu runner 就是这种形态）', () => {
  // GitHub Actions 的 ubuntu runner 没有设置 core.autocrlf；未设置时 git **不归一化**行尾，
  // 所以「未设置 → 跳过」会让这条门禁在 CI 上恒绿 = 没有门禁（TITA-91 R1）。
  for (const value of ['', '   ', undefined, null, 'false']) {
    assert.equal(
      collectState({ autocrlf: value, eolRows: [], dirty: [], plainDiff: [], ignoringCrDiff: [] }).enforced,
      true,
      'autocrlf=' + JSON.stringify(value) + ' 必须判定'
    );
  }
  // 未设置 + 一个 LF→CRLF 的文件：跑前干净、跑后新增 ⇒ 必须红
  const before = collectState({ autocrlf: '', eolRows: [row('lib/a.ts', 'lf', 'lf')], dirty: [], plainDiff: [], ignoringCrDiff: [] });
  const after = collectState({
    autocrlf: '',
    eolRows: [row('lib/a.ts', 'lf', 'crlf')],
    dirty: [{ status: 'M', path: 'lib/a.ts' }],
    plainDiff: ['lib/a.ts'],
    ignoringCrDiff: [],
  });
  const r = compareStates(before, after);
  assert.equal(r.ok, false, '未设置 autocrlf 时，新增行尾差异必须判红（评审的复现场景）');
  assert.deepEqual(r.newEol.map((e) => e.path), ['lib/a.ts']);
});

test('R1：autocrlf=true/input 下「新增内容改动」仍然判红（不能一起跳过）', () => {
  for (const value of ['true', 'input']) {
    const before = collectState({ autocrlf: value, eolRows: [], dirty: [], plainDiff: [], ignoringCrDiff: [] });
    const after = collectState({
      autocrlf: value,
      eolRows: [],
      dirty: [{ status: 'M', path: 'lib/assistant/agent.ts' }],
      plainDiff: ['lib/assistant/agent.ts'],
      ignoringCrDiff: ['lib/assistant/agent.ts'],
    });
    const r = compareStates(before, after);
    assert.equal(r.ok, false, 'autocrlf=' + value + ' 只跳过行尾判定，内容改动仍必须红');
    assert.equal(r.eolSkipped, true);
    assert.deepEqual(r.newDirty.map((d) => d.path), ['lib/assistant/agent.ts']);
  }
});

test('autocrlf=false：跑前就有的差异不算门禁的锅（只报新增）', () => {
  const before = collectState({
    autocrlf: 'false',
    eolRows: [row('lib/a.ts', 'lf', 'crlf')],
    dirty: [{ status: 'M', path: 'lib/a.ts' }],
    plainDiff: ['lib/a.ts'],
    ignoringCrDiff: [],
  });
  const after = JSON.parse(JSON.stringify(before)); // 跑完一字未变
  const r = compareStates(before, after);
  assert.equal(r.ok, true, '本来就脏的检出必须放行 —— 否则这条门禁会变成"永远红"');
  assert.deepEqual(r.newEol, []);
});

test('autocrlf=false：门禁跑完新增的行尾差异必须红（L-25 合成坏样本）', () => {
  const before = collectState({
    autocrlf: 'false',
    eolRows: [row('lib/a.ts', 'lf', 'lf')],
    dirty: [],
    plainDiff: [],
    ignoringCrDiff: [],
  });
  const after = collectState({
    autocrlf: 'false',
    eolRows: [row('lib/a.ts', 'lf', 'crlf')],
    dirty: [{ status: 'M', path: 'lib/a.ts' }],
    plainDiff: ['lib/a.ts'],
    ignoringCrDiff: [],
  });
  const r = compareStates(before, after);
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.newEol.map((e) => e.path),
    ['lib/a.ts']
  );
  assert.deepEqual(
    r.newDirty.map((d) => d.path),
    ['lib/a.ts']
  );
});

test('autocrlf=false：门禁跑完新增的**内容**改动也要红（不只是行尾）', () => {
  const before = collectState({ autocrlf: 'false', eolRows: [], dirty: [], plainDiff: [], ignoringCrDiff: [] });
  const after = collectState({
    autocrlf: 'false',
    eolRows: [],
    dirty: [{ status: 'M', path: 'lib/a.ts' }],
    plainDiff: ['lib/a.ts'],
    ignoringCrDiff: ['lib/a.ts'],
  });
  const r = compareStates(before, after);
  assert.equal(r.ok, false, '纯内容改动同样说明门禁改了工作树');
  assert.deepEqual(r.newDirty.map((d) => d.path), ['lib/a.ts']);
});

test('门禁按实测重写的快照不算"改脏工作树"，但会明确提示要提交', () => {
  const before = collectState({ autocrlf: 'false', eolRows: [], dirty: [], plainDiff: [], ignoringCrDiff: [] });
  const after = collectState({
    autocrlf: 'false',
    eolRows: [],
    dirty: [{ status: 'M', path: 'tests/.test-count.json' }],
    plainDiff: ['tests/.test-count.json'],
    ignoringCrDiff: ['tests/.test-count.json'],
  });
  const r = compareStates(before, after);
  assert.equal(r.ok, true, '快照本来就要入库，新增用例后必然变 —— 不能因此判门禁改脏了树');
  assert.deepEqual(r.generated.map((g) => g.path), ['tests/.test-count.json']);
  assert.deepEqual(r.newDirty, []);
});

test('快照之外的任何新增改动仍然判红（白名单只放一个文件）', () => {
  const before = collectState({ autocrlf: 'false', eolRows: [], dirty: [], plainDiff: [], ignoringCrDiff: [] });
  const after = collectState({
    autocrlf: 'false',
    eolRows: [],
    dirty: [
      { status: 'M', path: 'tests/.test-count.json' },
      { status: 'M', path: 'lib/assistant/agent.ts' },
    ],
    plainDiff: ['tests/.test-count.json', 'lib/assistant/agent.ts'],
    ignoringCrDiff: ['tests/.test-count.json', 'lib/assistant/agent.ts'],
  });
  const r = compareStates(before, after);
  assert.equal(r.ok, false);
  assert.deepEqual(r.newDirty.map((d) => d.path), ['lib/assistant/agent.ts']);
});

test('本来就脏的文件被门禁又改了行尾：仍判红（diff 那条会漏，靠 ls-files 兜住）', () => {
  const before = collectState({
    autocrlf: 'false',
    eolRows: [row('lib/a.ts', 'lf', 'lf')],
    dirty: [{ status: 'M', path: 'lib/a.ts' }], // 已有内容改动（所以 diff 两版都非空）
    plainDiff: ['lib/a.ts'],
    ignoringCrDiff: ['lib/a.ts'],
  });
  const after = collectState({
    autocrlf: 'false',
    eolRows: [row('lib/a.ts', 'lf', 'crlf')],
    dirty: [{ status: 'M', path: 'lib/a.ts' }],
    plainDiff: ['lib/a.ts'],
    ignoringCrDiff: ['lib/a.ts'],
  });
  const r = compareStates(before, after);
  assert.equal(r.ok, false);
  assert.deepEqual(r.newEol.map((e) => e.path), ['lib/a.ts']);
});
