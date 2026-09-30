// 验证 DSH 原生插件（方案 B）的端到端逻辑：不加载进 DSH 也能验的部分。
//
// 做法：用假的 Cordis context 调 apply()，把监听器抓出来，喂**真实的会话事件形状**
// （照 dsh-session 的类型声明写），再确认这些事件真的经 /event 落到桥接队列里。
//
// 覆盖不到的一步：DSH 的 loader 能否解析并挂载这个包 —— 那需要重启 DSH。
// 这里如实标注，不假装验证过。
const PORT = process.env.RECALLFLOW_MCP_PORT || '7802';
const BASE = 'http://127.0.0.1:' + PORT;
const H = { 'X-RecallFlow-Token': 'recallflow-local-bridge-v1' };

const { apply } = await import('../integrations/dsh-plugin-recallflow/index.js');

// 假 ctx：只实现 ctx.on，把监听器存下来
const listeners = new Map();
const ctx = {
  on(type, fn) {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  },
};
const emit = (type, session, event) => {
  for (const fn of listeners.get(type) || []) fn(session, event);
};

apply(ctx, { port: Number(PORT), timeoutMs: 1500 });

const drain = async () => {
  const r = await fetch(BASE + '/poll', { headers: H });
  return (await r.json()).events || [];
};

await drain(); // 清空历史

const session = { id: 'session-abcdef12-3456' };

// 会话开始
emit('session/created', session);

// 用户提问
emit('session/event', session, {
  type: 'user/message',
  data: { role: 'user', content: [{ type: 'text', text: '这个页面为什么有报错' }] },
});

// 助手回答（**方案 B 的关键**：hook 拿不到这段）
emit('session/event', session, {
  type: 'assistant/message',
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: '内部思考，不应显示' },
        { type: 'text', text: '有两个错误：一个来自页面本身，一个来自广告脚本。' },
      ],
    },
    stream: [],
  },
});

// 一个普通工具调用（应上报）
emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'Bash', arguments: '{"command":"git status"}' } });
// 一个 RecallFlow MCP 工具调用（应跳过，避免与 MCP 服务端重复）
emit('session/event', session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c2', name: 'mcp__recallflow__read_console', arguments: '{}' } });
// 工具失败（应上报一行错误）
emit('session/event', session, { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', isError: true, content: [] }, error: { name: 'E', code: 'ENOENT', reason: '找不到文件' } } });

// 系统注入的运行时上下文（**真实样本**：DSH 会把它也作为 user/message 投递）。
// 必须被挡住 —— 否则面板上会出现「👤 你在 DSH：Current runtime context…」这种用户没说过的话。
emit('session/event', session, {
  type: 'user/message',
  data: {
    role: 'user',
    source: { kind: 'runtime-context' },
    content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
  },
});

// 助手的**长**回答：验证截断额度确实从 400 放宽了（面板侧曾只留 400 字，把回答砍成残句）。
const LONG = '长回答内容'.repeat(400); // 2000 字
emit('session/event', session, {
  type: 'assistant/message',
  data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: LONG }] }, stream: [] },
});

await new Promise((r) => setTimeout(r, 600));
const events = await drain();

console.log('取到 ' + events.length + ' 条事件：');
for (const e of events) console.log('  ' + JSON.stringify(e));

const sayDsh = events.find((e) => e.kind === 'say' && e.who === 'dsh' && e.text.includes('广告脚本'));
const sayUser = events.find((e) => e.kind === 'say' && e.who === 'user');
const start = events.find((e) => e.kind === 'tool' && e.phase === 'start');
const fail = events.find((e) => e.kind === 'tool' && e.phase === 'end' && e.ok === false);
const mcp = events.filter((e) => e.tool && String(e.tool).startsWith('mcp__'));
const longEv = events.find((e) => e.kind === 'say' && e.text && e.text.startsWith('长回答内容'));

const checks = [
  ['会话开始有开场事件', events.some((e) => e.kind === 'say' && e.text.includes('会话已开始'))],
  ['用户消息 who=user', Boolean(sayUser) && sayUser.text.includes('为什么有报错')],
  ['**助手成文回答已同步**（hook 做不到的那部分）', Boolean(sayDsh)],
  ['reasoning 块未被显示', !events.some((e) => e.text && e.text.includes('内部思考'))],
  ['普通工具调用已上报', Boolean(start) && start.tool === 'Bash'],
  ['工具失败上报为一行错误且带工具名', Boolean(fail) && fail.tool === 'Bash' && fail.error === '找不到文件'],
  ['mcp__* 工具被跳过（不与 MCP 服务端重复）', mcp.length === 0],
  // ① 的集成验证：真实样本喂进来，必须一条都不产出
  [
    '① 系统注入的运行时上下文被挡住（不显示成"用户说的话"）',
    !events.some((e) => e.text && e.text.includes('Current runtime context')),
  ],
  // ② 的集成验证：走完整管线（插件 → /event → 队列）后，长回答仍保留到新额度
  [
    '② 助手长回答按新额度保留（>400 且 ≤2000，不是旧的 400 一刀切）',
    Boolean(longEv) && longEv.text.length > 400 && longEv.text.length <= 2001,
  ],
  ['事件总数符合预期（1 开场 + 1 用户 + 2 助手 + 1 工具 + 1 失败 = 6）', events.length === 6],
];

console.log('\n--- 结论 ---');
let allOk = true;
for (const [label, ok] of checks) {
  if (!ok) allOk = false;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + label);
}
console.log('\n未覆盖：DSH 的 loader 能否解析并挂载本包。');
console.log('  （后来用「隔离的 dsh headless + 只含本插件的 --patch」补验过一次：装载自报事件出现了，');
console.log('   说明能装载；但那不是这个脚本覆盖的，所以这里仍如实标注。）');
process.exitCode = allOk ? 0 : 1;
