// 工作树行尾（EOL）守卫：把「跑门禁之前就脏的检出」与「门禁自己留下的脏」分开。
//
// 为什么需要它（TITA-90 / L-19 形态三）：
//   在 `core.autocrlf=false` 的检出上，如果文件曾被 autocrlf=true 物化成 CRLF，
//   `git status` 会稳定地报出整文件行尾差异（+N/−N）。这种红**在跑门禁之前就存在**，
//   但没人跑前跑后各看一次，于是每次都被算到"门禁把源码写成了 CRLF"头上。
//   同类事故还有一次是真的：崩溃自愈把 CRLF 时代的备份写回了 LF 检出
//   （已由 scripts/lib/mutation-fs.mjs 的逐字节判据修掉，并配了回归用例）。
//
// 用法（run-all-checks.mjs 已经接线，一般不用手跑）：
//   node scripts/check-worktree-eol.mjs --snapshot <tmp.json>   # 跑门禁前
//   node scripts/check-worktree-eol.mjs --compare  <tmp.json>   # 跑门禁后
//   node scripts/check-worktree-eol.mjs                         # 单看当前状态（只诊断，不比较）
//
// 判据：
//   · `core.autocrlf` 不是 false 时 git 会归一化行尾，磁盘 CRLF 是正常的 ⇒ 跳过；
//   · 索引与工作树行尾不一致（i/lf w/crlf、i/crlf w/lf、w/mixed）⇒ 检出状态问题；
//   · `git diff` 有改动但 `--ignore-cr-at-eol` 没有 ⇒ 纯行尾差异；
//   · 只对**跑门禁前没有、跑门禁后新增**的项红：这条门禁守的是"门禁不许自己改脏工作树"，
//     不是"开发者不许有未提交的改动"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const TEXT_EOLS = new Set(['lf', 'crlf', 'mixed']);

// 门禁**有意**会写、且本来就该由开发者提交的生成物。
// 它们的变化不算"门禁把工作树改脏"：tests/.test-count.json 由 run-all-checks 的最后一步
// 按实测重写（新增用例时必然变）。这不放过任何一个行尾问题 —— 行尾差异仍然一律判红。
// 交付前仍要求 `git status --short` 为空：提交这份快照即可（它本来就是要入库的数字）。
const DECLARED_GENERATED = new Set(['tests/.test-count.json']);

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
}

/** `git ls-files --eol -z` 的输出 → [{ path, indexEol, worktreeEol }]。纯函数，便于单测。 */
export function parseEolListing(out) {
  const rows = [];
  for (const record of String(out || '').split('\0')) {
    if (!record) continue;
    const m = /^i\/(\S+)\s+w\/(\S+)\s+attr\/(\S*)\s*\t(.*)$/.exec(record);
    if (!m) continue;
    rows.push({ indexEol: m[1], worktreeEol: m[2], attr: m[3], path: m[4] });
  }
  return rows;
}

/**
 * 从 ls-files 行里挑出「行尾不一致」的跟踪文件。
 *
 * 只处理文本行尾（lf / crlf / mixed）；`-text`（二进制）不参与，否则图片/产物会一直报。
 * 索引与工作树**一致**（含两边都是 crlf）不算问题 —— 它只是这份检出被物化成了 CRLF，
 * 与"门禁改脏了树"无关；这类状态由 autocrlf 判定统一跳过。
 */
export function findEolMismatches(rows) {
  const out = [];
  for (const r of rows) {
    if (!TEXT_EOLS.has(r.indexEol) || !TEXT_EOLS.has(r.worktreeEol)) continue;
    if (r.attr && r.attr.split(',').some((a) => a === '-text' || a === 'binary')) continue;
    if (r.worktreeEol === 'mixed') {
      out.push({ path: r.path, indexEol: r.indexEol, worktreeEol: r.worktreeEol, reason: '工作树内混合行尾' });
    } else if (r.indexEol !== r.worktreeEol) {
      out.push({ path: r.path, indexEol: r.indexEol, worktreeEol: r.worktreeEol, reason: '索引与工作树行尾不一致' });
    }
  }
  return out;
}

/** 纯行尾差异：`git diff` 有它、`--ignore-cr-at-eol` 没有它。 */
export function findEolOnlyDiffs(plainPaths, ignoringCrPaths) {
  const ignore = new Set(ignoringCrPaths);
  return plainPaths.filter((p) => !ignore.has(p));
}

/** 全仓状态快照（供 --snapshot / --compare 使用）。 */
export function collectState({ autocrlf, eolRows, dirty, plainDiff, ignoringCrDiff }) {
  const eolMismatches = findEolMismatches(eolRows);
  const eolOnly = findEolOnlyDiffs(plainDiff, ignoringCrDiff);
  return {
    autocrlf: String(autocrlf || '').trim(),
    // autocrlf=true/input：git 会把磁盘 CRLF 归一化后与索引比较，CRLF 是合法检出形态。
    enforced: String(autocrlf || '').trim() === 'false',
    dirty,
    eolMismatches,
    eolOnly: eolOnly.map((p) => {
      const hit = eolMismatches.find((m) => m.path === p);
      return hit || { path: p, indexEol: '', worktreeEol: '', reason: '纯行尾差异（diff 里只有 CR）' };
    }),
  };
}

/**
 * 比较前后两份状态，只报**新增**的问题。
 *
 * 返回 { ok, newEol: [...], newDirty: [...] }。
 * 为什么只报新增：开发者带着未提交改动跑门禁是常态；把"本来就脏"判成门禁的锅，
 * 就会重演这条门禁想解决的误归因（L-44）。
 */
export function compareStates(before, after) {
  if (!after.enforced) return { ok: true, skipped: true, newEol: [], newDirty: [] };
  const beforeEolPaths = new Set([
    ...((before && before.eolOnly) || []).map((e) => e.path),
    ...((before && before.eolMismatches) || []).map((e) => e.path),
  ]);
  const beforeDirty = new Set(((before && before.dirty) || []).map((d) => d.path));
  // 两个来源都要看：ls-files --eol 抓"索引 vs 工作树"，diff 抓"工作树 vs 索引"的纯行尾改动。
  // 前者对「本来就脏的文件被门禁改了行尾」仍然有效（diff 那条会漏，因为 ignore-cr 也非空）。
  const allEol = new Map();
  for (const e of [...(after.eolOnly || []), ...(after.eolMismatches || [])]) allEol.set(e.path, e);
  const newEol = [...allEol.values()].filter((e) => !beforeEolPaths.has(e.path));
  const newDirty = (after.dirty || []).filter((d) => !beforeDirty.has(d.path));
  const generated = newDirty.filter((d) => DECLARED_GENERATED.has(d.path));
  const unexpected = newDirty.filter((d) => !DECLARED_GENERATED.has(d.path));
  return { ok: newEol.length === 0 && unexpected.length === 0, skipped: false, newEol, newDirty: unexpected, generated };
}

function snapshotNow() {
  const autocrlf = (() => {
    try {
      return git(['config', '--get', 'core.autocrlf']);
    } catch (e) {
      return '';
    }
  })();
  const eolRows = parseEolListing(git(['ls-files', '--eol', '-z']));
  const dirty = git(['status', '--porcelain'])
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3).trim() }));
  const plainDiff = git(['diff', '--name-only']).split('\n').filter(Boolean);
  const ignoringCrDiff = git(['diff', '--ignore-cr-at-eol', '--name-only']).split('\n').filter(Boolean);
  return collectState({ autocrlf, eolRows, dirty, plainDiff, ignoringCrDiff });
}

function describe(list, label) {
  if (!list.length) return;
  console.error('\n✗ ' + label + '（' + list.length + ' 个）:');
  for (const item of list.slice(0, 20)) {
    const extra = item.reason ? '  [' + item.reason + (item.worktreeEol ? '：i/' + item.indexEol + ' vs w/' + item.worktreeEol : '') + ']' : '';
    console.error('  ' + item.path + extra);
  }
  if (list.length > 20) console.error('  … 还有 ' + (list.length - 20) + ' 个');
}

function main() {
  const argv = process.argv.slice(2);
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1];
  };
  const snapshotPath =
    argOf('--snapshot') || argOf('--compare') || path.join(os.tmpdir(), 'rf-worktree-eol-' + process.pid + '.json');
  const state = snapshotNow();

  if (argv.includes('--json')) {
    console.log(JSON.stringify(state, null, 2));
    return 0;
  }

  if (!state.enforced) {
    console.log('工作树行尾检查：core.autocrlf=' + (state.autocrlf || '(未设置)') + '，git 会归一化行尾，跳过');
    return 0;
  }

  if (argv.includes('--snapshot')) {
    fs.writeFileSync(snapshotPath, JSON.stringify(state), 'utf8');
    if (state.eolMismatches.length) {
      console.log(
        '工作树行尾检查：跑前已有 ' + state.eolMismatches.length + ' 个文件行尾不一致（记为检出状态，不计到门禁头上）\n' +
          '  修复（确认内容一致后再物化）：git diff --ignore-cr-at-eol --quiet -- <文件> && git checkout-index -f -- <文件>'
      );
    } else {
      console.log('工作树行尾检查：跑前干净（快照 ' + snapshotPath + '）');
    }
    return 0;
  }

  if (argv.includes('--compare')) {
    let before = null;
    try {
      before = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    } catch (e) {
      console.error('工作树行尾检查：读不到跑前快照 ' + snapshotPath + '（门禁接线漏了 --snapshot？）');
      return 1;
    }
    const r = compareStates(before, state);
    try {
      fs.unlinkSync(snapshotPath);
    } catch (e) {
      // 清理失败不影响结论
    }
    if (r.ok) {
      if (r.generated && r.generated.length) {
        console.log(
          '工作树行尾检查：跑完没有新增行尾差异 / 新增改动 ✓（' +
            r.generated.map((g) => g.path).join(', ') +
            ' 由门禁按实测重写，属预期生成物 —— 记得提交）'
        );
      } else {
        console.log('工作树行尾检查：跑完没有新增行尾差异 / 新增改动 ✓');
      }
      return 0;
    }
    describe(r.newEol, '门禁跑完后新增的行尾差异');
    describe(r.newDirty, '门禁跑完后新增的未提交改动');
    console.error(
      '\n这说明**门禁自己**把工作树改脏了（跑前并没有）。优先查就地改写源码的步骤（变异测试 / 自愈）。\n' +
        '如果只是行尾，恢复：git checkout-index -f -- <上面列出的文件>'
    );
    return 1;
  }

  // 单看当前状态
  if (state.eolMismatches.length) {
    describe(state.eolMismatches, '当前检出存在行尾不一致');
    console.error(
      '\n这是**检出状态**，不是代码问题。core.autocrlf=false 时需要一次性重新物化：\n' +
        '  git diff --ignore-cr-at-eol --quiet -- <文件> && git checkout-index -f -- <文件>'
    );
    return 1;
  }
  console.log('工作树行尾检查：索引与工作树行尾一致 ✓');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  process.exit(main());
}
