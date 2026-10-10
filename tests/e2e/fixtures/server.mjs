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

// 下单页：一个有代表性的"多步表单"页面。
//
// 为什么不能用检索页那种单个输入框凑：点单真正的难点是**步骤之间有依赖、且有业务校验**：
//   ① 控件类型多（select / 文本 / checkbox / 按钮），四种走**不同的工具与定位方式**；
//   ② **勾选「我已确认」是承重的** —— 不勾就提交，页面只回「请补全信息」，不会下单。
//      于是 check_box 一坏，这条用例必红（这正是它比"填个框"值钱的地方）；
//   ③ 下单结果**异步出现**，且只有真正成功才渲染摘要。
// 页面显式写了 role / aria-label：语义定位需要它（与检索页同一个前提）。
function checkoutPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具下单页</title></head>
<body>
  <h1>下单</h1>
  <label for="product">商品</label>
  <select id="product" role="combobox" aria-label="商品">
    <option value="">请选择商品</option>
    <option value="coffee-a">哥伦比亚 慧兰</option>
    <option value="coffee-b">埃塞俄比亚 耶加雪菲</option>
  </select>

  <label for="qty">数量</label>
  <input id="qty" role="textbox" aria-label="数量" value="1">

  <label for="addr">收货地址</label>
  <input id="addr" role="textbox" aria-label="收货地址">

  <label for="agree"><input type="checkbox" id="agree" role="checkbox" aria-label="我已确认订单信息"> 我已确认订单信息</label>

  <button id="submit" type="button" role="button" aria-label="提交订单">提交订单</button>
  <div id="done" role="status"></div>
  <script>
    window.__submits = 0;    // 提交了几次（业务校验失败也会 +1）
    window.__order = null;   // 真正下单时页面收到的数据
    document.getElementById('submit').addEventListener('click', function () {
      window.__submits += 1;
      var o = {
        product: document.getElementById('product').value,
        qty: document.getElementById('qty').value,
        addr: document.getElementById('addr').value,
        agree: document.getElementById('agree').checked,
      };
      if (!o.product || !o.addr || !o.agree) {
        // 刻意**不**调用任何工具、也不下单：真实站点的表单校验就是这样，
        // 模型必须能从页面反馈里看出"还差什么"。
        document.getElementById('done').textContent = '请补全信息（商品 / 收货地址 / 确认勾选都必填）';
        return;
      }
      window.__order = o;
      setTimeout(function () {
        document.getElementById('done').textContent =
          '下单成功：' + o.product + ' × ' + o.qty + '，寄往 ' + o.addr;
      }, 120);
    });
  </script>
</body></html>`;
}

// 文章页：一个**刻意难读**的页面，用来做"可读性美化"。
//
// 难点不在"改一个属性"，而在**美化与搞坏的分界**：
//   · 字号 11px、行高 1（挤成一团）、正文 #c9c9c9 on #fff（对比度约 1.6，远低于 4.5）；
//   · 容器宽 1500px → **横向溢出**（在窄窗口里必须左右拖才能读）；
//   · 于是"把它变得好读"可以用很多手法，其中有些是**作弊**：
//     把正文 display:none 掉、或删掉几段 —— 那样对比度/溢出全都"达标"了，但内容没了。
//
// 所以页面自带一个测量器 `window.__readability()`，并记下**改动前的正文字数**：
// 断言里必须同时检查"指标达标"与"内容没少" —— 后者才是美化与搞坏的分界。
function articlePage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具文章页</title>
<style>
  /* 全部刻意做差：小字号、行高 1、低对比、超宽容器 */
  body { margin: 0; font-family: system-ui; font-size: 11px; line-height: 1; color: #c9c9c9; background: #ffffff; }
  h1 { font-size: 12px; margin: 0; }
  p { margin: 0; }
  .wrap { width: 1500px; }
</style>
</head>
<body>
  <div class="wrap" id="article">
    <h1>为什么行高与对比度比字体更影响可读性</h1>
    <p>正文的易读性主要由三件事决定：字号、行高、以及前景与背景的对比度。三者之中，行高的影响往往被低估——行与行贴得太近时，眼睛在换行时容易串行，阅读速度会明显下降。</p>
    <p>对比度同样关键。浅灰文字放在白底上看似“高级”，但对比度低于 4.5:1 时，在户外或低亮度屏幕上几乎无法辨认。可访问性指南把 4.5:1 作为正文的最低要求，并非苛刻，而是来自大量实测。</p>
    <p>最后是宽度。一行文字过长会让视线难以准确定位到下一行的开头，于是读者反复回扫。把正文容器限制在 60 到 80 个字符宽，通常能显著改善长文的阅读体验。</p>
  </div>
  <script>
    function lum(c) {
      var m = String(c).match(/\\d+(\\.\\d+)?/g) || [0, 0, 0];
      var f = function (v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(+m[0]) + 0.7152 * f(+m[1]) + 0.0722 * f(+m[2]);
    }
    // 有效背景色：**必须向上找**，因为元素自身的 background-color 默认是 transparent。
    // 直接用元素的 backgroundColor 会解析成 rgba(0,0,0,0) → 当成黑色 →
    // 与深色文字算出的对比度接近 1:1，于是"改好了"被误判为没改好（实测踩过）。
    function effBg(el) {
      var n = el;
      while (n && n.nodeType === 1) {
        var c = getComputedStyle(n).backgroundColor;
        if (c && c !== 'transparent' && !/rgba\\(0,\\s*0,\\s*0,\\s*0\\)/.test(c)) return c;
        n = n.parentElement;
      }
      return 'rgb(255,255,255)';
    }
    window.__readability = function () {
      var el = document.querySelector('.wrap');
      var cs = getComputedStyle(el);
      var fs = parseFloat(cs.fontSize) || 0;
      var lh = cs.lineHeight === 'normal' ? 1.2 : (parseFloat(cs.lineHeight) || 0) / (fs || 1);
      var a = lum(cs.color), b = lum(effBg(el));
      var hi = Math.max(a, b), lo = Math.min(a, b);
      return {
        fontSize: fs,
        lineHeightRatio: Math.round(lh * 100) / 100,
        contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
        hOverflow: document.documentElement.scrollWidth - window.innerWidth,
        textLength: (el.innerText || '').replace(/\\s+/g, '').length,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && el.offsetHeight > 0,
      };
    };
    // 改动前的正文字数：用来断言"美化没有靠删内容达成"
    window.__textBefore = window.__readability().textLength;
  </script>
</body></html>`;
}

function framePage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具框架</title></head>
<body><button id="fb" role="button">框架按钮</button>
<script>window.__frameClicked = false; document.getElementById('fb').addEventListener('click', () => { window.__frameClicked = true; });</script>
</body></html>`;
}

/** 回一个"调用某个工具"的步骤（脚本化剧本的基本单位）。 */
function toolStep(res, name, args) {
  sse(res, [toolCallDelta(name, args), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
}
/** 回一段最终文本（本步之后这一轮就结束了）。 */
function finalText(res, text, tokens) {
  sse(res, [
    textDelta(text),
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { usage: { total_tokens: tokens || 40 } },
  ]);
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
/** 把**当前记录周期内**所有请求里的 tool 消息文本拼起来 —— 断言"模型看到过什么"用这个。
 *
 *  为什么不是"只看最后一次请求"（曾经的写法）：一轮跑完后通常还有一次校验/收尾请求，
 *  它**没有** tool 消息 —— 于是"只看最后一次"会读到空串，断言随执行时序时好时坏。
 *  实测踩过一次：同一条用例第一次过、第二次挂在 `Received string: ""`。
 *  跨用例隔离靠调用方在每个用例开始前 `resetLlmRequests()`。 */
export function toolResultsText() {
  return llmRequests
    .flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool'))
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
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 1) { toolStep(res, 'type_text', { role: 'textbox', name: '站内搜索', value: '咖啡' }); return; }
      if (done === 2) { toolStep(res, 'click_element', { role: 'button', name: '搜索' }); return; }
      if (done === 3) { toolStep(res, 'inspect_element', { op: 'text', selector: '#results' }); return; }
      finalText(
        res,
        '已取回结果：哥伦比亚 慧兰 水洗 ￥88；埃塞俄比亚 耶加雪菲 ￥108；云南 小粒咖啡 ￥68。',
        60
      );
      return;
    }

    // 剧本：点单 / 多步表单（playbook id = 'checkout-form'，6 轮）。
    //
    // 与检索剧本的区别在于**步骤之间有依赖，而且有业务校验**：
    // 商品+数量+地址+勾选缺一样，页面就只回「请补全信息」、根本不下单。
    // 所以最后两轮（提交流程 + 读结果）才是真正的判据 —— 只看"点过提交"是假证据。
    if (userText.includes(PLAYBOOKS['checkout-form'].trigger)) {
      const done = toolResults.length;
      // 工具集与 fixtures/playbooks.mjs 的 'checkout-form' 对齐（契约门禁保证不漂移）。
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 1) { toolStep(res, 'select_option', { selector: '#product', label: '埃塞俄比亚 耶加雪菲' }); return; }
      if (done === 2) { toolStep(res, 'type_text', { role: 'textbox', name: '数量', value: '2', clearFirst: true }); return; }
      if (done === 3) { toolStep(res, 'type_text', { role: 'textbox', name: '收货地址', value: '上海市浦东新区 1 号', clearFirst: true }); return; }
      // 承重的一步：不勾选，页面就只回「请补全信息」，不会下单。
      if (done === 4) { toolStep(res, 'check_box', { role: 'checkbox', name: '我已确认订单信息', checked: true }); return; }
      if (done === 5) { toolStep(res, 'click_element', { role: 'button', name: '提交订单' }); return; }
      if (done === 6) { toolStep(res, 'inspect_element', { op: 'text', selector: '#done' }); return; }
      finalText(res, '已下单：埃塞俄比亚 耶加雪菲 × 2，寄往上海市浦东新区 1 号。', 70);
      return;
    }

    // 剧本：UI 美化 / 可读性（playbook id = 'readability-fix'）。
    //
    // 难点是**美化与搞坏的分界**：把正文隐藏掉也能让"对比度达标"，删几段也能让"不溢出"。
    // 所以剧本必须**真的改样式**（两次 annotate，分别改排版与容器宽度），
    // 并且**读回计算后的值**才算验证过。
    //
    // ⚠ 最后一步用 run_javascript 读 getComputedStyle，是因为面板 agent 目前**没有**
    //   专门的"读计算样式"入口（`verify_change` 只对 MCP 侧开放，`inspect_element` 的
    //   op 只有 inspect/text/table，`annotate` 只回一句摘要）。这是本轮发现的能力缺口。
    if (userText.includes(PLAYBOOKS['readability-fix'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 1) {
        toolStep(res, 'annotate', {
          op: 'style',
          selector: 'body',
          styles: { fontSize: '17px', lineHeight: '1.7', color: '#1a1a1a', background: '#ffffff' },
        });
        return;
      }
      if (done === 2) {
        // 修横向溢出：把固定 1500px 宽改成自适应 + 上限，这才是"可读"的宽度
        toolStep(res, 'annotate', { op: 'style', selector: '.wrap', styles: { width: 'auto', maxWidth: '760px' } });
        return;
      }
      if (done === 3) {
        // 读回**计算后的**样式来取证。
        // 这里刻意用 `inspect_element({op:"styles"})` 而不是 run_javascript：
        // 后者是 alwaysRequireApproval（每次打断用户）且会因页面 CSP 直接失败 ——
        // 本轮做美化能力时正是踩到这一点，才补出了 styles 这一档（见 commands.js 的 cmdReadStyles）。
        toolStep(res, 'inspect_element', {
          op: 'styles',
          selector: '.wrap',
          props: ['font-size', 'line-height', 'color', 'max-width', 'overflow-x'],
        });
        return;
      }
      finalText(res, '已把正文调成 17px / 行高 1.7 / 深色文字，并把容器宽度限制到 760px，横向溢出已消除。', 80);
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
        : req.url && req.url.startsWith('/checkout') ? checkoutPage()
          : req.url && req.url.startsWith('/article') ? articlePage()
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
