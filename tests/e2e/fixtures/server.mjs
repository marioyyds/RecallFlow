// E2E 夹具服务：
// - 主站（7802）：包含按钮/输入框 + 一个跨域 iframe。
// - 框架站（7803）：跨域 iframe 内容。
// - 模拟 LLM（7804）：OpenAI 兼容，按脚本返回 tool_calls / 文本，供 Agent 端到端测试。
import http from 'node:http';
import { PLAYBOOKS } from './playbooks.mjs';

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

// 站内检索页：一个有代表性的"搜索 + 结果列表"页面。
//
// 为什么不能只用主站那个输入框凑：检索这个能力类的难点**不在输入**，而在
//   ① 结果列表是**异步渲染**的（提交后才出现）→ 必须等；
//   ② 结果里混着**广告**（与"检索"是两种不同的判断）；
//   ③ 要**结构化取回**标题/价格，而不是把整页文本倒给模型。
// 页面刻意做成"点搜索才渲染"，就是为了让这三件事都能被测到。
function searchPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具站内搜索</title>
<style>
  #results .ad { opacity: .7; }
  .result-title { font-weight: 700; }
</style>
</head>
<body>
  <h1>站内搜索</h1>
  <!-- 刻意写成**规范可访问**的形态（显式 role + aria-label）：
       这是 role/name 定位能生效的前提，也是"好页面"该有的样子。
       实测：只靠 <label for> 关联、不写 role/aria-label 时，快照里的语义定位取不到它 ——
       所以坏页面必须回退到 CSS 选择器/文本定位（这条差异由技能文案交代）。 -->
  <label for="site-search">站内搜索</label>
  <input id="site-search" name="q" placeholder="搜点什么" role="textbox" aria-label="站内搜索">
  <button id="go" type="button" role="button" aria-label="搜索">搜索</button>
  <div id="empty">尚未检索。</div>
  <div id="results" role="list"></div>
  <script>
    // 固定数据集：标题与价格都是确定值，断言才能钉死。
    var DATA = [
      { id: 'r1', title: '哥伦比亚 慧兰 水洗', price: '￥88', ad: false },
      { id: 'r2', title: '埃塞俄比亚 耶加雪菲', price: '￥108', ad: false },
      { id: 'a1', title: '【广告】咖啡器具大促', price: '￥9.9', ad: true },
      { id: 'r3', title: '云南 小粒咖啡', price: '￥68', ad: false },
      { id: 'a2', title: '【广告】品牌旗舰店', price: '￥1', ad: true },
    ];
    window.__searched = 0;
    window.__renderedCount = 0;
    document.getElementById('go').addEventListener('click', function () {
      var q = document.getElementById('site-search').value;
      window.__searched += 1;
      window.__lastQuery = q;
      var box = document.getElementById('results');
      box.innerHTML = '';
      document.getElementById('empty').style.display = 'none';
      // 刻意异步：真实站点的结果都是请求回来才有的，同步渲染测不出"等待"这件事。
      setTimeout(function () {
        DATA.forEach(function (d) {
          var el = document.createElement('div');
          el.className = 'result' + (d.ad ? ' ad' : '');
          el.setAttribute('role', 'listitem');
          el.setAttribute('data-id', d.id);
          el.innerHTML = '<span class="result-title">' + d.title + '</span>' +
                         '<span class="result-price">' + d.price + '</span>';
          box.appendChild(el);
        });
        window.__renderedCount = box.children.length;
      }, 120);
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
// 思维链增量：只有推理模型（deepseek-reasoner）会发这个字段。
// 单独造一个 helper，是为了让「思考记录」这条路径能在**真实浏览器**里被验证 ——
// 单测只能证明代码接了线，证明不了面板上真的出现了一块可折叠的记录。
function reasoningDelta(content) {
  return { choices: [{ delta: { reasoning_content: content } }] };
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

// 记录**模型实际收到了什么**。
//
// 这是"能力验收"里最关键的一条证据来源：E2E 用的模拟模型是脚本化的，
// 所以"最终答复里写了什么"证明不了任何事（那句话是脚本写的）。
// 能证明的是：**工具结果里到底有没有把数据交到模型手上**。
// 把每次请求的 messages 记下来，spec 就能直接断言这件事。
const llmRequests = [];
export function getLlmRequests() {
  return llmRequests.slice();
}
export function resetLlmRequests() {
  llmRequests.length = 0;
}
/** 把最近一次请求里所有 tool 消息的文本拼起来 —— 断言"模型看到了什么"用这个。 */
export function lastToolResultsText() {
  const last = llmRequests[llmRequests.length - 1];
  if (!last) return '';
  return (last.messages || [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')))
    .join('\n');
}

// ---- 真模型 eval 模式 ----
// `E2E_LLM_REAL=1` 时，本服务不再返回脚本，而是把请求**原样转发**给真实端点并流式回传。
// 于是扩展面对的是一个真模型 —— **工具选择由模型自己决定**，这才是能验证
// "技能文案对模型有没有用"的唯一方式（脚本化剧本验证的是能力可用，不是文案有效）。
//
// 刻意与常规 E2E 用同一套夹具服务与同一套页面判据，**只换掉"谁在做决定"**：
// 否则"脚本下能过、真模型下不能过"就无法归因到底是能力问题还是文案问题。
const REAL = /^(1|true|yes)$/i.test(String(process.env.E2E_LLM_REAL || ''));
const REAL_BASE = process.env.E2E_LLM_REAL_BASE || 'https://api.deepseek.com';
const REAL_KEY = process.env.E2E_LLM_REAL_KEY || '';
const REAL_MODEL = process.env.E2E_LLM_REAL_MODEL || '';

async function proxyToRealModel(req, res, body, payload) {
  const upstream = await fetch(REAL_BASE.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + REAL_KEY },
    body: JSON.stringify(Object.assign({}, payload, REAL_MODEL ? { model: REAL_MODEL } : {})),
  });
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  if (!upstream.body) {
    res.end(await upstream.text());
    return;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

const llm = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch (e) {}
    const messages = payload.messages || [];
    // 记录每次请求（含 messages）——供 spec 断言"模型实际收到了什么"。
    // 只留最近 40 次，避免长任务把内存堆起来。
    llmRequests.push({ messages, at: Date.now() });
    if (llmRequests.length > 40) llmRequests.shift();

    // 真模型模式：原样转发，脚本一律不参与。
    if (REAL) {
      try {
        await proxyToRealModel(req, res, body, payload);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '代理到真实模型失败：' + e.message } }));
      }
      return;
    }
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

    // 场景 F：思考记录（思维链）。
    // 为什么需要：`reasoning_content` 是**推理模型独有**的字段，此前全仓库没有任何地方读它，
    // 于是「模型在思考时界面一片空白」这个问题既没被测过、也没被看见过。
    // 这里让模拟模型先吐思维链、再吐正文，用来验证面板真的渲染出可折叠的思考记录、
    // 并且在正文开始时自动收起。
    if (userText.includes('思考')) {
      // 刻意发**两段**思维链，中间夹着正文 —— 用来验证"穿插"而不是"聚成一个总块"：
      // 期望的面板结构是 思考块 → 正文 → 思考块 → 正文。
      sse(res, [
        reasoningDelta('先确认页面结构，'),
        reasoningDelta('再决定点击哪个按钮。'),
        textDelta('我想好了：结论如下。'),
        reasoningDelta('再复核一下边界情况。'),
        textDelta('补充一句。'),
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { usage: { total_tokens: 42 } },
      ]);
      return;
    }

    // 剧本：站内检索（playbook id = 'site-search'）。
    //
    // 这条与别的场景不同：它**故意跨 4 轮**，逐步做「看页面 → 填搜索框 → 点搜索 → 结构化读结果」。
    // 为什么不能一轮做完：检索这个能力类的难点不在"输入"，而在
    //   ① 结果列表是**点击之后异步渲染**的 → 工具必须等页面静定，
    //      否则下一轮 `inspect_element` 拿到的是空列表（这条剧本正好在验 settle 生效）；
    //   ② 要**结构化取回**条目，而不是把整页文本倒给模型。
    // 用的工具与 fixtures/playbooks.mjs 的 'site-search' 声明一致 —— 由契约门禁保证不漂移。
    if (userText.includes(PLAYBOOKS['site-search'].trigger)) {
      const done = toolResults.length;
      const next = (name, args) => {
        sse(res, [toolCallDelta(name, args), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
      };
      if (done === 0) { next('get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 1) { next('type_text', { role: 'textbox', name: '站内搜索', value: '咖啡' }); return; }
      if (done === 2) { next('click_element', { role: 'button', name: '搜索' }); return; }
      if (done === 3) { next('inspect_element', { op: 'text', selector: '#results' }); return; }
      sse(res, [
        textDelta('已取回结果：哥伦比亚 慧兰 水洗 ￥88；埃塞俄比亚 耶加雪菲 ￥108；云南 小粒咖啡 ￥68。'),
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { usage: { total_tokens: 60 } },
      ]);
      return;
    }

    // 场景 G：拾取元素后的追问。
    // 只回文本、**不调工具** —— 这条测的是"拾取信息有没有留在对话里"，
    // 不希望页面被工具动作改动（否则断言分不清是拾取还是点击造成的）。
    if (userText.includes('这是什么元素')) {
      sse(res, [textDelta('这是页面上的提交按钮。'), { choices: [{ delta: {}, finish_reason: 'stop' }] }, { usage: { total_tokens: 20 } }]);
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
  res.end(
    req.url && req.url.startsWith('/coord') ? coordPage()
      : req.url && req.url.startsWith('/search') ? searchPage()
        : mainPage()
  );
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
