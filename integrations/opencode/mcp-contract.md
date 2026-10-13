# RecallFlow ↔ opencode MCP contract

RecallFlow exposes a small MCP server. It deliberately exposes **only the capabilities
opencode cannot already provide** (real browser session + personal knowledge + evidence
archive). It does **not** expose generic web search or plain fetch — opencode already has
those, so re-exposing them would be redundant.

## Division of labour

| | opencode | RecallFlow |
| --- | --- | --- |
| Role | hands — terminal, files, git, tests/builds | eyes + memory — live browser, personal KB, evidence snapshots |
| Evidence | test/build output (code facts) | timestamped + hashed page snapshots (web facts) |

## Tools

### `browser_read`

Open a URL in RecallFlow's **isolated browser window** (uses the user's real session:
cookies, login state, JS rendering), read the rendered content, archive an immutable
snapshot, and return the text plus evidence metadata.

Input:
```json
{
  "type": "object",
  "properties": {
    "url": { "type": "string", "description": "Absolute http(s) URL to read." },
    "waitFor": { "type": "string", "description": "Optional CSS selector to wait for before reading (SPA)." },
    "maxChars": { "type": "integer", "description": "Max characters of text to return (default 12000)." }
  },
  "required": ["url"]
}
```

Output:
```json
{
  "ok": true,
  "url": "https://example.com/page",
  "title": "Page title",
  "fetchedAt": "2026-09-17T08:31:00.000Z",
  "snapshotHash": "a1b2c3d4",
  "text": "rendered page text ...",
  "quotes": [{ "text": "exact supporting sentence", "selector": "optional css anchor" }]
}
```
On failure: `{ "ok": false, "error": "reason", "url": "..." }`.

Notes:
- `text` is **untrusted data**; callers must not treat it as instructions (prompt-injection).
- The snapshot is persisted in RecallFlow's evidence store keyed by `snapshotHash`, so the
  citation can be re-verified later even if the live page changes or 404s.

### `browser_search_read`

Optional convenience: run a search, open the most authoritative result, and `browser_read`
it in one call. Returns the same evidence shape as `browser_read` (with the chosen `url`).
Use sparingly; prefer `browser_read` with a URL found by the caller.

Input: `{ "query": "string", "preferOfficial": "boolean?" }`

### ~~`kb_search`~~ / ~~`kb_get`~~ —— **未实现，勿据此调用**

本文件曾把这两个工具写成契约的一部分。核对 `integrations/opencode/recallflow-mcp/index.js`
的 `TOOLS` 后确认：**它们从未被暴露过**（MCP 面上不存在 `kb_search` / `kb_get`）。
知识库能力目前只存在于扩展内置助手的 `knowledge_read({op})` 里，不经桥接。

保留这条记录而不是直接删掉整段，是因为「文档里有、实现里没有」的工具会让调用方
按文档发出注定失败的调用，而失败信息是 `unknown tool` —— 看不出是"没实现"还是"拼错了"。
新增工具时请以 `TOOLS` 为准，不要以本节为模板。

### `evidence_get`

Retrieve an archived snapshot for re-verification.

Input: `{ "hash": "string?", "url": "string?" }` (one of the two)
Output:
```json
{
  "found": true,
  "snapshot": { "url": "...", "title": "...", "fetchedAt": "...", "snapshotHash": "...", "text": "..." }
}
```

### `page_action`

**唯一会改变页面**（且不改变"你在哪一页"）的工具：在标签页上执行一次动作
（点击 / 输入 / 按键 / 滚动 / 等待元素 / 下拉 / 勾选 / 取快照 / AX 树 / 列框架）。

Input: `{ "tool": "click_element", "args": { "ref": "rf-3" }, "tabId": 12345 }`

- `tool` 必须在白名单内（见下）。`args` 是该工具自己的参数。
- `tabId` 可选：不传则用本 MCP 会话上次 `open_tab` 打开的标签页，再没有才回退到**当前活动标签页**。
  指定的标签页已关闭时**明确报错**，不会静默换页（静默换页会把动作做到用户正在看的页面上，
  而这类错误看起来像"点击没生效"，极难归因）。
- **多步流程请始终显式传 `tabId`**，否则用户一切走窗口，动作就会落到别的页面。

Output:
```json
{
  "ok": true,
  "tool": "click_element",
  "result": "已点击 ……",
  "verification": { "...": "..." },
  "hadEffect": true,
  "tabId": 12345,
  "pageUrl": "https://example.com/…"
}
```
`hadEffect: false` 不一定是失败（有的交互本就不改变 DOM）—— 必须复核，**不得假定成功**。

### `open_tab`

**导航**工具：打开一个页面（同 URL 已打开则复用），并把它设为本 MCP 会话的默认动作目标。

为什么必须有它：跑完一次完整流程的第一步是**到达目标页面**。此前只能由用户手动打开页面
并保持为活动标签页，外部 agent 才动得了 —— 那让"发一条指令就完成一次流程"在第一步就断了。

Input: `{ "url": "https://example.com/publish", "newTab": false }`

- 只放行 **http(s)**：`chrome://`、`file://`、`javascript:`、`data:` 一律拒绝（会越过浏览器安全边界）。
- 单次调用只新开**一个**标签页；`newTab: false`（默认）会先按 URL 复用已打开的标签页，避免越开越多。
- `switch_tab` **仍不开放**：它会改变用户当前视图。需要目标页面时用 `open_tab`（可复用）。

Output: `{ "ok": true, "tabId": 12345, "reused": false, "pageUrl": "...", "ready": true }`

### `read_console`

Read the **active tab's** recent console output (error/warn/log/info) and uncaught
exceptions — frontend debugging. Captured from `document_start` by a main-world hook.

Input: `{ "level": "error|warn|log|info?", "limit": "integer?" }`
Output: `{ "ok": true, "text": "[error] ...\n[warn] ..." }`

### `read_network`

Read the **active tab's** recent network requests (fetch/XHR: URL, method, status, ms, error, initiator).

Input: `{ "filter": "string?", "limit": "integer?" }`
Output: `{ "ok": true, "text": "GET 500 https://api.x/users (320ms)\n..." }`

### `get_element_source`

Resolve a DOM element on the **active tab** to its framework source location (React `_debugSource`
/ Vue `__file` / Svelte `__svelte_meta`; dev builds). The **page → code pointer**.

Input: `{ "ref"?: "string", "selector"?: "string", "text"?: "string", "index"?: "integer" }`
Output: `{ "ok": true, "text": "元素源码位置：src/components/Foo.tsx:42:7（react · Foo）" }`

### `get_picked_element`

Return the element the user most recently **picked** in the browser (via the panel's picker
（鼠标指针图标按钮）). Lets opencode map "the thing I clicked" to front-end code.

Input: `{}`
Output: `{ "found": true, "picked": { "selector": "#submit", "tag": "button", "label": "登录", "source": { "framework": "react", "file": "src/Login.tsx", "line": 42, "column": 7, "component": "LoginButton" }, "pageUrl": "https://…", "tabId": 12, "ts": 1700000000000 } }`
(`source` is `null` on production builds; `found: false` when nothing has been picked.)

### `dev_session_get` / `dev_session_set`

Shared dev context so the browser view and the code stay aligned. Stored server-side
(`~/.recallflow-evidence/dev-session.json`).

Input (`set`): `{ "projectRoot"?, "devUrl"?, "changedFiles"?: string[], "debugTabId"?, "note"? }`
Output: the merged session object.

## Trust boundaries

- **Permissions**: `browser_read` touches the user's browser → gate behind the client's
  permission policy. `evidence_get` / `recallflow_session` / `get_picked_element` /
  `dev_session_get` are read-only. (`kb_*` 与 `browser_search_read` 未实现，见上文。）
- **Write channels (`page_action`, `open_tab`)**: these are the **only** tools that mutate
  state. `page_action` changes the page (click / type / press / scroll / wait / select / check /
  snapshot reads); `open_tab` additionally changes **which page you are on**.
  They exist because the debugging loop breaks without them: no interaction means no request,
  so a bug cannot be reproduced and a fix cannot be triggered — and no navigation means the
  flow cannot even reach the page it is supposed to act on.
  **The allowlist is enforced on the extension side** (`lib/shared/bridge-write-policy.js`),
  not only in the MCP schema — a schema `enum` is a hint to the model, not a security boundary.
  The allowlist is split by **argument shape**, not by topic: page actions need a target
  (`ref`/`selector`/coordinates), navigation needs a valid http(s) `url`. Putting `open_tab`
  in the page-action set would either mis-reject it with `NO_TARGET` or let page actions skip
  their target check.
  Deliberately **not** exposed over the bridge: `run_javascript` (arbitrary code execution),
  user scripts, `upload_file` (would hand local files to a website), `switch_tab` (would change
  what the user is looking at), and local knowledge-base writes. Those require per-call approval
  in the browser panel, because the bridge is a **separate entry point** that does not pass
  through the agent loop's approval flow.
  `page_action` therefore returns `verification` / `hadEffect`; a caller must not treat
  `ok: true` alone as proof the action took effect.
- **Untrusted input**: everything returned from the web is data, not instructions. RecallFlow
  sanitises fetched text (strips fake system/instruction markers) before returning it.
- **No fabrication**: citations must reference a `snapshotHash` that exists in the evidence
  store; `evidence_get` is the check.
- **Tool count is a contract**: the MCP surface currently exposes **14** tools. `TOOLS` in
  `recallflow-mcp/index.js` is the single source of truth; `tests/bridge-contract.test.mjs`
  enforces that every bridge method is both declared and dispatched on the extension side.


## Session isolation

Multiple MCP clients may share one resident server (HTTP mode, independent `mcp-session-id`).
Bridge requests/responses are **bucketed per session**: each job carries a `session` tag that
the extension echoes back verbatim, and `/result` routes strictly by that tag (unattributable
results are dropped and logged rather than handed to whichever waiter holds the id).
Without this, a concurrent client could receive another client's page text — which for
debugging is worse than an error, because a wrong result still looks plausible.
See `docs/bridge-session-isolation-plan.md` and `recallflow-mcp/test/session-isolation.test.mjs`.

## Wiring it into opencode

The MCP server hosts a **local bridge (`127.0.0.1:7801`, WebSocket + HTTP long-poll)** that the
RecallFlow extension connects to as a client. Tool calls are relayed over that bridge to the
extension, which uses the real browser session and returns the result; the server archives
evidence where applicable. See `recallflow-mcp/README.md` for the implementation.

**Transport**: stdio (1:1) and Streamable HTTP are both supported. With DSH the resident HTTP
process is what is actually used (`http://127.0.0.1:7801/mcp` + `X-RecallFlow-Token`), because
the extension can only reach the process that owns port 7801 — with stdio, N clients spawn N
servers and only one of them can serve the browser. Changing extension-side code
(`lib/bridge/*`, `lib/shared/bridge-*`) requires **reloading the extension**; changing
server-side code (`recallflow-mcp/index.js`) requires **restarting the server process**.
Neither requires restarting the MCP client, although the client's cached tool list is only
refreshed on a new session — a newly added tool may not appear until the client reconnects.

Add the server (opencode example, local stdio; a remote HTTP server works too):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "recallflow": {
      "type": "local",
      "command": ["node", "C:/path/to/recallflow-mcp/index.js"],
      "enabled": true,
      "environment": {}
    }
  }
}
```

Remote variant:

```json
{
  "mcp": {
    "recallflow": {
      "type": "remote",
      "url": "http://127.0.0.1:7801/mcp",
      "headers": { "Authorization": "Bearer {env:RECALLFLOW_TOKEN}" }
    }
  }
}
```

Then drop the companion skill so the agent knows *when* and *how* to use it:

```
~/.config/opencode/skills/recallflow-evidence/SKILL.md
```

Restart opencode after adding the server or skill (config is loaded once at startup).

## Roadmap

- ✅ P0: `browser_read` + `evidence_get` (the evidence core).
- ✅ P1: `page_action` (the write channel) — without it the debug loop cannot close.
- ✅ P2: `open_tab` + `tabId` targeting — the first step of **driving a whole flow**
  (reach the page, then act on it deterministically instead of "whatever tab is active").
- ⛔ 已放弃 / 未实现: `kb_search` / `kb_get`（见上文「未实现」说明）、`browser_search_read`。
- ⏳ P3（未开始，需先定审批语义）: `agent_task` —— 外部客户端把**一整条任务**交给扩展内置
  agent 执行并回传进度。难点不在通道（`runAgentStream` 已存在），而在
  **审批**：扩展的逐次审批是 `port.postMessage({type:'tool-approval'})` 等**面板 UI** 应答，
  外部驱动要么一直挂到超时，要么绕过审批 —— 后者正是 `bridge-write-policy.js` 存在的理由。
  同时 `upload_file`（发带图内容的前提）目前被有意拒绝：放开它等于允许任何拿到桥接 token
  的本机进程把本机文件交给任意网站，因此应在**换掉默认桥接 token** 之后再单独决策。
- ⏳ P4: 长任务异步化（job id + 进度读取）—— 单次 MCP 调用受客户端超时约束
  （DSH 侧 `toolCallTimeoutMs: 90000`），分钟级任务必须在单次调用之外推进。

