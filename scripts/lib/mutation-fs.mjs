// 变异测试的**文件安全**原语：锁 + 备份 + 崩溃自愈。
//
// 为什么要把它们抽出来：`scripts/mutation-check.mjs` 会**就地改写**源文件，
// 这类脚本一旦出错，代价是"仓库里的源码被悄悄改成变异版本"——
// 本会话真实发生过一次：两个进程并发跑（`npm test` 的门禁 + 手动跑的那次），
// 一个进程的还原把另一个进程的**变异版本**写了回去，而收尾核对只报了一行 ✗，
// 源文件就这样带着 `idx.slice(0)`（keepFull 失效的变异）留在了工作区。
//
// 抽成纯函数后，这些性质可以被单测钉住（见 tests/mutation-guard.test.mjs），
// 而不是靠"读一遍脚本觉得没问题"。
import fs from 'node:fs';

export const BACKUP_SUFFIX = '.mutation-backup';
export const META_SUFFIX = '.mutation-backup.meta.json';

/** pid 是否还活着。EPERM 表示进程存在但无权探测 ⇒ 也算活着（宁可不抢锁）。 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

export function readLock(lockFile) {
  try {
    const j = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if (!j || !Number.isInteger(Number(j.pid)) || Number(j.pid) <= 0) return null;
    return { pid: Number(j.pid), at: j.at || '' };
  } catch (e) {
    return null; // 没有锁文件 / 内容坏掉 ⇒ 都视为"没有锁"（不能因为锁文件坏了就永久卡住）
  }
}

/**
 * 取锁。**已经有人拿着且那个进程还活着** ⇒ 拒绝（返回 {ok:false, holder}）。
 * 陈旧锁（pid 已不存在）允许接手 —— 否则一次 SIGKILL 会永久堵住这个门禁。
 */
export function acquireLock(lockFile, opts = {}) {
  const pid = opts.pid === undefined ? process.pid : opts.pid;
  const isAlive = opts.isAlive || pidAlive;
  const cur = readLock(lockFile);
  if (cur && cur.pid !== pid && isAlive(cur.pid)) return { ok: false, holder: cur };
  fs.writeFileSync(lockFile, JSON.stringify({ pid, at: new Date().toISOString() }), 'utf8');
  return { ok: true, tookOverStale: Boolean(cur && cur.pid !== pid) };
}

/** 释放锁。**只删自己的** —— 否则迟到的进程会把当前持有者的锁删掉，并发就又回来了。 */
export function releaseLock(lockFile, opts = {}) {
  const pid = opts.pid === undefined ? process.pid : opts.pid;
  const cur = readLock(lockFile);
  if (!cur) return false;
  if (cur.pid !== pid) return false;
  try {
    fs.unlinkSync(lockFile);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 写变异备份（原始字节 + 变了什么），供还原与崩溃自愈使用。
 *
 * 原始字节走 base64 存在 meta 里：`copyFileSync` 那种"原样拷回来"当然也行，
 * 但 meta 里同时留着 `to`（变异的替换文本）才能在自愈时**判断这份备份还算不算数** ——
 * 没有这个判断，一次崩溃之后如果你手工改过这个文件，自愈会把你的改动覆盖掉。
 */
export function writeBackup(absFile, rawText, toText, at = new Date().toISOString()) {
  fs.writeFileSync(absFile + BACKUP_SUFFIX, rawText, 'utf8');
  fs.writeFileSync(
    absFile + META_SUFFIX,
    JSON.stringify({ file: absFile, at, to: toText }), // 不含原文：原文就在 backup 里
    'utf8'
  );
}

/** 还原并清掉备份。用于正常路径的 finally。 */
export function restoreBackup(absFile) {
  const backup = absFile + BACKUP_SUFFIX;
  try {
    fs.copyFileSync(backup, absFile);
  } catch (e) {
    return false;
  }
  removeBackup(absFile);
  return true;
}

export function removeBackup(absFile) {
  for (const f of [absFile + BACKUP_SUFFIX, absFile + META_SUFFIX]) {
    try {
      fs.unlinkSync(f);
    } catch (e) {
      /* 已经不在了 */
    }
  }
}

/**
 * 崩溃自愈：启动时把上次被打断留下的变异版本还原。
 *
 * 三种情况分开处理（**不能一律还原**）：
 *   · 有备份 + meta，且源文件**仍含**那次变异的替换文本 ⇒ 确实是"变异还留在盘上" ⇒ 还原；
 *   · 有备份 + meta，但源文件已不含它 ⇒ 崩溃后这个文件被人改过（或已还原过），
 *     此时还原等于覆盖别人的改动 ⇒ **只删备份并报告**，不动源文件；
 *   · 有备份但没 meta（更老的版本留下的）⇒ 无法判断 ⇒ 不动源文件，报告出来让人看。
 */
export function recoverLeftovers(absFiles) {
  const restored = [];
  const skipped = [];
  for (const abs of absFiles) {
    const backup = abs + BACKUP_SUFFIX;
    if (!fs.existsSync(backup)) continue;
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(abs + META_SUFFIX, 'utf8'));
    } catch (e) {
      meta = null;
    }
    let current = '';
    try {
      current = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      current = '';
    }
    if (meta && typeof meta.to === 'string' && meta.to && current.includes(meta.to)) {
      if (restoreBackup(abs)) restored.push(abs);
    } else {
      removeBackup(abs);
      skipped.push(abs);
    }
  }
  return { restored, skipped };
}
