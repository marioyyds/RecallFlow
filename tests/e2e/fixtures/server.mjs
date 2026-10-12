// E2E 夹具服务：
// - 主站（7802）：包含按钮/输入框 + 一个跨域 iframe。
// - 框架站（7803）：跨域 iframe 内容。
// - 模拟 LLM（7804）：OpenAI 兼容，按脚本返回 tool_calls / 文本，供 Agent 端到端测试。
//
// ===================================================================================
// ⚠⚠ 本文件里的每个 `xxxPage()` 都返回**模板字符串**。在这个文件里写注释时：
//
//        不要在注释里使用反引号（`）
//
//     一个反引号就会**提前结束模板字符串**，文件直接语法错误。
//     本会话为此踩了**四次**，每次都只是白跑一轮 `node --check`。
//     需要引用代码/名字时用「」或直接写，别用反引号。
// ===================================================================================
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

// 取件凭证页（**A 页 / 来源页**）：多标签页编排场景的起点。
//
// 难点是**"现在到底在哪个标签页"这件事是隐式的**。页面上故意放了一个
// **诱饵输入框**（`#note`，可访问名「备注」）—— 它是个看起来也很合理的目标。
// 如果 agent 读完成验证码后**没有真正切到新标签页**就往输入框里打字，
// 字会落进这个诱饵、本页的「保存备注」还可能被点，而 B 页什么也没收到：
// **每一步都返回成功**，只有页面状态能拆穿。
// 所以 E2E 除了断言 B 页收到验证码，还要断言 **A 页的诱饵没被动过、本页没提交**。
function handoffPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具取件凭证</title></head>
<body>
  <h1>取件凭证</h1>
  <p>验证码：<code id="code">RF-7391</code></p>
  <label for="note">备注</label>
  <input id="note" role="textbox" aria-label="备注">
  <button id="save" type="button" role="button" aria-label="保存备注">保存备注</button>
  <p><a id="go" href="/handoff-form" target="_blank" role="link" aria-label="打开填写页">打开填写页</a></p>
  <div id="status" role="status">本页未提交</div>
  <script>
    window.__submits = 0;
    window.__noteValue = null;
    document.getElementById('note').addEventListener('input', function (e) {
      window.__noteValue = e.target.value;
    });
    document.getElementById('save').addEventListener('click', function () {
      window.__submits += 1;
      document.getElementById('status').textContent = '本页已保存备注：' + (window.__noteValue || '（空）');
    });
  </script>
</body></html>`;
}

// 填写页（**B 页 / 目标页**）：在新标签页里打开，验证码要填到这里。
function handoffFormPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具填写验证码</title></head>
<body>
  <h1>填写验证码</h1>
  <label for="code">验证码</label>
  <input id="code" role="textbox" aria-label="验证码">
  <button id="ok" type="button" role="button" aria-label="提交验证码">提交验证码</button>
  <div id="status" role="status">等待填写</div>
  <script>
    window.__submits = 0;
    window.__submittedCode = null;
    document.getElementById('ok').addEventListener('click', function () {
      window.__submits += 1;
      window.__submittedCode = document.getElementById('code').value;
      document.getElementById('status').textContent = window.__submittedCode
        ? ('已提交验证码：' + window.__submittedCode)
        : '请先填写验证码';
    });
  </script>
</body></html>`;
}

// 虚拟列表面板：**DOM 里只有可见的几行**，其余是假的。
//
// 难点是"**DOM 里没有 ≠ 页面上没有**"：
//   · 列表共 100 条，容器只渲染**当前窗口的 5 条**（滚动时回收重建）；
//   · 所以 `get_page_snapshot` 里看不到目标行，`document.querySelectorAll('.row').length` 只返回 5 ——
//     把它当成"这个列表只有 5 条"或"没有 VL-87 这一条"都是**错的**。
//   · 而且目标在一个**内部可滚动容器**里：窗口滚动(`window.scrollBy`)对它毫无作用，
//     必须滚**容器自己**（`scroll_page({ selector: '#list', y: … })`）。
//
// `#pad` 撑出总高度（100×40px），行绝对定位在 `#list` 里（`#list` 是定位祖先），
// 于是行号与 scrollTop 成正比：start = floor(scrollTop / 40)。
function virtualListPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具虚拟列表</title>
<style>
  #list { position: relative; height: 200px; overflow-y: auto; border: 1px solid #cbd5e1; }
  .row { position: absolute; left: 0; right: 0; height: 40px; line-height: 40px; padding-left: 8px; }
  .row:hover { background: #f1f5f9; }
</style></head>
<body>
  <h1>虚拟列表</h1>
  <div id="list" role="list" aria-label="条目列表"><div id="pad"></div><div id="win"></div></div>
  <div id="status" role="status">未点开</div>
  <script>
    var TOTAL = 100, ROW = 40, VISIBLE = 5;
    window.__clicked = null;
    window.__renderedIds = [];
    window.__windowStart = 0;
    // 容器**真的被滚过**的证据：记 scrollTop 的最大值。
    // ⚠ 这里刻意不记"滚了多少"这个具体量 —— 目标行（第 87 条）在 3400 与 3480 这类
    //   不同偏移下都会进窗口，"必须恰好滚 3480"是**路径断言**，会把合法的另一种滚法判红
    //   （真模型 eval 实测：它滚 3400，页面判据全过，却因为回执里没有 scrollTop=3480 而红）。
    //   判据要的是"**这个容器真的滚动过**"（窗口滚不动它 ⇒ 只能是滚了容器）+ "第 87 条真的进了窗口"。
    window.__maxScrollTop = 0;
    var list = document.getElementById('list');
    var pad = document.getElementById('pad');
    var win = document.getElementById('win');
    pad.style.height = (TOTAL * ROW) + 'px';
    list.addEventListener('scroll', function () {
      if (list.scrollTop > window.__maxScrollTop) window.__maxScrollTop = list.scrollTop;
    });
    function render() {
      var start = Math.floor(list.scrollTop / ROW);
      if (start > TOTAL - VISIBLE) start = Math.max(0, TOTAL - VISIBLE);
      window.__windowStart = start;
      win.innerHTML = '';
      var ids = [];
      for (var i = start; i < start + VISIBLE && i < TOTAL; i++) {
        var row = document.createElement('div');
        row.className = 'row';
        row.setAttribute('role', 'listitem');
        row.setAttribute('data-id', 'i' + i);
        row.style.top = (i * ROW) + 'px';
        row.textContent = '条目 ' + i + (i === 87 ? ' · VL-87 目标条目' : '');
        (function (idx) {
          row.addEventListener('click', function () {
            window.__clicked = 'i' + idx;
            document.getElementById('status').textContent = '已点开：' + idx;
          });
        })(i);
        win.appendChild(row);
        ids.push('i' + i);
      }
      window.__renderedIds = ids;
    }
    list.addEventListener('scroll', render);
    render();
  </script>
</body></html>`;
}

// 反馈信息流页：**页面级无限滚动** + **hover 才出现的预览**（两个真难点叠在一页里）。
//
// A1 无限滚动（**页面级**，不是滚容器）：
//   · 一次滚动只触发**一批**加载：滚到底（防抖之后）才加载，而加载是**异步**的（500ms）；
//   · append 之后页面变高、当前位置**不再是底部**，而且不会再触发 scroll 事件
//     ⇒ 必须"滚动 → 等新批 → 再滚"；
//   · 目标在第 4 批（共 5 批）⇒ 不滚到位就永远看不到它，`get_page_snapshot` 里没有它；
//   · 最后一批之后才出现「已到底」—— 这是**唯一的停止信号**（状态行只报"已加载 N 条"，
//     不报总数 ⇒ "还有没有更多"只能靠它），读到它才该停；
//   · 「加载更多」按钮是**迷惑项**：点它不加载任何东西（看起来能点的东西推不动页面）。
//
// A2 hover 预览：
//   · 预览文本**不在页面里**（HTML/JS 里一个字都没有）：只在**可信** mouseenter 时向
//     /feed-preview 取 ⇒ "不 hover 直接读"在结构上不可能（不是靠 CSS 藏起来）；
//   · 合成事件过不去：夹具检查 event.isTrusted，假事件只计数、不取内容；
//   · 鼠标一移开，**行内 popover 就清空**（`#pv-<id>` 只在还停在这一行时才有内容）。
//
// ⚠⚠ 为什么要同时留一条**耐久**的「最近一次查看」记录（`#peek`）：CDP 注入的 hover 随时会被
//   **真实鼠标事件**重置 —— 实测（本机人的鼠标就在窗口里）：`hover_element` 把光标放到目标行的
//   41ms 之后，一条真实的 `mousemove`（x=830，落在侧边栏上）就把 hover 状态挪走了，
//   行内 popover 随即被清空 ⇒ 这时"读 popover"能不能成功**取决于运气**，用例必然时好时坏。
//   真实站点也常这么做（详情/预览面板会留下"最近查看"）。于是：
//     · popover = hover 期间才可见（基线断言"移开就消失"用它）；
//     · `#peek` = 最近一次**可信 hover** 取到的预览（读它才是可靠的取证路径）。
//   两者都**只在可信 hover 之后**才有内容 —— "不 hover 读不到"这条没有被削弱。
//
// 连**标题**都是按批从服务端取的（/feed-batch）：页面源码里既没有第 4 批的标题，
// 也没有任何订单号 —— 所以"目标不在快照里"是真的不在**页面里**，不是抽取逻辑漏了它。
//
// 两个难点的状态都记在 window.__feed 上（供 E2E 读回）：
// batches / exhausted / decoyClicks / trustedEnters / fakeEnters / leaves / revealedIds / revealedText。
//
// ⚠ 第一批刻意撑到**超过一屏**（每条约 81px × 10 条 + 头部 ≈ 1090px）：文档不比视口高时，
//   滚到底根本不产生 scroll 事件，那这条场景会变成"怎么滚都不加载"。
function feedPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具反馈信息流</title>
<style>
  /* ⚠ body 收窄到 560px 是**必须的**（不是排版偏好）：RecallFlow 面板默认贴在右边、
     宽 640px，而 CDP 类的工具（hover_element / click_at / drag_element）用的是元素**中心点**
     的视口坐标 —— 整行铺满宽度时中心点正好落在面板底下，鼠标会打到面板上而不是页面上，
     mouseenter 根本不触发（实测：坐标 632,294 与 632,360 都撞在面板区域里）。
     收窄之后行中心在 x≈280，明确在面板左侧。 */
  body { max-width: 560px; }
  .intro { padding: 18px 0; }
  .peek { padding: 6px 0 10px; color: #334155; }
  .item { border-bottom: 1px solid #e2e8f0; }
  .row { position: relative; display: block; padding: 20px 12px; }
  .meta { display: block; color: #64748b; font-size: 12px; }
  /* 预览：默认 display:none（既看不见，也不进 innerText）；hover 才显示。
     内容由 mouseenter 时向服务端取 —— 也就是说**不 hover 时它压根不存在**。 */
  .preview { display: none; position: absolute; left: 12px; top: 50px; z-index: 5;
             padding: 8px 12px; border-radius: 6px; background: #1e293b; color: #fff; font-size: 13px; }
  .item:hover .preview { display: block; }
</style></head>
<body>
  <h1>反馈信息流</h1>
  <div class="intro">
    <p>反馈按时间从新到旧排列，继续向下滚动会自动加载更早的反馈。</p>
    <p>把鼠标移到某一条反馈上，可以看到它的订单预览。</p>
  </div>
  <div id="peek" class="peek" role="status">最近一次查看：—</div>
  <div id="feed" role="feed"></div>
  <div id="feed-status" role="status">正在加载…</div>
  <div id="feed-end" role="status"></div>
  <button id="more" type="button" role="button" aria-label="加载更多">加载更多</button>
  <div id="more-note" role="status"></div>
  <script>
    var BATCH = 10, TOTAL_BATCHES = 5, LOAD_MS = 500, SETTLE_MS = 150, EDGE_PX = 8;
    window.__feed = {
      batches: 1, loading: false, exhausted: false, decoyClicks: 0, scrollEvents: 0,
      trustedEnters: 0, fakeEnters: 0, leaves: 0, hoveredId: null,
      revealedIds: [], revealedText: {}
    };
    var feedState = window.__feed;
    var feedEl = document.getElementById('feed');
    var statusEl = document.getElementById('feed-status');
    var endEl = document.getElementById('feed-end');
    var moreNoteEl = document.getElementById('more-note');
    var peekEl = document.getElementById('peek');

    function attachHover(row, id, pv) {
      row.addEventListener('mouseenter', function (ev) {
        // ★ 只认**可信**事件：dispatchEvent 造出来的鼠标事件 isTrusted=false ——
        //   它既不会去取预览，也不会让内容出现（在夹具层面就过不去）。
        if (!ev.isTrusted) { feedState.fakeEnters += 1; return; }
        feedState.trustedEnters += 1;
        feedState.hoveredId = id;
        fetch('feed-preview?id=' + id).then(function (r) { return r.json(); }).then(function (data) {
          var text = '订单号 ' + data.order + ' · ' + data.owner + ' · ' + data.state;
          // 耐久记录：**无条件写下**（这就是"可信 hover 真的发生过"的可靠凭据，
          // 也是读预览的可靠路径 —— 详见文件顶部关于真实鼠标事件的说明）
          peekEl.textContent = '最近一次查看：' + text;
          if (feedState.revealedIds.indexOf(id) < 0) feedState.revealedIds.push(id);
          feedState.revealedText[id] = text;
          // 行内 popover 只在这一行**还处于 hover** 时填：鼠标一移开它就没了
          if (feedState.hoveredId === id) pv.textContent = text;
        }).catch(function () {});
      });
      row.addEventListener('mouseleave', function (ev) {
        if (!ev.isTrusted) return;
        feedState.leaves += 1;
        if (feedState.hoveredId === id) feedState.hoveredId = null;
        // 移开就消失：只清 popover（那个「最近一次查看」记录留着）
        pv.textContent = '';
      });
    }

    function makeRow(it) {
      var id = it.id;
      var item = document.createElement('div');
      item.className = 'item';
      item.setAttribute('data-id', id);
      var row = document.createElement('div');
      row.className = 'row';
      row.setAttribute('data-id', id);
      // tabindex 让这一行进入快照的可交互元素列表（模型据此拿到 ref/selector 再 hover）
      row.setAttribute('tabindex', '0');
      row.textContent = it.title;
      var meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = '受理中 · 编号 ' + id.slice(1);
      row.appendChild(meta);
      var pv = document.createElement('div');
      pv.className = 'preview';
      pv.id = 'pv-' + id;
      pv.setAttribute('role', 'tooltip');
      row.appendChild(pv);
      attachHover(row, id, pv);
      item.appendChild(row);
      return item;
    }

    // 按批取数：页面源码里**没有**任何标题（更别说订单号）—— 目标条目只有滚到第 4 批才存在。
    function appendBatch(n) {
      return fetch('feed-batch?n=' + n).then(function (r) { return r.json(); }).then(function (rows) {
        var frag = document.createDocumentFragment();
        rows.forEach(function (it) { frag.appendChild(makeRow(it)); });
        feedEl.appendChild(frag);
        feedState.batches = n;
      });
    }

    function atBottom() {
      return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - EDGE_PX;
    }

    function loadNext() {
      if (feedState.loading || feedState.exhausted) return;
      feedState.loading = true;
      statusEl.textContent = '正在加载更早的反馈…';
      // 真实站点这里是一次请求；把"加载窗口"固定成 500ms，让"滚动 → 等 → 再滚"可观测
      setTimeout(function () {
        appendBatch(feedState.batches + 1).then(function () {
          feedState.loading = false;
          statusEl.textContent = '已加载 ' + (BATCH * feedState.batches) + ' 条反馈';
          if (feedState.batches >= TOTAL_BATCHES) {
            feedState.exhausted = true;
            endEl.textContent = '已到底 · 没有更多反馈了';
          }
        }).catch(function () {
          feedState.loading = false;
          statusEl.textContent = '加载失败，请稍后重试';
        });
      }, LOAD_MS);
    }

    var scrollTimer = null;
    window.addEventListener('scroll', function () {
      feedState.scrollEvents += 1;
      // 防抖：**滚动停下来**并且停在底部，才加载下一批。
      // 这一条同时保证了"一次滚动只加载一批"：append 之后页面变高、当前位置不再是底部，
      // 而且不会再触发 scroll 事件 ⇒ 要加载下一批必须**再滚一次**。
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(function () {
        scrollTimer = null;
        if (atBottom()) loadNext();
      }, SETTLE_MS);
    });

    document.getElementById('more').addEventListener('click', function () {
      // ★ 迷惑项：这个按钮**什么都不加载**（看起来能点，推不动页面）
      feedState.decoyClicks += 1;
      moreNoteEl.textContent = '「加载更多」暂不可用：请在页面底部继续向下滚动，更早的反馈会自动加载。';
    });

    appendBatch(1).then(function () {
      statusEl.textContent = '已加载 ' + (BATCH * feedState.batches) + ' 条反馈';
    });
  </script>
</body></html>`;
}

// 播放验收台：**视频播放器状态**（playbook id = 'video-playback-verify'）。
//
// 这一类要造的是"**看起来在播 ≠ 真的在播**"。难点逐条造在机制里（不是加装饰）：
//
// ① **"看起来在播"的状态栏**：`#statusbar` 在**加载那一刻**写着「播放中 · 进度 00:00」，
//    而且**永远不刷新**（真实站点里这种烂状态栏很常见）。而页面用的是 `autoplay` +
//    首帧 `play()` 探测：**探针结果（成功/被拦的名字）与真实 paused 都如实记在
//    `window.__autoplayError` / `window.__autoplayPaused` 上**，并且**随后由页面自己
//    `pause()` 一次**（探针的一次播放不能算"用户要播"）—— 于是初始一定是
//    `paused === true`、`__decoded === 0`，而状态栏那句话是**假的**。
//    ⚠ 诚实说明（不许假装）：本 harness 里**做不到**让自动播放被策略拦住 ——
//      Playwright 给 Chromium 传 `--no-user-gesture-required`，且它自身持有用户激活
//      （实测：`--autoplay-policy=user-gesture-required` /
//      `document-user-activation-required` 都被无视，`play()` 一律 resolve）。
//      所以自动播放这一层**不作为难点计数**：难点是"状态栏说的话与真实状态相反"，
//      与自动播放是否被拦无关（见 golden.spec.mjs 里这条用例的注解）。
// ② **必须区分「在播 / 卡住 / 播完」**：页面把 video 的事件序列原样记在 `#ev-log` 上，
//    并且**专门触发一次真实的 `waiting`** —— 「跳转到末尾」用**副播放器**（同一个 blob）
//    seek 到**未缓冲区间**，`waiting` 是真的触发（实测：2 秒素材、seek 到 duration-1，
//    18/18 次都出现 `seeking → waiting → seeked → playing`）。`waiting` 一过就接着
//    `playing` → `ended`：**只看某一瞬间的 paused 会得出"卡住了"或"播完了"这两种
//    相反的错误结论**，要看事件序列与累计次数（`__waits`）。
// ③ **迷惑控件**：`#fake-play`（装饰性播放键）与 `#fake-bar`（假进度条）**推不动页面** ——
//    点它们只动一个纯 CSS 的假填充、`__decoyPresses` 加一，真播放器的
//    `__decoded` / `__waits` / 事件序列一个都不变。
// ④ **决定性状态藏在额外动作后**：真实数值只在点开「播放详情」之后才**被写进 DOM**
//    （初始 `#diag-body` 是空的，而且 `<details>` 折叠时 `innerText` 只有 summary）——
//    所以初始快照里没有任何进度数值。
// ⑤ **"真在播"必须是真证据**：`requestVideoFrameCallback` 的**帧计数**（`__decoded`，
//    注册必须早于挂 src）+ `currentTime` 的推进。`paused === false` 只作参考，不作判据。
//
// ⚠ 媒体来源：**零二进制资产**。仓库里没有视频素材，也不该塞一个大二进制进 git。
//   本页在**页面内**用 `canvas.captureStream()` + `MediaRecorder` 录一段**真的 WebM**
//   （2 秒，blob URL），再交给 `<video>` **真的解码播放** —— 不是假状态位。
//   实测证据：`__decoded`（RVFC 帧计数）推进到几十上百，`currentTime` 推进，
//   事件序列每次都出现 play → playing → (waiting) → … → pause → ended
//   （见 golden.spec.mjs 里这条用例的基线断言）。
//
// ⚠⚠ **时长（duration）是这条用例唯一的 flaky 来源**，有两副面孔，**两副都做成确定的**：
//
//   面孔 A：**元数据还没解析完**。MediaRecorder 录出来的 WebM，"时长"要等解复用器**读到文件尾**
//     才知道。实测事件顺序是 `durationchange:Infinity` → `loadedmetadata`（那一刻 duration
//     仍可能是 `Infinity`）→ `durationchange:<真时长>`。blob URL 是本地瞬间可读的，所以
//     **多数时候**解析会在 `loadedmetadata` 之前完成（直接就是真数字）—— 时好时坏就来自这里。
//     ⇒ 处理：`loadedmetadata` 之后若 duration 不是有限正值，就把 `currentTime` 设成 `1e101`
//       **逼 Chromium 完整解析**，拿到真时长后再复位 `currentTime = 0`；
//       **只有拿到有限真时长才设 `__ready = true`**（`__durFix.forced` 记着这一手用了几次）。
//       该页里**两处**读时长的地方（主播放器 + 「跳转到末尾」用的副本播放器）都走同一个入口，
//       因为 `duration - 1` 在 duration 还是 Infinity 时是空操作 ⇒ 那条"中途缓冲"判据也会跟着 flaky。
//       实测（同一段素材，直接读 vs 逼解析后读）：直接读 `Infinity` ／ 逼解析后 `1.97`。
//
//   面孔 B：**录制本身就录短了**（更隐蔽，实测在满载时抓到过红）。本轮 `--repeat-each=10`
//     （同时还有别的测试在跑、机器很忙）实测出现过 `v.duration === 0.979969`：文件是完整的、
//     也真的被解码了，**只是那段 WebM 的真实时长不到 1 秒**（同一轮还有 1.52 秒的）；
//     此时 `__probePlayError` 是空、`__durFix.forced` 是 0 —— 面孔 A 那手**救不了它**
//     （逼解析只会把 0.98 如实读出来）。任务里报的 `0.001` 就是这一副面孔的极端值
//     （WebM 的 Duration 字段写下来本就是极小值；我把**另一段**素材截到 1024 字节复现过
//     `0.086`、截到 4096 字节复现过 `0.787`，仅作形态旁证，不当作同一段素材的实测）。
//     ⇒ 处理：录完**先量一遍真实解码时长**，不在 [1.5, 12] 秒就**重录**（最多 3 次），
//       仍然不合格就**如实失败**（`__ready` 不会设成 true）。`__durFix.attempts` 记着录了几次。
//
//   ⇒ 判据 `dur0 > 1` **没有被放宽**：它验的是"这段 WebM 真的被解码出时长"，
//     而夹具保证的是"交给它的素材真的约 2 秒" —— 两件事各自都还在验。
//
// ⚠ body 收窄到 560px：CDP 的坐标类工具用元素**中心点**，面板贴右宽 640px，
//   全宽元素的中心会落在面板底下（点击/悬停会打到面板上）。见 /feed 的说明。
function videoPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具播放验收台</title>
<style>
  body { max-width: 560px; }
  video { display: block; width: 320px; background: #0f172a; }
  #fake-bar { position: relative; width: 320px; height: 14px; margin: 6px 0 2px;
              background: #e2e8f0; border: 1px solid #cbd5e1; cursor: pointer; }
  #fake-fill { width: 0%; height: 100%; background: #94a3b8; }
  button { display: inline-block; margin: 6px 8px 6px 0; padding: 6px 12px; }
  .note { color: #334155; }
  #ev-log { color: #0f172a; font-size: 13px; }
</style></head>
<body>
  <h1>播放验收台</h1>
  <p class="note">演示视频（页面自己录制并播放）。「播放详情」里的数字才是真实状态。</p>
  <video id="v" muted autoplay playsinline width="320" height="180" poster="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='320' height='180' fill='%23334155'/%3E%3C/svg%3E"></video>
  <div id="fake-bar" role="progressbar" aria-label="播放进度条" aria-valuenow="0"><div id="fake-fill"></div></div>
  <div id="bar-note" class="note">进度 00:00 / 00:00</div>
  <div id="ctl">
    <button id="fake-play" type="button">▶ 播放（演示）</button>
    <button id="real-play" type="button">播放视频</button>
    <button id="pause-mid" type="button">暂停视频</button>
    <button id="seek-end" type="button">跳转到末尾</button>
    <button id="open-diag" type="button">打开播放详情</button>
  </div>
  <div id="statusbar" role="status">播放中 · 进度 00:00</div>
  <div id="diag-when" role="status">播放详情尚未打开（先点「打开播放详情」）</div>
  <details id="diag"><summary>播放详情</summary><div id="diag-body"></div></details>
  <div id="diag-flags" hidden></div>
  <script>
    window.__probePlayError = '';
    window.__probePaused = null;
    window.__realPlays = 0;
    window.__pauses = 0;
    window.__decoyPresses = 0;
    window.__decoded = 0;
    window.__waits = 0;
    // ⚠ 单独记「**播放中途**出现的缓冲」：媒体在**加载那一刻**天然就会 waiting 一次
    //   （位置 0.0），所以「缓冲次数 > 0」是**恒真**的、不能当判据（注入缺陷实测过：假绿）。
    //   中途缓冲（位置 > 0.5 秒）才说明"播着播着卡住了" —— 那只能由 seek 到**未缓冲区间**造出来。
    window.__midWaits = 0;
    window.__lastMidWaitAt = -1;
    // ⑥ 「逼 Chromium 完整解析媒体」与「录制长度不合格就重录」这一手的账本：
    //    forced > 0 表示主播放器真的需要过"逼解析"（loadedmetadata 那一刻 duration 还不是真数字）；
    //    copyForced 单独记副本播放器（「跳转到末尾」那次），免得把主播放器的数字顶上去；
    //    recordDur 是**量出来的真实解码时长**，attempts 是录了几次才拿到合格素材。
    //    用例里有一条断言把它钉住，免得日后有人把这些保险删掉却以为"反正一直都很绿"。
    window.__durFix = { forced: 0, copyForced: 0, recordDur: null, targetDur: null, attempts: 0 };
    window.__seeked = 0;
    window.__events = [];
    window.__lastWaitingAt = -1;
    window.__ready = false;
    var v = document.getElementById('v');
    var statusEl = document.getElementById('statusbar');
    var barNote = document.getElementById('bar-note');
    var fakeFill = document.getElementById('fake-fill');
    var evLogEl = document.getElementById('ev-log');
    var diagBody = document.getElementById('diag-body');
    var probed = false;
    function pad2(n) { n = Math.floor(n); return (n < 10 ? '0' : '') + n; }
    function clock(t) { return pad2(t / 60) + ':' + pad2(t % 60); }
    // ⚠ 事件序列节点**必须每次现查**，不能像别的元素那样缓存引用：
    //   它在「打开播放详情」时才被注入。第一版缓存了它的引用（getElementById 一次）
    //   —— 那一刻它还是 null，于是**事件序列永远写不进 DOM**（实测：面板里其它数字都有、
    //   只有它空白）。而"事件序列"恰恰是本场景判断"在播/卡住/播完"的关键证据。
    function evLogNow() { return document.getElementById('ev-log'); }

    // ⑥ **时长必须是真的**：等 video 的 duration 落成**有限且 > 0** 的真数字，才对外宣称
    //    "媒体准备好了"；否则**逼 Chromium 完整解析**（loadedmetadata 之后 duration 可能还是
    //    Infinity 那种"还没解析完"的哨兵值）。
    //
    // 为什么必须有这一手（实测，不是推测）：
    //   · 媒体是页面内 MediaRecorder 现录的 WebM，时长要**把整段文件解析完**才知道。
    //   · 实测事件顺序：durationchange:Infinity → loadedmetadata（那一刻 duration 仍是 Infinity）
    //     →（解析到文件尾）→ durationchange:<真时长>。blob URL 本地瞬间可读，多数时候解析会在
    //     loadedmetadata 之前完成（那就直接是真数字）—— 这就是这条用例时好时坏的来源。
    //   · 处理：loadedmetadata 之后若 !isFinite(duration) || duration <= 0，就把 currentTime 设成
    //     一个天文数字（1e101）迫使解复用器读到文件尾，等真时长出来后再复位 currentTime = 0。
    //     ⚠ **必须等 durationchange/seeked 之后再读** —— 先读到的那个不作数。
    //   · **它救不了"素材本身就短"**（实测的边界）：对一段真实时长 0.98 秒的完整文件，
    //     逼解析也是如实读回 0.98 —— 那种红属于**录制长度**问题，见下面"媒体准备"那段
    //     的"量出来不合格就重录"。两件事分开兜，判据 dur0 > 1 一个字都没改。
    function ensureFiniteDuration(el, counterKey, cb) {
      var done = false;
      var rounds = 0;
      var timer = null;
      function forcedCount() { return Number(window.__durFix[counterKey]) || 0; }
      function finish(res) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        cb(res);
      }
      function ok() { return isFinite(el.duration) && el.duration > 0; }
      function oneShot(evName, fn) { el.addEventListener(evName, fn, { once: true }); }
      // 兜底：残余不确定性（例如某天 Chromium 改了行为、seek 不再触发完整解析）必须
      // **如实失败**，不许把 __ready 设成 true 把用例拖绿 —— 所以这里有硬超时。
      timer = setTimeout(function () {
        finish({ dur: el.duration, forced: forcedCount() > 0, timedOut: true });
      }, 8000);
      function round() {
        // ⚠ 这里**不靠 durationchange 当唯一判决**（实测的坑）：如果 duration 本来就已经是
        //   有限值，seek 之后 Chromium **不会**再发一次 durationchange（它没"变过"）——
        //   只等那个事件就会白白等到硬超时。所以用 seeked（seek 真做完的信号）+
        //   兜底计时，两者谁先到都行，然后再读一次 duration 判真伪。
        var settled = false;
        var settle = function () {
          if (settled) return;
          settled = true;
          if (rounds < 3 && !ok()) {
            rounds += 1;
            setTimeout(round, 50);
            return;
          }
          // 拿到真时长后**复位到 0**：判据要求初始播放位置是 0，而且复位之后
          // 后面那条"跳转到末尾"的 seek 才是从干净起点出发的。
          el.currentTime = 0;
          var done2 = function () { finish({ dur: el.duration, forced: true, timedOut: false }); };
          oneShot('seeked', done2);
          setTimeout(done2, 1500);
        };
        oneShot('seeked', settle);
        setTimeout(settle, 1500);
        // 逼解析：这个天文数字不需要是"合法时间"，Chromium 会把它夹到媒体末尾，
        // 关键是这一步**迫使解复用器读到文件尾**，从而算出真时长。
        el.currentTime = 1e101;
        // ⚠ 两个播放器分开计数：主播放器的 round 数被 spec 的断言钉住，而 agent 一轮里
        //   还会点「跳转到末尾」触发**副本**播放器的同一手；共用一个计数器会把它顶上去 ⇒ 假红。
        window.__durFix[counterKey] = forcedCount() + 1;
      }
      function verify() {
        if (ok()) { finish({ dur: el.duration, forced: forcedCount() > 0, timedOut: false }); return; }
        // ⚠ readyState 还是 0（连元数据都没到）时 seek 是空操作，必须等 loadedmetadata，
        //   否则会把"逼解析"浪费在一次无效 seek 上。
        if (el.readyState >= 1) round();
        else oneShot('loadedmetadata', function () { if (!done) verify(); });
      }
      oneShot('error', function () { finish({ dur: el.duration, forced: false, timedOut: false, error: true }); });
      // ⚠ 不能只看 loadedmetadata：它在 duration 还是 Infinity 的时候就可能已经触发过了
      //   （实测顺序见上）。所以**两条路都接上**：事件没来就等它，事件已经来过就直接校验。
      oneShot('loadedmetadata', verify);
      setTimeout(function () { if (!done) verify(); }, 0);
    }

    // ① 首帧的自动播放**探针**：结果如实记账（成功 / 被拦的错误名 + 那一刻的真实 paused）。
    //    探针本身不改变页面语义 —— 紧接着页面自己 pause() 一次（探针的播放不算用户要播）。
    function probeAutoplay() {
      if (probed) return;
      probed = true;
      var p = v.play();
      var settle = function (err) {
        if (err && err.name) window.__probePlayError = err.name;
        window.__probePaused = v.paused;
        v.pause();
        update();
      };
      if (p && p.then) p.then(function () { settle(null); }, function (e) { settle(e); });
      else settle(null);
    }

    // ② 事件序列：原样记下来。**三个状态（在播/卡住/播完）的区分只能靠它 + 累计次数**。
    ['loadedmetadata', 'play', 'playing', 'waiting', 'seeked', 'pause', 'ended'].forEach(function (evName) {
      v.addEventListener(evName, function () {
        window.__events.push(evName + '@' + v.currentTime.toFixed(1));
        if (evName === 'waiting') {
          window.__waits += 1;
          window.__lastWaitingAt = Number(v.currentTime.toFixed(1));
          // 中途缓冲：位置已经走过一段（> 0.5 秒）才叫"卡住"，加载那一刻那次不算
          if (v.currentTime > 0.5) {
            window.__midWaits += 1;
            window.__lastMidWaitAt = Number(v.currentTime.toFixed(1));
          }
        }
        if (evName === 'seeked') { window.__seeked += 1; }
        update();
      });
    });
    function evText() { return window.__events.slice(-10).join(' → '); }
    function diagOpened() { return document.getElementById('diag').open === true; }

    // 真实数值全部落进 DOM（供 inspect_element 读回）。
    function update() {
      var t = v.currentTime || 0;
      var d = v.duration || 0;
      // ⚠ 这条状态栏**故意不刷新**：它在加载那一刻写着「播放中 · 进度 00:00」，
      //   之后就不再变（有人中途暂停、播放已结束，它照旧说"播放中"）。
      //   它是"看起来在播"这句话的来源，**不是判据** —— 判据看下面那些数字。
      if (evLogNow()) evLogNow().textContent = '事件序列：' + (evText() || '—');
      var stEl = document.getElementById('d-state');
      if (stEl) {
        var state = v.paused
          ? (window.__decoded > 0 ? '已暂停（上次播放确实推进过；也可能已经播完）' : '未开始播放（尚未解码任何一帧）')
          : (v.ended
              ? '已播完'
              : (window.__lastWaitingAt >= 0 && t - window.__lastWaitingAt < 0.5 ? '卡住（缓冲中）' : '正在播放'));
        stEl.textContent = '状态：' + state;
        document.getElementById('d-time').textContent = '播放位置：' + t.toFixed(2) + ' 秒';
        document.getElementById('d-decoded').textContent = '已解码帧数：' + window.__decoded;
        document.getElementById('d-waits').textContent = '缓冲等待次数：' + window.__waits + '（其中播放中途 ' + window.__midWaits + ' 次，最近一次在 ' + window.__lastMidWaitAt.toFixed(1) + ' 秒）';
        document.getElementById('d-autoplay').textContent = '首次自动播放探测：' + (window.__probePlayError ? ('被拦（' + window.__probePlayError + '）') : '未被拦（play() 直接成功）');
        document.getElementById('d-real').textContent = '真实播放按钮按下次数：' + window.__realPlays + '；暂停按钮按下次数：' + window.__pauses;
        document.getElementById('d-decoy').textContent = '迷惑控件按下次数：' + window.__decoyPresses;
      }
      document.getElementById('diag-when').textContent = diagOpened()
        ? (v.ended ? '播放详情已打开 · 播放已结束（ended）' : '播放详情已打开 · 尚未播完')
        : '播放详情尚未打开（先点「打开播放详情」）';
      document.getElementById('diag-flags').textContent =
        'probeError=' + (window.__probePlayError || 'none') +
        ' decoded=' + window.__decoded + ' waits=' + window.__waits + ' midWaits=' + window.__midWaits +
        ' t=' + t.toFixed(2) + ' dur=' + d.toFixed(2) + ' paused=' + v.paused +
        ' ended=' + v.ended + ' durFix=' + window.__durFix.forced + ' takes=' + window.__durFix.attempts +
        ' statusbar=' + statusEl.textContent;
    }

    // ⑤ 真证据：RVFC 帧计数（真解码过多少帧）+ currentTime 推进。
    //    ⚠ 必须在**附上 src 之前**注册：实测（本机 Chromium）在 srcObject/src 已经挂上、
    //      媒体正在播之后才注册 RVFC 的回调**一次都不会被调用**（第一次探针就是 0 帧，
    //      改成先注册之后帧计数正常推进）。
    if (typeof v.requestVideoFrameCallback === 'function') {
      var loop = function () { window.__decoded += 1; v.requestVideoFrameCallback(loop); };
      v.requestVideoFrameCallback(loop);
    }
    setInterval(function () { if (!v.paused) update(); }, 200);

    // ④ 决定性状态只在**点开之后**才写进 DOM（初始 #diag-body 是空的）。
    //    ⚠ details 元素的 open 属性要**显式设**：只靠点 summary 在测试里不可靠，
    //      而折叠时 details 的正文**不进 innerText**（实证：innerText 只有 "播放详情"）——
    //      那"读详情"这条路会变成"读不到"，用例会误判成模型没做事。
    document.getElementById('open-diag').addEventListener('click', function () {
      document.getElementById('diag').open = true;
      if (!diagBody.innerHTML) {
        diagBody.innerHTML =
          '<div id="d-state" role="status"></div>' +
          '<div id="d-time"></div>' +
          '<div id="d-decoded"></div>' +
          '<div id="d-waits"></div>' +
          '<div id="d-autoplay"></div>' +
          '<div id="d-real"></div>' +
          '<div id="d-decoy"></div>' +
          '<div id="ev-log"></div>' +
          '<p class="note">说明：页面那条状态栏**不会刷新**，本面板的数字才是真实状态。' +
          '「事件序列」里的 waiting 是缓冲，playing 是恢复播放，ended 是播完。</p>';
      }
      update();
    });

    // ② 真实的 buffering：用**另一个 video 元素**（#diag-video）播同一段媒体，
    //    并 seek 到**未缓冲区间** —— waiting 是真的触发（不是伪造事件）。
    //    实测（Playwright 的 Chromium，2 秒素材）：seeking → waiting → seeked → playing → ended
    //    每次都出现；主播放器（#v）自己则停在这一刻（它不 seek），于是事件序列里同时看得到
    //    waiting 与它之后的状态。
    document.getElementById('seek-end').addEventListener('click', function () {
      var d2 = document.createElement('video');
      d2.muted = true;
      d2.setAttribute('playsinline', '');
      d2.style.width = '120px';
      d2.src = v.currentSrc || v.src;
      document.getElementById('ctl').appendChild(d2);
      ['play', 'playing', 'waiting', 'seeked'].forEach(function (t) {
        d2.addEventListener(t, function () {
          window.__events.push('副本:' + t + '@' + d2.currentTime.toFixed(1));
          if (t === 'waiting') {
            window.__waits += 1;
            window.__lastWaitingAt = Number(d2.currentTime.toFixed(1));
            // 副本播放器 seek 到**未缓冲区间**触发的那次 waiting 就是"中途缓冲"：
            // 它一定发生在位置 > 0.5 秒处（我们 seek 到 duration-1）
            if (d2.currentTime > 0.5) {
              window.__midWaits += 1;
              window.__lastMidWaitAt = Number(d2.currentTime.toFixed(1));
            }
          }
          update();
        });
      });
      // ⚠ 这里也必须**先等时长是真的**再 seek：副本读的是同一个 blob，loadedmetadata
      //   那一刻它的 duration 同样可能是 Infinity（实测），于是 duration - 1 还是 Infinity、
      //   seek 变成空操作 ⇒ waiting 不出现 ⇒ 用例的"中途缓冲"判据时好时坏地红。
      //   这是**同一条 flaky 的另一处入口**，一并做确定（判据本身一个字没改）。
      ensureFiniteDuration(d2, 'copyForced', function (res2) {
        if (!isFinite(res2.dur) || res2.dur <= 0) {
          window.__probePlayError = res2.timedOut ? 'copy-duration-timeout' : 'copy-duration-unreadable';
          update();
          return;
        }
        d2.play().then(function () {
          d2.currentTime = Math.max(0, d2.duration - 1);
        }).catch(function () {});
      });
      window.__seeked += 1;
      update();
    });

    // ③ 迷惑控件：看着像能播、能拖，推不动页面（只动纯 CSS 的假填充与一个计数）
    document.getElementById('fake-play').addEventListener('click', function () {
      window.__decoyPresses += 1;
      var n = 0;
      var t2 = setInterval(function () {
        n += 1;
        fakeFill.style.width = Math.min(100, n * 10) + '%';
        if (n >= 10) clearInterval(t2);
      }, 120);
      update();
    });
    document.getElementById('fake-bar').addEventListener('click', function () {
      window.__decoyPresses += 1;
      fakeFill.style.width = '35%';
      update();
    });

    // 真实播放键：真按下去（这是**用户的手势**，播放从此才真的开始）
    document.getElementById('real-play').addEventListener('click', function () {
      window.__realPlays += 1;
      var p = v.play();
      if (p && p.catch) p.catch(function (e) { window.__probePlayError = (e && e.name) ? e.name : String(e); update(); });
      update();
    });

    // 中途暂停：**状态栏不会跟着改**（它永远写着"播放中"）—— 这正是"看起来在播"的陷阱。
    // 真实状态要看事件序列（pause 之后没有 playing）与"已解码帧数"。
    document.getElementById('pause-mid').addEventListener('click', function () {
      window.__pauses += 1;
      v.pause();
      update();
    });

    // ① 媒体准备：页面内录 2 秒真 WebM（零二进制资产），交给 video 播放。
    //
    // ⚠⚠ **录制长度必须是确定的** —— 这是本页第二个、也是更隐蔽的 flaky 来源（实测抓到过红）：
    //    本机实测（--repeat-each=10，同时还有别的测试在跑、机器很忙的那一轮）出现过
    //    v.duration === 0.979969：**文件是完整的、也被真的解码了，只是"录短了"** ——
    //    2000ms 那次录制在满载下产出的 WebM 真实时长不到 1 秒（同一轮里还有 1.52 秒的），
    //    于是判据 dur0 > 1 红，而 __probePlayError 是 empty、__durFix.forced 是 0
    //    （逼解析把真实时长 0.98 如实读了出来，它**救不了"素材本身就短"**）。
    //    任务里给的 0.001 就是这个形态的极端值（WebM 的 Duration 字段写下来就是极小值）。
    //    ⇒ 处理：录完**先量一遍真实解码时长**，不在 [1.5, 12] 秒就**重录**（最多 3 次；
    //      每次都是新的 MediaRecorder + 新的 canvas）；仍然不合格就让它**如实失败**
    //      （__ready 不会被设成 true）。这样"约 2 秒素材"是**量出来的**，不是"一般都能录到"。
    //    ⚠ 判据 dur0 > 1 因此**没有被放宽**：它验的是"这段 WebM 真的被解码出时长"，
    //      而这里保证的是"交给它的那段素材真的约 2 秒" —— 两件事，各自都还在验。
    var DUR_MIN_OK = 1.5;
    var DUR_MAX_OK = 12;
    var RECORD_MS = 2000;
    var MAX_TAKES = 3;
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      var g = canvas.getContext('2d');
      var n2 = 0;
      setInterval(function () {
        n2 += 1;
        g.fillStyle = 'hsl(' + ((n2 * 13) % 360) + ',70%,45%)';
        g.fillRect(0, 0, 320, 180);
        g.fillStyle = '#fff'; g.font = '28px sans-serif';
        g.fillText('F' + n2, 14, 104);
      }, 33);
      window.__durFix.attempts = 0;
      // 每次重录都要把"媒体状态"清干净（否则上一段媒体的 readyState/duration 会串到下一段）
      function resetRecordState() {
        try { v.pause(); } catch (e) { /* 还没挂 src，忽略 */ }
        window.__durFix.recordDur = null;
        window.__durFix.forced = 0;
        window.__durFix.copyForced = 0;
      }
      function announceReady(res) {
        // ⚠ 顺序是判据的一部分，不能随手改：**先把播放位置复位到 0，再宣告 ready 并做探针**。
        //   实测踩到过：如果在"位置还没复位"时就把 __ready 设成 true，用例会在
        //   initial.t === 0 那条基线上读到 0.0001 —— 探针那次 play() 已经推进了一点点。
        //   复位是同步生效的 property：赋值后如果 seekable 非空，currentTime 立刻就是 0
        //   （实测 12/12 次都是 0），所以这里读一次确认，没到 0 就等 seeked。
        v.currentTime = 0;
        var go = function () {
          window.__ready = true;
          update();
          probeAutoplay();
        };
        if (v.currentTime === 0) { go(); return; }
        var done = false;
        var once = function () { if (done) return; done = true; go(); };
        v.addEventListener('seeked', once, { once: true });
        setTimeout(once, 1000);
      }
      function startRecording(take) {
        resetRecordState();
        var rec = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
        var chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          try {
            // ⚠⚠ **不要把 canvas 的 MediaStream 挂到这个 video 上**（第一版就是这么写的）：
            //   video 元素挂 MediaStream（srcObject）属于"实时流"，**自动播放策略对它不生效** ——
            //   于是"首帧探测"这条路会静默变成"自动播放成功"，与真实站点不同。
            //   这里只挂**录好的 blob URL**（文件型媒体）。素材本身仍然是真的：
            //   canvas 的动画帧被 MediaRecorder 编成真 WebM，再由 video 真解码播放。
            window.__durFix.attempts = take;
            v.src = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
            // ① 挂上 src 之后**先等时长变成真的**（见 ensureFiniteDuration 的实测说明：必要时由它
            //    把 currentTime 设成 1e101 逼 Chromium 完整解析，再复位 0），**然后**才宣称"准备好了"。
            //    这样 __ready === true 就等于"媒体真被解码、时长是真的"。
            ensureFiniteDuration(v, 'forced', function (res) {
              window.__durFix.recordDur = isFinite(res.dur) ? Number(res.dur) : String(res.dur);
              window.__durFix.targetDur = RECORD_MS / 1000;
              var sane = isFinite(res.dur) && res.dur > 0;
              if (!sane) {
                // 连时长都读不出来（文件不完整 / 8 秒内没解析完）：不设 __ready，如实失败。
                window.__probePlayError = res.timedOut ? 'duration-timeout' : 'duration-unreadable';
                update();
                return;
              }
              // ⚠ 这一步是"录制长度确定"的关键：**量出来的真实解码时长**说了算。
              if ((res.dur < DUR_MIN_OK || res.dur > DUR_MAX_OK) && take < MAX_TAKES) {
                startRecording(take + 1);
                return;
              }
              if (res.dur < DUR_MIN_OK || res.dur > DUR_MAX_OK) {
                // 重录到上限仍然不合格：如实留下错误标记，**不设 __ready**（用例会红在媒体这一层）。
                window.__probePlayError = 'record-duration-out-of-range:' + Number(res.dur).toFixed(3);
                update();
                return;
              }
              announceReady(res);
            });
          } catch (e) {
            window.__probePlayError = 'ready-handler:' + (e && e.message ? e.message : String(e));
            update();
          }
        };
        rec.start();
        setTimeout(function () { rec.stop(); }, RECORD_MS);
      }
      startRecording(1);
    } catch (e) {
      window.__probePlayError = 'record-failed:' + (e && e.message ? e.message : String(e));
    }
    update();
  </script>
</body></html>`;
}

// 比价下单页：**多候选收敛**（6 个候选 × 5 个可核对属性 + 详情里才有的决定属性 + 实时报价重读）。
//
// 这一类要造的是"**看起来都行**"的下一层：多个候选在**第一个属性**（标价，页面上最显眼）
// 上都说得通，只有逐条核对**全部约束**、并且把某些属性**重新读一次**，才能收敛到唯一正确的那个。
//
// ## 六个难点（每条都对应下面一段机制，不是装饰）
//
// ① **候选多、属性多**：6 个候选 × 5 个可核对属性（标价 / 到货天数 / 退货政策 / 供货方式 + 详情里的总价）。
// ② **第一个属性不足以决断**：标价最低的是 P-106（¥262），而它**退货要收 8% 手续费** ⇒
//    "看一眼标价就选"必然错。标价第二低的是 P-102（¥240），按缓存报价它**恰好是唯一过关的**（见④）。
// ③ **决定属性藏在额外动作后面**：**含运费的总价**只在展开详情之后才存在 ——
//    初始 HTML 的正文里既没有「总价」二字、也没有任何一个候选的总价数字。也就是说
//    "不展开详情就选"在**结构上**不可能（不是被 CSS 藏起来）。
// ④ **陈旧读取陷阱（本页的核心）**：展开详情时显示的是**缓存报价** `rawTotal`，
//    而页面上方的横幅写着"实时报价在详情里刷新"。每个候选的**第一次读一定是缓存值**，
//    而缓存值与实时值的差**会让决策翻转**（三条约束：总价 < 290 / ≤3 天 / 支持 7 天无理由退货）：
//      · 按**缓存**值：唯一过关的是 P-102（¥243）；P-105 是 ¥304（**超预算**）被排掉；
//      · 按**实时**值：P-102 跳到 ¥300（超预算，**被服务端拒**），过关的只剩 P-105（¥284）。
//    ⇒ "只读一次就下单"必然选到 P-102（次优且是错的），正确答案是 P-105。
//    ⚠ 这条铁律必须保住：**每个候选的第一次读一定是缓存值**（`fresh:false`），
//    与 agent 什么时候开始、读得多快无关 ⇒ 用例才可能稳定（不是靠时序碰运气）。
// ⑤ **约束落在指令里**，其中一条**容易被忽略**：「**支持 7 天无理由退货**」。
//    它在**不显眼的位置**（详情面板的最后一行，而不是列表上的徽标），且是排除 P-104 的那条；
//    而 P-106 的"退货要收手续费"只写在列表那一行里 —— 两条合起来才说明"退货"这个属性
//    真的要逐条核对（P-104 与 P-106 都被它排除）。
// ⑥ **提交要有服务端回执**：点「提交选择」后由 `/pick-commit` **在服务端按实时报价重算并校验**，
//    服务端记下**每一次尝试**（成功的 + 被拒的及原因）。因此"错误候选没有被提交过"这句话
//    有服务端日志作证，而不是"页面上看起来没点"。页面自己只把服务端的回执渲染出来。
//
// ## 页面自己记录的可断言状态（`window.__det`）
//   · `records[id]` = `{ rawTotal, total, rawDays, days, returnable, fresh, opens, reads, refreshes }`
//     —— **读的次数**与**最后一次读到的值**都记在里面 ⇒ 用例能区分"重读过"与"没重读"；
//     ⚠ `records` 是页面加载时**预建**好的（6 个键）⇒ "详情展开过没有"要看 `opens`，
//     不能看 `Object.keys(records).length`（那样写恒等于 6，实测踩到过）；
//   · `log` = 按顺序记下的每一次读 `{ id, total, fresh }` ⇒ 能证明"第一次读到的是缓存值"；
//   · `submits` / `rejected` / `submitted` / `picked` ⇒ 提交历史（服务端那一份才是权威，这里是镜像）。
// 富文本编辑器夹具（`/rich`）：**"看起来改上了 ≠ 真的改上了"**（④ 场景泛化 · 富文本）
//   ① `contenteditable` 只认**可信 / 带 inputType** 的输入：纯合成事件或直接赋值 ⇒ 状态**不更新**（`syntheticIgnored++`）✗
//   ② 必须保住**结构**（加粗 / 列表 / 链接）—— 页面自己数，判据**从结构取证**（不看 innerText）
//   ③ 工具栏作用于**选区**：没有选区就点 ⇒ 什么都不做（`noopClicks++`）✗
//   ④ 隐藏字段**只在 blur 时**同步（不失焦就读 = **旧值**；`syncs++`）✗
//   ⑤ 装饰性「B」图标：点了只动它自己（`fakeBold++`）✗
// 页面把状态写进 `#rt-status`（供 inspect_element 读回）与 `window.__rt`（供 E2E 断言）。
function richTextPage() {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具富文本编辑器</title>' +
    '<style>body{max-width:560px;font:15px/1.7 system-ui}' +
    '#rt-editor{min-height:90px;border:1px solid #cbd5e1;padding:8px}' +
    '.tb{display:inline-block;padding:4px 10px;margin-right:6px;border:1px solid #94a3b8;border-radius:6px;cursor:pointer}' +
    '</style></head><body>' +
    '<h1>富文本编辑器</h1>' +
    '<p>用工具栏按钮改格式；改完请把内容<b>读回来</b>确认。</p>' +
    '<div><span class="tb" id="rt-bold" role="button" tabindex="0">加粗</span>' +
    '<span class="tb" id="rt-list" role="button" tabindex="0">项目符号</span>' +
    '<span class="tb" id="rt-link" role="button" tabindex="0">插入链接</span>' +
    '<span class="tb" id="rt-fake-bold" role="button" tabindex="0">B</span>' +
    '<span class="tb" id="rt-select-all" role="button" tabindex="0">全选</span></div>' +
    '<div id="rt-editor" contenteditable="true" role="textbox" aria-label="正文"><p>第一段：这里是可以编辑的正文。</p></div>' +
    '<input type="hidden" id="rt-hidden" value="">' +
    '<div id="rt-status" role="status">尚未同步</div>' +
    '<script>' +
    'var st = window.__rt = { syntheticIgnored:0, noopClicks:0, syncs:0, fakeBold:0, inputs:0, strong:0, list:0, links:0, events:[] };' +
    // 临时诊断（用完删）：把 #rt-bold 上收到的每一个事件按顺序记下来（含 isTrusted 与 detail）
    '["mousedown","mouseup","click"].forEach(function(t){ document.getElementById("rt-bold").addEventListener(t, function(ev){ st.events.push(t + (ev.isTrusted ? ":trusted" : ":synthetic") + ":detail" + ev.detail); }, true); });' +
    'var ed = document.getElementById("rt-editor");' +
    'var hid = document.getElementById("rt-hidden");' +
    'var stEl = document.getElementById("rt-status");' +
    'function counts(){ st.strong = ed.querySelectorAll("strong,b").length; st.list = ed.querySelectorAll("ul li,ol li").length; st.links = ed.querySelectorAll("a[href]").length; }' +
    'function paint(){ counts(); stEl.textContent = "输入" + st.inputs + " 结构:粗" + st.strong + "列" + st.list + "链" + st.links + " 合成被拒" + st.syntheticIgnored + " 空操作" + st.noopClicks + " 同步" + st.syncs + " 装饰键" + st.fakeBold; }' +
    // ⚠ 判据从"必须 isTrusted"改成"**必须带 inputType**"：产品的 typing 只发**合成**事件（实测，即使 cdpEnabled:true）✗
    //   而**直接改 DOM / 纯赋值根本没有 beforeinput** ⇒ 陷阱仍然成立 ✓（基线断言不用改）
    'ed.addEventListener("beforeinput", function(ev){ if (ev.inputType) { st.inputs += 1; paint(); return; } if (ev.cancelable) ev.preventDefault(); st.syntheticIgnored += 1; paint(); });' +
    // 只惩罚"**没有** beforeinput 的输入事件"（纯合成派发）；带 inputType 的正常输入不再被误伤 ✓
    'ed.addEventListener("input", function(ev){ if (!ev.inputType && st.lastBeforeInput !== true) { st.syntheticIgnored += 1; paint(); } });' +
    // 真实编辑器里"全选"是**合法 UI**（本夹具提供可见控件）：合成按键造不出选区（`press_key` 也只发合成按键 ✗），
    //   所以给模型一条真实可达的选区路径；"没选就点按钮 ⇒ 空操作"的陷阱**保持不变** ✓
    'var selAll = document.getElementById("rt-select-all");' +
    'selAll.addEventListener("click", function(ev){ ev.preventDefault(); ed.focus(); var r = document.createRange(); r.selectNodeContents(ed); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); st.selectAlls = (st.selectAlls || 0) + 1; paint(); });' +
    'ed.addEventListener("blur", function(){ hid.value = ed.innerHTML; st.syncs += 1; paint(); });' +
    // 真实编辑器的做法：**记住最后一次非空选区**；点工具栏时若选区已被浏览器清掉就恢复它 ✓
    //   ⚠ 陷阱仍在：**从没选过**（lastRange 为 null）就点按钮 ⇒ 记一次空操作、结构不变 ✗
    'var lastRange = null;' +
    'document.addEventListener("selectionchange", function(){ var s = window.getSelection(); if (s && !s.isCollapsed && s.rangeCount && ed.contains(s.anchorNode)) { lastRange = s.getRangeAt(0).cloneRange(); } });' +
    'function needSel(ev, fn){ ev.preventDefault(); var s = window.getSelection(); var ok = !!(s && !s.isCollapsed && s.rangeCount && ed.contains(s.anchorNode)); if (!ok && lastRange) { s.removeAllRanges(); s.addRange(lastRange); ok = true; } if (!ok) { st.noopClicks += 1; paint(); return; } ed.focus(); var s2 = window.getSelection(); if (lastRange && (!s2 || s2.isCollapsed || !s2.rangeCount)) { s2.removeAllRanges(); s2.addRange(lastRange); } fn(); paint(); }' +
    // ⚠ **必须同时挂 `mousedown` 与 `click`**：真实鼠标走 `mousedown`（那时选区还在，要及时 preventDefault）；
    //   而内容脚本的 `click_element` 派发的是**合成 click**，**不会**触发 `mousedown` ✗
    //   ⇒ 只挂 mousedown 的话，脚本化路径点按钮**永远不会生效**（实测：strong 一直是 0）
    'function onTool(id, fn){ var el = document.getElementById(id); el.addEventListener("mousedown", function(ev){ ev.preventDefault(); needSel(ev, fn); }); el.addEventListener("click", function(ev){ if (ev.isTrusted && ev.detail === 0) return; needSel(ev, fn); }); }' +
    // ⚠ 不再依赖 `document.execCommand`（实测：选区活着、handler 也跑了，但结构**不落地** ✗）。
    //   改成**确定的 DOM 操作**：把选中的内容抽出来、包进目标元素再插回去（真实编辑器同样这么做 ✓）
    'function wrapSel(make){ var s = window.getSelection(); if (!s || !s.rangeCount || s.isCollapsed) return false; var r = s.getRangeAt(0); var node = make(); try { node.appendChild(r.extractContents()); r.insertNode(node); s.removeAllRanges(); var r2 = document.createRange(); r2.selectNodeContents(node); s.addRange(r2); return true; } catch (e) { return false; } }' +
    'onTool("rt-bold", function(){ wrapSel(function(){ return document.createElement("strong"); }); });' +
    'onTool("rt-list", function(){ wrapSel(function(){ var ul = document.createElement("ul"); ul.appendChild(document.createElement("li")); return ul; }); });' +
    'onTool("rt-link", function(){ wrapSel(function(){ var a = document.createElement("a"); a.setAttribute("href", "https://example.com/rf"); return a; }); });' +
    'document.getElementById("rt-fake-bold").addEventListener("click", function(ev){ ev.preventDefault(); st.fakeBold += 1; var me = this; me.style.color = me.style.color === "red" ? "" : "red"; paint(); });' +
    'paint();' +
    '<\/script></body></html>';
}

// HTML5 原生拖放夹具（`/h5drag`）：**"看起来拖过去了 ≠ 真的收到了"**（④ 场景泛化 · HTML5 拖放）
//   ① 原生拖放**不走鼠标事件**（合成 mousedown/mousemove 无效）⇒ 必须派发真的 DragEvent / 用 DataTransfer ✗
//   ② `drop` 只有在 `dragover` 里 `preventDefault()` 过才可能触发（**时机错 ⇒ drop 被浏览器吞掉**）
//   ③ payload 必须在 **`drop` 里**读（`dragover` 里读 `getData` 拿到空串）⇒ 空读记 `emptyDrops++` ✗
//   ④ 两个落点：只有右区接受 `RF-7391`；放错记 `wrongZone++` ✗
//   ⑤ 迷惑项：卡片看着能拖，但它的 `dragstart` 被 `preventDefault()` 取消（`fakeDrags++`）✗
// 状态写进 `#dd-status`（供 inspect_element 读回）与 `window.__dd`（供 E2E 断言）。
function html5DragPage() {
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具 HTML5 拖放</title>' +
    '<style>body{max-width:560px;font:15px/1.7 system-ui}' +
    '.zone{min-height:64px;border:2px dashed #94a3b8;border-radius:8px;padding:8px;margin:8px 0}' +
    '#dd-card{display:inline-block;padding:6px 12px;border:1px solid #475569;border-radius:6px;cursor:grab}' +
    '#dd-fake{display:inline-block;padding:6px 12px;border:1px solid #cbd5e1;border-radius:6px;cursor:grab;color:#94a3b8}' +
    '</style></head><body>' +
    '<h1>工单派发（拖放）</h1>' +
    '<p>把工单卡片拖到右边「收件区」；左边是退回区。</p>' +
    '<span id="dd-card" draggable="true" role="button" tabindex="0">工单 RF-7391</span>' +
    '<span id="dd-fake" draggable="true" role="button" tabindex="0">工单 RF-0000（已归档）</span>' +
    '<div id="dd-left" class="zone">退回区</div>' +
    '<div id="dd-right" class="zone">收件区</div>' +
    '<div id="dd-result" role="status">尚未收到任何工单</div>' +
    '<div id="dd-status" role="status">就绪</div>' +
    '<script>' +
    'var st = window.__dd = { dragStarts:0, dragOverAccepted:0, drops:0, acceptedDrops:0, wrongZone:0, emptyDrops:0, fakeDrags:0, lastPayload:"", lastZone:"" };' +
    'var res = document.getElementById("dd-result"); var stEl = document.getElementById("dd-status");' +
    'function paint(){ stEl.textContent = "拖动" + st.dragStarts + " 接受dragover" + st.dragOverAccepted + " 落下" + st.drops + " 收下" + st.acceptedDrops + " 放错" + st.wrongZone + " 空读" + st.emptyDrops + " 假卡" + st.fakeDrags; }' +
    'document.getElementById("dd-card").addEventListener("dragstart", function(ev){ st.dragStarts += 1; ev.dataTransfer.setData("text/plain", "RF-7391"); ev.dataTransfer.effectAllowed = "move"; paint(); });' +
    'document.getElementById("dd-fake").addEventListener("dragstart", function(ev){ st.fakeDrags += 1; ev.preventDefault(); paint(); });' +
    'function wire(id, isRight){ var z = document.getElementById(id);' +
    ' z.addEventListener("dragover", function(ev){ ev.preventDefault(); st.dragOverAccepted += 1; paint(); });' +
    ' z.addEventListener("drop", function(ev){ ev.preventDefault(); st.drops += 1;' +
    '  var payload = ev.dataTransfer ? String(ev.dataTransfer.getData("text/plain") || "") : "";' +
    '  if (!payload) { st.emptyDrops += 1; res.textContent = "落下了但没读到数据（payload 为空）"; paint(); return; }' +
    '  st.lastPayload = payload; st.lastZone = id;' +
    '  if (isRight && payload === "RF-7391") { st.acceptedDrops += 1; res.textContent = "已收下 " + payload + "（落点：" + id + "）"; }' +
    '  else { st.wrongZone += 1; res.textContent = "落点/内容不对：" + payload + " 落在 " + id; }' +
    '  paint(); }); }' +
    'wire("dd-left", false); wire("dd-right", true);' +
    'paint();' +
    '<\/script></body></html>';
}

function pickPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具比价下单</title>
<style>
  /* ⚠ body 收窄到 560px 与 feedPage 同样的理由：RecallFlow 面板默认贴右、宽 640px，
     而 CDP 类工具用元素**中心点**的视口坐标 —— 整行铺满时中心点会落在面板底下。 */
  body { max-width: 560px; }
  .intro { padding: 10px 0; color: #334155; }
  .quote { padding: 8px 0; color: #7c2d12; }
  .card { border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; margin: 10px 0; }
  .card h3 { margin: 0 0 6px; font-size: 15px; }
  .row1 { display: block; color: #334155; font-size: 13px; line-height: 1.6; }
  .back { color: #64748b; font-size: 12px; }
  .bad { color: #b91c1c; }
  .toggle { margin-top: 6px; }
  .detail { margin-top: 8px; padding: 8px 10px; background: #f8fafc; border-radius: 4px; }
  .line { display: block; font-size: 13px; line-height: 1.7; }
  .note { color: #0369a1; font-size: 12px; }
</style></head>
<body>
  <h1>备件询价 · 摄像头模组</h1>
  <div class="intro">
    <p>下面是 6 家供应商对同一支摄像头模组（型号 CM-40）的报价。列表上是**标价**（货价）；</p>
    <p>**含运费的实际金额只在展开详情之后才显示**，所以别只看列表那一列就下单。</p>
    <p>每家都标了到货天数与退货政策，请逐条核对后再提交。</p>
  </div>
  <div id="quote-banner" class="quote" role="status">
    报价单已缓存；系统会**逐个候选**重新询价一次，候选的**实时报价在详情里刷新**（**第一次读到详情后**很快生效，约 1 秒内）。
  </div>
  <div id="picks" role="list"></div>
  <div id="status" role="status"></div>
  <script>
    // ---- 每个候选的 5 个可核对属性 ----
    // quote  = 展开详情时**先**显示的缓存报价（第一次读必然是它）
    // live   = 该候选**第一次被读到之后** REFRESH_MS 才生效的实时报价（**总价与天数都可能变**）
    //
    // ★★ 数值是**算过**的，且与文件下方服务端的 PICK_PARTS.liveTotal **必须逐条相等**
    //    （liveTotal = list + live.fee）。理由：服务端是判定的权威，页面是展示 ——
    //    两边一旦漂移，"缓存值 vs 实时值会让决策翻转"这条就静默失效（真实踩过一次：
    //    服务端 liveTotal 写 265 而页面算出来 249，结果**服务端接受了错误候选**）。
    //
    // 按**缓存**报价（第一次读到的）：只有一个候选同时满足三条约束 —— P-102（¥243）；
    // 按**实时**报价：唯一满足的是 P-105（¥283），而 P-102 跳到 ¥300（超 290 预算）。
    // ⇒ 正确答案从 P-102 **翻转**成 P-105，"只读一次就下单"必然选错（详见文件顶部④）。
    var PARTS = [
      { id: 'p101', name: '锐视 S1 摄像头模组', supplier: '锐视光电', list: 285, days: 2, ret: '支持 7 天无理由退货',
        retOk: true, note: '', quote: { fee: 8,  days: 2 }, live: { fee: 20, days: 2 } },
      { id: 'p102', name: '星野 X2 摄像头模组', supplier: '星野影像', list: 240, days: 3, ret: '支持 7 天无理由退货',
        retOk: true, note: '', quote: { fee: 3,  days: 3 }, live: { fee: 60, days: 3 } },
      { id: 'p103', name: '云台 Y3 摄像头模组', supplier: '云台科技', list: 268, days: 4, ret: '支持 7 天无理由退货',
        retOk: true, note: '', quote: { fee: 25, days: 4 }, live: { fee: 28, days: 3 } },
      { id: 'p104', name: '铭匠 M1 摄像头模组', supplier: '铭匠精工', list: 296, days: 1, ret: '',
        retOk: false, note: '退货：仅支持质量问题换货，不支持无理由退货。',
        quote: { fee: 4,  days: 1 }, live: { fee: 4,  days: 1 } },
      { id: 'p105', name: '昊远 H5 摄像头模组', supplier: '昊远电子', list: 279, days: 3, ret: '支持 7 天无理由退货',
        retOk: true, note: '', quote: { fee: 30, days: 3 }, live: { fee: 4,  days: 3 } },
      { id: 'p106', name: '安视 A9 摄像头模组', supplier: '安视安防', list: 262, days: 5, ret: '',
        retOk: false, note: '退货：可退，但要收订单金额 8% 的手续费。',
        quote: { fee: 9,  days: 5 }, live: { fee: 29, days: 5 } }
    ];
    // 报价刷新的延时：**只影响"等刷新"的代价**，不影响那条**结构性**性质 ——
    // 语义：**从"该候选第一次被读到"算起**（而不是从"展开"算起，见 observeDetail()）
    // ⇒ "只读一次必然是缓存价"仍然成立 ✓
    // ⚠ 第五轮真模型实测：原值 2000ms 让模型**等不出刷新**（它一次展开 6 家、只有 1 家等到，
    //   另 5 家各白等 8s）→ 绕圈 → **180s 超时被 kill** ✗ 故下调到 700ms（"等"的代价几乎为零）。
    var REFRESH_MS = 700;

    window.__det = {
      submits: 0,        // 尝试提交的次数（成功的 + 被拒的都算）
      rejected: 0,       // 被服务端拒掉的次数
      rejectedIds: [],   // 被拒的候选 id（服务端判的）
      submitted: [],     // 被服务端**接受**过的候选 id（服务端判的）
      lastSubmitted: null,
      picked: null,      // 当前选中的候选（页面上只有一个）
      records: {},       // id -> 每个候选的属性 + 读次数 + 最后一次读到的值
      log: []            // 按顺序记下每一次读（含 fresh 标记）
    };
    var det = window.__det;
    var picksEl = document.getElementById('picks');
    var statusEl = document.getElementById('status');

    function money(n) { return '¥' + Math.round(n); }

    // 把某个候选的详情面板填成"缓存报价的样子"（展开的那一刻先显示它）。
    // ★★ 展开之前**没有任何地方**把总价写进 DOM —— 列表里只有标价，
    //    所以"初始快照里没有决定性属性"是**结构性**的（不是靠 CSS 藏起来）。
    function paintRaw(id) {
      var r = det.records[id];
      document.getElementById('total-' + id).textContent = money(r.rawTotal);
      document.getElementById('fee-' + id).textContent = money(r.rawFee);
      document.getElementById('days-' + id).textContent = String(r.rawDays) + ' 天';
      document.getElementById('detail-' + id).setAttribute('data-live', '0');
    }

    // **记一次读**：把 DOM 上**当前实际显示**的那个总价记下来（值与"是否实时"一起记）。
    //
    // ★★ 这是全页唯一"读属性"的入口，而且它**不改 DOM** —— 改 DOM 会再次触发观察者，
    //    形成"读→写→读"的同步死循环（实测：Playwright 点一下按钮直接卡死 30 秒）。
    //    真实站点也正是这样：节点上写着什么，读到的就是什么。
    //
    // ★★ 两种调用者必须分开（fromClient）：
    //      · fromClient = true：**agent 真的读了这个节点**。页面自己看不出"被读了"
    //        （innerText / textContent 不产生 DOM 变更），所以框架会在**被读的那个元素上**
    //        派发 recallflow:element-read（见 lib/page/commands.js 的 notifyElementsRead），
    //        这里就是那个监听器的落点；
    //      · fromClient = false：**页面自己写节点**引起的观察者回调（paintRaw() 摆缓存价、
    //        刷新定时器写实时价）。它是"页面重渲染"，不是"agent 读了一次"。
    //
    // ★★ 刷新定时器**只由**"该候选的第一次**真的被读**"启动（就是下面那一行）。
    //    这就是本夹具的结构性保证 —— 与 agent 什么时候开始、读得多快、LLM 往返多久**全都无关**：
    //      · 展开 ⇒ 节点上写的是**缓存报价**（paintRaw），而且**还没有**安排任何刷新；
    //      · 第一次读 ⇒ （读到的值在**读的那一刻**就已经定下 = 缓存报价），读完之后才开始重新询价；
    //      · 读后 REFRESH_MS ⇒ 同一个节点被改写成**实时报价**并给出刷新说明；
    //      · 之后读 ⇒ 实时报价。
    //    ⇒ "只读一次就下单"**必然**用到过期值；"读 → 等刷新说明 → 再读"**必然**拿到实时值。
    //    ⚠ 改前是"**展开时**就起定时器"：真模型"展开"与"读"之间隔着 LLM 往返（数秒），
    //      于是它第一次读到的已经是实时价、缓存价从未进过它的上下文（实测 4/4 都如此）。
    function observeDetail(id, fromClient) {
      var r = det.records[id];
      var shown = document.getElementById('total-' + id).textContent;
      var firstClientRead = fromClient && r.clientReads === 0;
      if (fromClient) r.clientReads += 1;
      if (shown !== r.lastReadTotal) {
        r.reads += 1;
        r.lastReadTotal = shown;
        r.lastReadFresh = r.fresh;
        det.log.push({ id: id, total: shown, fresh: r.fresh, client: !!fromClient });
      }
      // ★ 顺序是关键：本函数由"读"的**通知**触发，而那条通知是在 get_text **算出文本之后**
      //   才派发的 ⇒ 这一次读拿到的值在**读的那一刻**就已经定了（展开后还没有任何刷新）
      //   ⇒ **必然是缓存报价**。从这一行起才开始重新询价的时钟。
      if (firstClientRead) scheduleRefresh(id);
    }

    function scheduleRefresh(id) {
      var r = det.records[id];
      if (r.timer || r.fresh) return;   // 已经安排过 / 已经是实时价：不重复安排
      r.timer = setTimeout(function () {
        r.timer = null;
        r.fresh = true;
        r.refreshes += 1;
        r.refreshMsg = '实时报价已重新询价：' + money(r.fee) + ' 元运费档，缓存报价已过期。';
        document.getElementById('note-' + id).textContent = r.refreshMsg;
        // ★ 这里**写**一次总价节点：写下去会被节点的 MutationObserver 观察成一次"页面重渲染"
        //   （fromClient = false，所以它不会再去安排定时器），于是"实时报价生效"这件事本身也进 log
        //   （与真实站点"数据到了就重渲染"同形）。
        document.getElementById('total-' + id).textContent = money(r.total);
      }, REFRESH_MS);
    }

    // 选中：页面上只有一个候选处于选中态（服务端以"提交时的选中项"为准）。
    function selectPart(id, btn) {
      det.picked = id;
      var all = picksEl.querySelectorAll('.pick');
      for (var i = 0; i < all.length; i++) {
        all[i].textContent = '选择此项';
        all[i].setAttribute('aria-pressed', 'false');
      }
      btn.textContent = '已选择';
      btn.setAttribute('aria-pressed', 'true');
      statusEl.textContent = '已选择 ' + id.toUpperCase() + '，尚未提交。';
    }

    // 提交：服务端按**实时报价**重算约束并记下每一次尝试（含被拒的原因）。
    // 页面只把服务端回执渲染出来 —— **界面的成功态不作为任何证据**。
    function submitPick() {
      if (!det.picked) { statusEl.textContent = '请先选择一个候选。'; return; }
      fetch('pick-commit?part=' + encodeURIComponent(det.picked))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          det.submits += 1;
          if (data && data.ok) {
            det.lastSubmitted = data.part;
            det.submitted.push(data.part);
            statusEl.textContent = data.message;
          } else if (data && data.rejected) {
            det.rejected += 1;
            det.rejectedIds.push(data.part);
            statusEl.textContent = '提交被拒：' + data.message;
          } else {
            statusEl.textContent = '提交失败：' + ((data && data.error) || '服务端没有回执');
          }
        })
        .catch(function (e) {
          statusEl.textContent = '提交失败：' + e.message;
        });
    }

    function buildCard(p) {
      var card = document.createElement('div');
      card.className = 'card';
      card.id = 'card-' + p.id;
      card.setAttribute('data-part', p.id);
      card.setAttribute('role', 'listitem');

      var h = document.createElement('h3');
      h.textContent = p.name + ' · 供应商：' + p.supplier;
      card.appendChild(h);

      var row1 = document.createElement('div');
      row1.className = 'row1';
      row1.textContent = '编号 ' + p.id.toUpperCase() + ' · 标价 ' + money(p.list) +
        ' · 到货 ' + p.days + ' 天 · ' + (p.ret || '（退货政策见详情）') +
        (p.note ? ' · ' + p.note : '') + ' · 供货方式：' + (p.id === 'p104' ? '要定金' : '无定金');
      card.appendChild(row1);

      var bar = document.createElement('div');
      var toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'toggle';
      toggle.id = 'toggle-' + p.id;
      toggle.setAttribute('role', 'button');
      toggle.setAttribute('aria-label', '查看详情 ' + p.id.toUpperCase());
      toggle.textContent = '查看详情';
      bar.appendChild(toggle);

      var pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'pick';
      pick.id = 'pick-' + p.id;
      pick.setAttribute('role', 'button');
      pick.setAttribute('aria-label', '选择 ' + p.id.toUpperCase());
      pick.setAttribute('aria-pressed', 'false');
      pick.textContent = '选择此项';
      bar.appendChild(pick);
      card.appendChild(bar);

      var detail = document.createElement('div');
      detail.className = 'detail';
      detail.id = 'detail-' + p.id;
      detail.setAttribute('data-live', '0');
      detail.hidden = true;
      detail.setAttribute('role', 'group');
      detail.setAttribute('aria-label', '详情 ' + p.id.toUpperCase());
      detail.innerHTML =
        '<span class="line">总价（含运费）：<span id="total-' + p.id + '"></span></span>' +
        '<span class="line">运费：<span id="fee-' + p.id + '"></span></span>' +
        '<span class="line">到货：<span id="days-' + p.id + '"></span></span>' +
        '<span class="line">退货：' + (p.ret || p.note || '—') + '</span>' +
        '<span class="line note" id="note-' + p.id + '"></span>';
      card.appendChild(detail);

      toggle.addEventListener('click', function () {
        var r = det.records[p.id];
        r.opens += 1;
        if (detail.hidden) {
          detail.hidden = false;
          toggle.textContent = '收起详情';
          // 展开只做一件事：把**缓存报价**摆上节点（并记一次"页面重渲染"）。
          // ⚠ **不在这里**起刷新定时器 —— 它由"第一次真的读到这个节点"启动（见 observeDetail）。
          paintRaw(p.id);
        } else {
          detail.hidden = true;
          toggle.textContent = '查看详情';
        }
      });
      // ★★ "读属性"分两路（详见 observeDetail 的注释）：
      //   · 节点被**页面自己**改写（paintRaw / 刷新定时器）⇒ observer 走 fromClient = false，
      //     只记一次"页面重渲染"，**不**启动刷新；
      //   · 节点被 **agent 读**⇒ 框架在**被读的那个元素上**派发 recallflow:element-read
      //     （lib/page/commands.js 的 notifyElementsRead；读取类是 innerText/textContent，
      //     **不产生任何 DOM 变更** ⇒ 页面无法用 MutationObserver 察觉"被读了"，
      //     所以必须有这个信号）。这里收到就按 fromClient = true 记一次读。
      //   没有这条，"agent 看到什么"与"页面写了什么"就分不开，"第一次读必然是缓存价"也无从保证。
      var totalNode = detail.querySelector('#total-' + p.id);
      totalNode.addEventListener('recallflow:element-read', function () { observeDetail(p.id, true); });
      new MutationObserver(function () { observeDetail(p.id, false); })
        .observe(totalNode, { childList: true, characterData: true, subtree: true });
      pick.addEventListener('click', function () { selectPart(p.id, pick); });
      return card;
    }

    PARTS.forEach(function (p) {
      det.records[p.id] = {
        list: p.list,
        rawFee: p.quote.fee,
        fee: p.live.fee,
        rawDays: p.quote.days,
        days: p.live.days,
        rawTotal: p.list + p.quote.fee,   // 缓存总价 = **第一次**读到的那个
        total: p.list + p.live.fee,       // 实时总价 = 刷新之后才是它
        returnable: p.retOk,
        fresh: false,
        opens: 0,
        reads: 0,
        clientReads: 0,     // agent **真的读**这个总价节点的次数（页面自己写节点不算）
        refreshes: 0,
        lastReadTotal: null,
        lastReadFresh: null,
        timer: null,
        refreshMsg: ''
      };
      picksEl.appendChild(buildCard(p));
    });

    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.id = 'submit';
    submitBtn.setAttribute('role', 'button');
    submitBtn.setAttribute('aria-label', '提交选择');
    submitBtn.textContent = '提交选择';
    submitBtn.addEventListener('click', submitPick);
    picksEl.parentNode.insertBefore(submitBtn, statusEl);
  </script>
</body></html>`;
}

// 比价下单的**服务端**数据与提交记录（权威副本，与 pickPage 的 PARTS 必须一致）。
//
// 为什么要两份：① 页面那份是"客户端的缓存/展示"，而**判定必须由服务端做** ——
// 这正是本块要的"提交要有服务端回执"（界面的成功态不作为证据）；
// ② 服务端按**实时报价**重算约束，于是"只读了一次缓存报价就下单"会在服务端被拒，
//    而不是被页面悄悄放过。
//
// `PICK_COMMITS` 是**每一次尝试**的日志：成功的与被拒的（含原因）都在里面 ——
// "错误候选没有被提交过"这句话因此有服务端证据。
const PICK_PARTS = {
  p101: { name: '锐视 S1 摄像头模组', supplier: '锐视光电', liveTotal: 305, liveDays: 2, returnable: true, deposit: false },
  p102: { name: '星野 X2 摄像头模组', supplier: '星野影像', liveTotal: 300, liveDays: 3, returnable: true, deposit: false },
  p103: { name: '云台 Y3 摄像头模组', supplier: '云台科技', liveTotal: 296, liveDays: 3, returnable: true, deposit: false },
  p104: { name: '铭匠 M1 摄像头模组', supplier: '铭匠精工', liveTotal: 300, liveDays: 1, returnable: false, deposit: true },
  p105: { name: '昊远 H5 摄像头模组', supplier: '昊远电子', liveTotal: 283, liveDays: 3, returnable: true, deposit: false },
  p106: { name: '安视 A9 摄像头模组', supplier: '安视安防', liveTotal: 291, liveDays: 5, returnable: false, deposit: false },
};
/** 提交约束（唯一事实来源）。指令里的三条必须与这三条一致。 */
const PICK_RULES = { maxTotal: 290, maxDays: 3, needReturnable: true };
let PICK_COMMITS = [];

/** 服务端校验：按**实时报价**逐条核对约束，返回拒绝原因（通过则返回 null）。 */
function pickRejectReason(part) {
  const p = PICK_PARTS[part];
  if (!p) return '没有这个候选编号：' + part;
  const bad = [];
  if (!(p.liveTotal < PICK_RULES.maxTotal)) bad.push('总价 ' + p.liveTotal + ' 元不低于 ' + PICK_RULES.maxTotal + ' 元');
  if (!(p.liveDays <= PICK_RULES.maxDays)) bad.push('到货 ' + p.liveDays + ' 天超过 ' + PICK_RULES.maxDays + ' 天');
  if (PICK_RULES.needReturnable && !p.returnable) bad.push('不支持 7 天无理由退货');
  return bad.length ? bad.join('；') : null;
}

// 信息流的数据：**标题与订单号都只在服务端**（夹具页的 HTML/JS 里一个字都没有）。
//
// 这是两个难点的**结构性**保证（不是"藏在 CSS 后面"，而是页面里根本没有这些文本）：
//   · 标题按批从 /feed-batch 取 ⇒ 第 4 批的标题在滚动加载之前**不存在**于页面里；
//   · 订单号只在 /feed-preview 里，而它只在**可信** mouseenter 时被请求一次 ⇒ 不 hover 读不到。
// 目标条目是第 38 条（0 基下标）「结算页白屏，刷新后才恢复」，它的订单号是 SO-8842。
// ⚠ 它刻意放在第 4 批**靠后**的位置：滚到底之后它就在视口里（视口高 720 时还有几百像素余量），
//   于是脚本可以**直接 hover**，不必"滚到目标 → 立刻 hover" —— 后者会被 Chromium
//   在滚动后按**真实光标位置**重算的 hover 状态立刻清掉（实测：滚动后约 60ms 补发一次重算，
//   鼠标被"挪"回真实光标处，刚填好的预览随即被清空）。
const FEED_ITEMS = [
  ['登录后头像不显示', 'SO-4101', '张伟', '已复现'],
  ['消息列表重复推送', 'SO-7788', '李娜', '受理中'],
  ['表格导出少一列', 'SO-2299', '王强', '已修复'],
  ['图片上传进度卡住', 'SO-6642', '陈静', '待确认'],
  ['夜间模式颜色反差低', 'SO-3315', '刘洋', '受理中'],
  ['搜索建议不刷新', 'SO-9027', '张伟', '已复现'],
  ['分页跳转回到首页', 'SO-1184', '李娜', '待确认'],
  ['通知红点无法清除', 'SO-5560', '王强', '已修复'],
  ['时间显示时区不对', 'SO-8433', '陈静', '受理中'],
  ['表单粘贴被截断', 'SO-2718', '刘洋', '已复现'],
  ['弹窗按钮点不动', 'SO-6094', '张伟', '受理中'],
  ['列表滚动位置丢失', 'SO-4477', '李娜', '已修复'],
  ['附件下载失败', 'SO-9351', '王强', '待确认'],
  ['头像裁剪偏移', 'SO-1266', '陈静', '受理中'],
  ['快捷键在输入框里也生效', 'SO-7820', '刘洋', '已复现'],
  ['收藏后列表不更新', 'SO-3589', '张伟', '待确认'],
  ['草稿没有自动保存', 'SO-6103', '李娜', '已修复'],
  ['标签拖动后顺序错乱', 'SO-2917', '王强', '受理中'],
  ['分享链接过期太快', 'SO-8674', '陈静', '已复现'],
  ['富文本粘贴样式丢失', 'SO-4058', '刘洋', '待确认'],
  ['评论区折叠后无法展开', 'SO-7331', '张伟', '受理中'],
  ['批量删除提示语歧义', 'SO-1592', '李娜', '已修复'],
  ['移动端底部被键盘遮挡', 'SO-5806', '王强', '已复现'],
  ['图表颜色区分度不足', 'SO-9243', '陈静', '待确认'],
  ['重复登录不提示', 'SO-3170', '刘洋', '受理中'],
  ['上传大文件没有进度', 'SO-6485', '张伟', '已修复'],
  ['日期选择器跨月错位', 'SO-2038', '李娜', '待确认'],
  ['导出的表格有乱码', 'SO-8562', '王强', '已复现'],
  ['消息搜索不到历史记录', 'SO-4727', '陈静', '受理中'],
  ['页面刷新后表单清空', 'SO-7419', '刘洋', '已修复'],
  ['多选后批量操作无反馈', 'SO-1853', '张伟', '待确认'],
  ['复制按钮在 Safari 无效', 'SO-5968', '李娜', '已复现'],
  ['语音消息播放中断', 'SO-3702', '王强', '受理中'],
  ['二维码扫描识别慢', 'SO-8146', '陈静', '待确认'],
  ['地址簿选择后不生效', 'SO-7505', '刘洋', '已复现'],
  ['优惠券叠加算错金额', 'SO-2471', '李娜', '受理中'],
  ['订单状态不同步', 'SO-6993', '王强', '已修复'],
  ['客服入口在深色模式看不见', 'SO-1348', '陈静', '待确认'],
  ['结算页白屏，刷新后才恢复', 'SO-8842', '张伟', '已复现'],
  ['支付结果页一直加载中', 'SO-3827', '张伟', '受理中'],
  ['发票信息填写被清空', 'SO-9116', '李娜', '已修复'],
  ['退款进度查不到', 'SO-5084', '王强', '待确认'],
  ['物流轨迹缺少最新一条', 'SO-2273', '陈静', '已复现'],
  ['收藏夹排序不稳定', 'SO-6701', '刘洋', '受理中'],
  ['分享到微信打不开', 'SO-1495', '张伟', '已修复'],
  ['消息提醒延迟几分钟', 'SO-8938', '李娜', '待确认'],
  ['图片放大后无法关闭', 'SO-3416', '王强', '已复现'],
  ['表格列宽拖动后复位', 'SO-7285', '陈静', '受理中'],
  ['时间轴节点重叠', 'SO-1929', '刘洋', '已修复'],
  ['底部导航遮挡内容', 'SO-5367', '张伟', '待确认'],
];

// 级联下拉框页：选了省份，城市才**异步**填进去。
//
// 三层难点叠在一起（真实表单里很常见）：
//   ① 城市框初始是 **disabled**、并且只有一句「请先选省份」—— 不先选省份根本选不了城市；
//   ② 选了省份之后，城市选项要**几秒后**才填进来（真实站点是请求回来才有）——
//      "选完立刻选城市"会得到「未找到匹配的 option」，而那句话极易被读成"页面上没有这个城市"；
//   ③ 填充期间城市框**还是 disabled** —— 所以光等"选项出现"不够，还要等到**可用**。
//
// ⚠ 延迟刻意取 **3000ms**，必须**大于真模型一轮工具往返**（实测约 1 秒）。
// 起初写的是 300ms，结果真模型"选完省份立刻选城市"**照样成功** ——
// 那 300ms 被它自己的往返延迟吃掉了，也就是说**这个场景在真模型下什么都没验到**
// （脚本化 E2E 仍会过，因为它显式等了；只有真模型 eval 才能暴露这一点）。
//
// 另外：option 在闭合的 select 里**没有布局盒子**，所以等它出现要用
// state:"attached"（挂在 DOM 上），用 visible 会一直等不到 —— 这点写进了技能。
function cascadePage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具配送范围</title></head>
<body>
  <h1>配送范围</h1>
  <label for="prov">省份</label>
  <select id="prov" role="combobox" aria-label="省份">
    <option value="">请选择</option>
    <option value="zj">浙江</option>
    <option value="js">江苏</option>
  </select>
  <label for="city">城市</label>
  <select id="city" role="combobox" aria-label="城市" disabled>
    <option value="">请先选省份</option>
  </select>
  <button id="ok" type="button" role="button" aria-label="提交配送范围">提交配送范围</button>
  <div id="status" role="status">未提交</div>
  <script>
    var CITIES = { zj: [['hz', '杭州'], ['nb', '宁波']], js: [['nj', '南京'], ['sz', '苏州']] };
    window.__submits = 0;
    window.__picked = null;
    var prov = document.getElementById('prov');
    var city = document.getElementById('city');
    // ⚠ 变量名**不能叫 status**：window.status 是浏览器的**遗产属性**（状态栏文本），
    // var status = … 在经典脚本里**不会遮蔽它** —— 赋值走的是它自带的 setter，
    // 读回来是一个**字符串**（不是元素），于是 status.textContent = '…' 变成
    // "给字符串设属性"：**宽松模式下静默无效、不抛异常**。
    // 实测代价：提交处理看起来完全没生效（回执一直是「未提交」），而 __submits / __picked 都正常。
    //（本段在模板字符串里，注释中不能出现反引号。）
    var statusEl = document.getElementById('status');
    function labelOf(sel) {
      var o = sel.options[sel.selectedIndex];
      return o ? o.textContent : '';
    }
    prov.addEventListener('change', function () {
      city.disabled = true;
      city.innerHTML = '<option value="">加载中…</option>';
      setTimeout(function () {
        var list = CITIES[prov.value] || [];
        city.innerHTML = '<option value="">请选择</option>' +
          list.map(function (p) { return '<option value="' + p[0] + '">' + p[1] + '</option>'; }).join('');
        city.disabled = false;
      }, 3000);
    });
    document.getElementById('ok').addEventListener('click', function () {
      window.__submits += 1;
      window.__picked = { prov: prov.value, city: city.value };
      statusEl.textContent = city.value
        ? ('已提交：' + labelOf(prov) + ' / ' + labelOf(city))
        : '请先选择城市';
    });
  </script>
</body></html>`;
}

// 配送方式页：**必须比较选项**才能选对（"选最便宜的那个"）。
//
// 难点在于：这是一个**原生 `<select>`**，闭合状态下它的 `<option>` 文案
// **不在页面正文里**（没有布局盒子，正文抽取按"不可见"跳过）——
// 所以 `get_page_snapshot` 的 text 里只有「配送方式」这个 label，**看不到 ¥8 / ¥22 / ¥5**。
// 而任务只说了"最便宜"，没有点明是哪一个 —— 不把选项列出来就无从比较。
//
// 价格刻意只写在 option 文案里（真实站点也常这样），并让"最便宜"**不是**默认项、
// 也不是第一个：猜 value / 猜顺序都会错。
function shippingPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具配送方式</title></head>
<body>
  <h1>选择配送方式</h1>
  <label for="ship">配送方式</label>
  <select id="ship" role="combobox" aria-label="配送方式">
    <option value="">请选择</option>
    <option value="std">标准配送 · ¥8 · 3-5 天</option>
    <option value="fast">次日达 · ¥22 · 1 天</option>
    <option value="eco">经济配送 · ¥5 · 7 天</option>
  </select>
  <button id="ok" type="button" role="button" aria-label="确认配送方式">确认配送方式</button>
  <div id="status" role="status">未确认</div>
  <script>
    window.__picked = null;
    window.__submits = 0;
    var statusEl = document.getElementById('status');
    document.getElementById('ok').addEventListener('click', function () {
      window.__submits += 1;
      var sel = document.getElementById('ship');
      window.__picked = sel.value;
      var opt = sel.options[sel.selectedIndex];
      statusEl.textContent = sel.value ? ('已确认：' + (opt ? opt.textContent : '')) : '请先选择配送方式';
    });
  </script>
</body></html>`;
}

// CSP 页：**严格禁止 eval**（`script-src 'self' 'unsafe-inline'`，没有 `unsafe-eval`），
// 且真实数据只在**页面的 JS 状态**里 —— 两个难点叠在一起，正好覆盖 README 声称的那条能力：
// "需要时经 CDP 在页面主世界执行，**不受页面 CSP 限制**"。
//
//   ① `run_javascript` 的默认沙箱用 `new Function` 实现，而**内容脚本里的 eval 类构造
//      同样受页面 CSP 约束** —— 所以在这页上沙箱执行会被拒，必须自动改用页面主世界（CDP）；
//   ② 就算没有 CSP，沙箱跑在**隔离世界**里，也**看不到页面的 JS 变量**（`window.__orderState`）——
//      DOM 是共享的，页面全局不是。
//
// 页面上的 ¥88 是**陈旧值**，真实总价 108 只存在于 JS 状态里（DOM 里没有 "108" 这三个字符），
// 所以"工具结果里出现 108"就只可能来自**页面主世界读到 JS 状态**。
function cspPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具订单核对</title></head>
<body>
  <h1>订单核对</h1>
  <p>页面显示的总价：¥<span id="shown">88</span></p>
  <p>（页面脚本渲染的这个数字看起来没跟上真实订单状态）</p>
  <div id="status" role="status">未核对</div>
  <script>
    // 页面**自己的脚本**试一次 new Function，把结果记下来 —— 这是"页面确实禁止 eval"的可断言证据。
    // ⚠ 不要在用例里用 page.evaluate 去试：它走 CDP Runtime.evaluate，**不受页面 CSP 约束**，
    // 于是永远得到 "eval-ok"（本会话先踩过这个，误判成"夹具的 CSP 没生效"）。
    // 这段内联脚本本身是允许的（CSP 里有 'unsafe-inline'），但 new Function 需要 'unsafe-eval'。
    //（本段在模板字符串里，注释中不能出现反引号 —— 这条规则本会话已踩过四次。）
    window.__evalAllowed = (function () {
      try { new Function('return 1')(); return true; } catch (e) { return false; }
    })();
    // 页面 JS 状态里的**真实**总价。DOM 上是陈旧值 88 —— 这类"显示与状态不一致"很常见。
    window.__orderState = { items: [['咖啡豆', 68], ['滤纸', 40]], total: 108 };
    window.__checked = null;
    window.reportTotals = function () {
      window.__checked = window.__orderState.total;
      document.getElementById('status').textContent = '已核对：' + window.__checked;
    };
  </script>
</body></html>`;
}

// 草稿页：验**撤销**这条声称的能力（README：「撤销可回退输入 / 勾选 / 选择 / 样式 / 滚动」）。
//
// 页面本身很简单，难点在**撤销栈的边界**：工具的描述写明了
// 「仅输入 / 勾选 / 选择 / 改样式 / 滚动可撤销；**点击与导航不可撤销**」——
// 于是"做了三件可撤销的事 + 点了一次保存，然后撤销上一步"时，
// 撤销弹出的是**选择**那一格（最后一次可撤销动作），
// **保存那一下不会被撤回**（`__saves` 保持 1）。
//
// 所以判据必须同时看两件事：**该回退的回退了**（优先级回到未设置）、
// **不该回退的还在**（标题与发布保持、保存次数仍是 1）。
// 只断言"回退了一部分"或"点了撤销"都证明不了这条边界。
function undoPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具草稿</title></head>
<body>
  <h1>草稿</h1>
  <label for="title">标题</label>
  <input id="title" role="textbox" aria-label="标题">
  <label for="publish">发布</label>
  <input id="publish" type="checkbox" role="checkbox" aria-label="发布">
  <label for="level">优先级</label>
  <select id="level" role="combobox" aria-label="优先级">
    <option value="">未设置</option>
    <option value="high">高</option>
    <option value="low">低</option>
  </select>
  <button id="save" type="button" role="button" aria-label="保存草稿">保存草稿</button>
  <div id="status" role="status">未改动</div>
  <script>
    window.__saves = 0;
    window.__state = { title: '', publish: false, level: '' };
    var statusEl = document.getElementById('status');
    function sync() {
      window.__state = {
        title: document.getElementById('title').value,
        publish: document.getElementById('publish').checked,
        level: document.getElementById('level').value,
      };
      statusEl.textContent =
        '标题=' + (window.__state.title || '空') +
        '／发布=' + (window.__state.publish ? '是' : '否') +
        '／优先级=' + (window.__state.level || '未设置') +
        '／保存次数=' + window.__saves;
    }
    ['input', 'change'].forEach(function (ev) {
      document.getElementById('title').addEventListener(ev, sync);
      document.getElementById('publish').addEventListener(ev, sync);
      document.getElementById('level').addEventListener(ev, sync);
    });
    document.getElementById('save').addEventListener('click', function () {
      window.__saves += 1;
      sync();
    });
    sync();
  </script>
</body></html>`;
}

// 报名表页：**HTML5 原生校验**静默拦住提交。
//
// 难点是"**页面上什么都没说**"：表单填得不对时，浏览器拦住 submit，
// 只在**它自己的原生气泡**里提示（工具读不到），DOM 里既没有错误文案、`#status` 也不变。
// 于是"点了提交没反应"看起来像"按钮坏了"，而真相是字段没通过约束。
//
// ⚠⚠ 夹具设计上的一个真坑（实测出来的，值得记住）：
//   **`minlength` 对"程序化填值"不生效** —— 按规范 `tooShort` 需要用户输入产生的
//   "脏值标记"，而工具是用 `setNativeValue` + 派发 input 事件写值的，**不会**让它变脏。
//   实测：姓名填「李」+ `minlength="2"` → `validity.valid` 仍是 **true**，
//   也就是说这个约束**根本拦不住 agent**，拿它做夹具等于什么都没验。
//   改用 `pattern` 就正常生效（`patternMismatch`）—— 与 `required` 空值、`type=email` 一样，
//   它们不依赖脏值标记。所以本页的"至少 2 个字"用 `pattern=".{2,}"` 表达。
function validatePage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具报名表</title></head>
<body>
  <h1>报名表</h1>
  <form id="f">
    <label for="name">姓名</label>
    <input id="name" required pattern=".{2,}" aria-label="姓名">
    <label for="phone">手机号</label>
    <input id="phone" required pattern="1[3-9][0-9]{9}" aria-label="手机号">
    <label for="email">邮箱</label>
    <input id="email" type="email" required aria-label="邮箱">
    <label for="agree">同意条款</label>
    <input id="agree" type="checkbox" required aria-label="同意条款">
    <button id="ok" type="submit" role="button" aria-label="提交报名">提交报名</button>
  </form>
  <div id="status" role="status">未提交</div>
  <script>
    window.__submits = 0;
    var statusEl = document.getElementById('status');
    document.getElementById('f').addEventListener('submit', function (e) {
      e.preventDefault();
      window.__submits += 1;
      statusEl.textContent = '已提交：' + document.getElementById('name').value +
        '／' + document.getElementById('email').value;
    });
  </script>
</body></html>`;
}

// 番剧付费墙页：验「**能打开 ≠ 能看**」这一类。
//
// 难点刻意做成"**不试就看不出来**"（忠实还原用户那次会话）：
//   · 页面打开完全正常、标题正确、选集列表也在 —— 于是很容易得出"已打开最新一集 → 完成"✗
//   · 但第195话是**会员试看**：`duration` 只有 180 秒（正片约 1140 秒），
//     而且**播放之后**才出现那句"会员专享内容，试看中" ✗
//   · 真要回答用户的问题（没会员怎么办），还必须找出**免费能看的最后一集是第180话** ——
//     这在当前这一集页面上**看不出来**，得去选集列表里读状态。
//
// 判据因此落在两处：页面真的换到了免费那一集并播到片尾（页面状态），
// 以及"最后一集免费的是 180"这个结论真的到了模型手里（回执）。
function paywallPage() {
  const eps = [];
  for (let n = 178; n <= 195; n++) {
    // 178–180 免费/限免，181 起会员专享（与用户会话里的真实边界一致）
    const status = n <= 179 ? 'free' : n <= 180 ? 'limited' : 'vip';
    eps.push(
      '<li class="ep" data-ep="' + n + '" data-status="' + status + '" role="listitem">' +
        '<button class="ep-btn" role="button" aria-label="第' + n + '话">第' + n + '话' +
        (status === 'vip' ? '<span class="badge vip">会员</span>' : '<span class="badge">限免</span>') +
        '</button></li>'
    );
  }
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具番剧 · 凡人修仙传</title></head>
<body>
  <h1>凡人修仙传</h1>
  <div id="player-box">
    <div id="player-title">第195话 慕兰之战19</div>
    <div id="player-time">00:00 / 03:00</div>
    <div id="player-note"></div>
    <button id="play" type="button" role="button" aria-label="播放">播放</button>
    <button id="seek-end" type="button" role="button" aria-label="跳到片尾">跳到片尾</button>
  </div>
  <h2>选集</h2>
  <ul id="episodes">${eps.join('')}</ul>
  <div id="status" role="status">就绪</div>
  <script>
    // 权威数据：正片 1140 秒；仅第 1–180 话可完整观看，181 起为会员试看（180 秒）
    window.__lastFreeEp = 180;
    window.__previewSeconds = 180;
    window.__fullSeconds = 1140;
    window.__currentEp = 195;
    window.__playStarts = 0;
    window.__reachedEnd = false;
    window.__player = { ep: 195, duration: 180, currentTime: 0, isPreview: true, playing: false };
    var statusEl = document.getElementById('status');
    var timeEl = document.getElementById('player-time');
    var noteEl = document.getElementById('player-note');
    var titleEl = document.getElementById('player-title');
    function fmt(s) {
      var m = Math.floor(s / 60), x = Math.floor(s % 60);
      return (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
    }
    function epStatus(n) {
      var li = document.querySelector('li.ep[data-ep="' + n + '"]');
      return li ? li.getAttribute('data-status') : '';
    }
    function render() {
      var p = window.__player;
      timeEl.textContent = fmt(p.currentTime) + ' / ' + fmt(p.duration);
      titleEl.textContent = '第' + p.ep + '话';
    }
    /** 切到某一集：免费集给完整时长，会员集只给试看时长。 */
    function selectEp(n) {
      var st = epStatus(n);
      var preview = st === 'vip';
      window.__currentEp = n;
      window.__player = {
        ep: n,
        duration: preview ? window.__previewSeconds : window.__fullSeconds,
        currentTime: 0,
        isPreview: preview,
        playing: false,
      };
      window.__reachedEnd = false;
      noteEl.textContent = '';
      statusEl.textContent = '已切换：第' + n + '话（' + (preview ? '会员' : '免费') + '）';
      render();
    }
    document.getElementById('play').addEventListener('click', function () {
      window.__playStarts += 1;
      window.__player.playing = true;
      // ⚠ 试看提示**只在播放之后**出现 —— 这正是"不试就看不出来"的那一步。
      if (window.__player.isPreview) {
        noteEl.textContent = '本片是大会员专享内容，试看中（' + fmt(window.__player.duration) + '）';
      }
      statusEl.textContent = '播放中：第' + window.__player.ep + '话';
      render();
    });
    document.getElementById('seek-end').addEventListener('click', function () {
      var p = window.__player;
      if (!p.playing) { statusEl.textContent = '请先播放'; return; }
      p.currentTime = p.duration;
      window.__reachedEnd = true;
      statusEl.textContent = p.isPreview
        ? '试看结束：第' + p.ep + '话（仅 ' + fmt(p.duration) + '）'
        : '已看完整集：第' + p.ep + '话（' + fmt(p.duration) + '）';
      render();
    });
    document.getElementById('episodes').addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.ep-btn') : null;
      if (!btn) return;
      var li = btn.closest('li.ep');
      if (li) selectEp(Number(li.getAttribute('data-ep')));
    });
    render();
  </script>
</body></html>`;
}

// 对话框页：验 **浏览器级 JS 对话框**（alert / confirm / prompt）。
//
// 难点是真实的：

//   · `confirm` / `prompt` 会**阻塞页面 JS** —— 对话框没处理之前，页面就不动了；
//   · 所以正确的下一步是 `handle_dialog`，而**不是**再点一次按钮（那只会叠加对话框）；
//   · `prompt` 还需要**回填一个值**（`promptText`）—— 只 accept 会拿到默认值。
//
// 页面上记录两件事供断言：确认框的结果、以及 prompt 真正收到的文本。
function dialogPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具对话框</title></head>
<body>
  <h1>备注管理</h1>
  <div id="note">旧备注内容</div>
  <button id="del" type="button" role="button" aria-label="删除备注">删除备注</button>
  <button id="ren" type="button" role="button" aria-label="重命名备注">重命名备注</button>
  <div id="status" role="status">就绪</div>
  <script>
    window.__confirmResult = null;
    window.__promptValue = null;
    window.__deleted = false;
    window.__renamed = '';
    var statusEl = document.getElementById('status');
    document.getElementById('ren').addEventListener('click', function () {
      // ⚠ 这里**同步**弹 prompt（而不是 setTimeout 延迟）：
      // 实测延迟版反而让对话框处理不成功（原因未定，见剧本注释里的"已知缺口"），
      // 而同步版是能跑通的路径。代价是"点击"这一步本身会被对话框卡住 ——
      // 那**恰恰是真实体验**（点了之后页面就停住），也值得让用例覆盖到。
      var v = window.prompt('请输入新的备注名', '未命名');
      window.__promptValue = v;
      if (v) {
        window.__renamed = v;
        document.getElementById('note').textContent = v;
        statusEl.textContent = '已重命名：' + v;
      } else {
        statusEl.textContent = '已取消重命名';
      }
    });
    document.getElementById('del').addEventListener('click', function () {
      var ok = window.confirm('确定要删除这条备注吗？');
      window.__confirmResult = ok;
      if (ok) {
        window.__deleted = true;
        document.getElementById('note').textContent = '（已删除）';
        statusEl.textContent = '已删除';
      } else {
        statusEl.textContent = '已取消删除';
      }
    });
  </script>
</body></html>`;
}

// 下载页：验「**下载是浏览器级事件，页面上不会发生任何变化**」这一类。
//
// 难点：点一下之后页面**什么都不变**（没有 DOM 变化、没有状态文案）——
// 于是"点了链接"与"文件真的下载了"分家 ✗ 与付费墙那类同源（能点 ≠ 生效）。
// 唯一可信来源是**浏览器自己报的下载事件**（CDP `Page.downloadWillBegin` →
// `read_diagnostics({kind:"downloads"})`），而它同样要求**点击之前已 attach CDP**。
function downloadPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具报表</title></head>
<body>
  <h1>月度报表</h1>
  <p>把本月报表导出为 CSV。</p>
  <a id="dl" href="/files/report.csv" role="link" aria-label="导出报表 CSV">导出报表 CSV</a>
  <div id="status" role="status">就绪</div>
  <script>
    // 页面**不会**因为下载而变化 —— 这正是本场景要考的：别把"点了"当成"下载了"。
    window.__clicked = 0;
    document.getElementById('dl').addEventListener('click', function () { window.__clicked += 1; });
  </script>
</body></html>`;
}

// 日期选择器页：验「**自定义控件，打字没用、必须点**」这一类。
//
// 四个真实难点：
//   ① 输入框是 `readonly` —— 往里打字**静默无效**（工具可能还回"已输入"✗）；
//   ② 日历是**异步渲染**的：点开之后要等一拍才有格子，立刻点会落空；
//   ③ 目标日期在**下个月** —— 必须先点"下个月"，不能只看当前月就下结论；
//   ④ 有**已订满的禁用日**（含紧邻目标的那天）—— 必须真的看日历，不能按顺序猜。
function datePickerPage() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>夹具预订</title></head>
<body>
  <h1>预订房间</h1>
  <label for="checkin">入住日期</label>
  <input id="checkin" readonly placeholder="请选择日期" aria-label="入住日期">
  <button id="open" type="button" role="button" aria-label="选择入住日期">选择日期</button>
  <div id="cal" hidden>
    <div class="cal-head">
      <button id="prev" type="button" role="button" aria-label="上个月">上个月</button>
      <span id="cal-month" role="heading"></span>
      <button id="next" type="button" role="button" aria-label="下个月">下个月</button>
    </div>
    <div id="cal-days" role="list"></div>
  </div>
  <div id="status" role="status">就绪</div>
  <script>
    window.__selected = '';
    window.__typed = 0;
    // 只有 2026-03-15 是我们要的日期；14 号已订满，用来验证"真看了日历"
    var FULL = { '2026-03-10': 1, '2026-03-11': 1, '2026-03-14': 1 };
    var month = { y: 2026, m: 2 }; // 先显示 2 月（目标在下个月）
    var statusEl = document.getElementById('status');
    var daysEl = document.getElementById('cal-days');
    var monthEl = document.getElementById('cal-month');
    var inputEl = document.getElementById('checkin');
    var calEl = document.getElementById('cal');
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function key(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
    function render() {
      var y = month.y, m = month.m;
      monthEl.textContent = y + ' 年 ' + m + ' 月';
      daysEl.innerHTML = '';
      var last = new Date(y, m, 0).getDate();
      for (var i = 1; i <= last; i++) {
        var k = y + '-' + pad(m) + '-' + pad(i);
        var b = document.createElement('button');
        b.type = 'button';
        // ⚠ 必须用**采集器认得的** role：'listitem' 不在
        // page-text.js 的 INTERACTIVE_SELECTOR / INTERACTIVE_ROLES 里 ⇒
        // 这个格子**根本不会进快照**（连带它的 aria-label（含「已订满」）也看不到）。
        // 上一轮我把这个现象误读成"快照不列 disabled 元素"✗ —— 其实是夹具自己的 markup 问题。
        b.setAttribute('role', 'button');
        b.setAttribute('aria-label', m + '月' + i + '日' + (FULL[k] ? '（已订满）' : ''));
        b.textContent = String(i);
        b.disabled = !!FULL[k];
        b.setAttribute('data-date', k);
        if (FULL[k]) { b.title = '已订满'; }
        daysEl.appendChild(b);
      }
    }
    document.getElementById('open').addEventListener('click', function () {
      calEl.hidden = false;
      // ① 异步渲染：点开之后要等一拍才有格子
      daysEl.innerHTML = '<span id="loading">加载中…</span>';
      statusEl.textContent = '日历已打开';
      window.setTimeout(render, 200);
    });
    document.getElementById('next').addEventListener('click', function () {
      month.m += 1;
      if (month.m > 12) { month.m = 1; month.y += 1; }
      daysEl.innerHTML = '<span id="loading">加载中…</span>';
      window.setTimeout(render, 200);
    });
    document.getElementById('prev').addEventListener('click', function () {
      month.m -= 1;
      if (month.m < 1) { month.m = 12; month.y -= 1; }
      daysEl.innerHTML = '<span id="loading">加载中…</span>';
      window.setTimeout(render, 200);
    });
    daysEl.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('button[data-date]') : null;
      if (!b) return;
      var k = b.getAttribute('data-date');
      if (b.disabled) { statusEl.textContent = '该日期已订满：' + k; return; }
      window.__selected = k;
      inputEl.value = k.replace(/-/g, '/');
      calEl.hidden = true;
      statusEl.textContent = '已选择入住日期：' + k.replace(/-/g, '/');
    });
    // ② readonly 输入框：程序化输入也会被忽略（这里如实计数，供断言"打字无效"）
    inputEl.addEventListener('input', function () { window.__typed += 1; });
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

/** 思考记录场景里"思考进行中"这个窗口的长度（见 sseThinkStream 的注释）。 */
const THINK_HOLD_MS = 4000;

/**
 * 思考记录场景的流：先给两片思维链，**压住连接 `THINK_HOLD_MS`**，再补正文与第二段。
 *
 * 为什么必须留这个窗口：思考记录的新默认是**折叠**，而"进行中也是折叠的"这条断言
 * 只能在 `data-state="running"` 时观察。模拟 LLM 默认瞬间返回，整段思考几十毫秒就跑完，
 * E2E 拿到 locator 时状态早已是 `done` —— 于是"进行中"根本无从观察（实测踩过）。
 * 窗口由**夹具自己**留，不借 `E2E_LLM_CHUNK_DELAY_MS`：那是全局开关，
 * 会让所有场景一起变慢，而且全量 E2E 默认就是 0。
 */
function sseThinkStream(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const write = (c) => res.write('data: ' + JSON.stringify(c) + '\n\n');
  write(reasoningDelta('先确认页面结构，'));
  write(reasoningDelta('再决定点击哪个按钮。'));
  const timer = setTimeout(() => {
    write(textDelta('我想好了：结论如下。'));
    write(reasoningDelta('再复核一下边界情况。'));
    write(textDelta('补充一句。'));
    write({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    write({ usage: { total_tokens: 42 } });
    res.write('data: [DONE]\n\n');
    res.end();
  }, THINK_HOLD_MS);
  res.on('close', () => clearTimeout(timer));
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

/**
 * 模型**实际收到**的工具结果，按 `tool_call_id` 去重后按到达顺序返回。
 *
 * 为什么必须去重：Agent 每次请求都把**完整历史**再发一遍，所以同一条工具结果会出现在
 * 之后的每一个请求里。要看"第一次读到了什么"、或者要**数调用次数**，就必须按 id 去重 ——
 * 否则同一次调用会被数成十几次（本仓库的轨迹打印踩过这个坑）。
 */
export function toolMessagesInOrder() {
  const seen = new Set();
  const out = [];
  for (const r of llmRequests) {
    for (const m of r.messages || []) {
      if (!m || m.role !== 'tool') continue;
      const key = m.tool_call_id || 'idx:' + out.length + ':' + String(m.content || '').slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

/**
 * 模型**发起**的工具调用次数（按 `tool_calls[].id` 去重）。
 *
 * 用途：给"它到底滚了几次"这类**上界判据**提供可复核的数字 ——
 * 无限滚动场景里"停不下来"是反复出现的失败形态，而每一次调用都记在请求里。
 */
export function toolCallCount(name) {
  const ids = new Set();
  for (const r of llmRequests) {
    for (const m of r.messages || []) {
      if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        if (!tc || !tc.function || tc.function.name !== name) continue;
        ids.add(tc.id || 'anon:' + ids.size);
      }
    }
  }
  return ids.size;
}

// ---- 真模型 eval 模式 ----
// `E2E_LLM_REAL=1` 时，本服务不再返回脚本，而是把请求**原样转发**给真实端点并流式回传。
// 于是扩展面对的是一个真模型 —— **工具选择由模型自己决定**，这才是能验证
// "技能文案对模型有没有用"的唯一方式（脚本化剧本验证的是能力可用，不是文案有效）。
//
// 刻意与常规 E2E 用同一套夹具服务与同一套页面判据，**只换掉"谁在做决定"**：
// 否则"脚本下能过、真模型下不能过"就无法归因到底是能力问题还是文案问题。
const REAL = /^(1|true|yes)$/i.test(String(process.env.E2E_LLM_REAL || ''));
// 视觉截图场景用哪一臂：'1' 才真的调 `take_screenshot`（见下面那个场景块的说明）。
// 它只决定"要不要发起截图"，与 `VISION_ENABLED`（要不要把图送进上下文）是两件事 ——
// 二者正是 vision-switch.spec.mjs 要对照的两个变量。默认不发截图。
const VISION_SHOT_ARM = /^(1|true|yes)$/i.test(String(process.env.E2E_LLM_VISION_SHOT || ''));
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
    // 这里让模拟模型先吐思维链、再吐正文，用来验证面板真的渲染出**可折叠**的思考记录，
    // 且**默认是折叠的**（进行中也折叠，用户点开才看全文）。
    if (userText.includes('思考')) {
      // 刻意发**两段**思维链，中间夹着正文 —— 用来验证"穿插"而不是"聚成一个总块"：
      // 期望的面板结构是 思考块 → 正文 → 思考块 → 正文。
      // 前两片之后压住 4 秒（见 sseThinkStream）：让"思考进行中 + 折叠"成为可稳定断言的窗口。
      sseThinkStream(res);
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
      // ⚠ **必须先等结果渲染出来再读** —— 这一条原先漏了，于是成了 5 次里失败 1 次的**间歇性**用例。
      //
      // 夹具的搜索页是**刻意异步**的（`box.innerHTML = ''` 之后 `setTimeout(..., 120)` 才填充），
      // 因为真实站点的结果是请求回来才有的。剧本点完「搜索」立刻 `inspect_element`，
      // 就有一段时间窗读到**空列表** —— 而后面那条 `expect.poll(__renderedCount === 5)`
      // 是在**已经取完工具结果之后**才轮询的，它看到的是 5，于是失败信息只显示
      // "工具结果里没有【广告】"，完全指不到"读早了"。
      //
      // 这正是分页剧本里写明的那条纪律（"翻页后先 wait_for_element 再读"），检索这边当时没照做。
      // 全部 5 条是在**同一个同步循环**里 append 的，所以"等到任意一条出现"就等于"5 条都到齐了"。
      if (done === 3) { toolStep(res, 'wait_for_element', { selector: '#results .result', state: 'visible' }); return; }
      if (done === 4) { toolStep(res, 'inspect_element', { op: 'text', selector: '#results' }); return; }
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

    // 场景：视觉（多模态）截图链路 —— 对照门禁用（tests/e2e/vision-switch.spec.mjs）。
    //
    // 为什么要让**被叫到的那条 user 消息决定**脚本顺序（而不是分两个场景）：
    //   · 本臂不发起截图（`E2E_LLM_VISION_SHOT` 未设）：请求里**不得**出现任何图像内容；
    //   · 本臂发起截图（`=1`，run-e2e 的"视觉两臂"阶段就是这么跑的）：同一条工具调用之后，
    //     agent.js 会**追加一条 user 消息**承载图片 ⇒ 请求里**必须**出现图像内容，
    //     且 `tool` 消息本身仍是纯文本（形态臂）。
    // 两臂共用这一份脚本，靠环境变量选路 ⇒ 不会出现"脚本只覆盖了一臂"。
    // ⚠ 第 6 步已把 `VISION_ENABLED` 打开 ⇒ 捕获到的请求里**现在会有图**；
    //   spec 的"关闭臂"会被 skip（真实扩展读的就是那个常量），关闭侧的传输行为
    //   由 tests/vision-messages.test.mjs 的 `visionEnabled:false` override 钉住 ✓
    // 触发词用**字面量**而不是 PLAYBOOKS：见 vision-switch.spec.mjs 的说明
    // （不把它登记成"能力剧本"，它验的是传输管道，不是一条新能力）。
    // 场景：**富文本编辑器**（剧本 `rich-text-structure`，夹具页 `/rich`）
    //   ⚠ 用**计数器**推进（`toolResults.length`），**不要**用"回执里有没有某串"推进 ✗
    //   难点对应：选中才动结构（不选就点 ⇒ `noopClicks++`）/ 打字要可信输入 / 失焦才同步 / 装饰键不动结构
    if (userText.includes(PLAYBOOKS['rich-text-structure'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 1) { toolStep(res, 'click_element', { selector: '#rt-editor' }); return; }
      // ⚠ 可信输入（CDP）：探针已证明纯合成编辑会被页面拒（syntheticIgnored++）
      if (done === 2) { toolStep(res, 'type_text', { selector: '#rt-editor', value: '补充一句。' }); return; }
      // 先用页面提供的「全选」控件造出**真实选区**（合成按键造不出选区 ✗）
      if (done === 3) { toolStep(res, 'click_element', { selector: '#rt-select-all' }); return; }
      if (done === 4) { toolStep(res, 'click_element', { selector: '#rt-bold' }); return; }
      if (done === 5) { toolStep(res, 'click_element', { selector: '#rt-list' }); return; }
      if (done === 6) { toolStep(res, 'click_element', { selector: '#rt-fake-bold' }); return; }
      // 让编辑区失焦 ⇒ 隐藏字段才被同步（`__rt.syncs++`）
      if (done === 7) { toolStep(res, 'click_element', { selector: 'h1' }); return; }
      if (done === 8) { toolStep(res, 'inspect_element', { op: 'text', selector: '#rt-status' }); return; }
      finalText(res, '已从结构读回：粗体与列表都在，装饰键没有改变结构，隐藏字段已同步。', 60);
      return;
    }

    if (userText.includes('来张截图')) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      // 有截图臂才真的截图（没开这一臂时不再发起 take_screenshot）。
      // spec 侧会按 `VISION_SHOT_ARM` 取**不同的锚点**证明脚本真的走过了（见 spec 的 ①）。
      if (done === 1 && VISION_SHOT_ARM) {
        // 真截图：走 CDP `Page.captureScreenshot`（e2e 已装扩展、cdpEnabled 由 spec 打开）。
        toolStep(res, 'take_screenshot', { label: '视觉门禁', quality: 40 });
        return;
      }
      if (done === 1 || done === 2) {
        // 文本证据：用 `inspect_element({op:"styles"})`（只读、不需要审批）读回计算值。
        toolStep(res, 'inspect_element', { op: 'styles', selector: '.wrap', props: ['font-size', 'max-width'] });
        return;
      }
      finalText(res, '页面正文 11px、容器 1500px 宽，已按文本证据读出计算值。', 60);
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

    // 剧本：跨标签页搬运（playbook id = 'cross-tab-handoff'）。
    //
    // 在 A 页读到验证码 → 点链接（会新开 B 页并**自动绑定**）→ 把验证码填进 B 页并提交。
    // 关键顺序：**必须在点开新页之前把验证码读到手** —— 切过去之后 A 页的正文就不在眼前了。
    if (userText.includes(PLAYBOOKS['cross-tab-handoff'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 600 }); return; }
      if (done === 1) { toolStep(res, 'click_element', { role: 'link', name: '打开填写页' }); return; }
      if (done === 2) { toolStep(res, 'type_text', { role: 'textbox', name: '验证码', value: 'RF-7391' }); return; }
      if (done === 3) { toolStep(res, 'click_element', { role: 'button', name: '提交验证码' }); return; }
      if (done === 4) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已把 A 页的取件验证码 RF-7391 填进新标签页的填写页并提交，回执为「已提交验证码：RF-7391」。', 90);
      return;
    }

    // 剧本：虚拟列表（playbook id = 'virtual-list-scroll'）。
    //
    // 目标行**一开始不在 DOM 里**（只有 5 行被渲染），所以必须先滚**容器自己**再读。
    // 100 条 × 40px，第 87 条 ⇒ scrollTop = 87 × 40 = 3480。
    if (userText.includes(PLAYBOOKS['virtual-list-scroll'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      // 滚**容器**（不是窗口）—— 这正是本轮补上的那个能力
      if (done === 1) { toolStep(res, 'scroll_page', { selector: '#list', y: 3480 }); return; }
      // 滚动后必须**重新读**才知道窗口换成了哪几行
      if (done === 2) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 3) { toolStep(res, 'click_element', { text: 'VL-87' }); return; }
      if (done === 4) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已滚到第 87 条并点开它（目标条目 VL-87，页面回执「已点开：87」）。', 70);
      return;
    }

    // 剧本：级联下拉框（playbook id = 'cascade-select'）。
    //
    // 关键节奏：选省份 → **等城市选项挂上 DOM**（`attached`，不能用 `visible`：
    // `<option>` 在闭合的 select 里没有布局盒子）→ 选城市 → 提交。
    if (userText.includes(PLAYBOOKS['cascade-select'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 1) { toolStep(res, 'select_option', { selector: '#prov', label: '浙江' }); return; }
      if (done === 2) {
        toolStep(res, 'wait_for_element', { selector: '#city option[value="hz"]', state: 'attached' });
        return;
      }
      if (done === 3) { toolStep(res, 'select_option', { selector: '#city', label: '杭州' }); return; }
      if (done === 4) { toolStep(res, 'click_element', { role: 'button', name: '提交配送范围' }); return; }
      if (done === 5) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已把配送范围选成浙江 / 杭州并提交，页面回执「已提交：浙江 / 杭州」。', 70);
      return;
    }

    // 剧本：读下拉框选项再选（playbook id = 'read-select-options'）。
    //
    // 顺序即要点：**先把选项列出来**（`inspect_element({op:"options"})`），
    // 比较价格后再按 value 选中真正最便宜的那个。
    // 在此之前这一步只能借道 run_javascript（高危审批），实测过。
    if (userText.includes(PLAYBOOKS['read-select-options'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 1) { toolStep(res, 'inspect_element', { op: 'options', selector: '#ship' }); return; }
      if (done === 2) { toolStep(res, 'select_option', { selector: '#ship', value: 'eco' }); return; }
      if (done === 3) { toolStep(res, 'click_element', { role: 'button', name: '确认配送方式' }); return; }
      finalText(res, '已比较三个配送方式（¥8 / ¥22 / ¥5），选中最便宜的经济配送 ¥5 并确认。', 70);
      return;
    }

    // 剧本：严格 CSP 页面上读页面 JS 状态（playbook id = 'csp-page-world-js'）。
    //
    // 关键：**不带 `engine`** —— 走默认沙箱，让页面 CSP 把它拒掉，
    // 再让工具**自动改用页面主世界**（这正是要验的那条能力）。
    // 带上 `engine:"page"` 反而绕过了它。
    if (userText.includes(PLAYBOOKS['csp-page-world-js'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      // 默认沙箱（`new Function`）→ 被页面 CSP 拒 → 工具自动改用页面主世界重试
      if (done === 1) {
        toolStep(res, 'run_javascript', { code: 'return (window.__orderState || {}).total;' });
        return;
      }
      // 调页面自己的函数（同样必须跑在页面主世界）
      if (done === 2) {
        toolStep(res, 'run_javascript', { code: 'window.reportTotals(); return window.__checked;' });
        return;
      }
      if (done === 3) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已从页面 JS 状态读到真实总价 108（页面显示的 ¥88 是陈旧值），并调用页面自身的 reportTotals() 记下核对结果。', 80);
      return;
    }

    // 剧本：撤销（playbook id = 'undo-last-action'）。
    //
    // 刻意做三件**可撤销**的事 + 一次**不可撤销**的点击，再撤销上一步 ——
    // 验的正是"撤销只弹最后一次可撤销动作"这条边界。
    if (userText.includes(PLAYBOOKS['undo-last-action'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 1) { toolStep(res, 'type_text', { role: 'textbox', name: '标题', value: '周报' }); return; }
      if (done === 2) { toolStep(res, 'check_box', { role: 'checkbox', name: '发布', checked: true }); return; }
      if (done === 3) { toolStep(res, 'select_option', { selector: '#level', label: '高' }); return; }
      // 点击**不进撤销栈**（工具描述写明了）—— 这一下应当保留
      if (done === 4) { toolStep(res, 'click_element', { role: 'button', name: '保存草稿' }); return; }
      if (done === 5) { toolStep(res, 'undo_last_action', {}); return; }
      if (done === 6) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已撤销上一步（回退的是优先级选择）；标题「周报」与发布勾选保留，点击保存不在撤销范围内、保存次数仍为 1。', 90);
      return;
    }

    // 剧本：HTML5 原生校验静默拦住提交（playbook id = 'form-validation'）。
    //
    // 节奏：按用户给的（有问题的）值填 → 点提交（**被浏览器静默拦住**）→
    // 用 inspect 读出哪两个字段不合法 → 改好 → 再提交成功。
    if (userText.includes(PLAYBOOKS['form-validation'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 400 }); return; }
      if (done === 1) { toolStep(res, 'type_text', { role: 'textbox', name: '姓名', value: '李' }); return; }
      if (done === 2) { toolStep(res, 'type_text', { role: 'textbox', name: '手机号', value: '13800138000' }); return; }
      if (done === 3) { toolStep(res, 'type_text', { role: 'textbox', name: '邮箱', value: 'lilei#example.com' }); return; }
      if (done === 4) { toolStep(res, 'check_box', { role: 'checkbox', name: '同意条款', checked: true }); return; }
      // 第一次提交：会被原生校验拦住（页面上不会有任何提示）
      if (done === 5) { toolStep(res, 'click_element', { role: 'button', name: '提交报名' }); return; }
      // 读**表单**：不合格的字段与原因就在这一步的返回里
      if (done === 6) { toolStep(res, 'inspect_element', { op: 'inspect', selector: '#f' }); return; }
      // 按读到的原因改好
      if (done === 7) { toolStep(res, 'type_text', { role: 'textbox', name: '姓名', value: '李雷', clearFirst: true }); return; }
      if (done === 8) { toolStep(res, 'type_text', { role: 'textbox', name: '邮箱', value: 'lilei@example.com', clearFirst: true }); return; }
      if (done === 9) { toolStep(res, 'click_element', { role: 'button', name: '提交报名' }); return; }
      if (done === 10) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '第一次提交被 HTML5 原生校验静默拦住了（姓名少于 2 字、邮箱格式不对），补齐这两处后提交成功。', 90);
      return;
    }

    // 剧本：付费墙 / 试看边界（playbook id = 'paywall-preview-limit'）。
    //
    // 节奏刻意模仿真实过程：先"打开最新一集"（看起来就成了）→ 播放 → **只在这时**
    // 才发现是会员试看（`duration` 180 vs 正片 1140）→ 去选集列表找免费能看的最后一集
    // → 切过去并**播到片尾证明真能看**。
    if (userText.includes(PLAYBOOKS['paywall-preview-limit'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 60, maxText: 600 }); return; }
      if (done === 1) { toolStep(res, 'click_element', { role: 'button', name: '播放' }); return; }
      // 播放之后页面才给出试看提示；读回播放器状态坐实"不能看完整"
      if (done === 2) {
        toolStep(res, 'run_javascript', {
          code: 'const p = window.__player; return { ep: p.ep, duration: p.duration, isPreview: p.isPreview, note: (document.getElementById("player-note")||{}).textContent };',
        });
        return;
      }
      // 去选集列表里读每一集的状态，找出**免费能看的最后一集**
      if (done === 3) {
        toolStep(res, 'run_javascript', {
          code: 'const all = [...document.querySelectorAll("li.ep")].map(li => ({ ep: Number(li.dataset.ep), status: li.dataset.status })); return { lastFree: Math.max(...all.filter(x => x.status !== "vip").map(x => x.ep)), total: all.length };',
        });
        return;
      }
      if (done === 4) { toolStep(res, 'click_element', { role: 'button', name: '第180话' }); return; }
      if (done === 5) { toolStep(res, 'click_element', { role: 'button', name: '播放' }); return; }
      if (done === 6) { toolStep(res, 'click_element', { role: 'button', name: '跳到片尾' }); return; }
      if (done === 7) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '最新一集是第195话《慕兰之战19》，但它是大会员专享、只能试看 3 分钟（正片约 19 分钟）。没会员能完整观看的最后一集是第180话，我已切过去并播到片尾确认可完整观看。', 100);
      return;
    }

    // 剧本：浏览器级 JS 对话框（playbook id = 'dialog-handling'）。
    //
    // 节奏：先重命名（prompt 需要**回填值** → 走 handle_dialog({promptText})），
    // 再删除（confirm 只需确定）。刻意都先点一次按钮**让对话框出现**，
    // 再读快照看到"未处理对话框"的提示，然后处理它 —— 这正是真实使用路径。
    // 剧本：下载文件（playbook id = 'download-verify'）。
    //
    // ⚠ 第一步用 **CDP 支撑的**读取：下载事件（Page.downloadWillBegin）只有
    // 在"点击之前就已 attach"时才会到达扩展 —— 与对话框是同一个坑。
    if (userText.includes(PLAYBOOKS['download-verify'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_ax_snapshot', { limit: 30 }); return; }
      if (done === 1) { toolStep(res, 'click_element', { role: 'link', name: '导出报表 CSV' }); return; }
      // 页面不会变，唯一的凭据来自浏览器自己的下载事件
      if (done === 2) { toolStep(res, 'read_diagnostics', { kind: 'downloads' }); return; }
      if (done === 3) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已从浏览器下载事件确认报表已导出，文件名是 report.csv（页面上不会有任何变化，这正是要说明的地方）。', 90);
      return;
    }

    // 剧本：自定义日期选择器（playbook id = 'date-picker-custom'）。
    //
    // 节奏刻意踩到四个坑：打开日历后**不立刻点**（等异步渲染）→ 点"下个月"
    // → 读一次日历（看到"已订满"的日期）→ 点目标日。
    if (userText.includes(PLAYBOOKS['date-picker-custom'].trigger)) {
      const done = toolResults.length;
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 500 }); return; }
      if (done === 1) { toolStep(res, 'click_element', { role: 'button', name: '选择入住日期' }); return; }
      // ⚠ 日历是异步渲染的（200ms）。脚本化模式下没有"思考延迟"，
      //   直接读快照会读到"加载中…"—— 上一轮「已订满」看不到就是这个原因 ✗
      //   （我一度误读成"快照不列 disabled 元素"）。这里用 wait_for_element 钉住渲染。
      if (done === 2) {
        toolStep(res, 'wait_for_element', { selector: 'button[data-date="2026-02-28"]', state: 'visible', timeoutMs: 4000 });
        return;
      }
      if (done === 3) { toolStep(res, 'get_page_snapshot', { maxElements: 60, maxText: 800 }); return; }
      if (done === 4) { toolStep(res, 'click_element', { role: 'button', name: '下个月' }); return; }
      if (done === 5) {
        // 翻月后先等目标格子出现（日历异步渲染）。
        // ⚠ 也曾试过"等月份标题含 3 月"，但那一步会让路径跑不完（回执判据仍然拿不到标签），
        //   已回退到这个**验证过可用**的等待方式。原因未查（不再建假设）。
        toolStep(res, 'wait_for_element', { selector: 'button[data-date="2026-03-15"]', state: 'visible', timeoutMs: 4000 });
        return;
      }
      if (done === 6) {
        // ★ 对上一轮根因链的**预测检验**：快照的 elements 按"离视口中心远近"排序、
        //   再过体积预算裁剪 —— 日历格子原本在视口外 ⇒ 排在最后 ⇒ 被裁掉，
        //   所以「已订满」进不了上下文。若链条成立，先把它滚进视口，它就该出现。
        toolStep(res, 'scroll_page', { selector: 'button[data-date="2026-03-15"]' });
        return;
      }
      if (done === 7) { toolStep(res, 'get_page_snapshot', { maxElements: 60, maxText: 800 }); return; }
      if (done === 8) { toolStep(res, 'click_element', { role: 'button', name: '3月15日' }); return; }
      // 第 9 步：读回"值真的写进去了"。
      //   ⚠ 这里原来是 `inspect_element({ op: 'value' })` —— **没有这个 op**
      //     （`INSPECT_OPS` 只有 text / inspect / table / styles / options，见
      //     lib/assistant/page-command-tools.js），所以它每一步都回 BAD_ARGS、
      //     面板上是个红叉，而用例没断言这一步 ⇒ 长期静默失败（直到录 GIF 才看见）。
      //     现在由 tests/e2e-scripted-steps.test.mjs 在**源码层**兜住这一类错误。
      //   为什么读 `#status` 而不是读输入框：
      //     · `op:'text'` 读的是 innerText/textContent，`<input>` 上恒为空 ✗；
      //     · `get_attribute({attribute:'value'})` 读的是**属性**，而页面是
      //       `inputEl.value = ...`（只改 property、不改 attribute）⇒ 会回
      //       「属性不存在：value」，看着像失败、其实是个**换了个姿势的错读** ✗；
      //     · 而 `#status` 的文案正是这次点击写下的「已选择入住日期：2026/03/15」，
      //       是**同一段真实 DOM 状态**，也正是用例断言的那个节点 ✓
      if (done === 9) { toolStep(res, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      finalText(res, '已选择入住日期 2026/03/15（自定义日历：输入框是只读的，只能点日历；15 号在 3 月，需要先翻到下个月）。', 90);
      return;
    }

    // 剧本：无限滚动 + hover 预览（playbook id = 'infinite-scroll-hover-preview'）。
    //
    // 节奏即能力，而且**停止条件是状态驱动的**（与真模型该做的一样）：
    //   看一遍（这时只有第 1 批，目标条目不在里面）→ 试一下那个"看起来能点"的加载按钮
    //   （它会如实说此路不通）→ 循环「滚到底 → 等新批挂上 DOM → 再读一次页面」，
    //   **直到读到「已到底」才停** → 把目标滚进视口 → 可信 hover → 等预览填充 → 读回 → 作答。
    //
    // ⚠ 循环自带**上界**（8 次）：夹具要是坏了（比如永远不显示「已到底」），
    //   这里会如实报告并停下，而不是无限重滚 —— 于是失败信息指向夹具，而不是"模型不行"。
    if (userText.includes(PLAYBOOKS['infinite-scroll-hover-preview'].trigger)) {
      const done = toolResults.length;
      const textOf = (m) => (typeof m.content === 'string' ? m.content : '');
      const seen = toolResults.map(textOf).join('\n');
      const last = done ? textOf(toolResults[done - 1]) : '';
      // 第 1 步：先看一遍 —— 此时只有第 1 批，目标条目**不在**里面
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 3000 }); return; }
      // 第 2 步：先试那个"看起来能点"的按钮 —— 它不加载任何东西
      if (done === 1) { toolStep(res, 'click_element', { role: 'button', name: '加载更多' }); return; }

      // 第 3 步起：滚到底 → 等新批 → 再读一次，直到读到「已到底」
      if (!/已到底/.test(seen)) {
        const scrolls = (seen.match(/已滚动(?!到)/g) || []).length;
        if (scrolls > 8) {
          finalText(res, '滚到底很多次也没读到「已到底」，先停下如实报告：这个信息流没有可读的停止信号。', 40);
          return;
        }
        if (/已滚动(?!到)/.test(last)) {
          // 刚滚到底：**加载是异步的**，等新的一批真的挂上 DOM 再往下走
          //（这正是"滚一次不够"的那一步；等错东西就会一直等到超时）
          const snaps = toolResults.filter((m) => textOf(m).includes('已加载'));
          const loaded = Number((/已加载 (\d+) 条反馈/.exec(snaps.length ? textOf(snaps[snaps.length - 1]) : '') || [])[1] || 0);
          toolStep(res, 'wait_for_element', { selector: '#feed .item[data-id="r' + loaded + '"]', state: 'attached' });
          return;
        }
        if (/已等到目标元素（attached）/.test(last)) {
          // 新批到了：**读一次页面**才知道有没有「已到底」
          toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 3000 });
          return;
        }
        toolStep(res, 'scroll_page', { y: 4000 });
        return;
      }

      // 第 4 步：**可信** hover（合成事件读不到：夹具只认 isTrusted 的事件）。
      // ⚠ 这里刻意**不**先"滚到目标再 hover"：目标在第 4 批靠后处，滚到底之后它就在视口里，
      //   而"刚滚过就 hover"会被浏览器按**真实光标位置**重算的 hover 状态立刻挪走
      //   （实测：滚动后约 60ms 补发一次 hover 重算）。若确实需要滚进视口：用 behavior:"auto"
      //   （立即完成），**滚完先读一次页面**再 hover。
      // 第 5 步：等预览填充（内容是一次异步取数）→ **紧接着**读回。
      //   读的是 `#peek`（页面留下的"最近一次查看"）而不是行内 popover —— 后者随时可能
      //   被真实鼠标事件清掉（本机人的鼠标就在窗口里），而"读 popover"能不能成功全看运气。
      // 第 6 步：读到就读回（`#peek` 的文本就是结果本身）。
      //
      // ⚠⚠ 这一段是本用例**唯一**与"人真的在动鼠标"相关的地方，因此判据必须**逐条盯最近一次**：
      //   先前这里用的是"整轮里有没有出现过某文案"（`toolResults.some(...)` / `seen` 正则），
      //   那是**粘性**的 —— 一旦印过一次就永远为真，会把后面的重试逻辑吃掉
      //   （旧版甚至会把整轮里任何一次「等待元素超时」都当成"刚 hover 失败"，
      //    于是**两次 hover 额度可能被历史一次性烧掉**，直接走到"读不到订单号"的放弃分支）。
      //   现在三个信号全部只看**最后一条**工具结果，并且**按读回的订单号判断成败**。
      const hovers = (seen.match(/已悬停到元素/g) || []).length;
      const lastTimedOut = /等待元素超时/.test(last);
      const peekIsTarget = toolResults.some((m) => textOf(m).includes('SO-8842'));
      const readBack = toolResults.some((m) => /最近一次查看：/.test(textOf(m)));
      // 已经 hover 过、但 `#peek` 还是空的（或不是目标行）：如实重试，最多 4 次。
      // ⚠ 上限保留：夹具坏了（永远读不到）就该**如实报告**并停下，而不是无限重 hover。
      if (hovers >= 1 && !peekIsTarget && hovers < 4 && !lastTimedOut) {
        // 上一次 hover 已经过去（`#peek` 该有了）：**先直接读一次**再决定要不要重 hover ——
        // "等元素"会花掉一个往返，而真实鼠标随时可能把 hover 状态挪走，读得越早越好。
        if (!readBack) { toolStep(res, 'inspect_element', { op: 'text', selector: '#peek' }); return; }
      }
      if (hovers >= 1 && !peekIsTarget && hovers < 4) {
        toolStep(res, 'hover_element', { text: '结算页白屏' });
        return;
      }
      if (hovers >= 4 && !peekIsTarget) {
        finalText(res, '悬停 4 次都没读到目标预览（`#peek` 始终没有「SO-8842」），先如实报告：读不到订单号。', 40);
        return;
      }
      if (hovers === 0) { toolStep(res, 'hover_element', { text: '结算页白屏' }); return; }
      if (!readBack) { toolStep(res, 'inspect_element', { op: 'text', selector: '#peek' }); return; }
      finalText(res, '信息流已经到底（共 50 条反馈）。「结算页白屏，刷新后才恢复」这条的悬停预览里是：订单号 SO-8842 · 张伟 · 已复现。', 90);
      return;
    }

    // 剧本：视频播放器状态 —— 「看起来在播 ≠ 真的在播」（playbook id = 'video-playback-verify'）。
    //
    // 节奏即能力，而且**每一步都在拆穿一层假象**：
    //   看一遍（状态栏写着「播放中」，但真实数值一个都没有）
    //   → 点那个**装饰性播放键**（它不是进度条，推不动页面）
    //   → 点假进度条（同样推不动）
    //   → 真按「播放视频」→ 等**真解码**的证据（帧计数 > 0、位置推进）
    //   → 中途暂停（状态栏**不改口**）
    //   → 「跳转到末尾」触发一次**真缓冲**（waiting）
    //   → 播到 ended → 打开「播放详情」→ 读回位置 / 帧数 / 缓冲次数 / 事件序列。
    //
    // ⚠ 节奏用**计数器**（done = 已收到几条工具结果）推，与文案、截断、编码无关 ——
    //   这是本文件前几轮踩过坑之后定下来的写法（见多候选收敛那段的长注释）。
    if (userText.includes(PLAYBOOKS['video-playback-verify'].trigger)) {
      const done = toolResults.length;
      const textOf = (m) => (typeof m.content === 'string' ? m.content : '');
      // 第 0 步：先看一遍页面（此刻状态栏说「播放中」，但没有任何真实数值）
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 40, maxText: 3000 }); return; }
      // 第 1 步：先点那个"看起来能播"的装饰性播放键（它会如实说点过了）
      if (done === 1) { toolStep(res, 'click_element', { selector: '#fake-play' }); return; }
      // 第 2 步：假进度条同理（推不动页面）
      if (done === 2) { toolStep(res, 'click_element', { selector: '#fake-bar' }); return; }
      // 第 3 步：真按播放键
      if (done === 3) { toolStep(res, 'click_element', { selector: '#real-play' }); return; }
      // 第 4 步：等一拍（让"真的解码过帧"这件事在页面上留下痕迹）
      if (done === 4) {
        toolStep(res, 'wait_for_element', { selector: '#diag-flags', state: 'visible', timeoutMs: 5000 });
        return;
      }
      if (done === 5) { toolStep(res, 'inspect_element', { op: 'text', selector: '#statusbar' }); return; }
      // 第 6 步：读一下（此刻它应当还是写着「播放中」—— 但那句话不是证据）
      if (done === 6) { toolStep(res, 'inspect_element', { op: 'text', selector: '#diag-when' }); return; }
      // 第 7 步：中途暂停 —— 「在播 / 停了」必须分得开（状态栏不会改口）
      if (done === 7) { toolStep(res, 'click_element', { selector: '#pause-mid' }); return; }
      // 第 8 步：跳转到末尾 —— 触发**真缓冲**（waiting）
      if (done === 8) { toolStep(res, 'click_element', { selector: '#seek-end' }); return; }
      if (done === 9) { toolStep(res, 'inspect_element', { op: 'text', selector: '#diag-when' }); return; }
      // 第 10 步：打开详情（决定性状态这时才进 DOM）
      if (done === 10) { toolStep(res, 'click_element', { selector: '#open-diag' }); return; }
      // 第 11 步：再真播一次，让它走到 ended（"播完"与"卡住"要能分开）
      if (done === 11) { toolStep(res, 'click_element', { selector: '#real-play' }); return; }
      // 第 12 步：等它**播到头**。等的是页面自己写的状态信号「播放已结束（ended）」——
      //   用 `attached`/`visible` 会立刻满足（那是更弱的信号），必须等**文本**变成播完的样子。
      //   ⚠ 这就是"在播 / 播完"必须分得开的那一步：少了它，脚本会读到"还在播"的中间态。
      if (done === 12) {
        toolStep(res, 'wait_for_element', {
          selector: '#diag-when', state: 'text_contains', text: '播放已结束', timeoutMs: 8000,
        });
        return;
      }
      if (done === 13) { toolStep(res, 'inspect_element', { op: 'text', selector: '#bar-note' }); return; }
      // 第 14 步：读回概率性数值（位置 / 帧数 / 缓冲次数 / 事件序列）
      if (done === 14) { toolStep(res, 'inspect_element', { op: 'text', selector: '#diag-body' }); return; }
      finalText(
        res,
        '结论：这个视频**现在没有在播**（页面那条「播放中」是假的 —— 它中途暂停过、最后也播完了，' +
          '那句话一次都没改口）。实际发生过的是：真播放键按过、真的解码过帧（已解码帧数 > 0），' +
          '播放位置推进过，中途出现过缓冲（缓冲等待次数 >= 1），中间暂停过一次，最后走到了 ended（播完）。' +
          '那个装饰性播放键点过但推不动页面。',
        90
      );
      return;
    }

    // 剧本：多候选收敛 —— 比价 + 详情 + **实时报价重读**（playbook id = 'multi-candidate-convergence'）。
    //
    // 节奏即能力，而且要**逐条**核对：
    //   ① 先看页面（列表的标价里没有任何一个候选的总价）；
    //   ② **逐个展开详情并读一次总价** —— 这一步得到的**必然**是缓存报价（每个候选的第一次读）；
    //   ③ 读到的任何一个缓存总价都**不足以决断**（唯一过关的 P-102 恰好是标价最低的那个）；
    //   ④ 回到页面横幅写的"实时报价在详情里刷新"，**等它生效（1200ms）再重读一次**；
    //   ⑤ 按"总价 < 290 且 ≤3 天且 7 天无理由退货"逐条过滤 → 实时价下只有 P-105 同时成立；
    //   ⑥ 选中 → 提交 → **读回服务端回执**。
    //
    // ⚠ 第 ④ 步的等待**不是**装饰：`wait_for_element` 等的是页面自己写的
    //   「实时报价已重新询价」那行说明 —— 它是"刷新真的发生了"的可判信号。
    //   少了它，第 ⑤ 步的输入就是过期数据，而结论会翻转成 P-102（脚本会照实报出来）。
    //
    // ⚠⚠ 节奏用**计数器**推（`done` = 已经收到几条工具结果），不要用"回执里有没有某个字符串"推。
    //   本轮实测踩到两个都会让脚本**原地打转**的坑，两个都不报错、只表现为"工具调用停不下来"：
    //     ① `'¥300'` 这个字面量在写脚本的人这边是 U+FFE5（全角￥），而页面 `'¥' + n` 是
    //        U+00A5 —— 人眼看着一模一样，`includes()` 却永远为 false；
    //     ② `wait_for_element` 的成功回执是「已等到目标元素（text_contains）」，**不带 selector**
    //        （写成 `/…（text_contains）[^\n]*#note-p105/` 永远匹配不上）；
    //        更阴的是：那个等待块排在后面，于是它一旦为真就**吃掉下一步**（选中的点击发不出去）。
    //   计数器版与文案、编码、截断全部无关。
    if (userText.includes(PLAYBOOKS['multi-candidate-convergence'].trigger)) {
      const done = toolResults.length;
      const textOf = (m) => (typeof m.content === 'string' ? m.content : '');
      // ⚠⚠ 反例留在这里（都是实测踩过的）：**不要**用"我这一步发过没有 / 回执里有没有某个字符串"
      //   来推进节奏 —— `tool_calls[].function.arguments` 是 JSON 字符串（引号带反斜杠），
      //   按字面量匹配会**误命中自己**；而"看见字符串"也可能只是取数口径差异。
      //   但"看**上一条读**的结果是什么"是另一回事：它是**数据**，不是"我发过什么"。
      //   本块唯一的例外就是它（用于"等到刷新之后再读一次实时价"），其余节奏全部按 done 推。
      const step = (n, name, args) => { toolStep(res, name, args); };
      // 工具调用序列（`done` = "已经收到几条工具结果"）：
      //   0                        → 看页面（此刻列表里没有总价）
      //   1 + 3k / 2 + 3k / 3 + 3k → 第 k 家的「查看详情」/ 读总价 / 读到货
      //                              k = 0..5 ⇒ 工具调用 1..18
      //   19 起                    → 重读 P-105 → 等刷新生效 → 再读（实时价）→ 选中 → 提交 → 读回回执
      //
      // ★★ 与新夹具时序对齐（这是本轮改动）：页面把"重新询价"的时钟**从展开挪到了第一次读之后**
      //    ⇒ 第 19 步那次读拿到的是**缓存价（超预算）**，而实时价要等页面自己写出刷新说明、
      //    并且**再读一次**才拿得到。所以脚本也必须"读 → 等 → 再读"，不能再"展开完直接读实时价"。
      const pass1 = ['p101', 'p103', 'p104', 'p105', 'p102', 'p106'];
      if (done === 0) { toolStep(res, 'get_page_snapshot', { maxElements: 80, maxText: 4000 }); return; }
      // 第一遍：6 家 × (展开 + 读总价 + 读到货) = 18 次
      if (done >= 1 && done <= 18) {
        const k = Math.floor((done - 1) / 3);
        const phase = (done - 1) % 3;
        const id = pass1[k];
        if (phase === 0) {
          toolStep(res, 'click_element', { role: 'button', name: '查看详情 ' + id.toUpperCase() });
          return;
        }
        if (phase === 1) { toolStep(res, 'inspect_element', { op: 'text', selector: '#total-' + id }); return; }
        toolStep(res, 'inspect_element', { op: 'text', selector: '#days-' + id });
        return;
      }
      // 固定两拍（`done` 推）：
      //   19 → 读 P-105 的总价（**第一次读必然是缓存价**；这次读本身也开始了重新询价的时钟）
      //   20 → 等刷新真的发生（等 #note-p105 的**文本**，不是"元素在不在"）
      if (done === 19) { step(19, 'inspect_element', { op: 'text', selector: '#total-p105' }); return; }
      if (done === 20) {
        step(20, 'wait_for_element', { selector: '#note-p105', state: 'text_contains', text: '实时报价', timeoutMs: 8000 });
        return;
      }
      // 上界：脚本/夹具坏了就**如实停下**并报出来，别无限循环（失败信息要指向夹具，而不是"模型不行"）
      if (done >= 34) {
        finalText(res, '多候选收敛的脚本没有在预期步数内走完（done=' + done + '；末条回执：' +
          textOf(toolResults[toolResults.length - 1] || {}).slice(0, 100) + '），先如实报告。', 40);
        return;
      }
      // 此后只看**上一条读的结果**（它只能是 ¥309 或 ¥283 / ¥300 —— 都是"读到什么"，不是"发过什么"）：
      //   读到实时价 → 往下走；读到缓存价 → 再读（最多 4 次，按**读的次数**判，不按 done 判）。
      const lastRead = textOf(toolResults[toolResults.length - 1] || {}).trim();
      const gotFreshTotal = /^¥283(\n|$)/.test(lastRead);
      const gotStaleTotal = /^¥309(\n|$)/.test(lastRead);
      if (!gotFreshTotal) {
        if (/等待元素超时/.test(lastRead)) {
          finalText(res, '105 号的实时报价没等到（等元素超时），先如实报告：无法确定该选哪家。', 40);
          return;
        }
        const rereads = toolResults.slice(19).filter((m) => /^¥\d/.test(textOf(m).trim())).length;
        if (gotStaleTotal && rereads >= 4) {
          finalText(res, '重读 105 号总价 4 次拿到的仍是缓存报价（末条：' +
            JSON.stringify(lastRead.slice(0, 60)) + '），先如实报告。', 40);
          return;
        }
        step(done, 'inspect_element', { op: 'text', selector: '#total-p105' });
        return;
      }
      // 到这里：已经等到刷新、并且读到了实时报价（¥283）。剩下的是固定五步：
      //   选中 → 提交 → 等状态行变成回执 → **把回执读出来** → 收尾核对。
      // ⚠ 提交是真异步（服务端回执回来才写状态）；而 `wait_for_element` 只回一句
      //   「已等到目标元素（text_contains）」，**不带元素文本** —— 只等不读，回执其实没进模型手里。
      const afterFresh = toolResults.slice(19).map(textOf);
      const picked = afterFresh.some((t) => /aria-pressed="true"/.test(t));
      const submitted = afterFresh.some((t) => /aria-label="提交选择"/.test(t) && /已点击元素/.test(t));
      const waitedStatus = afterFresh.some((t) => /^已等到目标元素（text_contains）/.test(t.trim()));
      const readStatus = afterFresh.some((t) => /已下单：/.test(t));
      if (!picked) { step(done, 'click_element', { role: 'button', name: '选择 P105' }); return; }
      if (!submitted) { step(done, 'click_element', { role: 'button', name: '提交选择' }); return; }
      if (!waitedStatus) {
        step(done, 'wait_for_element', { selector: '#status', state: 'text_contains', text: '已下单', timeoutMs: 6000 });
        return;
      }
      if (!readStatus) { step(done, 'inspect_element', { op: 'text', selector: '#status' }); return; }
      // 收尾前核对：**刚读到的那条**回执里必须有服务端判定的结果（编号要能对上）。
      // ⚠ 判据只用"服务端回执那句话本身"（编号由服务端决定），不写"恰好等于某段长文案"：
      //   文案里带金额，而金额字面量最容易与页面漂移（本轮已经因此踩过两次）。
      if (!/已下单：P-105/.test(textOf(toolResults[toolResults.length - 1] || {}))) {
        finalText(res, '提交后读到的页面回执不是「已下单：P-105」（末条回执：' +
          JSON.stringify(textOf(toolResults[toolResults.length - 1] || {}).slice(0, 140)) + '），先如实报告。', 40);
        return;
      }
      finalText(res,
        '逐条核对后只有 P-105 同时满足三条：总价 ¥283（含运费）< 290 元、到货 3 天、支持 7 天无理由退货。' +
        '⚠ 它的**缓存报价是 ¥309（超预算）**，重读实时报价才变成 ¥283 —— 只读一次的话会误判成不合格。' +
        '页面回执：已下单 P-105 昊远 H5 摄像头模组。', 110);
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
  const url = String(req.url || '');
  // ⚠ 下载路由要**先于**页面路由处理：它返回的是附件而不是 HTML。
  if (url.startsWith('/files/report.csv')) {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="report.csv"',
    });
    res.end('月份,金额\n2026-01,100\n2026-02,200\n');
    return;
  }
  // 反馈的**按批数据**：只有 id 与标题（**没有订单号**）。
  // 页面按批取它 ⇒ 页面上"还没加载到的那几批"连标题都不存在（不是"看不见"，是没有）。
  if (url.startsWith('/feed-batch')) {
    const m = /[?&]n=(\d+)/.exec(url);
    const n = m ? Number(m[1]) : 0;
    const rows = n >= 1
      ? FEED_ITEMS.slice((n - 1) * 10, n * 10).map((item, i) => ({ id: 'r' + ((n - 1) * 10 + i), title: item[0] }))
      : [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(rows));
    return;
  }
  // 反馈预览的**服务端数据**：订单号只存在于这里（夹具页的 HTML/JS 里一个字都没有）。
  // 页面只在**可信** mouseenter 时来取一次 —— 这就是"不 hover 读不到"的结构性保证，
  // 也让"合成事件绕过"在夹具层面就过不去（假事件连请求都不会发）。
  if (url.startsWith('/feed-preview')) {
    const m = /[?&]id=r(\d+)/.exec(url);
    const item = m ? FEED_ITEMS[Number(m[1])] : null;
    res.writeHead(item ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(item ? { order: item[1], owner: item[2], state: item[3] } : { error: '没有这条反馈' }));
    return;
  }
  // 比价下单的**服务端提交回执**（先在页面路由之前处理：它返回 JSON 而不是 HTML）。
  //
  // 服务端按**实时报价**逐条核对约束 —— 所以"只读了一次缓存报价就下单"会在这里被拒。
  // 每一次尝试都进 `PICK_COMMITS`（成功的 + 被拒的及原因），于是用例可以断言
  // "错误候选**没有被提交过**"，而且依据是**服务端自己记的**，不是"页面上看起来没点"。
  if (url.startsWith('/pick-commit')) {
    const m = /[?&]part=([a-z0-9]+)/.exec(url);
    const part = m ? m[1] : '';
    const reason = pickRejectReason(part);
    const p = PICK_PARTS[part];
    const record = { part, ok: !reason, reason: reason || '', at: Date.now() };
    PICK_COMMITS.push(record);
    res.writeHead(reason ? 409 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(reason
      ? { ok: false, rejected: true, part, reason, message: reason }
      : {
          ok: true,
          part,
          name: p.name,
          supplier: p.supplier,
          total: p.liveTotal,
          days: p.liveDays,
          message: '已下单：' + part.replace(/^p/, 'P-').toUpperCase() + ' ' + p.name + ' · 总价 ¥' + p.liveTotal +
            ' · 到货 ' + p.liveDays + ' 天 · 支持 7 天无理由退货 · 供应商 ' + p.supplier,
        }));
    return;
  }
  // ⚠ CSP 夹具需要**不同的响应头**：`script-src 'self' 'unsafe-inline'` 放行页面自己的内联脚本
  // （否则连夹具页的脚本都跑不起来，难点就不是"eval 被拒"了），但**不放行 `unsafe-eval`** ——
  // 这正是 run_javascript 默认沙箱（`new Function`）会撞上的东西。其余夹具页仍用宽松的头。
  const cspHeaders = url.startsWith('/csp')
    ? { 'Content-Security-Policy': "script-src 'self' 'unsafe-inline'; object-src 'none'" }
    : {};
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, cspHeaders));
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
                                        // ⚠ `/handoff-form` 必须排在 `/handoff` **前面**：
                                        // `startsWith('/handoff')` 会把 /handoff-form 也吃掉。
                                        : req.url && req.url.startsWith('/handoff-form') ? handoffFormPage()
                                          : req.url && req.url.startsWith('/handoff') ? handoffPage()
                                            : req.url && req.url.startsWith('/vlist') ? virtualListPage()
                                              : req.url && req.url.startsWith('/feed') ? feedPage()
                                              : req.url && req.url.startsWith('/video') ? videoPage()
                                              : req.url && req.url.startsWith('/h5drag') ? html5DragPage()
        : req.url && req.url.startsWith('/rich') ? richTextPage()
        : req.url && req.url.startsWith('/pick') ? pickPage()
                                              : req.url && req.url.startsWith('/cascade') ? cascadePage()
                                                : req.url && req.url.startsWith('/shipping') ? shippingPage()
                                                  : req.url && req.url.startsWith('/csp') ? cspPage()
                                                    : req.url && req.url.startsWith('/undo') ? undoPage()
                                                      : req.url && req.url.startsWith('/validate') ? validatePage()
                                                        : req.url && req.url.startsWith('/paywall') ? paywallPage()
                                                          : req.url && req.url.startsWith('/dialog') ? dialogPage()
                                                            : req.url && req.url.startsWith('/download') ? downloadPage()
                                                              : req.url && req.url.startsWith('/datepicker') ? datePickerPage()
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

