// 读源码路径解析：迁移期同一个模块可能已经是 `.ts`，而测试里写的还是 `.js`。
//
// 为什么需要它（不是偷懒）：源码级门禁断言的是**模块的当前内容**，
// 而 TS 迁移会逐个把 `.js` 改名成 `.ts`。测试若把 `.js` 写死，一次改名就会
// 让整批门禁以 ENOENT 崩掉（不是断言失败，是加载期崩溃 —— 见知识库 L-30），
// 而「把每条路径都改成 .ts」又会在下一批迁移时重复同一次返工。
//
// 规则：**先按写的那样找，找不到再试同名 `.ts`**。
// 两个都不在时返回原路径，让 readFileSync 抛出带真实路径的 ENOENT（错误信息才可读）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} rel 相对仓库根的路径（可写 `.js`，即便实际是 `.ts`）
 * @returns {string} 真实存在的绝对路径；都不存在时返回按入参拼出的绝对路径
 */
export function sourcePath(rel) {
  const abs = path.resolve(ROOT, rel);
  if (fs.existsSync(abs)) return abs;
  const ts = abs.replace(/\.js$/, '.ts');
  if (ts !== abs && fs.existsSync(ts)) return ts;
  const js = abs.replace(/\.ts$/, '.js');
  if (js !== abs && fs.existsSync(js)) return js;
  return abs;
}

/** 读源码（自动处理 `.js` ↔ `.ts` 的改名）。 */
export function readSource(rel) {
  return fs.readFileSync(sourcePath(rel), 'utf8');
}
