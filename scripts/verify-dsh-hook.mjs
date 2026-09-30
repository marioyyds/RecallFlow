// 验证 DSH hook → 面板事件 的真实链路（用 node 客户端，避免 PowerShell 的编码干扰）。
//
// 为什么单独做这一步：第一次用 PowerShell 的 Invoke-RestMethod 取回时中文显示成乱码，
// 但那可能只是 PowerShell 的解码问题、也可能是数据真的坏了。**必须区分**：
// 前者是工具问题，后者是 bug。node 的 fetch 会正确按 UTF-8 解码，用它来判定。
import { spawnSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:' + (process.env.RECALLFLOW_MCP_PORT || '7802');
const H = { 'X-RecallFlow-Token': 'recallflow-local-bridge-v1' };
const HOOK = 'integrations/dsh-hooks/recallflow-panel-hook.mjs';

const drain = async () => {
  const r = await fetch(BASE + '/poll', { headers: H });
  return (await r.json()).events || [];
};

// 用 spawnSync 明确以 UTF-8 传输 stdin —— 绕开 PowerShell 对管道编码的处理
function runHook(payload) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
  return { code: r.status, stderr: r.stderr };
}

await drain();
const results = [];
results.push(['UserPromptSubmit', runHook({ hook_event_name: 'UserPromptSubmit', prompt: '帮我看下这个页面的报错' })]);
results.push(['PreToolUse Bash', runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } })]);
results.push(['PreToolUse mcp__*', runHook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__recallflow__read_console', tool_input: {} })]);
results.push(['Stop', runHook({ hook_event_name: 'Stop', stop_hook_active: false })]);

for (const [name, r] of results) {
  console.log('  ' + name + ' → 退出码 ' + r.code + (r.stderr ? '  stderr=' + r.stderr.trim().slice(0, 80) : ''));
}

await new Promise((r) => setTimeout(r, 500));
const events = await drain();
console.log('\n取到事件 ' + events.length + ' 条：');
for (const e of events) console.log('  ' + JSON.stringify(e));

const say = events.find((e) => e.kind === 'say');
const tool = events.find((e) => e.kind === 'tool');

const checks = [
  ['所有 hook 都以 0 退出（绝不阻塞 DSH）', results.every(([, r]) => r.code === 0)],
  ['只产出 2 条事件（mcp__* 与 Stop 都不产出）', events.length === 2],
  ['中文原样无损（不是乱码）', Boolean(say) && say.text === '帮我看下这个页面的报错'],
  ['用户提示词 who=user', Boolean(say) && say.who === 'user'],
  ['工具事件 tool=Bash 且带参数', Boolean(tool) && tool.tool === 'Bash' && String(tool.args).includes('git status')],
  ['来自外部提交（source=external）', Boolean(say) && say.source === 'external'],
];

console.log('\n--- 结论 ---');
let allOk = true;
for (const [label, ok] of checks) {
  if (!ok) allOk = false;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label);
}
process.exitCode = allOk ? 0 : 1;
