// TS 迁移期的 resolve hook：让 importer 里写 `.js` 也能解析到已经改名的 `.ts`。
//
// 为什么需要它：TS 的惯例是「specifier 里写 `.js`，实际文件是 `.ts`」——
// esbuild 会自动做这个替换，但 **Node 不会**（实测 `ERR_MODULE_NOT_FOUND`）。
// 于是一个文件改名后，所有 import 它的地方都得同步改后缀；在两个 Dev 并行迁不同目录时，
// 这会让「谁先合」变成硬依赖。这个 hook 让「一半 .ts 一半 .js」的中间态合法，
// 各迁各的、互不阻塞。
//
// ⚠ **迁移期脚手架，Batch 5 收口时回收**（TITA-70 报告 §1.4 路径 2 的建议）：
//   收口方式是把所有 specifier 改成真实后缀（路径 1），然后删掉本文件与
//   scripts/ts-resolve-reg.mjs，并去掉 run-all-checks.mjs 测试步骤里的 `--import`。
//   不回收的代价：任何 `node scripts/x.mjs` 直跑命令都多一层隐性要求，
//   而「CI 绿」不再等价于「裸 node 能跑」。
//
// 两个已踩过的坑（改动时不要退回去）：
//   1. **不要**在返回值里带 `format: 'module'` —— 带了 Node 就绕过 type stripping，
//      直接 `SyntaxError: Unexpected token ':'`。
//   2. 探测候选文件是否存在用 `existsSync`，**不要**靠调用 `next()` 抛异常来判断
//      （实测会得到 `ERR_INVALID_URL, input: '[object Object]'` 这种莫名其妙的错）。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 只处理相对 specifier：裸包名与 `node:` 内置模块不碰。
const RELATIVE = /^\.{1,2}\//;
const REPLACE = [
  ['.js', '.ts'],
  ['.mjs', '.mts'],
];

export async function resolve(specifier, context, nextResolve) {
  if (!RELATIVE.test(specifier) || !context.parentURL) return nextResolve(specifier, context);
  for (const [from, to] of REPLACE) {
    if (!specifier.endsWith(from)) continue;
    const candidate = new URL(specifier.slice(0, -from.length) + to, context.parentURL).href;
    // 非 file: 的 URL（例如 parentURL 是 data:）交给默认解析，fileURLToPath 会抛。
    if (!candidate.startsWith('file:')) continue;
    if (existsSync(fileURLToPath(candidate))) {
      // 只给 url，不给 format：让 Node 自己走 type stripping。
      return { url: candidate, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
