# CODEBUDDY.md — 本仓库的编码约定

> 新增于 TITA-73（TS 迁移 Batch 0，2026-10-26）。这里只写**会让人踩坑、且踩了不会立刻报错**的约定。
> 迁移的整体方案与分批清单见 `docs/typescript-migration-plan.md`。

## TypeScript 迁移约定（进行中）

存量 `.js` 一律不动，新增/迁移的模块可以是 `.ts`。迁移期内这些是硬约束：

1. **禁止 `enum` / `namespace` / 参数属性（`constructor(public readonly x: number)`）。**
   Node 24 的 type stripping 只支持「可擦除」语法，这三类会直接
   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
   **为什么必须写成明令**：esbuild **支持**它们，所以 `npm run build:content` 与 CI 打包
   全绿、新鲜度门禁也绿 —— 只有真正跑到那行才会炸，而那时已经是运行时。构建链当不了把关人。
   （函数重载签名、`implements`、`satisfies`、`as const`、`abstract`、泛型约束、映射/条件类型
   都是可擦除的，可以用。）

2. **测试文件保持 `.test.mjs`，迁移只改测试里的 import 后缀。**
   `tests/assertion-quality.test.mjs` 与 `scripts/test-count.mjs` 都按 `.test.mjs` 枚举，
   且它们的断言是**只有上界**的棘轮。测试文件一旦改成 `.test.ts`，它就从统计里消失
   ⇒ 数字变小 ⇒ 门禁变弱但**一声不吭**。

3. **specifier 写真实后缀**（`import { x } from './table.ts'`）。
   esbuild 会自动做 `.js → .ts` 替换，但 **Node 不会** —— 写 `.js` 会
   `ERR_MODULE_NOT_FOUND`。迁移期有 `scripts/ts-resolve.mjs` 这个 resolve hook 兜住
   「importer 还写着 `.js`」的中间态（Batch 5 收口时回收）。

4. **每批都必须 `node scripts/build-content.mjs` 重建 `content.js`。**
   产物字节数不受迁移影响（全图迁完实测逐字节相同），所以**不要抬体积棘轮**；
   但产物里的路径注释 `// lib/x.js → // lib/x.ts` 会让新鲜度门禁变红。

5. **`tsc --noEmit` 目前还不是门禁。** 仓库里现在 0 个 `.ts`，挂进
   `scripts/run-all-checks.mjs` 就是一条永远为绿的假闸。
   Batch 1 首批 `.ts` 落地时，在同一个提交里把它补进 STEPS（入口已就绪：`npm run check:types`）。

6. **浏览器不能加载 `.ts`（Chromium 没有 type stripping）。**
   凡是不经过 `content.js` 打包就会被浏览器按文件名取走的模块，都不能只有 `.ts` 版本：
   `manifest.json` 里写死的入口、`chrome.scripting.executeScript({files:[...]})`、
   `chrome.runtime.getURL('lib/userscript/*.js')`。动到这些之前先做真浏览器复验。
