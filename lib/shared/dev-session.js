/**
 * dev-session 的读写（共享）。
 *
 * 这是「源码 URL → 磁盘路径」归一化所需的上下文来源：
 * 扩展侧不知道磁盘布局，所以 projectRoot / devUrl 只能由**本机进程**提供。
 *
 * 为什么放到 lib/shared：桥接与 DSH 插件运行在**两个进程**里，但必须读**同一个**文件 ——
 * 否则插件侧做出来的路径归一化与桥接侧不一致，用户会看到两套结果。
 * 路径是确定的（环境变量或家目录），所以在共享模块里算一次就够了。
 *
 * 这里刻意**不在 import 时建目录**：读不建目录（读不到就是空的），
 * 只有写入时才建 —— import 时做文件系统副作用会让"只是 import 一下"变成有副作用的操作。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 证据目录。规则必须与 evidence-store.js 的 DIR **逐字一致**，否则会读到两个地方。 */
export function evidenceDir() {
  return process.env.RECALLFLOW_EVIDENCE_DIR || path.join(os.homedir(), '.recallflow-evidence');
}

export function devSessionFile() {
  return path.join(evidenceDir(), 'dev-session.json');
}

/** 读不到 / 解析失败一律返回空对象（"没配置过"与"读坏了"对调用方是同一件事）。 */
export function readDevSession() {
  try {
    return JSON.parse(fs.readFileSync(devSessionFile(), 'utf8'));
  } catch (e) {
    return {};
  }
}

export function writeDevSession(patch) {
  const next = Object.assign(readDevSession(), patch, { updatedAt: new Date().toISOString() });
  try {
    fs.mkdirSync(evidenceDir(), { recursive: true });
    fs.writeFileSync(devSessionFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {}
  return next;
}

/** 归一化所需的上下文（来自 dev_session_set）。 */
export function devCtx() {
  const s = readDevSession();
  return { projectRoot: s.projectRoot || '', devUrl: s.devUrl || '' };
}
