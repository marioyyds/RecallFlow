// 变异测试的**文件安全**原语（锁 / 备份 / 崩溃自愈）—— 它们出错时的代价是"源码被悄悄改坏"。
//
// 为什么要单独测这些看起来"只是几个 fs 调用"的函数：
// 本会话真实发生过一次 —— 两个变异测试进程撞在一起（`npm test` 里的门禁 + 手动跑的那次），
// 一个进程还原的是另一个进程备份下来的**变异版本**，于是 `lib/assistant/context.js`
// 带着 `idx.slice(0)`（keepFull 失效的变异）留在了工作区，而收尾核对两个进程都"通过"了。
// 从外面看只有一个后果：测试莫名其妙变红，而源码看起来"没改过"。
//
// 所以这组测试盯的不是"函数能跑"，而是三条安全性质：
//   ① 同一时刻只允许一个变异进程；
//   ② 崩溃后自愈**不能**覆盖崩溃之后的人工改动；
//   ③ 还原必须逐字节（CRLF 不能被悄悄换成 LF）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireLock,
  releaseLock,
  readLock,
  pidAlive,
  writeBackup,
  restoreBackup,
  recoverLeftovers,
  writeFileRetry,
  BACKUP_SUFFIX,
  META_SUFFIX,
} from '../scripts/lib/mutation-fs.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rf-mutfs-'));
}

/** 一个几乎不可能存在的 pid —— 用来模拟"上次被 SIGKILL 的进程"。 */
const DEAD_PID = 4194303;

test('锁：空闲可取、同 pid 可重入、别的活着的进程会挡住', () => {
  const dir = tmpDir();
  const lockFile = path.join(dir, 'lock.json');

  assert.deepEqual(acquireLock(lockFile, { pid: 111 }), { ok: true, tookOverStale: false });
  // 同一个 pid 再取一次不算冲突（脚本可能因为重入/重试走到这里）。
  assert.equal(acquireLock(lockFile, { pid: 111 }).ok, true);

  const blocked = acquireLock(lockFile, { pid: 222, isAlive: () => true });
  assert.equal(blocked.ok, false, '另一个活着的进程持锁时必须拒绝 —— 并发会互相覆盖源文件');
  assert.equal(blocked.holder.pid, 111);
  assert.equal(readLock(lockFile).pid, 111, '被拒绝时不能把别人的锁改写成自己的');
});

test('锁：陈旧锁（持有者已死）允许接手，并标记出来', () => {
  // 否则一次 SIGKILL 会永久堵住这个门禁（而它还是 npm test 的一环）。
  const dir = tmpDir();
  const lockFile = path.join(dir, 'lock.json');
  acquireLock(lockFile, { pid: DEAD_PID });
  assert.equal(pidAlive(DEAD_PID), false, '前提：这个 pid 确实不存在');
  const got = acquireLock(lockFile, { pid: 333 });
  assert.equal(got.ok, true);
  assert.equal(got.tookOverStale, true, '接手陈旧锁要能被报告出来（便于排查）');
  assert.equal(readLock(lockFile).pid, 333);
});

test('锁：释放只删自己的（迟到的进程不能删掉当前持有者的锁）', () => {
  const dir = tmpDir();
  const lockFile = path.join(dir, 'lock.json');
  acquireLock(lockFile, { pid: 444 });
  assert.equal(releaseLock(lockFile, { pid: 555 }), false, '不是自己的锁不能删');
  assert.equal(readLock(lockFile).pid, 444, '别人的锁必须还在');
  assert.equal(releaseLock(lockFile, { pid: 444 }), true);
  assert.equal(readLock(lockFile), null);
});

test('还原必须逐字节：CRLF 源文件不能被悄悄改成 LF', () => {
  // 这是历史上真的发生过的副作用：写回时用归一化文本，于是 CRLF 文件被永久改成 LF，
  // 而 `git diff` 因为 autocrlf 看不到行尾差异 —— 直到某次 `git add -A` 把行尾变更一起提交。
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  const crlf = 'const a = 1;\r\nconst b = 2;\r\n';
  fs.writeFileSync(file, crlf, 'utf8');
  writeBackup(file, crlf, 'const a = 999;', 'const a = 1;');
  fs.writeFileSync(file, 'const a = 999;\r\nconst b = 2;\r\n', 'utf8');
  assert.equal(restoreBackup(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), crlf, '还原后必须与原文逐字节一致（含 CRLF）');
  assert.equal(fs.existsSync(file + BACKUP_SUFFIX), false, '还原后备份应清掉');
  assert.equal(fs.existsSync(file + META_SUFFIX), false, '还原后 meta 也应清掉');
});

test('自愈：源文件仍含变异文本 → 按备份还原', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  const original = 'export function f() {\r\n  return 1;\r\n}\r\n';
  fs.writeFileSync(file, original, 'utf8');
  writeBackup(file, original, '  return 2;', '  return 1;');
  fs.writeFileSync(file, original.replace('  return 1;', '  return 2;'), 'utf8'); // 模拟"崩溃时变异还留在盘上"

  const { restored, skipped } = recoverLeftovers([file]);
  assert.deepEqual(restored, [file]);
  assert.deepEqual(skipped, []);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('自愈：源文件已不含变异文本（崩溃后被改过）→ 绝不覆盖，只清备份', () => {
  // 这条是自愈最容易写错的地方：一律还原会把崩溃之后的人工修复覆盖掉。
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  const original = 'export const x = 1;\n';
  fs.writeFileSync(file, original, 'utf8');
  writeBackup(file, original, 'export const x = 2;', 'export const x = 1;');
  // 崩溃之后有人把它改成了第三种内容（不是原始、也不是变异）
  const edited = 'export const x = 1; // 手工修过\n';
  fs.writeFileSync(file, edited, 'utf8');

  const { restored, skipped } = recoverLeftovers([file]);
  assert.deepEqual(restored, [], '不该还原');
  assert.deepEqual(skipped, [file], '要报出来让人看一眼');
  assert.equal(fs.readFileSync(file, 'utf8'), edited, '人工改动必须原样保留');
  assert.equal(fs.existsSync(file + BACKUP_SUFFIX), false, '备份本身要清掉，否则每次启动都会再喊一次');
});

test('自愈：to 是通用片段时，旧备份绝不能覆盖比它更新的源码', () => {
  // 这条对应一次真实事故：meta.to 是 `  return false;`（几乎每个 catch 块都有）。
  // 原判据 `current.includes(to)` 于是恒真 —— 一次崩溃留下的**旧备份**在下一次启动时
  // 把当时已经新加的功能整段回退，而门禁全程"通过"。
  // 现在要求"当前文件恰好等于由备份替换 from→to 的结果"，才允许还原。
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  const original = 'if (x) {\n  return false;\n}\n';
  fs.writeFileSync(file, original, 'utf8');
  writeBackup(file, original, '  return true;', '  return false;');

  // 崩溃之后文件继续被开发：新增了一段，而且**仍然含** "  return false;" 这个通用片段
  const newer = original + 'function added() {\n  return false;\n}\n';
  fs.writeFileSync(file, newer, 'utf8');

  const { restored, skipped } = recoverLeftovers([file]);
  assert.deepEqual(restored, [], '备份比当前文件旧，不能覆盖');
  assert.deepEqual(skipped, [file], '要报出来让人看一眼');
  assert.equal(fs.readFileSync(file, 'utf8'), newer, '新加的代码必须原样保留');
});

test('自愈：停在变异态（精确匹配）仍能还原 —— 收紧判据不能把自愈本身废掉', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  const original = 'if (x) {\n  return false;\n}\n';
  fs.writeFileSync(file, original, 'utf8');
  writeBackup(file, original, '  return true;', '  return false;');
  fs.writeFileSync(file, original.replace('  return false;', '  return true;'), 'utf8');

  const { restored } = recoverLeftovers([file]);
  assert.deepEqual(restored, [file]);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('自愈：没有 meta 的老备份无法判断 → 不动源文件，只报告', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  fs.writeFileSync(file, 'const y = 1;\n', 'utf8');
  fs.writeFileSync(file + BACKUP_SUFFIX, 'const y = 0;\n', 'utf8'); // 只有备份，没有 meta
  const { restored, skipped } = recoverLeftovers([file]);
  assert.deepEqual(restored, []);
  assert.deepEqual(skipped, [file]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'const y = 1;\n', '无从判断时不能猜');
});

test('自愈：没有备份的文件完全不受影响（幂等）', () => {
  const dir = tmpDir();
  const a = path.join(dir, 'a.js');
  fs.writeFileSync(a, 'x\n', 'utf8');
  assert.deepEqual(recoverLeftovers([a, path.join(dir, 'missing.js')]), { restored: [], skipped: [] });
  assert.equal(fs.readFileSync(a, 'utf8'), 'x\n');
});

// ---------------------------------------------------------------- 写入重试
//
// 这一组来自一次真实发生的事故：写变异版本时 `open` 抛了
// `errno: -4094, code: 'UNKNOWN'`（Windows 上杀毒/索引服务短暂持有句柄的典型表现），
// 整个门禁带着一段栈崩掉，还在盘上留了一份备份，靠下一次运行的自愈才收干净。
//
// 所以写入必须分两类对待：**瞬态**错误（重试即消失）和**真**错误（重试只会拖慢报错）。

/** 造一个"前 n 次抛瞬态错误、之后成功"的假写入。 */
function flakyWrite(realWrite, failTimes, code = 'UNKNOWN') {
  let n = 0;
  return (file, data) => {
    n += 1;
    if (n <= failTimes) {
      const e = new Error('模拟瞬态写入失败');
      e.code = code;
      throw e;
    }
    realWrite(file, data);
  };
}

test('写入重试：瞬态错误重试成功（Windows 的 UNKNOWN 不该让门禁崩）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  const sleeps = [];
  const r = writeFileRetry(file, 'const a = 1;', {
    write: flakyWrite((f, d) => fs.writeFileSync(f, d, 'utf8'), 2),
    sleep: (ms) => sleeps.push(ms),
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3, '第 3 次才成功');
  assert.deepEqual(sleeps, [25, 50], '线性退避，不是死循环猛冲');
  assert.equal(fs.readFileSync(file, 'utf8'), 'const a = 1;');
});

test('写入重试：**非瞬态**错误立即抛出，一次都不多试', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  let calls = 0;
  assert.throws(
    () =>
      writeFileRetry(file, 'x', {
        write: () => {
          calls += 1;
          const e = new Error('磁盘满');
          e.code = 'ENOSPC';
          throw e;
        },
        sleep: () => {},
      }),
    /写文件失败（已尝试 1 次）/
  );
  assert.equal(calls, 1, '重试对 ENOSPC 毫无意义，只会拖慢报错');
});

test('写入重试：一直瞬态失败 → 用尽次数后抛出，并带上路径与真实原因', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  let calls = 0;
  assert.throws(
    () =>
      writeFileRetry(file, 'x', {
        retries: 3,
        write: () => {
          calls += 1;
          const e = new Error('还是被占着');
          e.code = 'EBUSY';
          throw e;
        },
        sleep: () => {},
      }),
    (e) => {
      assert.match(e.message, /已尝试 3 次/);
      assert.ok(e.message.includes(file), '报错必须指名道姓');
      assert.ok(e.message.includes('还是被占着'), '真实原因不能被吞掉');
      assert.equal(e.code, 'EBUSY');
      return true;
    }
  );
  assert.equal(calls, 3);
});

test('还原走重试：备份逐字节写回（Buffer 直通，不经编码转换）', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'src.js');
  // 故意放一段非 ASCII + CRLF：一旦中间经历一次 utf8 往返，这里就会变样
  const original = '// 中文注释\r\nconst s = "「」";\r\n';
  fs.writeFileSync(file, 'const mutated = 1;\r\n', 'utf8');
  writeBackup(file, original, 'const mutated = 1;', 'const s = "「」";');
  assert.equal(restoreBackup(file), true);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(file + BACKUP_SUFFIX), false);
});
