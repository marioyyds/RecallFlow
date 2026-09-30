// 反向链路的手工探针：往桥接塞一个回合、再读回来。
//
// 为什么要脚本而不是 curl：在 **PowerShell 5.1** 里把 JSON 传给 curl.exe 会被重引用，
// 实测 `-d '{"role":"user","text":"…"}'` 与 `-d "{\"role\":…}"` 两种写法都失败
// （服务端收到后返回 {"ok":false}，因为 text 没能解析成非空字符串）。
// 与其在文档里留一条跑不通的命令，不如给一个不经过 shell 引号的探针。
//
// 用途：把反向链路切成两段排查 ——
//   本脚本通 = 桥接的读写端没问题 → 若 DSH 仍读不到面板对话，问题就在"扩展那一跳"。
//
// 用法：
//   node scripts/probe-panel-turns.mjs                      # 塞一条 + 读回
//   node scripts/probe-panel-turns.mjs --read               # 只读
//   node scripts/probe-panel-turns.mjs --text "自定义内容"   # 塞自定义内容
const PORT = Number(process.env.RECALLFLOW_MCP_PORT || 7801);
const TOKEN = process.env.RECALLFLOW_BRIDGE_TOKEN || 'recallflow-local-bridge-v1';
const BASE = 'http://127.0.0.1:' + PORT;
const H = { 'X-RecallFlow-Token': TOKEN, 'Content-Type': 'application/json' };

const argv = process.argv.slice(2);
const readOnly = argv.includes('--read');
const ti = argv.indexOf('--text');
const text = ti >= 0 && argv[ti + 1] ? argv[ti + 1] : '探针塞入的一句（' + new Date().toTimeString().slice(0, 8) + '）';

async function get(path) {
  const r = await fetch(BASE + path, { headers: H });
  return { status: r.status, body: await r.text() };
}

console.log('桥接: ' + BASE);

// 先看版本：旧代码没有 /panel-turns 读端
const probe = await get('/panel-turns?limit=1').catch((e) => ({ status: 0, body: String(e.message) }));
if (probe.status === 404) {
  console.log('  ✗ /panel-turns 返回 404 —— 桥接跑的是**旧代码**，需先重启桥接（它没有反向通道）。');
  process.exitCode = 2;
} else if (probe.status !== 200) {
  console.log('  ✗ 读端状态 ' + probe.status + '：' + probe.body.slice(0, 200));
  console.log('    （桥接没起来？或 token 不对？）');
  process.exitCode = 1;
} else {
  if (!readOnly) {
    const r = await fetch(BASE + '/panel-turns', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ role: 'user', text, pageUrl: '(探针)', pageTitle: '(探针)' }),
    });
    console.log('  写入 ' + JSON.stringify(text) + ' → ' + r.status + ' ' + (await r.text()));
  }
  const after = await get('/panel-turns?limit=5');
  let data = {};
  try {
    data = JSON.parse(after.body);
  } catch (e) {}
  console.log('  读回 total=' + (data.total || 0) + '：');
  for (const t of data.turns || []) console.log('    [' + t.role + '] ' + String(t.text).slice(0, 60));
  const seen = (data.turns || []).some((t) => t.text === text);
  if (!readOnly) {
    console.log(seen ? '  ✓ 写入的回合能原样读回（中文无损）' : '  ✗ 写入的回合没读回来');
    process.exitCode = seen ? 0 : 1;
  }
  console.log('');
  console.log('  说明：这一段通了，就说明桥接读写端没问题。若 DSH 仍读不到面板对话，');
  console.log('  问题只在「扩展那一跳」（面板 → 后台 → POST /panel-turns），先重载扩展。');
}
