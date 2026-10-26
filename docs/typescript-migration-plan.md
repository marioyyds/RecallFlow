> **来源**：TITA-70 的预研报告（附件 `typescript-migration-plan.md`），2026-10-26 由 TITA-73（Batch 0）原样入库到 `docs/typescript-migration-plan.md`。
> 正文未作改写；分批方案以此为据，落地状态与增量见各批次 issue 的交付评论。
> 口径提醒：报告里的「基线 `master@b58288c`」「全仓 0 个 .ts」等是**当时的实测快照**，读的时候请按当前 HEAD 复核。

# RecallFlow TypeScript 迁移预研报告（草稿）

> 产物类型：**纯调研**。本轮未改动任何 `lib/`、`scripts/`、`tests/`、根 JS 文件。
> 基线：`master` @ `b58288c29e92e4a22e83bf847ba2bcdd8a367eda`（`git ls-remote` 实测 2026-10-26T13:44:01Z，交付前 14:33:26Z 复测**未变**）
> 环境：Windows 11 / Node **v24.19.0** / npm 11.17.0 / esbuild 0.28.2 / TypeScript 5.9.2（装在仓库外的临时目录）
> 所有破坏性实验都在**仓库外的沙箱副本**里做（`marioyyds/RecallFlow` 的一份纯拷贝），跑完即弃；本文件是唯一产出。

---

## 0. 一页结论

| 结论 | 判定 |
| --- | --- |
| Node 24 能否直接跑 import 了 `.ts` 的 `.mjs` 测试 | ✅ 能，type stripping 默认开启，零 flag、零 loader |
| Node 会不会做类型检查 | ❌ 不会 —— 必须有独立的 `tsc --noEmit` 门禁 |
| esbuild 打包能不能吃 `.ts` | ✅ 能，且**自动把 `'./x.js'` 解析成 `x.ts`**，入口都不用改 |
| TS 迁移会不会把 `content.js` 撑大 | ❌ 不会，全图迁完字节数**完全相同**（452440），体积棘轮不用抬 |
| 但要不要重建 `content.js` | ✅ 每批都要（产物里的路径注释 `// lib/x.js` → `// lib/x.ts` 会让新鲜度门禁变红） |
| 静态门禁会不会失效 | ⚠️ 会，且**三处是静默失效**（见 §3 表格标红的行） |
| 浏览器能不能直接加载 `.ts` | ❌ 不能（Chromium 实测 SyntaxError）—— 这是**范围的第一约束** |
| 推荐策略 | **allowJs 渐进 + 分批**，先只迁 content bundle 图；不要把测试改成 `.test.ts` |

**最大的单点风险**：`scripts/check-const-assign.mjs` 的 `EXTENSIONS = ['.js', '.mjs']`。文件一改名成 `.ts`，这道闸**既不报错也不报警，直接停止覆盖**。这类失效不会被任何人发现，除非有人回头对比「应该扫到多少文件」。

---

## 1. 测试链路（必答问题 ①）

### 1.1 Node 24 type stripping 实测

```bash
node -v            # v24.19.0
# 最小样本：math.ts（含 interface / 联合类型 / 显式返回类型）+ math.test.mjs
node --test math.test.mjs
# ℹ tests 3 / ℹ pass 3 / ℹ fail 0          exit=0
```

- `.mjs` 测试 **可以直接 import `.ts` 模块**，无需任何 loader / flag。
- `.ts` 文件本身也能被 `node --test` 直接执行（作为测试文件也可以）。
- **不做类型检查**：`export const x: number = '字符串'` 实测正常运行并输出字符串 ⇒ type stripping 只是「擦除 + 执行」。→ 必须有 `tsc --noEmit` 作为独立门禁（见 §6）。

### 1.2 不可擦除语法：有哪些、代价是什么

| 语法 | 裸 `node` | `--experimental-transform-types` |
| --- | --- | --- |
| `enum` | `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode`（exit 1） | ✅ 可用（带 ExperimentalWarning） |
| `namespace` | 同上：「namespace declaration is not supported in strip-only mode」 | ✅ 可用 |
| 参数属性 `constructor(public readonly x: number)` | `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | ✅ 可用 |
| 函数重载签名 / ` implements ` / `satisfies` / `as const` / `abstract` / `<T extends X>` / `keyof` / 映射类型 / 条件类型 | ✅ 全部可擦除 | ✅ |
| `declare const x: number` | ⚠️ **能过解析，但运行时 `ReferenceError: x is not defined`** —— 注释一样的东西被擦掉后引用留着 | 同 |

**关键好消息（全仓扫描，b58288c）**：

```
lib/** 中 enum 匹配数         : 0
lib/** 中 namespace 匹配数    : 0
lib/** 中参数属性匹配数        : 0
```

⇒ 现有代码用到的 TS 语法 100% 落在 strip-only 覆盖范围内。**迁移期不要引入 enum / namespace / 参数属性**，这条要写进 AGENTS/贡献约定，因为 esbuild 会让你在本地和 CI 打包全绿，只有真跑起来才炸（§2.4）。

### 1.3 specifier 后缀：Node 不认识 TS 的 `.js` 约定

```bash
# ./math.js 这个 specifier 指向实际存在的 math.ts
node spec.mjs
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../math.js'      exit=1
```

Node **不做** TS 的 `.js → .ts` 扩展名替换（esbuild 做，见 §2.1）。所以改名有涟漪：

> 实测：只把 `lib/assistant/claim-check.js` 改成 `.ts`，`lib/assistant/agent.js:22` 立刻
> `ERR_MODULE_NOT_FOUND: ... lib\assistant\claim-check.js imported from ... lib\assistant\agent.js`。

**需要改写的 specifier 实测计数**（`b58288c`）：

| 范围 | 文件数 | 含相对 import 的文件 | 相对 specifier 数 | 其中 `.js` 结尾 |
| --- | --- | --- | --- | --- |
| `tests/*.test.mjs` | 163 | 127 | 209 | **175**（174 条指向 `../lib/`） |
| `integrations/.../test/*.test.mjs` | 5 | 4 | 4 | **4** |
| `lib/**/*.js` | 95 | 41 | 157 | **157** |
| `entries/content.js` | 1 | 1 | 5 | **5** |
| 根入口 6 个 JS | 6 | 6 | 37 | **37**（但**这 37 条改不得**，见 §4.2） |
| **合计需改写** | | | | **约 378 处** |

### 1.4 三条可行路径（推荐第 1 条）

**路径 1 —— 直接把 specifier 改成 `.ts`（推荐）**

脚本改写 + 全量测试回归。优点：零运行时开销、零 loader、行为与现在完全一致（显式后缀）。
实测：`lib/assistant/claim-check.js → .ts`（还加了 `interface ClaimInput` / `ClaimResult` 联合类型 / 显式返回类型）+ 测试 import 改 `.ts` → `tests 21 / pass 21 / fail 0`。

**路径 2 —— 一个 20 行的 resolve hook，specifier 一字不改**

```js
// scripts/ts-resolve.mjs（沙箱内跑通，未提交）
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const REPLACE = [['.js', '.ts'], ['.mjs', '.mts']];
export async function resolve(spec, ctx, next) {
  if (/^\.{1,2}\//.test(spec) && ctx.parentURL) {
    for (const [from, to] of REPLACE) {
      if (!spec.endsWith(from)) continue;
      const cand = new URL(spec.slice(0, -from.length) + to, ctx.parentURL).href;
      if (existsSync(fileURLToPath(cand))) return { url: cand, shortCircuit: true };
    }
  }
  return next(spec, ctx);
}
// 注册：register('./scripts/ts-resolve.mjs', import.meta.url)
// 用法：node --test --import ./scripts/ts-resolve-reg.mjs tests/*.test.mjs
```

⚠️ **两个坑**（本轮都踩过）：
1. resolve hook 里**不要**返回 `format: 'module'` —— 返回了 Node 就绕过 type stripping，直接报 `SyntaxError: Unexpected token ':'`。
2. `nextResolve(...)` 靠「抛异常」做探测不可靠（会变成 `ERR_INVALID_URL, input: '[object Object]'`）；直接用 `existsSync` 判存在性。

实测：同一个 TS 模块，**无论 importer 写 `.js`（走 loader）还是 `.ts`（改后缀）都通过** `tests 21 / pass 21`。
**性能**：40 个测试文件 / 462 条用例，改后缀 8.509s vs 加 loader 8.543s ⇒ **开销 <1%（约 34ms）**，可以忽略。

**建议**：把 loader 当成**迁移期的临时脚手架**（它让「一半 `.ts` 一半 `.js`」的中间态合法，两个 Dev 可以并行且互不阻塞），最后回收 switching 到路径 1；不要把它做成长期运行时依赖 —— 那会让 `node scripts/x.mjs` 这种直跑命令多一层隐性要求。

**路径 3 —— 测试文件自己也改成 `.test.ts`**
不推荐：会让 `tests/assertion-quality.test.mjs` 与 `scripts/test-count.mjs` **静默失去覆盖**（见 §3）。

### 1.5 一句话答案

> Node 24 的 `node --test` **能**直接跑 import 了 `.ts` 的 `.mjs` 测试；type stripping 只支持可擦除语法（本项目现有代码全部满足，enum/namespace/参数属性一个都没有），且**不做任何类型检查**；约 378 处 `.js` specifier 需要改写，推荐用脚本批量改 `.ts`，迁移期可用一个 20 行 resolve hook 让混合态合法（开销 <1%）。

---

## 2. 构建链路（必答问题 ②）

### 2.1 esbuild 会自动做 TS 扩展名替换 —— 入口都不用改

实测（沙箱，`lib/shared/lru.js` → `lru.ts`，加了泛型 `createLruCache<K,V>` 与 `interface LruCache`）：

```
importer lib/page/chat.js 里仍然是：import { createLruCache } from '../shared/lru.js';
node scripts/build-content.mjs --check
  → 输入模块：25 个 / 产物大小：442 KB / 自包含性检查通过
```

再把**整个可达图 25 个模块**（含入口 `entries/content.js` → `content.ts`）全部改成 `.ts`，`scripts/build-content.mjs` 的 `entryPoints` **一个字都不改**，照样构建成功：

```
modules 25  bytes 452440  checkBundle -> []
vs 纯 JS 基线 compareBundle -> {"line":8,"diskLines":10410,"builtLines":10410}
逐行比：共 25 行不同 —— 全部是 esbuild 打的路径注释 // lib/xxx.js → // lib/xxx.ts
字节数：452440 == 452440（完全相同）
预算：SIZE_BUDGET_BYTES = 444*1024 = 454656，剩余余量 2216 字节
```

### 2.2 对棘轮与门禁的影响

| 项 | 结论 | 证据 |
| --- | --- | --- |
| `SIZE_BUDGET_BYTES` | **不用抬**（前提：不加 enum/装饰器等会产出运行时代码的语法） | 全图迁完字节数逐字节相同 |
| `content.js` 必须重建 | **必须**，每批都要 | `tests/content-bundle-freshness.test.mjs` 实测：**`tests 5 / pass 4 / fail 1`**，用例名 `content.js 与源码同步（改了 lib/page/** 或 lib/shared/** 就必须重建）`，diff 定位 `line 4134`（就是那行 `// lib/shared/lru.js`）；跑 `node scripts/build-content.mjs` 重建后 **`tests 5 / pass 5`** |
| L-36 可达性规则 | 仍然成立，但可以更省事：esbuild 的 metafile 直接给出 25 个输入，不用再 grep 独有字符串 | 本轮就是这么取的 |

### 2.3 一句话答案

> `entryPoints` 切到 `.ts` 后 esbuild **直接可用且无需改脚本**；产物字节几乎不变（只有路径注释，且不改变字节数）；体积棘轮**不必调整**，但**每批必须跑 `node scripts/build-content.mjs` 重建**并提交 `content.js`，否则新鲜度门禁会响。

### 2.4 一个必须写进约定的坑

esbuild **支持** enum / namespace / 参数属性；Node strip-only **不支持**。也就是说：

> 「CI 打包全绿 + `content-bundle-freshness` 通过」**不代表运行时能跑**。
> 只有走到那条路径（或 Node 直跑该模块）才会 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
> ⇒ **明令：迁移期禁止引入 enum / namespace / 参数属性。**（esbuild 比 Node 宽容，构建链不能当把关人。）

---

## 3. 静态门禁兼容性（必答问题 ③，本轮最大风险）

全部为沙箱实测。每条都给「命令 → exit / tests N / pass / fail / 用例名」。
**标 🔴 的是静默失效**（门禁既不变红也不报警，直接失去覆盖）—— 这三条是本报告最需要被记住的。

| # | 门禁 | 对 TS 的真实行为 | 性质 |
| --- | --- | --- | --- |
| 1 | `scripts/check-const-assign.mjs` | `EXTENSIONS = ['.js', '.mjs']` ⇒ `.ts` 文件**完全不进扫描集**；即便把 TS 文本放进 `.js`，`const total: number = 1; total += 1;` 也**检测不到** | 🔴 **静默失效** |
| 2 | `scripts/check-prefix-stability.mjs` | ①文件改名 → `[R0] 目标文件不存在` exit 1；②`let iter: number = ...` → `[R0] 未找到主循环…检查已失效` exit 1；③`const injectPlanMessage: () => void = ` → `[R3] splice 出现在 injectPlanMessage 之外` 误报在 1504 行 | 🟢 高声失败 |
| 3 | `scripts/mutation-check.mjs` | 15 个 TARGET / 10 个文件硬编码；①改名 → `ENOENT` 直接崩 exit 1；②**只改名不改行 → 6 条变异全抓住**；③变异锚点那一行加了类型标注 → `✗ 变异锚点未找到（脚本需随源码更新）` exit 1 | 🟢 高声失败 |
| 4 | `tests/panel-scope.test.mjs`（整file） | `SRC='lib/page/chat.js'`；改名 → `tests 5 / pass 2 / fail 3`（ENOENT） | 🟢 高声失败 |
| 5 | `tests/panel-scope.test.mjs` 变量规则 | 收集 openPanel 局部变量的正则要求「名字后紧跟 `=`」；`const el: HTMLElement = document.createElement(...)` ⇒ 局部集归零 → `前置：应识别出若干局部元素变量，实际 0`，`tests 5 / pass 4 / fail 1` | 🟡 失败（有前置断言兜住） |
| 6 | `tests/panel-scope.test.mjs` 模块级假阳性 | 模块级 `interface RowRefs { chip: HTMLElement \| null }` ⇒ 判成「引用了 openPanel 内局部变量 chip」，offender 原文 `chip 出现于：chip: HTMLElement \| null;` | 🟠 **假阳性**（L-37 的类型版） |
| 7 | `tests/panel-scope.test.mjs` 顶层函数断言 | 给 `mountThinkSegment` 加 `export` ⇒ 该条红；改成多行签名 ⇒ 仍绿 | 约束 |
| 8 | `tests/assertion-quality.test.mjs` | 只统计 `.test.mjs`；一个读源码的测试改成 `.test.ts` ⇒ `total 159→158、读源码文件 70→69、readFileSync 调用 166→164`，**门禁仍 5/5 全绿** | 🔴 **静默失效** |
| 9 | `scripts/test-count.mjs` | 只统计 `.test.mjs`；同上改成 `.test.ts` ⇒ `files.total 168→167`，快照照写不报错 | 🔴 **静默失效** |
| 10 | `tests/content-bundle-freshness.test.mjs` | 见 §2.2 | 🟢 预期红，重建即绿 |

### 3.1 check-const-assign：为什么会漏，怎么修

根因是声明收集这条正则把 `:` 排除在外：
```js
/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?=[=;,)\]}])/g
//                                        ↑ 名字后必须紧跟 = ; , ) ] } —— 类型标注的 ':' 不在集合里
```

**沙箱内验证通过的改造**（给将来真正动手时用）：
```diff
-const EXTENSIONS = ['.js', '.mjs'];
+const EXTENSIONS = ['.js', '.mjs', '.ts', '.mts'];

-        for (const m of code.matchAll(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?=[=;,)\]}])/g)) note(m[2], m[1], i + 1);
+        for (const m of code.matchAll(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[A-Za-z_$(][\w$<>|&(),\[\]{}\.\s:=>]*)?(?=[=;,;)\]}])/g)) note(m[2], m[1], i + 1);
```
实测结果：
- 4 个带类型标注的 const 赋值样本（`total: number` / `o: Opts` / `arr: Array<Map<...>>` / `fn: (a: string) => boolean`）**全部报出**（改造前 0/4）；
- 纯 JS 全仓复扫仍 `扫描 331 个文件 / 未发现「对 const 赋值」 ✓` ⇒ **无新增误报**；
- 干净 TS 语法样本（interface / type / keyof / 映射类型 / 条件类型 / abstract / 非 null 断言 / `as const` / `satisfies` / 泛型约束 / 正则+类型混排）**0 假阳性**。

### 3.2 check-prefix-stability：验证过的改造

```diff
-const LOOP_RE = /for\s*\(\s*let\s+iter\s*=\s*resumeIteration/;
+const LOOP_RE = /for\s*\(\s*let\s+iter\s*(?::\s*[^=;]+)?=\s*resumeIteration/;
-const PLAN_FN_RE = /const\s+injectPlanMessage\s*=/;
+const PLAN_FN_RE = /const\s+injectPlanMessage\s*(?::\s*[^=;]+)?=/;
-export const TARGET = 'lib/assistant/agent.js';
+export const TARGET = ['lib/assistant/agent.ts', 'lib/assistant/agent.js'].find((f) => fs.existsSync(f)) || 'lib/assistant/agent.js';
```
实测：两个锚点都加类型标注 → `请求前缀稳定性检查通过 ✓`；文件改名成 `.ts` → 也通过（自动选中 `.ts`）。

### 3.3 mutation-check：对 TS 源码仍然有效（特别验证）

- **inplace 模式与文件扩展名无关**：把 `lib/assistant/claim-check.js` 改成 `.ts`（并加 interface + 联合类型 + 显式返回类型），只含该目标的副本跑出来仍是 6/6：
  ```
  ✓ 规则 2 退回「只看失败名单」…        （实际变红：**同名工具失败后又重试成功** → …）
  ✓ 规则 1 去掉「调用过工具」的前提…    （实际变红：规则 1 只在「调用过工具」时触发…）
  ✓ 去掉「描述性措辞」的完成态线索要求…
  ✓ 把导航类声明放回写动词里…
  ✓ 把「看过内容」的工具也算成「打开过页面」…
  源文件未被改动 ✓ → 变异测试通过
  ```
- **但零容忍行级文本改动**：给第 1 条变异的锚点行加个类型标注（`mutating.every((t: string) => …)`）⇒
  ```
  ✗ 变异锚点未找到（脚本需随源码更新）：规则 2 退回「只看失败名单」（失败后重试成功的任务被判成撒谎）
  → 有变异未被抓住 —— 对应断言形同虚设     exit=1
  ```
- 15 个 TARGET 的 `file:` 字段要在迁移到某个文件时同步改（否则直接 `ENOENT` 崩）。
⇒ **迁移 PR 的 checklist 必须有一项**：本批是否碰到 mutation-check 的 15 个目标 / 它们的锚点行。

### 3.4 assertion-quality / test-count：为什么静默，怎么补

两者都用 `f.endsWith('.test.mjs')` 枚举，且断言是**只有上界**的棘轮（`rows.length <= 70`、`calls <= 166`、`sourceReading <= total/2`）。
文件从统计里消失 ⇒ 数字变小 ⇒ 断言更容易通过 ⇒ 门禁变弱但不吭声。

建议三选一（推荐第 1 条）：
1. **测试文件保持 `.test.mjs`**（只改里面的 import 后缀）——零成本，最稳；
2. 若确实要改成 `.test.ts`：两个脚本的枚举都改成 `/\.test\.(m?js|m?ts)$/`，并给棘轮加**下界**（`rows.length >= 70` 之类的「不许白白消失」断言）；
3. 至少给 `test-count.mjs` 加一条「`files.total` 必须等于实际测试文件数」的自检（对齐 L-22 那条口径）。

---

## 4. 迁移策略推荐（必答问题 ④）

### 4.1 先说那条决定范围的硬事实：浏览器不能加载 `.ts`

实测（Chromium 1248 / Playwright，本地 HTTP，`Content-Type: text/javascript` 这一最有利条件）：

| 用例 | 结果 |
| --- | --- |
| `.ts` 文件里是**纯 JS 语法** + JS MIME | ✅ `LOADED v=42` |
| `.ts` 文件里是 TS 语法 `export const v: number = 42` + JS MIME | ❌ `pageerror: SyntaxError: Missing initializer in const declaration`，页面停在 `pending` |

⇒ Chromium **没有 type stripping**，`.ts` 到了浏览器就是语法错误。
（**未验证**：我没有在真正的 MV3 扩展上下文里跑 —— 用 `--load-extension` 的探测脚本没能算出扩展 ID，页面拿到的是 `ERR_BLOCKED_BY_CLIENT`。V8 是同一个，结论可信度高；要在 MV3 上再确认一次，用 `tests/e2e/helpers.mjs:231` 的 `launchPersistentContext({args:['--load-extension=<root>']})` 即可。）

**推论**：凡是**不经过 `content.js` 打包**就会被浏览器按文件名取走的模块，都不能只有 `.ts` 版本：

| 加载方式 | 位置 | 约束 |
| --- | --- | --- |
| MV3 module service worker | `manifest.json` → `background.js` | 它 import 的所有 `.ts` 都到不了浏览器 |
| `popup/options/manager/skills-page/userscripts.html` | 各自的 `<script type=module>` | 同上 |
| content script 直列 | `manifest.json:37` `lib/page/debug-hook.js` | 文件名写死在 manifest |
| `chrome.scripting.executeScript({files:[...]})` | `lib/userscript/manager.js:44,237` | 文件名写死在字符串里 |
| `chrome.runtime.getURL('lib/userscript/*.js')` 动态 import | `lib/userscript/runner.js:12,13` | 文件名写死在字符串里 |

### 4.2 所以推荐：**allowJs 渐进迁移 + 分批**，第一批只做 content bundle 图内部

**为什么不推荐一次性切换**：一次性切换必须同时给 `background/popup/options/manager/skills-page/userscripts` 六个入口 + `debug-hook` + `userscript/runner` 都引入构建步骤（那是另一个量级的改动，还要动 manifest 与两处字符串），一次性做等于把「源级改动」和「加载方式改动」两种风险叠在同一批。

**推荐 allowJs（`checkJs` 先关）的理由**：
- `lib/**` 现状 strict 下 **2955 条错误 / 95 个文件**（见 §5）。一次性 strict 不可行；
- allowJs + `tsc --noEmit` 只对**已迁移文件**报错 ⇒ 棘轮式推进，与仓库现有的「棘轮文化」（体积棘轮、readFileSync 棘轮、测试数棘轮）一致；
- 一旦某目录全绿，可以把它的 `checkJs` 单独打开（用多个 tsconfig 或一个 tsconfig 逐步加 `// @ts-check`）。

### 4.3 两张依赖图（决定分批边界）

用 esbuild metafile / 静态解析在 `b58288c` 上实测：

- **浏览器加载图**（`background.js` + `popup/options/manager/skills-page/userscripts.js` + `lib/page/debug-hook.js`）：**85 个文件，其中 79 个 lib 模块**。
- **content bundle 图**（`entries/content.js`）：**25 个文件，其中 24 个 lib 模块**。
- **两图交集 9 个模块**：`lib/page/markdown.js`、`lib/assistant/run-hub.js`、`lib/shared/{utils,surrogates,constants,editable-text,screenshot-store,settings,handoff}.js`
- **仅 content 图内（15 个 lib + 入口）**：`page/{chat,commands,picker,debug-capture,page-text,settle,transcript,render-scheduler,save-clean,panel-css,panel-layout,fab-position,citation}.js`、`shared/{lru,table}.js`
- 两个图都不在：`lib/userscript/runner.js`（被 executeScript 注入）
- **目录级依赖方向**：`page → assistant → backend → shared → assistant`（**注意 `shared ↔ assistant` 有环**：`lib/shared/rag.js:4` import `../assistant/context.js`）。`bridge → assistant/backend/shared`；`userscript` 是纯叶子。

⇒ 因为有环，**不可能严格自底向上按目录分批**；要么同一环一起迁，要么靠 loader 让中间态合法。

### 4.4 分批清单

> 每批的验收口径建议统一为：
> ① `node scripts/run-all-checks.mjs` 全绿；② `node scripts/build-content.mjs --check` 25 模块 / 442 KB；③ **当批只给导出加类型，`const x: T` 这种变量级标注留到该文件的 strict 轮**（规避 §3.1 / §3.5 的漏报）；④ `git diff --stat <base> <head> -- content.js` 非空且体积未超棘轮；⑤ 碰到 mutation-check 15 个目标时，锚点行未变。

**Batch 0 —— 准备（单人，必须最先合）**
1. 加 `tsconfig.json`：`allowJs: true, checkJs: false, strict: true, target ES2022, lib [ES2022, DOM, DOM.Iterable], module/moduleResolution: NodeNext, types: ["chrome"], noEmit: true, skipLibCheck: true`。
2. `devDependencies` 加 `typescript` 与 `@types/chrome`（实测版本 5.9.2 / 0.3.6）。
3. 按 §3.1 / §3.2 改 `check-const-assign.mjs` 与 `check-prefix-stability.mjs`（**这是唯一的脚本改动，建议把它写成范围里的显式例外**）。
4. CI 的 `node-version` 从 `'22'` 改成 `'24'`（见 §6）。
5. 加 `scripts/ts-resolve.mjs` + 注册器，`run-all-checks.mjs` 的测试步骤加 `--import`。
6. 写进 `CODEBUDDY.md`：禁止 enum / namespace / 参数属性（§2.4）。

**Batch 1 —— content-only 16 个文件（**最大收益 + 零新增构建**，强烈推荐先做）**

`entries/content.js` + 上面列的 15 个 lib 模块。它们只在 `content.js` 打包产物里出现，浏览器永远看不到它们的路径 ⇒ **不需要动 manifest、不需要新构建**。

两个 Dev 可以并行，**切分依据实测内部依赖**（箭头=被依赖）：
- **Dev A（叶子层，11 个，彼此独立）**：`shared/lru.js`、`shared/table.js`、`page/{citation,page-text,save-clean,render-scheduler,transcript,debug-capture,settle,fab-position,panel-layout,panel-css}.js`
- **Dev B（聚合层，4 个）**：`page/{commands,picker}.js`、`page/chat.js`、`entries/content.js`
  （依赖 Dev A 的 `page-text/citation/debug-capture/settle/table`；用 loader 时不必等 A 合完，串行/把它排到 A 之后更稳）

> 这一批覆盖了 strict 错误最集中的文件：`lib/page/chat.js`（604 条）、`lib/page/commands.js`（162 条）、`lib/page/picker.js`（83 条）、`lib/page/transcript.js`（62 条）、`lib/page/page-text.js`（57 条）。

**Batch 2 —— 交集 9 个模块 + `lib/userscript/*`（7 个）**
动到这里就要先回答「`background.js` 怎么加载 TS」。**必须先做一次 4.1 的真浏览器复验**，再开 `lib/shared/*` 里那 7 个。

**Batch 3 —— `lib/assistant/*`（53 个文件，14312 行，strict 错误 1172 条）**
最大的一块，建议再拆：
- 3a：纯叶子（无 `../` import 的约 34 个文件）
- 3b：`agent.js`（197 条）、`tools.js`（165 条）、`context.js`、`llm.js` 等有环 / 有 mutation 目标的文件

**Batch 4 —— `lib/backend/cdp.js`（437 行 / 93 条）+ `lib/bridge/relay.js`（485 行 / 42 条）**
含 WS / CDP 协议类型，建议自写 d.ts，收益小、放到最后。

**Batch 5 —— 逐文件打开 `checkJs`（strict 收口）**
按错误密度从低到高关，配合 §5 的错误分布表挑「先歼 KP」。

### 4.5 并行前提（两个 Dev 同时动手的条件）

1. Batch 0 必须先合（否则两边都在改同一个 specifier，冲突在 import 行上）；
2. 用 loader（§1.4 路径 2）⇒ 文件所有权按目录/文件严格不重叠即可，**不必等对方合完**；
3. **同一时间只允许一个批次动 `content.js`** —— 它是构建产物，两批并行重建必冲突（L-04）；
4. 不要动别人的 `mutation-check` 目标行；15 个目标按 §3.3 列清单，撞上的那个 PR 自己负责同步锚点。

---

## 5. 类型定义范围与 strict 错误估算（必答问题 ⑤）

安装 `typescript@5.9.2`、`@types/chrome@0.3.6`（另备选官方 `chrome-types@0.1.459`）到仓库外目录，对 `lib/**` 全文跑 `allowJs + checkJs + strict`：

```
2496 / 2955 = TS7006 / TS7005 / TS7034  —— 隐式 any（约 84%）
 465        = TS2339                     —— 属性不存在（对象字面量被推成 {} / Object）
  91        = TS7053                     —— 索引签名缺 `any`
合计 2955 条 / 95 个文件 / 89 个文件有错 / 32536 行
⇒ 约 9.1 条 / 100 行
```

**按目录分布**

| 目录 | 行数 | strict 错误数 | 每 100 行 |
| --- | --- | --- | --- |
| `lib/assistant` | 14312 | 1172 | 8.2 |
| `lib/page` | 12491 | 1194 | 9.6 |
| `lib/shared` | 4080 | 346 | 8.5 |
| `lib/userscript` | 731 | 108 | 14.8 |
| `lib/backend` | 437 | 93 | 21.3 |
| `lib/bridge` | 485 | 42 | 8.7 |

**最难的 5 个文件**：`lib/page/chat.js` 604、`lib/assistant/agent.js` 197、`lib/assistant/tools.js` 165、`lib/page/commands.js` 162、`lib/backend/cdp.js` 93。

**抽查 3 个文件的逐项错误 TS**:

| 文件 | 行数 | strict 错误 | 构成 |
| --- | --- | --- | --- |
| `lib/assistant/claim-check.js` | 150 | 3 | TS7006 ×3（参数 `claim`/`verbs`/`result` 隐式 any）—— 它本来就有完整 JSDoc，逐个抄进 TS 即可 |
| `lib/shared/lru.js` | 52 | 6 | TS7006 ×5 + TS7005 ×1 —— 全是 `createLruCache(max)`/`get(key)` 的隐式 any |
| `lib/page/settle.js` | 127 | 20 | TS7006 ×5 / TS7005 ×3 / TS2339 ×5 / TS7034 ×3 —— 对象选项参数被推成 `{}`，`let quietTimer` 无初始值 |
| （补充）`lib/shared/store.js` | 327 | 9 | TS7006 ×3 / TS7034 ×2 / TS2307 ×2（单文件检查时的相对模块，全库一起检查时为 0）/ TS7005 / TS2810 |

**需要的类型来源**

| 需求 | 方案 | 实测 |
| --- | --- | --- |
| `chrome.*` MV3 API | `@types/chrome`（已验证）或官方 `chrome-types` | 不带这个包时全库多 117 条 `TS2304: Cannot find name 'chrome'`（2955 → 3042）；带上后 TS2304 = 0 |
| DOM | `lib: ["ES2022","DOM","DOM.Iterable"]`，**不装 `@types/web`** | 16 个 lib 文件用 `document`/`window`；全 scan TS2304=0 说明内置的 lib.dom 够了 |
| Node 侧（`scripts/`、`tests/`） | 需要 `@types/node` —— 本轮**未实测** | 若 `tsc` 的 include 覆盖到 `scripts/**` 就需要，建议首版 tsconfig 的 include 只写 `lib/**` |
| 自研模块接口 | 由 JSDoc 转 TS（`claim-check.js:59-68` 那份就是现成样板）；跨模块共享的形状先放 `types/*.d.ts` | `lib/**` 里现成 JSDoc 数量不少，是低成本入口 |
| MCP 子包 | 独立 `package.json` ⇒ 独立 tsconfig | 本轮未测，建议单独处理 |

**放宽到 `strict:false, noImplicitAny:false` ⇒ 170 条**（其中 TS2339 138 条是「对象字面量缺属性」，即真问题）。
⇒ **`noImplicitAny` 一个开关就贡献了约 2200 条**，是最划算的第一道分界线：先 `noImplicitAny:false` 把 Noise 压下，把 TS2339 当缺陷修，再逐个文件打开 `strict`。

---

## 6. CI 需要怎么改（必答问题 ⑥）

现状：`.github/workflows/checks.yml` 两个 job 都是 `runs-on: ubuntu-24.04`、`node-version: '22'`、`actions/{checkout,setup-node,cache}@v5`、`upload-artifact@v6`，`checks` job 走 `node scripts/run-all-checks.mjs`。

**必改项**

1. **Node 版本**：`'22'` → `'24'`。
   依据：type stripping 在 **Node 22.18.0（LTS，2025-07-31）起才默认开启**（官方 release note 小节标题即 "Type stripping is enabled by default"；可用 `--no-experimental-strip-types` 关闭）。虽然 `'22'` 大概率解析到 ≥22.18，但那依赖 runner 镜像里的版本，属于「 Silent Luck 」。本机实测用的是 v24.19.0，**钉 24 与本地一致最省事**。`e2e-nightly` 同改。
2. **`typescript` + `@types/chrome` 进根 `devDependencies`**（现状只有 `esbuild` 与 `@playwright/test`），`npm ci` 自动带上；同时更新缓存 key 的 `hashFiles`（已含 `package.json`，无需改）。
3. **加一道 `tsc --noEmit` 门禁**。推荐加进 `scripts/run-all-checks.mjs` 的 STEPS，而不是只加 CI step —— 否则会出现「本地 `npm test` 绿、CI 红」这种重复踩的坑（L-07）：
   ```js
   { name: '门禁：TypeScript 类型检查', cmd: process.execPath, args: ['node_modules/typescript/bin/tsc', '--noEmit'] },
   ```
   放在「单元测试」之后、「刷新测试数快照」之前（与现有约定一致）。
4. **若选 loader 路径**：给 `run-all-checks.mjs` 的测试 step 加 `--import ./scripts/ts-resolve-reg.mjs`，或直接 `NODE_OPTIONS`。**推荐先做 §1.4 路径 1（改后缀），CI 零改动**。
5. `tests/ci-workflow.test.mjs` 现有断言只覆盖「根依赖必须安装 / action 的 node24 major / 不得用浮动 runner」，**不会**因为改 `node-version` 而变红；若要防回归，可补一条「更低的 node-version 不得小于 22.18」的自检（可选，本轮未实现）。

**不必改**：`runs-on` 已经钉了 `ubuntu-24.04`；action 版本已在 node24 线；MCP 子包依赖安装已存在。

---

## 7. 风险表

| # | 风险 | 触发条件 | 后果 | 处置 |
| --- | --- | --- | --- | --- |
| R1 🔴 | `check-const-assign` 静默失去 `.ts` 覆盖 | 任何文件改成 `.ts` 而没同步 `EXTENSIONS` | const 赋值崩溃不再被拦截，且**无人察觉** | Batch 0 必须先改（补丁已在 §3.1 验证） |
| R2 🔴 | `assertion-quality` / `test-count` 静默少算 | 测试文件改成 `.test.ts` | 棘轮数字变小 ⇔ 门禁变弱而不红 | 测试保持 `.test.mjs`；或加下界断言 |
| R3 🟠 | `mutation-check` 锚点失配 | 给 15 个 TARGET 的**锚点行**加类型标注 | 「变异未被抓住」误报红 | PR checklist 强制核锚点；必要时同步改 `from` |
| R4 🟠 | `panel-scope` 假阳性 | 模块级 interface/type 的成员名撞上 openPanel 内唯一声明的局部变量名 | 误报，且报错像「运行到会 ReferenceError」，容易把人引去改函数结构（L-37 的老经验仍然适用） | 先 `grep` offender 那一行是不是类型声明；给 `risky` 集合剔除类型成员，或切片前剥 `interface`/`type` 块 |
| R5 🟠 | `panel-scope` 变量集归零（Thermo 有前置断言兜住 => 只是失败，不是静默） | `const el: HTMLElement = document.createElement(...)` | 红，但有清晰提示 | 要么同步改正则，要么迁移期不给 openPanel 内的局部元素变量加标注 |
| R6 🟠 | esbuild 与 Node 的 TS 语法宽容度不同 | 引入 enum / namespace / 参数属性 | CI 打包全绿，运行时 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` | 明令禁止 + 加一条 grep 门禁也可以考虑 |
| R7 🟡 | `SIZE_BUDGET_BYTES` 被误抬 | 有人看到「迁移了就该变大」 | 抬了预算却没真的变大 | 实测：全图迁完字节相同；只有引入运行时代码才变 |
| R8 🟡 | 浏览器加载 `.ts` | 把 browser-loaded 图里的模块改成只有 `.ts` | 扩展在真机上直接挂（不算 CI 保护范围） | Batch 2 之前必须真浏览器复验；必要时给那些入口加构建 |
| R9 🟡 | `.js` 后缀三处字符串 | `manifest.json:37` / `lib/userscript/manager.js:44,237` / `lib/userscript/runner.js:12,13` | 工具链不会提醒 | 迁移 checklist 里点名这三个位置 |
| R10 🟡 | `strict` 一次性打开 | Batch 5 之前就开 `checkJs` | 2955 条报错直接淹没 PR | allowJs 渐进，逐目录开 |

---

## 8. 本轮「未验证」清单（说清楚哪些只是推断）

1. **浏览器侧**：Chromium 无法解析 TS 是在**普通页面 + JS MIME** 下实测的；**真 MV3 扩展上下文**（`--load-extension` + service worker）没有跑通 —— 我的 `launchPersistentContext` 探测拿到的是 `ERR_BLOCKED_BY_CLIENT`，未能定位扩展 ID 的生成方式。V8 是同一个，结论可信度高，但严格说未验证。给出复跑脚本的位置见 §4.1。
2. **Node 22.18 的 "type stripping 默认开启"** 取自官方 v22.18.0 release note，**没有在本机实际安装 Node 22.18 验证**（本机是 24.19.0）。
3. **`check-const-assign` / `check-prefix-stability` 的改造补丁**只在沙箱副本里跑过（未提交、未入库）；没有写对应的「检测器会红」自检用例（也就是 L-25 要求的那条），真正落地时要补。
4. **生产环境 `npm ci` 的 typescript 安装与 CI 时长影响**未实测（沙箱里 `npm ci` 是 631ms/5 包；加 typescript 后 CI 会有几十 MB 体积变化，未测）。
5. **`tests/*.test.mjs` 全量 1947 条用例在迁移后的回归**：本轮只跑了受影响的子集（最多一次 40 个文件 / 462 条，全绿）。完整 1947 条没有跑。
6. **`entries/content.ts` 改名后 `scripts/build-content.mjs` 的 `entryPoints` 不用改**是实测结论，但那只验证了「esbuild 能解析」；**长期建议还是把 `entryPoints` 显式写成 `content.ts`**，别依赖 implicit resolution。
7. `@types/node` 是否必须，取决于 tsconfig 是否覆盖 `scripts/**`，本轮没有把这个组合跑一遍。
