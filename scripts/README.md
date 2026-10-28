# Scripts

本目录包含 RecallFlow 的构建、验证与维护脚本，以及它们的使用说明。

## MCP 截图通道隔离验证台

桥接层是整个项目中最难手工回归的部分。它横跨扩展与 MCP 两个包，真实调用还需要「重载扩展 + 重启 server」，两者都会打断正在使用的 MCP 会话。

因此，这里提供一套**隔离验证台**，无需触碰任何运行中的实例。

| 脚本 | 作用 |
| --- | --- |
| [`verify-mcp-shot.mjs`](./verify-mcp-shot.mjs) | 在隔离端口启动 server，通过真实 MCP 协议检查工具注册、参数、错误路径和本地工具往返。 |
| [`verify-mcp-shot-success.mjs`](./verify-mcp-shot-success.mjs) | 模拟扩展，走通截图成功路径，并验证图片返回、`includeImage` 开关和证据归档。 |

### 基础协议验证

`verify-mcp-shot.mjs` 会在隔离端口启动 server 实例，并使用真实 MCP 协议完成以下检查：

- `initialize`、`tools/list` 和 `tools/call` 调用正常。
- `page_screenshot` 工具已注册，参数定义完整。
- 扩展不可用时能返回清晰错误，不会抛出未处理异常或将 base64 包装成 JSON。
- `evidence_get` 等本地工具能够正常往返，证明协议处理本身可用。

### 成功路径验证

`verify-mcp-shot-success.mjs` 会额外扮演一个「假扩展」：

1. 通过 `/poll` 领取请求。
2. 通过 `/result` 返回模拟截图。
3. 验证图片以 MCP image 内容块返回。
4. 验证 `includeImage` 开关生效。
5. 验证证据成功归档，且落盘字节与源数据一致。

### 使用方法

在独立的 PowerShell 终端中启动隔离实例，避免占用正在使用的 `7801` 端口：

```powershell
$env:RECALLFLOW_MCP_PORT = '7802'
$env:RECALLFLOW_EXT_TIMEOUT_MS = '3000'
$env:RECALLFLOW_EVIDENCE_DIR = "$env:TEMP\rf-evidence-test"

node integrations/opencode/recallflow-mcp/index.js --http
```

server 启动后，在另一个终端中运行验证：

```powershell
node scripts/verify-mcp-shot.mjs
node scripts/verify-mcp-shot-success.mjs
```

两个脚本都以非零退出码表示验证失败，可直接用于改动后的回归检查。

> **端口隔离：** 不要使用 `7801`。该端口通常属于正在运行的实例，验证脚本应始终使用独立的 `7802`。

> **已知未覆盖：** 真实扩展的 CDP 截图实现（`screenshot_capture` relay）仍需要重载扩展后才能验证。

## `check-const-assign.mjs`

扫描「对 `const` 声明重新赋值」这类只能在运行时触发的代码问题。该检查由 `tests/static-checks.test.mjs` 作为门禁在每次执行时调用。

### 背景

该脚本源于一次真实崩溃：`agent.js` 中的 `const deterministicFails` 在后面被 `+= 1`。当「完成断言判定失败」分支执行时，代码会抛出 `Assignment to constant variable`，导致整个 agent run 中断。

这个问题不容易被现有检查发现：

- `node --check` 无法识别，因为语法本身合法。
- 400 项单元测试也无法覆盖，因为需要真实运行 agent 并进入特定失败场景。

也就是说，这类问题此前没有任何一层检查能够发现。

### 检查策略

仓库没有安装 JavaScript 解析器（如 acorn、espree 或 TypeScript），为单个检查引入依赖并不划算。因此，脚本使用两层保守启发式检查，目标是**零误报**：

1. **字符串剥离**

   逐字符跟踪 `'`、`"`、`` ` `` 三种引号及转义字符，将字符串内容替换为空白。否则，`'<button title="x">'` 中的 `title=` 会被误认为对 `const title` 赋值。实测中，这一项曾贡献 38 处误报。

2. **声明收集**

   识别 `const`、`let`、`var`（包括无初始化的 `let m;`）、`function`、`class` 名称和函数参数。只有当某个名称的所有声明都是 `const`，且从未作为参数使用时，脚本才会报告它在声明位置之外的赋值。

实测精度为：修复后 0 处误报；将 `const` 改回后，正好命中对应的一处问题。

### 运行

```powershell
node scripts/check-const-assign.mjs
```

非零退出码表示发现可疑赋值。

### 已知限制

该检查倾向于漏报而不是误报：

- 不执行真正的词法作用域分析，同名变量跨作用域遮蔽时可能漏报。
- 模板字符串的 `${}` 插值按字符串处理；插值中包含赋值时可能漏报。

## `mutation-check.mjs`

验证 `tests/page-debug-hook.test.mjs` 中的断言是否真正能够发现问题。

### 背景

该脚本源于一次实测：测试中最初有两条「恒真断言」。

- 在 vm 沙箱中，栈帧不包含文件名，导致「initiator 不含自身帧」始终通过。
- `var f = function() {}` 的名称推断问题，使「具名」断言在某种写法下失效。

没有检查能力的测试比没有测试更危险，因为它会制造虚假信心。

### 工作方式

脚本会在**临时副本**上精确破坏一处行为，然后运行测试，并确认预期断言确实失败。源文件保持只读，修改前后可通过哈希验证。

```powershell
node scripts/mutation-check.mjs
```

非零退出码表示存在未被测试捕获的变异，即对应断言可能形同虚设。新增针对该文件的断言后，建议同时补一条对应的变异检查。
