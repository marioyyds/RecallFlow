// E2E 夹具服务：
// - 主站（7802）：包含按钮/输入框 + 一个跨域 iframe。
// - 框架站（7803）：跨域 iframe 内容。
// - 模拟 LLM（7804）：OpenAI 兼容，按脚本返回 tool_calls / 文本，供 Agent 端到端测试。
import http from 'node:http';

const MAIN_PORT = 7802;
const FRAME_PORT = 7803;
const LLM_PORT = 7804;

function mainPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具主站</title></head>
<body>
  <h1>Fixture</h1>
  <button id="submit" role="button">提交</button>
  <input id="q" name="q" placeholder="搜索">
  <iframe id="f" src="http://localhost:${FRAME_PORT}/frame" width="300" height="120"></iframe>
  <script>
    window.__clicked = false;
    document.getElementById('submit').addEventListener('click', () => { window.__clicked = true; document.title = '已提交'; });
  </script>
</body></html>`;
}

function framePage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具框架</title></head>
<body><button id="fb" role="button">框架按钮</button>
<script>window.__frameClicked = false; document.getElementById('fb').addEventListener('click', () => { window.__frameClicked = true; });</script>
</body></html>`;
}

function sse(res, chunks) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

function textDelta(content) {
  return { choices: [{ delta: { content } }] };
}
function toolCallDelta(name, args) {
  return {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: 'call_' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  };
}

// 从工具结果里解析跨域 iframe 元素的 ref（f<frameId>:rf-N）——模拟真实模型「读快照后据此点击」。
function extractFrameRef(toolResults, label) {
  for (const m of toolResults) {
    const content = typeof m.content === 'string' ? m.content : '';
    const re = new RegExp('"ref":"(f\\d+:rf-\\d+)"[^}]*?"label":"' + label + '"');
    const hit = content.match(re);
    if (hit) return hit[1];
  }
  return null;
}

const llm = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (e) {}
    const messages = payload.messages || [];
    const system = messages.find((m) => m.role === 'system');
    const sys = system && typeof system.content === 'string' ? system.content : '';
    const isRouter = sys.includes('意图路由器');
    const isVerifier = sys.includes('任务校验器');

    // 意图路由 / 校验 / 非流式
    if (isRouter || isVerifier || payload.stream === false) {
      const content = isRouter
        ? '{"intent":"browser","confidence":0.95,"reason":"e2e"}'
        : isVerifier
          ? '{"ok":true,"confidence":0.9,"reason":"e2e"}'
          : 'ok';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { total_tokens: 5 } }));
      return;
    }

    const userMsg = [...messages].reverse().find((m) => m.role === 'user');
    const userText = userMsg && typeof userMsg.content === 'string' ? userMsg.content : '';
    const toolResults = messages.filter((m) => m.role === 'tool');
    const clicked = toolResults.some((m) => typeof m.content === 'string' && m.content.includes('已点击'));

    // 场景 A：跨域 iframe —— 先合并读快照，再按 f<frameId>: 前缀 ref 点击框架内按钮。
    if (userText.includes('框架')) {
      if (!toolResults.length) {
        sse(res, [toolCallDelta('get_page_snapshot', { includeFrames: true, maxElements: 40, maxText: 300 }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
        return;
      }
      const ref = extractFrameRef(toolResults, '框架按钮');
      if (ref && !clicked) {
        sse(res, [toolCallDelta('click_element', { ref }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
        return;
      }
      sse(res, [textDelta('已点击框架内按钮。'), { choices: [{ delta: {}, finish_reason: 'stop' }] }, { usage: { total_tokens: 42 } }]);
      return;
    }

    // 场景 B：主站按钮（role+name 定位）
    if (!toolResults.length) {
      sse(res, [toolCallDelta('click_element', { role: 'button', name: '提交' }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
    } else {
      sse(res, [textDelta('已完成点击。'), { choices: [{ delta: {}, finish_reason: 'stop' }] }, { usage: { total_tokens: 42 } }]);
    }
  });
});

const main = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(mainPage());
});
const frame = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(framePage());
});

export function startServers() {
  return new Promise((resolve) => {
    let n = 0;
    const done = () => { if (++n === 3) resolve({ MAIN_PORT, FRAME_PORT, LLM_PORT }); };
    main.listen(MAIN_PORT, '127.0.0.1', done);
    frame.listen(FRAME_PORT, '127.0.0.1', done);
    llm.listen(LLM_PORT, '127.0.0.1', done);
  });
}

export function stopServers() {
  main.close();
  frame.close();
  llm.close();
}
