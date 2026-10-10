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

// 坐标页：单独一份页面，专门给 CDP 坐标点击用。
// 为什么不让它和主站共用一页：第一版把固定定位的 #hit 加进主站后，
// 「role+name 点击提交」那条黄金任务开始失败（点击本身没问题，但没生效）。
// 为把变量降到最少，坐标目标独立成页 —— 黄金任务的夹具保持原样不动。
function coordPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具坐标页</title></head>
<body>
  <!-- 固定定位在 (20,300)，尺寸 200x60 → 中心恒为 (120,330)，坐标可预测。 -->
  <div id="hit" style="position:fixed;left:20px;top:300px;width:200px;height:60px;background:#ddd">坐标目标</div>
  <script>
    window.__hitBy = '';
    ['mousedown', 'click'].forEach((t) => {
      document.getElementById('hit').addEventListener(t, (e) => { window.__hitBy = t + ':' + Math.round(e.clientX) + ',' + Math.round(e.clientY); });
    });
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
  // 可选的「慢速流」模式：分片之间加延迟，从而**真实存在一个生成中的窗口**。
  // 为什么必须要有它：默认模拟 LLM 是瞬间返回的，整个 agent run 在几十毫秒内跑完 ——
  // 于是"在生成中断线"这个场景根本无从构造（实测：等到 .typing 出现时任务早已结束）。
  // 只有把流拉长，才能验证"中断后能否恢复"这类与时机相关的行为。
  const chunkDelayMs = Number(process.env.E2E_LLM_CHUNK_DELAY_MS) || 0;
  if (!chunkDelayMs) {
    for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  let i = 0;
  const timer = setInterval(() => {
    if (i < chunks.length) {
      res.write('data: ' + JSON.stringify(chunks[i]) + '\n\n');
      i += 1;
      return;
    }
    clearInterval(timer);
    res.write('data: [DONE]\n\n');
    res.end();
  }, chunkDelayMs);
  res.on('close', () => clearInterval(timer));
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

// 计数器必须在请求处理之外：它要跨多次 LLM 请求累计，
// 用来区分"被中断的那一次"（第一次，挂起）与"重连后的那一次"（第二次，正常返回）。
let holdOpenRunCount = 0;

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

    // 慢速流模式下的**确定性挂起**：只发第一个分片，然后一直挂着不结束。
    // 为什么需要它：默认模拟流瞬间结束，"在生成中断开"这类测试只能靠 sleep 抢时机，
    // 而实测那样会时好时坏（run 约 600ms 完成，400ms 的 sleep 竞争不过抖动）。
    // 挂起后，测试可以确定地在"流已开始、尚未结束"的时刻断开端口。
    //
    // **只挂起第一次**：挂起的目的是制造"被中断的那一次"；
    // 重连后的第二次必须正常返回，否则任务永远跑不完、也就无法验证"恢复后能接着完成"。
    const holdOpen = /^(1|true|yes)$/i.test(String(process.env.E2E_LLM_HOLD_OPEN || ''));
    if (holdOpen && !isRouter && !isVerifier && payload.stream !== false) {
      holdOpenRunCount += 1;
      if (holdOpenRunCount === 1) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        // 先给一个可见增量，确保"首个 token 已到"，前端进入流式状态
        res.write('data: ' + JSON.stringify(textDelta('正在处理…')) + '\n\n');
        // 之后**不结束**，等客户端断开（端口/请求被取消）
        res.on('close', () => { try { res.end(); } catch (e) {} });
        return;
      }
    }

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

    // 场景 C：审批拒绝 —— 用户明确不批准写操作。
    // 断言点是「按钮**没有**被点击」，即审批真的拦住了副作用（而不是只弹了个框）。
    // 与场景 B 共用同一次 click_element 调用，区别只在设置里关掉了 commands 类别的自动批准。
    if (userText.includes('不要批准') || userText.includes('审批拒绝')) {
      if (!toolResults.length) {
        sse(res, [toolCallDelta('click_element', { role: 'button', name: '提交' }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
      } else {
        sse(res, [textDelta('未获批准，已放弃该操作。'), { choices: [{ delta: {}, finish_reason: 'stop' }] }, { usage: { total_tokens: 42 } }]);
      }
      return;
    }

    // 场景 D：输入文本 —— 覆盖 type_text 的 value（负载）语义。
    // 为什么单独测：`text` 曾经既是"定位片段"又是"输入内容"，导致"在含某文本的元素里输入"
    // 在实现上不可能成立。拆成 value/text 之后，这条路径只有单测覆盖参数形状，
    // 没有人验证过"文字真的进了输入框、且没污染定位"。
    if (userText.includes('输入')) {
      if (!toolResults.length) {
        // 用 text 定位（输入框旁的 label/占位文本）+ value 作为负载
        sse(res, [toolCallDelta('type_text', { selector: '#q', value: 'hello-e2e', clearFirst: true }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
      } else {
        sse(res, [textDelta('已输入。'), { choices: [{ delta: {}, finish_reason: 'stop' }] }, { usage: { total_tokens: 42 } }]);
      }
      return;
    }

    // 场景 E：CDP 可信输入（坐标点击）。
    // 为什么必须有：`cdpEnabled` 此前在所有 E2E 里都是 false，于是**旗舰能力
    //（chrome.debugger 派发可信事件、可操作 canvas/虚拟列表）从未被端到端验证过**。
    // 这里用固定定位元素让坐标可预测，再用 click_at 走 CDP 路径。
    if (userText.includes('坐标')) {
      if (!toolResults.length) {
        sse(res, [toolCallDelta('click_at', { x: 120, y: 330 }), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
      } else {
        sse(res, [textDelta('已按坐标点击。'), { choices: [{ delta: {}, finish_reason: 'stop' }] }, { usage: { total_tokens: 42 } }]);
      }
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
  res.end(req.url && req.url.startsWith('/coord') ? coordPage() : mainPage());
});
const frame = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(framePage());
});

export function startServers() {
  holdOpenRunCount = 0;
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
