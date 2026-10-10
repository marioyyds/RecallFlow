// E2E 夹具服务：
// - 主站（7802）：包含按钮/输入框 + 一个跨域 iframe。
// - 框架站（7803）：跨域 iframe 内容。
// - 模拟 LLM（7804）：OpenAI 兼容，按脚本返回 tool_calls / 文本，供 Agent 端到端测试。
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYBOOKS } from './playbooks.mjs';

// 上传夹具的绝对路径：`upload_file` 要的是真实本地路径（CDP 的 DOM.setFileInputFiles）。
// 剧本指令里用 {{UPLOAD_FILE}} 占位，由 tests/e2e/helpers.mjs 的 resolveInstruction 解析 ——
// 这里给脚本化剧本用同一份。
const SAMPLE_UPLOAD = fileURLToPath(new URL('./sample-upload.txt', import.meta.url));

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

// 排查页：一个**症状可见、原因只在运行时**的页面，用来做"debug"。
//
// 难点（也是这一类能力与"改样式"的根本差别）：
//   · **症状与原因不在同一处**：用户看到的是"点了按钮没反应"，
//     真正的原因是一条只在点击后出现的未捕获 TypeError；
//   · **必须先在页面上复现**才能拿到运行期事实 —— 光看 DOM 快照看不出任何异常；
//   · 报错信息是**浏览器生成的**（不是页面写的），所以断言要对着真实文案，
//     不能自己编一句"出错了"来自我满足。
// 页面记下 __clicks / __totalRendered，让"确实复现了、且确实没渲染出结果"可被断言。
function debugPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具排查页</title></head>
<body>
  <h1>订单合计</h1>
  <p>点击下面的按钮计算合计。</p>
  <button id="apply" type="button" role="button" aria-label="计算总价">计算总价</button>
  <div id="total" role="status"></div>
  <script>
    window.__clicks = 0;
    window.__totalRendered = false;
    document.getElementById('apply').addEventListener('click', function () {
      window.__clicks += 1;
      // 真实的 bug 形态：数据结构里没有 cart，却直接当下标用。
      // 于是抛未捕获 TypeError，后面的赋值永远执行不到 ——
      // 用户看到的就是"点了没反应"。
      var state = { items: [{ price: 10 }] };
      document.getElementById('total').textContent = '合计：' + state.cart.total;
      window.__totalRendered = true;
    });
  </script>
</body></html>`;
}

// 遮挡页：一个**必须先处理干扰才能干活**的页面。
//
// 难点是**顺序**，不是"能不能点"：
//   · 全屏遮罩（`position: fixed; inset: 0`）盖住正文，此时点输入框/按钮会被判定为**被遮挡** ——
//     这是真实站点最常见的干扰（Cookie 同意、活动弹窗、引导蒙层）；
//   · 干扰不处理掉，后面的动作根本做不成；而"先关了它"这件事**只有断言事件顺序才能验到**：
//     只看"搜索出结果了"无法区分"先关弹窗再搜"与"运气好点到了"。
// 所以页面把每一次关键动作记进 `window.__events`，让顺序可被钉死。
function blockedPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具遮挡页</title></head>
<body>
  <div id="mask" style="position:fixed;inset:0;background:rgba(20,20,30,.55);z-index:9999">
    <div id="modal" role="dialog" aria-label="隐私提示" style="position:absolute;left:50%;top:40%;transform:translate(-50%,-50%);background:#fff;padding:24px">
      <p>本站使用 Cookie 以改善体验</p>
      <button id="accept" type="button" role="button" aria-label="接受并关闭">接受</button>
    </div>
  </div>

  <h1>站内搜索</h1>
  <label for="q">搜索关键词</label>
  <input id="q" role="textbox" aria-label="搜索关键词">
  <button id="go" type="button" role="button" aria-label="搜索">搜索</button>
  <div id="results" role="list"></div>

  <script>
    window.__events = [];        // 关键动作的顺序（断言"先处理干扰"靠它）
    window.__modalClosed = false;
    window.__renderedCount = 0;
    document.getElementById('accept').addEventListener('click', function () {
      window.__events.push('modal-closed');
      window.__modalClosed = true;
      document.getElementById('mask').style.display = 'none';
    });
    document.getElementById('go').addEventListener('click', function () {
      window.__events.push('search-clicked');
      var q = document.getElementById('q').value;
      var box = document.getElementById('results');
      box.innerHTML = '';
      ['哥伦比亚 慧兰 ￥88', '埃塞俄比亚 耶加雪菲 ￥108', '云南 小粒咖啡 ￥68'].forEach(function (t) {
        var el = document.createElement('div');
        el.className = 'result';
        el.setAttribute('role', 'listitem');
        el.textContent = t;
        box.appendChild(el);
      });
      window.__renderedCount = box.children.length;
      window.__lastQuery = q;
    });
  </script>
</body></html>`;
}

// 恢复页：一个**第一次提交必然失败**的页面，用来做"失败恢复自适应"。
//
// 难点是**自适应**，而不是"再点一次"：
//   · 页面用的是真实站点常见的**渐进式校验** —— 邀请码输入框**首次提交后才出现**，
//     并且报错里带上演示邀请码。任何人都无法事先知道要填它，
//     所以无论脚本还是真模型**都必须走一遍"失败 → 读原因 → 补上 → 重试"**；
//   · 这正好把"盲目重试"和"读懂原因再修"区分开：前者永远停在同一条错误上。
//
// 记录 `__submits`（提交次数）与 `__rejected`（是否出现过业务拒绝），
// 让"确实经历了恢复"与"一次就过（不可能）"可被区分。
function recoverPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具恢复页</title></head>
<body>
  <h1>购买</h1>
  <label for="product">商品</label>
  <select id="product" role="combobox" aria-label="商品">
    <option value="">请选择商品</option>
    <option value="coffee-a">哥伦比亚 慧兰</option>
    <option value="coffee-b">埃塞俄比亚 耶加雪菲</option>
  </select>
  <label for="qty">数量</label>
  <input id="qty" role="textbox" aria-label="数量">
  <label for="addr">收货地址</label>
  <input id="addr" role="textbox" aria-label="收货地址">
  <!-- 邀请码一行**初始隐藏**：首次提交被拒后才出现 -->
  <div id="inviteWrap" style="display:none">
    <label for="invite">邀请码</label>
    <input id="invite" role="textbox" aria-label="邀请码">
  </div>
  <button id="submit" type="button" role="button" aria-label="提交订单">提交订单</button>
  <div id="msg" role="status"></div>
  <script>
    window.__submits = 0;
    window.__rejected = false;
    window.__order = null;
    document.getElementById('submit').addEventListener('click', function () {
      window.__submits += 1;
      var o = {
        product: document.getElementById('product').value,
        qty: document.getElementById('qty').value,
        addr: document.getElementById('addr').value,
        invite: document.getElementById('invite').value,
      };
      var msg = document.getElementById('msg');
      if (!o.product || !o.qty || !o.addr) {
        window.__rejected = true;
        msg.textContent = '请补全信息（商品 / 数量 / 收货地址都必填）';
        return;
      }
      if (!o.invite) {
        // 渐进式校验：需求在**尝试之后**才揭示，并给出可用的值。
        window.__rejected = true;
        document.getElementById('inviteWrap').style.display = 'block';
        msg.textContent = '本商品需要邀请码才能下单（演示邀请码：RF2026）';
        return;
      }
      if (o.invite !== 'RF2026') {
        window.__rejected = true;
        msg.textContent = '邀请码不正确，请核对后重试';
        return;
      }
      window.__order = o;
      msg.textContent = '下单成功：' + o.product + ' × ' + o.qty + '，寄往 ' + o.addr;
    });
  </script>
</body></html>`;
}

// 表格页：一个**朴素读法必然错位**的表格（用来验"合并单元格还原"）。
//
// 难点是**错位**，不是"表格里有没有数据"：
//   · 表头是**两级**的（`上半年` 用 colspan 跨 Q1/Q2）；
//   · 首列 `区域` 用 **rowspan** 跨两行 —— 于是第 2、4 行在 DOM 里**少一个 td**，
//     朴素做法（逐行 `querySelectorAll('td')` 拼数组）会让「商品」列的值落到「区域」列上，
//     整张表**整体左移一格**，下游按列取值全错；
//   · 还有一个单元格里带换行（真实表格常见），用来验空白归一化。
//
// 判据因此是**具体某一行文本**（例如 `华东` 与 `B` 同行），
// 那是朴素读法**不可能**产出的形态。
function tablePage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具表格页</title></head>
<body>
  <h1>区域销量</h1>
  <table id="sales">
    <thead>
      <tr>
        <th rowspan="2">区域</th>
        <th rowspan="2">商品</th>
        <th colspan="2">上半年</th>
      </tr>
      <tr>
        <th>Q1</th>
        <th>Q2</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td rowspan="2">华东</td>
        <td>阿拉比卡</td>
        <td>10</td>
        <td>20</td>
      </tr>
      <tr>
        <td>罗布斯塔</td>
        <td>30</td>
        <td>40</td>
      </tr>
      <tr>
        <td rowspan="2">华南</td>
        <td>耶加雪菲</td>
        <td>50</td>
        <td>60</td>
      </tr>
      <tr>
        <td>小粒咖啡<br>（云南）</td>
        <td>70</td>
        <td>80</td>
      </tr>
    </tbody>
  </table>
</body></html>`;
}

// 跨域 iframe 内的**完整操作**页（挂在框架站 7803）。
//
// 与既有的极简 framePage（一个按钮）不同，这里是一次完整操作：
// 填文本 + 选下拉 + 提交 + 结果渲染，**全部发生在跨域框架内部**。
//
// 难点是**边界**：外层页面对这个 iframe 的 DOM 一无所知（不同源），
// 所以既不能从外层读到它，也不能把结果写回外层 ——
// 唯一可行的跨域通信是 `postMessage`。结果因此用 postMessage 报给外层，
// 外层记进 `window.__frameReport`，这样"框架里到底做成了什么"在外层也可断言。
function embedPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具内嵌检索</title></head>
<body>
  <h1>内嵌检索</h1>
  <label for="fq">关键词</label>
  <input id="fq" role="textbox" aria-label="内嵌关键词">
  <label for="fp">范围</label>
  <select id="fp" role="combobox" aria-label="内嵌范围">
    <option value="">全部</option>
    <option value="title">仅标题</option>
  </select>
  <button id="fgo" type="button" role="button" aria-label="内嵌搜索">搜索</button>
  <div id="fres" role="status"></div>
  <script>
    window.__frameSubmits = 0;
    window.__frameState = null;
    document.getElementById('fgo').addEventListener('click', function () {
      window.__frameSubmits += 1;
      var q = document.getElementById('fq').value;
      var scope = document.getElementById('fp').value;
      window.__frameState = { q: q, scope: scope };
      var text = '内嵌结果：' + (scope || '全部') + ' 命中「' + q + '」2 条';
      document.getElementById('fres').textContent = text;
      // 跨域下唯一能通知外层的通道
      try { parent.postMessage({ type: 'frame-result', q: q, scope: scope, text: text }, '*'); } catch (e) {}
    });
  </script>
</body></html>`;
}

// 外层页：正文里嵌一个**跨域** iframe（不同端口 = 不同源）。
function framedPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具外层页</title></head>
<body>
  <h1>外层页面</h1>
  <p>下面的检索在一个跨域 iframe 里。</p>
  <iframe id="embed" src="http://127.0.0.1:${FRAME_PORT}/embed" width="640" height="320"></iframe>
  <script>
    window.__frameReport = null;
    window.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'frame-result') window.__frameReport = e.data;
    });
  </script>
</body></html>`;
}

// 入口页：点了链接会**在新标签页**打开详情（用来验"新标签页接管"）。
//
// 难点是**换页之后还得继续干活**：
//   · 内容不在当前页 —— 点击之后，"当前页面"换成了另一个标签页；
//   · 若工具不接管新标签页，后续读取会**回到原页**上去找，得到"没有这个元素"，
//     而那个结论是错的（页面换了，不是元素不存在）；
//   · 跨标签页没法直接断言，所以这里借**同源 localStorage** 做一个跨标签页通道：
//     入口页加载时先清掉标记，详情页写入标记 —— 于是"详情页真的打开过"在入口页可查。
//     （两个页同源才有这个便利；跨域时只能靠 postMessage，见 /framed 那组。）
function portalPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具工单列表</title></head>
<body>
  <h1>工单列表</h1>
  <p>共 3 条工单，最新的那条需要查看详情。</p>
  <a id="open" href="/detail" target="_blank" role="link" aria-label="查看详情">查看详情</a>
  <script>
    // 清掉上一次运行留下的标记，避免"上一轮打开过"被当成这一轮的成绩
    try { localStorage.removeItem('rf-detail'); } catch (e) {}
    window.__portalClicks = 0;
    document.getElementById('open').addEventListener('click', function () { window.__portalClicks += 1; });
  </script>
</body></html>`;
}

// 新标签页里的详情页。
function detailPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具工单详情</title></head>
<body>
  <h1>工单详情</h1>
  <div id="detail-body" role="region" aria-label="详情正文">工单号 TK-8848；状态：待处理；负责人：张三；问题：导出报表时金额列错位。</div>
  <script>
    window.__detailOpened = true;
    // 同源跨标签页通道：入口页据此可判定"详情页真的打开过"
    try { localStorage.setItem('rf-detail', 'opened'); } catch (e) {}
  </script>
</body></html>`;
}

// 分页列表页：目标条目**只在第 3 页**，且翻页是**异步渲染**的。
//
// 两个难点叠在一起，这才是真实站点最常见的形态：
//   · **跨页**：目标不在当前页 —— 不翻页就永远找不到；而"没找到"与"不存在"是两件事；
//   · **异步**：点「下一页」后列表**先清空**、300ms 后才填入。
//     所以"点完立刻读"会读到**空列表** —— 而空列表很容易被误读成"这一页没有内容"，
//     进而得出"整站没有这条"的错误结论。
//
// 页面把这两个状态都记下来（`__page` / `__rendering`），让"翻到第几页"与
// "是否仍在渲染中"都可断言。
function pagedPage() {
  const pages = [
    ['TK-0001', '登录页按钮无响应'],
    ['TK-0002', '搜索框自动补全不显示'],
    ['TK-0003', '图片懒加载失败'],
    ['TK-0004', '表单提交后未清空'],
    ['TK-0005', '移动端菜单无法收起'],
    ['TK-0006', '分页控件样式错位'],
    ['TK-0007', '日期选择器时区偏差'],
    ['TK-0008', '导出按钮重复触发'],
    ['TK-0009', '表格横向滚动条消失'],
    ['TK-0010', '筛选条件刷新后丢失'],
    ['TK-0011', '弹窗在 Safari 下不居中'],
    ['TK-0012', '上传进度条卡在 99%'],
    ['TK-0013', '导出报表时金额列错位'],
    ['TK-0014', '多选后批量操作无反馈'],
    ['TK-0015', '页面滚动位置未恢复'],
  ];
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具工单分页</title></head>
<body>
  <h1>工单列表</h1>
  <div id="list" role="list"></div>
  <div id="pageinfo" role="status">第 1 / 3 页</div>
  <button id="next" type="button" role="button" aria-label="下一页">下一页</button>
  <script>
    var ALL = ${JSON.stringify(pages)};
    var PER = 5;
    window.__page = 1;
    window.__rendering = false;
    window.__nextClicks = 0;

    function render() {
      window.__rendering = true;
      var box = document.getElementById('list');
      // **先清空**：这正是"点完立刻读会读到空列表"的来源，与真实 SPA 一致
      box.innerHTML = '';
      document.getElementById('pageinfo').textContent = '第 ' + window.__page + ' / 3 页';
      setTimeout(function () {
        var start = (window.__page - 1) * PER;
        ALL.slice(start, start + PER).forEach(function (it) {
          var el = document.createElement('div');
          el.className = 'item';
          el.setAttribute('role', 'listitem');
          el.setAttribute('data-id', it[0]);
          el.textContent = it[0] + ' ' + it[1];
          box.appendChild(el);
        });
        window.__rendering = false;
      }, 300);
    }

    document.getElementById('next').addEventListener('click', function () {
      if (window.__page >= 3) return;
      window.__nextClicks += 1;
      window.__page += 1;
      render();
    });

    render();
  </script>
</body></html>`;
}

// Shadow DOM 页：搜索组件藏在自定义组件的 **shadow root** 里（两层深）。
//
// 难点是**朴素查询根本看不到它**：
//   · `document.querySelector('#q')` 返回 **null** —— 元素在 shadow root 里，
//     光看 DOM 树"顶层什么都没有"，很容易得出"页面上没有这个搜索框"的错误结论；
//   · 而且这里还套了**两层**：`rf-search` 的 shadow 里又有一个 `rf-inner`，
//     它的内容在第二层 shadow 里（用来探"穿透深度"的边界）。
//
// 组件内部的 JS 仍跑在页面主世界，所以把状态写到 `window` 上，
// 于是 main frame 的 `page.evaluate` 也能读到（shadow DOM 只隔离 DOM，不隔离全局）。
function shadowPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具组件页</title></head>
<body>
  <h1>组件页</h1>
  <p>下面的搜索框在一个自定义组件的 shadow DOM 里。</p>
  <rf-search id="comp"></rf-search>
  <script>
    window.__compSubmits = 0;
    window.__compQuery = '';
    window.__compResult = '';
    window.__deepSeen = '';

    class RfInner extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML = '<div id="deep" role="note">深层组件就绪</div>';
        window.__deepSeen = r.getElementById('deep').textContent;
      }
    }
    customElements.define('rf-inner', RfInner);

    class RfSearch extends HTMLElement {
      connectedCallback() {
        const r = this.attachShadow({ mode: 'open' });
        r.innerHTML =
          '<label for="q">组件内关键词</label>' +
          '<input id="q" role="textbox" aria-label="组件内关键词">' +
          '<button id="go" type="button" role="button" aria-label="组件内搜索">搜索</button>' +
          '<div id="res" role="status"></div>' +
          '<rf-inner></rf-inner>';
        r.getElementById('go').addEventListener('click', () => {
          window.__compSubmits += 1;
          window.__compQuery = r.getElementById('q').value;
          window.__compResult = '组件内结果：命中「' + window.__compQuery + '」3 条';
          r.getElementById('res').textContent = window.__compResult;
        });
      }
    }
    customElements.define('rf-search', RfSearch);
  </script>
</body></html>`;
}

// 拖拽页：一个**用鼠标事件实现**的自定义滑块（带刻度），用来验 CDP 可信拖拽。
//
// 为什么不用 HTML5 拖放（draggable + dragstart/dragover/drop）：
// `drag_element` 经 CDP 派发的是**鼠标事件**（mousedown → mousemove → mouseup），
// 而 HTML5 拖放只响应**拖放事件**，两者不通 —— 用 HTML5 DnD 做夹具会得到
// "拖了但什么都没发生"，进而把结论引向"工具不支持拖拽"。
// 真实站点里的滑块 / 自定义排序也大多是鼠标事件实现，所以这样更贴近实际。
//
// 刻度用**真元素**（`#mark-80`）而不是算坐标：`drag_element` 的终点只接受
// ref / selector / text，所以"拖到某个刻度"必须有一个可定位的目标元素。
function dragPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具音量页</title>
<style>
  #track { position: relative; width: 300px; height: 24px; background: #e5e7eb; margin: 24px 0; }
  #knob { position: absolute; top: 0; width: 20px; height: 24px; background: #2563eb; cursor: grab; }
  .mark { position: absolute; top: 28px; font-size: 12px; color: #6b7280; transform: translateX(-50%); }
</style></head>
<body>
  <h1>音量设置</h1>
  <div id="track" role="slider" aria-label="音量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
    <div id="knob" role="button" aria-label="音量滑块"></div>
  </div>
  <div id="val" role="status">当前音量：0</div>
  <script>
    var KNOB = 20;
    window.__value = 0;
    window.__dragEnds = 0;
    window.__lastClientX = null;
    window.__lastRatio = null;
    var track = document.getElementById('track');
    var knob = document.getElementById('knob');
    var dragging = false;

    function usable() { return Math.max(1, track.clientWidth - KNOB); }
    function leftFor(v) { return (v / 100) * usable(); }

    function paint() {
      knob.style.left = leftFor(window.__value) + 'px';
      document.getElementById('val').textContent = '当前音量：' + window.__value;
      track.setAttribute('aria-valuenow', String(window.__value));
    }

    // 刻度：0 / 80 / 100，中心与滑块中心对齐。
    // ⚠ 必须挂在 **track 内部**：绝对定位元素的定位原点是最近的「已定位祖先」，
    // 没放进去时原点会变成初始包含块（视口），于是"用 track 的坐标算出来的 left"
    // 落在别的地方 —— 实测这一处让拖拽终点偏到轨道右端、值变成 100 而不是 80。
    // （本段在模板字符串里，注释中不能出现反引号。）
    [0, 80, 100].forEach(function (v) {
      var m = document.createElement('div');
      m.className = 'mark';
      m.id = 'mark-' + v;
      m.setAttribute('data-v', String(v));
      m.textContent = String(v);
      m.style.left = (leftFor(v) + KNOB / 2) + 'px';
      track.appendChild(m);
    });

    function setFromX(clientX) {
      var r = track.getBoundingClientRect();
      var raw = (clientX - r.left - KNOB / 2) / usable();
      var ratio = Math.max(0, Math.min(1, raw));
      // 记录**未裁剪**的原始比例与坐标：出问题时能一眼看出是"鼠标真的走过头了"
      // 还是"夹具坐标算错了" —— 否则只能看到一个被 clamp 成 100 的结果，无从判断。
      window.__lastClientX = Math.round(clientX);
      window.__lastRatio = Math.round(raw * 1000) / 1000;
      window.__value = Math.round(ratio * 100);
      paint();
    }

    knob.addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); });
    // ⚠ 必须**同时**检查左键仍按着（e.buttons 的最低位）。
    // 只靠一个 dragging 布尔值会被**任何**进来的 mousemove 劫持 ——
    // 实测：CDP 拖拽的 8 步移动结束后、mouseup 之前，混进了一条 x=1138
    //（面板区域，buttons=0）的移动，ratio 被算成 4 → 裁剪成 100，
    // 于是"拖到 80"变成"拖到最右端"，且**五次里才出现一次**（间歇性最难查的那种）。
    // 真实站点的自定义拖拽也是这么写的：按住才跟随。
    //（本段在模板字符串里，注释中不能出现反引号。）
    document.addEventListener('mousemove', function (e) {
      if (!dragging || !(e.buttons & 1)) return;
      setFromX(e.clientX);
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      window.__dragEnds += 1;
      paint();
    });
    paint();
  </script>
</body></html>`;
}

// 画布工具条：按钮**只以像素形式存在**，DOM 里没有可点中的元素。
//
// 难点是**DOM 路线是死路**：
//   · 三个按钮画在 canvas 上，`get_page_snapshot` 里没有它们；
//   · 页面为了可访问性放了一层同名同位的覆盖元素（`role=button` + `aria-label`），
//     但那层是 `pointer-events:none` —— 命中测试会**穿过它**落到 canvas 上，
//     所以"被遮挡"判定为真，`click_element` 只能退化成**程序化 click**；
//     而程序化 click 派发在覆盖元素自身、**不会冒泡到 canvas**（两者是兄弟节点），
//     于是什么都没发生，工具只会回报"已派发，但页面快照暂未观察到变化"。
//   · 唯一可行的路：`get_ax_snapshot` 拿到按坐标，再用 `click_at` 派发**真实鼠标点击**。
//
// 覆盖层放在**已定位的 wrapper 里**（与 canvas 同坐标系）—— 上一轮踩过
// "绝对定位元素挂错父节点导致坐标错位"的坑。
function canvasPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具画布工具条</title></head>
<body>
  <h1>画布工具条</h1>
  <div id="wrap" style="position:relative;display:inline-block">
    <canvas id="cv" width="420" height="64" role="img" aria-label="工具条画布"></canvas>
    <div id="ax"></div>
  </div>
  <div id="status" role="status">未点击</div>
  <script>
    window.__clicks = 0;
    window.__hit = null;
    var ITEMS = [
      { name: '新建', x: 10, w: 120 },
      { name: '保存', x: 150, w: 120 },
      { name: '删除', x: 290, w: 120 }
    ];
    var cv = document.getElementById('cv');
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#eef2ff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.font = '16px system-ui';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1e293b';
    ctx.strokeStyle = '#94a3b8';
    ITEMS.forEach(function (it) {
      ctx.strokeRect(it.x, 8, it.w, 48);
      ctx.fillText(it.name, it.x + 12, 32);
    });

    // 可访问性层：与画布按钮同位同尺寸，pointer-events:none 让命中测试穿透到 canvas
    var ax = document.getElementById('ax');
    ITEMS.forEach(function (it) {
      var d = document.createElement('div');
      d.setAttribute('role', 'button');
      d.setAttribute('aria-label', it.name);
      d.style.cssText =
        'position:absolute;left:' + it.x + 'px;top:8px;width:' + it.w + 'px;height:48px;pointer-events:none;';
      ax.appendChild(d);
    });

    cv.addEventListener('click', function (e) {
      var r = cv.getBoundingClientRect();
      var x = e.clientX - r.left;
      var it = null;
      ITEMS.forEach(function (c) { if (x >= c.x && x <= c.x + c.w) it = c; });
      window.__clicks += 1;
      window.__hit = it ? it.name : null;
      document.getElementById('status').textContent = it ? ('已点击：' + it.name) : '未命中按钮';
    });
  </script>
</body></html>`;
}

// 宏页：一个"做一次 → 存成宏 → 回放一次"的最小可控场景。
//
// 难点是**两次执行要能分开数**：
//   · 手动做一次（`__runs` 变 1）；
//   · 回放宏再做一次（`__runs` 变 2）——
//     如果回放只是"报告成功"而没真在页面上重放动作，`__runs` 就会停在 1。
// 所以判据是**计数**，不是"工具返回了 ok"。
//
// 另外：宏按**站点**存储，且只记录白名单内的可回放工具
// （见 lib/assistant/macros.js 的 REPLAYABLE_TOOLS）——
// 所以剧本里 `get_page_snapshot` / `macro` 本身都不会进宏，
// 存下来的应当**恰好是 3 步**（填词 / 选范围 / 点执行）。
function macroPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具宏演示</title></head>
<body>
  <h1>宏演示</h1>
  <label for="kw">关键词</label>
  <input id="kw" role="textbox" aria-label="关键词">
  <label for="scope">范围</label>
  <select id="scope" role="combobox" aria-label="范围">
    <option value="">全部</option>
    <option value="title">仅标题</option>
  </select>
  <button id="go" type="button" role="button" aria-label="执行">执行</button>
  <div id="status" role="status">尚未执行</div>
  <script>
    window.__runs = 0;
    window.__last = null;
    document.getElementById('go').addEventListener('click', function () {
      window.__runs += 1;
      var kw = document.getElementById('kw').value;
      var scope = document.getElementById('scope').value;
      window.__last = { kw: kw, scope: scope };
      document.getElementById('status').textContent =
        '已执行第 ' + window.__runs + ' 次：' + (scope || '全部') + ' / ' + kw;
    });
  </script>
</body></html>`;
}

// 上传页：一个真实的 file input，用来验 CDP 的 DOM.setFileInputFiles。
//
// 难点是**工具有意不谎报成功**：`upload_file` 返回 `hadEffect:false` +
// 验证说明「已向文件输入框设置文件（未做页面变化观测）」——
// 因为设置文件本身不产生可观察的页面变化。所以"调用返回 ok"不等于"文件真的进去了"，
// 必须**读回**（页面状态或 input.files）才算验证过。
//
// 页面把「change 事件是否真的触发」与「文件名」都记下来：
//   · `window.__fileName` 只在 change 触发时更新 —— 能证明 CDP 设置文件**派发了事件**；
//   · `input.files[0].name` 是权威事实，与事件无关。
// 两者一起断言，才能区分"文件没设置"与"设置了但没触发事件"。
function uploadPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具资料上传</title></head>
<body>
  <h1>资料上传</h1>
  <label for="file">选择文件</label>
  <input id="file" type="file" role="button" aria-label="选择文件">
  <button id="send" type="button" role="button" aria-label="提交资料">提交资料</button>
  <div id="status" role="status">尚未选择文件</div>
  <script>
    window.__fileName = null;
    window.__submits = 0;
    document.getElementById('file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      window.__fileName = f ? f.name : null;
      document.getElementById('status').textContent = f ? ('已选择：' + f.name) : '尚未选择文件';
    });
    document.getElementById('send').addEventListener('click', function () {
      window.__submits += 1;
      document.getElementById('status').textContent = window.__fileName
        ? ('已提交：' + window.__fileName)
        : '请先选择文件';
    });
  </script>
</body></html>`;
}

// 纪要页：知识库场景的**素材来源**。
//
// ⚠ 这一类的难点**不在页面上**（知识库是扩展侧的存储，页面只是"要记什么"的来源），
// 而在**往返保真**：存进去的东西能不能原样取回来。真正的坑在 `add_entry` 这一行：
//
//     const id = args.url || 'kb:' + Date.now() + ...
//
// **传了 url 就用 url 当 id**（代码注释写着"同一 URL 视为同一条，天然去重"）。
// 于是"把三个要点分三条存、都带上这一页的网址"会**静默只剩最后一条** ——
// 前两条被覆盖掉了，而且每一步都返回 ok。这正是本场景要钉住的东西：
// 要么放进**一条**的备注里，要么三条都**不带 url**（各得一个生成 id）。
//
// 页面本身刻意**不含** KB-1/KB-2/KB-3 这几个编号（编号由模型按指令自己加），
// 而 `add_entry` 的结果**只回显标题、不回显备注** ——
// 于是"KB-1 出现在工具结果里"就**只能**来自一次读回，不可能来自页面或写入回显。
function notesPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具纪要</title></head>
<body>
  <h1>检索性能优化 · 纪要</h1>
  <ul>
    <li>把首屏索引预热挪到扩展启动时</li>
    <li>检索超时从 800ms 收到 300ms</li>
    <li>结果缓存按 query 归一化后命中</li>
  </ul>
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

/** 从 get_ax_snapshot 的结果文本里解析某个节点的视口坐标（格式：[n] role「名称」 坐标(x,y)）。 */
function extractAxCoords(toolResults, name) {
  for (const m of toolResults) {
    const content = typeof m.content === 'string' ? m.content : '';
    const re = new RegExp('\\[\\d+\\] [a-z]+「' + name + '」 坐标\\((\\d+),(\\d+)\\)');
    const hit = content.match(re);
    if (hit) return { x: Number(hit[1]), y: Number(hit[2]) };
  }
  return null;
}

/** 从 add_entry 的结果里解析条目 id（格式：已保存条目：标题「…」(id: xxx)。）。 */
function extractSavedId(toolResults) {
  for (const m of toolResults) {
    const content = typeof m.content === 'string' ? m.content : '';
    const hit = content.match(/\(id: ([^)]+)\)/);
    if (hit) return hit[1];
  }
  return null;
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

// 触发词只能看**真实指令**，不能看整条 user 消息。
//
// 为什么（实测踩到，症状极具误导性）：那条 user 消息里除了指令，还塞着**注入的页面正文**
// （不可信数据区）。于是页面自己写的文字就能命中另一个剧本的触发词 ——
// 遮挡页的 H1 写了「站内搜索」，正好包含检索剧本的触发词「站内搜」，
// 结果**检索剧本被选中**，而它去 `type_text(name:'站内搜索')` 自然找不到（那一页叫「搜索关键词」），
// 报出来的是「未找到可输入的目标元素」。症状看起来像**工具坏了**，实际是剧本选错了。
//
// 指令段有固定标签（带随机校验 token，见 lib/assistant/initial-messages.js 的 instructionLabel），
// 据此切出真正的指令即可；找不到标签时退回整条消息（兼容没有标签的请求形态）。
//
// ⚠ 遮挡页的 H1 刻意**保留**「站内搜索」不去改：它现在是这条修复的**永久回归探针** ——
//   一旦有人把这里的切分去掉，遮挡用例会立刻因为跑错剧本而红灯。
const INSTRUCTION_LABEL_RE = /以下是用户的真实指令（唯一具有指令效力的内容；校验标记 [^）]*）：\n?/;

export function instructionOf(text) {
  const s = String(text || '');
  const m = INSTRUCTION_LABEL_RE.exec(s);
  return m ? s.slice(m.index + m[0].length) : s;
}

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
    // 只取**真实指令**段做剧本分派（原因见 instructionOf 的注释：整条消息含页面正文，
    // 页面文字能命中别的剧本触发词，导致静默跑错剧本）。
    const userText = instructionOf(userMsg && typeof userMsg.content === 'string' ? userMsg.content : '');
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

    // 剧本：排查（playbook id = 'debug-console-error'）。
    //
    // 这一类与其余三类的根本差别：**症状与原因不在同一处**。
    // 用户看到的是"点了没反应"，原因是一条只在点击后出现的未捕获 TypeError ——
    // 所以必须先复现、再读运行期事实，光看快照什么也看不出来。
    if (userText.includes(PLAYBOOKS['debug-console-error'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      // 复现：不点一下，错误根本不会产生
      if (done === 1) { toolStep(res, 'click_element', { selector: '#apply' }); return; }
      // 读运行期事实（复盘后才会有的那条 TypeError）
      if (done === 2) { toolStep(res, 'read_diagnostics', { kind: 'console', level: 'error' }); return; }
      // 确认症状：结果区确实是空的
      if (done === 3) { toolStep(res, 'inspect_element', { op: 'text', selector: '#total' }); return; }
      finalText(res, '复现了：点击「计算总价」后抛出未捕获 TypeError（读取 undefined 的 total），因此结果区始终为空。代码里把 state.cart 当对象用，但该数据结构只有 items，没有 cart。', 110);
      return;
    }

    // 剧本：遮挡 / 弹层干扰（playbook id = 'dismiss-overlay'）。
    //
    // 顺序即能力：**先关掉遮罩，再做正事**。遮罩不关，输入框与按钮都在它下面，
    // 动作会被判定为"被遮挡"而失败。脚本按正确顺序写，真模型会不会也这么干由第三层检验。
    if (userText.includes(PLAYBOOKS['dismiss-overlay'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      // 第一步就是处理干扰 —— 不是先去点被挡住的东西
      if (done === 1) { toolStep(res, 'click_element', { role: 'button', name: '接受并关闭' }); return; }
      if (done === 2) { toolStep(res, 'type_text', { role: 'textbox', name: '搜索关键词', value: '咖啡' }); return; }
      if (done === 3) { toolStep(res, 'click_element', { role: 'button', name: '搜索' }); return; }
      if (done === 4) { toolStep(res, 'inspect_element', { op: 'text', selector: '#results' }); return; }
      finalText(res, '已关闭 Cookie 弹窗，并搜索「咖啡」：哥伦比亚 慧兰 ￥88；埃塞俄比亚 耶加雪菲 ￥108；云南 小粒咖啡 ￥68。', 90);
      return;
    }

    // 剧本：失败恢复自适应（playbook id = 'recover-from-rejection'）。
    //
    // 必须在**首次提交被拒之后**才去拿邀请码：那个输入框首次提交前根本不存在。
    // 这条剧本的形状就是"失败 → 读原因 → 补上 → 重试"，而不是"再点一次"。
    if (userText.includes(PLAYBOOKS['recover-from-rejection'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      if (done === 1) { toolStep(res, 'select_option', { selector: '#product', label: '哥伦比亚 慧兰' }); return; }
      if (done === 2) { toolStep(res, 'type_text', { selector: '#qty', value: '1', clearFirst: true }); return; }
      if (done === 3) { toolStep(res, 'type_text', { selector: '#addr', value: '上海市浦东新区 1 号', clearFirst: true }); return; }
      // 第一次提交：必然被拒（邀请码还没填）—— 这正是要验的那一步
      if (done === 4) { toolStep(res, 'click_element', { selector: '#submit' }); return; }
      // 读页面反馈，看清"还差什么"
      if (done === 5) { toolStep(res, 'inspect_element', { op: 'text', selector: '#msg' }); return; }
      // 补上从错误信息里学到的邀请码（输入框此时才出现）
      if (done === 6) { toolStep(res, 'type_text', { selector: '#invite', value: 'RF2026', clearFirst: true }); return; }
      // 重试
      if (done === 7) { toolStep(res, 'click_element', { selector: '#submit' }); return; }
      if (done === 8) { toolStep(res, 'inspect_element', { op: 'text', selector: '#msg' }); return; }
      finalText(res, '第一次提交被拒，页面提示需要邀请码（演示码 RF2026）；补填后重试成功，已下单：哥伦比亚 慧兰 × 1。', 120);
      return;
    }

    // 剧本：表格合并单元格提取（playbook id = 'extract-merged-table'）。
    //
    // 一步就够：`inspect_element({op:'table'})` 会走 expandTableGrid 把 rowspan/colspan
    // 还原成矩形网格。这条剧本同时是**数据是否真的交到模型手上**的探针 ——
    // 该命令原先把网格放在 markdown 字段、而投递层只取 result，于是模型只收到一句摘要。
    if (userText.includes(PLAYBOOKS['extract-merged-table'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      if (done === 1) { toolStep(res, 'inspect_element', { op: 'table', selector: '#sales' }); return; }
      finalText(res, '表已还原为 4 行 × 4 列：华东/阿拉比卡 10、20；华东/罗布斯塔 30、40；华南/耶加雪菲 50、60；华南/小粒咖啡（云南）70、80。上半年 = Q1+Q2。', 90);
      return;
    }

    // 剧本：跨域 iframe 内的完整操作（playbook id = 'operate-in-cross-origin-iframe'）。
    //
    // 三次操作全部发生在**跨域框架内部**，所以都走 `f<frameId>:rf-N` 复合 ref
    // （先 includeFrames 读合并快照，再按 ref 路由过去）—— 这是真实模型唯一可用的路径，
    // 因为不同源，外层读不到里面的 DOM。
    // 最后一步用**显式 frameId** 读回框架内的结果区，验证"读"也能跨域。
    if (userText.includes(PLAYBOOKS['operate-in-cross-origin-iframe'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { includeFrames: true, maxElements: 60, maxText: 600 }); return; }
      const kwRef = extractFrameRef(toolResults, '内嵌关键词');
      const scopeRef = extractFrameRef(toolResults, '内嵌范围');
      const goRef = extractFrameRef(toolResults, '内嵌搜索');
      if (!kwRef || !scopeRef || !goRef) {
        // 读不到框架内元素时**如实说明**，而不是继续猜 —— 脚本化剧本里"沉默地继续"
        // 会让后面的断言失败指向错误的地方。
        finalText(res, '未能在合并快照里找到跨域框架内的元素（' + [kwRef, scopeRef, goRef].join('/') + '）。', 30);
        return;
      }
      if (done === 1) { toolStep(res, 'type_text', { ref: kwRef, value: '咖啡' }); return; }
      if (done === 2) { toolStep(res, 'select_option', { ref: scopeRef, label: '仅标题' }); return; }
      if (done === 3) { toolStep(res, 'click_element', { ref: goRef }); return; }
      if (done === 4) {
        // frameId 从复合 ref（f<frameId>:rf-N）里取出来 —— 证明"读"也能跨域。
        const frameId = Number(String(goRef).replace(/^f(\d+):.*$/, '$1'));
        toolStep(res, 'inspect_element', { op: 'text', frameId: frameId, selector: '#fres' });
        return;
      }
      finalText(res, '已在跨域 iframe 内完成检索：关键词「咖啡」，范围「仅标题」，结果为 2 条。', 70);
      return;
    }

    // 剧本：新标签页接管（playbook id = 'new-tab-takeover'）。
    //
    // 点击后"当前页面"换成新标签页，后续读取必须落在**新页**上。
    // 这里刻意不做任何显式切页动作（不调 switch_tab）：
    // 点击工具在检测到新标签页时会自动绑定（结果文本里会写明），
    // 这条剧本验的就是"绑定之后，后面几步是不是真的在新页上执行"。
    if (userText.includes(PLAYBOOKS['new-tab-takeover'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      if (done === 1) { toolStep(res, 'click_element', { role: 'link', name: '查看详情' }); return; }
      if (done === 2) { toolStep(res, 'inspect_element', { op: 'text', selector: '#detail-body' }); return; }
      finalText(res, '已在新标签页里读到工单详情：TK-8848，状态待处理，负责人张三，问题是导出报表时金额列错位。', 80);
      return;
    }

    // 剧本：分页 + 异步加载（playbook id = 'paginate-async'）。
    //
    // 每一步"翻页之后"都**先等目标内容出现再读**，而不是点完立刻读 ——
    // 因为页面是"先清空、300ms 后才填"：立刻读会拿到空列表，
    // 而空列表极容易被误读成"这一页没有内容"，进而得出"整站没有这条"的错误结论。
    if (userText.includes(PLAYBOOKS['paginate-async'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      if (done === 1) { toolStep(res, 'inspect_element', { op: 'text', selector: '#list' }); return; }
      if (done === 2) { toolStep(res, 'click_element', { role: 'button', name: '下一页' }); return; }
      // 等第 2 页内容真的渲染出来
      if (done === 3) { toolStep(res, 'wait_for_element', { selector: '#list', state: 'text_contains', text: 'TK-0006' }); return; }
      if (done === 4) { toolStep(res, 'inspect_element', { op: 'text', selector: '#list' }); return; }
      if (done === 5) { toolStep(res, 'click_element', { role: 'button', name: '下一页' }); return; }
      // 等第 3 页的目标条目出现
      if (done === 6) { toolStep(res, 'wait_for_element', { selector: '#list', state: 'text_contains', text: 'TK-0013' }); return; }
      if (done === 7) { toolStep(res, 'inspect_element', { op: 'text', selector: '#list' }); return; }
      finalText(res, '翻到第 3 页找到了：工单 TK-0013「导出报表时金额列错位」。', 80);
      return;
    }

    // 剧本：Shadow DOM 穿透（playbook id = 'pierce-shadow-dom'）。
    //
    // 元素都在自定义组件的 shadow root 里，朴素 `document.querySelector` 看不到它们。
    // 这里同时探**两层**：`#res` 在第一层 shadow，`#deep` 在第二层。
    if (userText.includes(PLAYBOOKS['pierce-shadow-dom'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      if (done === 1) { toolStep(res, 'type_text', { role: 'textbox', name: '组件内关键词', value: '咖啡' }); return; }
      if (done === 2) { toolStep(res, 'click_element', { role: 'button', name: '组件内搜索' }); return; }
      // 第一层 shadow 里的结果区
      if (done === 3) { toolStep(res, 'inspect_element', { op: 'text', selector: '#res' }); return; }
      // 第二层 shadow（shadow 里套 shadow）—— 探穿透深度
      if (done === 4) { toolStep(res, 'inspect_element', { op: 'text', selector: '#deep' }); return; }
      finalText(res, '已在组件的 shadow DOM 内完成搜索：命中「咖啡」3 条；并确认两层 shadow 里的内容都可读到。', 90);
      return;
    }

    // 剧本：CDP 可信拖拽（playbook id = 'cdp-drag-slider'）。
    //
    // 注意 `drag_element` 的两端**只接受 ref / selector / text**（没有 role/name），
    // 所以这里用 selector 定位起终点。
    if (userText.includes(PLAYBOOKS['cdp-drag-slider'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      if (done === 1) { toolStep(res, 'drag_element', { fromSelector: '#knob', toSelector: '#mark-80' }); return; }
      // 读回结果值 —— 拖拽本身只说"已派发"，不等于"值真的变了"
      if (done === 2) { toolStep(res, 'inspect_element', { op: 'text', selector: '#val' }); return; }
      finalText(res, '已把音量滑块从 0 拖到 80 刻度，当前值为 80。', 60);
      return;
    }

    // 剧本：canvas + 坐标点击（playbook id = 'canvas-coordinate-click'）。
    //
    // DOM 路线是死路（按钮只画在 canvas 上，可访问性层是 pointer-events:none），
    // 所以必须走"AX 拿坐标 → click_at 派发真实鼠标点击"这条路。
    if (userText.includes(PLAYBOOKS['canvas-coordinate-click'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      if (done === 1) { toolStep(res, 'get_ax_snapshot', { limit: 60 }); return; }
      const at = extractAxCoords(toolResults, '保存');
      if (!at) {
        finalText(res, '可访问性树里没有找到「保存」的坐标，无法按坐标点击。', 30);
        return;
      }
      if (done === 2) { toolStep(res, 'click_at', { x: at.x, y: at.y }); return; }
      if (done === 3) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已在画布工具条上点击「保存」（按可访问性树给出的坐标 (' + at.x + ',' + at.y + ') 派发真实鼠标点击）。', 70);
      return;
    }

    // 剧本：宏保存 + 回放（playbook id = 'macro-save-replay'）。
    //
    // 先手动做一遍（`__runs` = 1），存成宏，再回放一次（`__runs` = 2）。
    // 存下来的应当**恰好 3 步** —— `get_page_snapshot` 与 `macro` 自身都不在
    // REPLAYABLE_TOOLS 白名单里，不会被记录。
    if (userText.includes(PLAYBOOKS['macro-save-replay'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      if (done === 1) { toolStep(res, 'type_text', { role: 'textbox', name: '关键词', value: '咖啡', clearFirst: true }); return; }
      if (done === 2) { toolStep(res, 'select_option', { selector: '#scope', label: '仅标题' }); return; }
      if (done === 3) { toolStep(res, 'click_element', { role: 'button', name: '执行' }); return; }
      if (done === 4) { toolStep(res, 'macro', { op: 'save', name: '咖啡查询', description: '填关键词+选范围+执行' }); return; }
      if (done === 5) { toolStep(res, 'macro', { op: 'run', name: '咖啡查询' }); return; }
      if (done === 6) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已执行一次并把「填词→选范围→执行」存成宏「咖啡查询」（3 步），随后回放了一次，页面累计执行 2 次。', 90);
      return;
    }

    // 剧本：文件上传（playbook id = 'upload-file'）。
    //
    // 关键点：`upload_file` **有意报告 hadEffect:false**（设置文件不产生可观察的页面变化），
    // 所以剧本不能停在"上传工具返回 ok"，必须**读回**页面状态才算完成。
    if (userText.includes(PLAYBOOKS['upload-file'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 300 }); return; }
      if (done === 1) { toolStep(res, 'upload_file', { selector: '#file', files: [SAMPLE_UPLOAD] }); return; }
      if (done === 2) { toolStep(res, 'click_element', { role: 'button', name: '提交资料' }); return; }
      if (done === 3) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已把 sample-upload.txt 设置到文件输入框并提交，页面回执「已提交：sample-upload.txt」。', 80);
      return;
    }

    // 剧本：知识库检索的召回边界（playbook id = 'knowledge-search-fallback'）。
    //
    // ⚠ 这一块必须排在「知识库往返」那一块**之前**：本剧本的指令里同时含
    // 「知识库」与「打开很慢」两个触发词，而分派是 `includes` 顺序匹配 ——
    // 排在后面就会被 knowledge-save-retrieve 抢走（静默跑错剧本）。
    // 门禁 tests/skill-playbook-contract.test.mjs 会盯着"更长/更具体的触发词先检查"。
    if (userText.includes(PLAYBOOKS['knowledge-search-fallback'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 600 }); return; }
      if (done === 1) {
        toolStep(res, 'add_entry', {
          type: 'note',
          title: '检索性能优化',
          note: 'KB-1 把首屏索引预热挪到扩展启动时；KB-2 检索超时从 800ms 收到 300ms；KB-3 结果缓存按 query 归一化后命中',
        });
        return;
      }
      // 用「页面打开很慢」检索 —— 与笔记在字符层面毫无交集，必然落空
      if (done === 2) { toolStep(res, 'knowledge_read', { op: 'search', query: '页面打开很慢' }); return; }
      // 回退：先列出本站已存条目
      if (done === 3) { toolStep(res, 'knowledge_read', { op: 'list' }); return; }
      const id = extractSavedId(toolResults);
      if (done === 4) {
        if (!id) { finalText(res, '拿不到条目 id，无法直接读出该条。', 30); return; }
        toolStep(res, 'knowledge_read', { op: 'get', id });
        return;
      }
      finalText(
        res,
        '检索「页面打开很慢」没有命中（词面确实对不上），但知识库里确实有这条记录，已按 id 读出来核对：' +
          'KB-1 首屏索引预热、KB-2 检索超时 300ms、KB-3 结果缓存命中。',
        90
      );
      return;
    }

    // 剧本：知识库往返（playbook id = 'knowledge-save-retrieve'）。
    //
    // 走的是**稳的那条路**：三个要点放进**一条**的备注里（不带 url，于是拿到生成 id），
    // 再用 `knowledge_read(op:'get')` 按 id 读回来核对 —— 读回那一步不能省，
    // 因为"写入返回 ok"并不证明"取回来是对的"。
    if (userText.includes(PLAYBOOKS['knowledge-save-retrieve'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 600 }); return; }
      if (done === 1) {
        // 稳的那条路：三个要点放进**一条**的备注（不带 url，于是拿到生成 id）。
        // 反例（实测过，见 E2E 注释）：三条各自带同一个 url → 存储里只剩最后一条。
        toolStep(res, 'add_entry', {
          type: 'note',
          title: '检索性能优化',
          note: 'KB-1 把首屏索引预热挪到扩展启动时；KB-2 检索超时从 800ms 收到 300ms；KB-3 结果缓存按 query 归一化后命中',
        });
        return;
      }
      const id = extractSavedId(toolResults);
      if (done === 2) {
        if (!id) { finalText(res, 'add_entry 没有返回条目 id，无法按 id 读回。', 30); return; }
        toolStep(res, 'knowledge_read', { op: 'get', id });
        return;
      }
      finalText(res, '已把三个要点存成知识库条目「检索性能优化」（一条，备注里带 KB-1/KB-2/KB-3），并已读回核对。', 80);
      return;
    }
    if (userText.includes('__INJECT_NEVER__')) {
      const id = extractSavedId(toolResults);
      if (done === 2) {
        if (!id) { finalText(res, 'add_entry 没有返回条目 id，无法按 id 读回。', 30); return; }
        toolStep(res, 'knowledge_read', { op: 'get', id });
        return;
      }
      finalText(res, '已把三个要点存成知识库条目「检索性能优化」（一条，备注里带 KB-1/KB-2/KB-3），并已读回核对。', 80);
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
            : req.url && req.url.startsWith('/debug') ? debugPage()
              : req.url && req.url.startsWith('/blocked') ? blockedPage()
                : req.url && req.url.startsWith('/recover') ? recoverPage()
                  : req.url && req.url.startsWith('/table') ? tablePage()
                    : req.url && req.url.startsWith('/framed') ? framedPage()
                      : req.url && req.url.startsWith('/portal') ? portalPage()
                        : req.url && req.url.startsWith('/detail') ? detailPage()
                          : req.url && req.url.startsWith('/paged') ? pagedPage()
                            : req.url && req.url.startsWith('/shadow') ? shadowPage()
                              : req.url && req.url.startsWith('/drag') ? dragPage()
                                : req.url && req.url.startsWith('/canvas') ? canvasPage()
                                  : req.url && req.url.startsWith('/macro') ? macroPage()
                                    : req.url && req.url.startsWith('/upload') ? uploadPage()
                                      : req.url && req.url.startsWith('/notes') ? notesPage()
                                        : mainPage()
  );
});
const frame = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(req.url && req.url.startsWith('/embed') ? embedPage() : framePage());
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
