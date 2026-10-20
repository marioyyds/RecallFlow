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

// Windows 上「文件明明存在、刚刚还读过，写入却失败」是常态而不是异常：
// 杀毒软件/索引服务会在文件被读之后短暂持有句柄，云盘同步也会。这些错误**重试即消失**。
// 本次就是被这个打中的：写变异版本时 `open` 抛 `errno: -4094, code: 'UNKNOWN'`，
// 整个门禁带着一段栈崩掉，还在盘上留下了一份备份（靠下一次运行的自愈才收干净）。
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'UNKNOWN', 'EBADF', 'EMFILE', 'EAGAIN']);

/** 极简同步 sleep（Node 主线程里 Atomics.wait 是唯一不阻塞事件循环以外东西的同步等待）。 */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 写文件，对**瞬态**错误退避重试；非瞬态错误原样抛出（重试没有意义，只会拖慢报错）。
 *
 * 返回实际尝试次数，便于调用方在日志里说明"这次是重试后才成功的"。
 * @param {string|Buffer} data
 * @param {{retries?:number, baseWaitMs?:number, write?:Function, sleep?:Function}} [opts]
 *        `write` / `sleep` 只是测试接缝 —— 生产路径不传。
 */
export function writeFileRetry(file, data, opts = {}) {
  const retries = Number.isInteger(opts.retries) && opts.retries > 0 ? opts.retries : 4;
  const baseWaitMs = Number.isFinite(opts.baseWaitMs) ? opts.baseWaitMs : 25;
  const write = opts.write || ((f, d) => fs.writeFileSync(f, d));
  const wait = opts.sleep || sleepSync;
  let lastError = null;
  let tried = 0;
  for (let attempt = 1; attempt <= retries; attempt++) {
    tried = attempt;
    try {
      write(file, data);
      return { ok: true, attempts: attempt };
    } catch (e) {
      lastError = e;
      const code = e && e.code;
      // 非瞬态（比如 ENOSPC / ENOENT）重试没有意义，直接把真实原因抛出去。
      if (!TRANSIENT_WRITE_CODES.has(code)) break;
      if (attempt < retries) wait(baseWaitMs * attempt); // 线性退避：25/50/75ms，够躲开一次扫描
    }
  }
  const err = new Error('写文件失败（已尝试 ' + tried + ' 次）：' + file + ' —— ' + (lastError && lastError.message));
  err.code = lastError && lastError.code;
  err.cause = lastError;
  throw err;
}

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
  writeFileRetry(absFile + BACKUP_SUFFIX, rawText);
  writeFileRetry(
    absFile + META_SUFFIX,
    JSON.stringify({ file: absFile, at, to: toText }) // 不含原文：原文就在 backup 里
  );
}

/** 还原并清掉备份。用于正常路径的 finally。 */
export function restoreBackup(absFile) {
  const backup = absFile + BACKUP_SUFFIX;
  let raw = null;
  try {
    raw = fs.readFileSync(backup); // Buffer：逐字节还原，不经过任何编码转换
  } catch (e) {
    return false;
  }
  // 这里是整个脚本**最不能失败**的写入：它失败就意味着源码带着变异版本留在盘上。
  // 所以用带退避重试的写入，而不是一次 copyFileSync 定生死。
  try {
    writeFileRetry(absFile, raw);
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
