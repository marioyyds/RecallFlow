/**
 * DSH hook → RecallFlow 面板的桥。
 *
 * 背景：MCP 是客户端发起的，RecallFlow 的 MCP 服务端只能看到**它自己的**工具调用。
 * 而 DSH 的 Claude 风格 hooks 能在会话、提示词、工具、停止等时刻执行命令 ——
 * 于是「DSH 里到底发生了什么」可以经这里推给页面里的面板。
 *
 * 用法（在 hooks.json 里）：
 *   {
 *     "hooks": {
 *       "UserPromptSubmit": [{ "hooks": [{ "type": "command",
 *         "command": "node \"D:/.../integrations/dsh-hooks/recallflow-panel-hook.mjs\"" }] }],
 *       "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "...同上..." }] }],
 *       "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "...同上..." }] }]
 *     }
 *   }
 *
 * 从 stdin 读入 DSH 传来的 JSON，映射成面板事件并 POST 给桥接服务端（/event）。
 *
 * 三条刻意的设计：
 * 1. **永不阻塞 DSH**：hook 失败一律静默退出（exit 0）。一个"显示同步"的副作用
 *    不该把用户的 agent 卡住或让它报错。
 * 2. **跳过 mcp__* 工具**：RecallFlow 自己的 MCP 工具已由服务端以更细的粒度上报过，
 *    这里再报一遍会让面板把同一次调用画两遍。
 * 3. **不猜助手的话**：DSH 的 hook 载荷里没有助手成文回答（transcript_path 为空串），
 *    所以这里不假装能拿到。要同步助手的话需要 DSH 原生插件。
 */

const PORT = Number(process.env.RECALLFLOW_MCP_PORT) || 7801;
const TOKEN = process.env.RECALLFLOW_BRIDGE_TOKEN || 'recallflow-local-bridge-v1';

/** 把 DSH hook 载荷映射为面板事件；返回 null 表示"这次没什么可显示的"。 */
export function toPanelEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const event = String(payload.hook_event_name || '');
  if (event === 'UserPromptSubmit') {
    const text = String(payload.prompt || '').trim();
    if (!text) return null;
    return { text, level: 'info', who: 'user' };
  }
  if (event === 'PreToolUse' || event === 'PostToolUse') {
    const tool = String(payload.tool_name || '').trim();
    if (!tool) return null;
    // RecallFlow 的 MCP 工具已由服务端上报，跳过以免重复
    if (tool.startsWith('mcp__')) return null;
    if (event === 'PreToolUse') return { kind: 'tool', phase: 'start', tool, args: payload.tool_input || {} };
    return { kind: 'tool', phase: 'end', tool, ok: true, ms: 0 };
  }
  // SessionStart / Stop / Subagent* 在载荷里没有可显示的文本，不产出事件。
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = null;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    return; // 载荷不是 JSON：不猜、不报错
  }
  const ev = toPanelEvent(payload);
  if (!ev) return;
  try {
    await fetch('http://127.0.0.1:' + PORT + '/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-RecallFlow-Token': TOKEN },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(2000),
    });
  } catch (e) {
    // 桥接没起来 / 端口不通：静默。绝不让"显示同步"影响 agent 运行。
  }
}

// 仅在被直接执行时跑；被测试 import 时不读 stdin。
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().finally(() => {
    process.exitCode = 0; // 永远成功退出，不阻塞 DSH
  });
}
