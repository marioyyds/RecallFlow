// 页面运行时捕获（MAIN world，document_start）：hook console / 未捕获异常 / fetch / XHR，
// 环形缓冲最近记录，并可把 DOM 元素解析到框架源码位置（React/Vue/Svelte）。
// 供隔离世界的内容脚本按需读取（前端调试 / 页面↔代码 指针）。
// 注意：本文件运行在页面主世界，必须是普通脚本（不能用 import/export）。
//
// 两条运维约束（都在 manifest 里体现，改动时请一并考虑）：
// 1. 注入范围是 http/https 全站、document_start —— 因为 page_health 需要抓到加载期错误，
//    晚注入就漏了。代价是它跑在每一个页面上，任何副作用都会被页面观测到：
//    因此这里坚持「只读或等价替换」——不改请求参数、不改返回值、不往页面对象挂属性。
// 2. 补丁是可被检测的：window.fetch.toString() 不再返回 [native code]，
//    少数站点/广告脚本会据此判断环境。这是本特性的固有代价（要在加载期抓错就必须先装钩子），
//    不是可以通过伪造 toString 优雅解决的问题 —— 伪造本身更脆弱且有欺骗性。
//    若某站点因此行为异常，应走「按站点停用」而不是加强伪装。
// ---- 迁移期类型声明（只存在于编译期；本文件必须仍是可直接注入的裸脚本）----
/** 本文件会在 window 上留一个「已装钩子」标记。 */
type PageWindow = Window & typeof globalThis & { __rfDebugHooked?: boolean };
/** 页面元素上由框架（React/Vue/Svelte）挂的私有字段：名字带随机后缀，只能动态取。 */
type FrameworkElement = Element & Record<string, any>;

/** console 缓冲项（GET page_health 时按原样回给隔离世界）。 */
interface ConsoleEntry {
  level: string;
  text: string;
  at: number;
  stack?: string;
}

/** 网络缓冲项：成功记 status/ok，失败记 error。 */
interface NetEntry {
  url: string;
  method: string;
  ms: number;
  at: number;
  status?: number;
  ok?: boolean;
  initiator?: string;
  error?: string;
}

(function () {
  const pageWindow = window as PageWindow;
  if (pageWindow.__rfDebugHooked) return;
  pageWindow.__rfDebugHooked = true;

  // ---- 面板宿主的自定义元素定义（对"另存为不留悬浮球"是必需的） ----
  //
  // 为什么定义放在这里（页面主世界）而不是内容脚本里：实测隔离世界拿到的
  // `customElements` 是 **null**（typeof 仍是 'object'，一调 .get 就抛），
  // 只有主世界能注册自定义元素。
  //
  // 为什么必须是自定义元素：Edge/Chromium 的「另存为」会把 open shadow root 一起
  // 序列化成声明式 shadow DOM，存档里因此会带着 .fab 与图标引用。宿主改用
  // <rf-ai-host> 后，存档里没有我们的脚本、元素不会被升级，于是面板样式里的
  // `:host(:not(:defined))` 命中，整块 UI 在存档里被隐藏 —— 这条判据是**运行期状态**，
  // 不会进 HTML，也不依赖"能不能拦住保存动作"。
  //
  // 它确实是"往页面世界加了东西"（页面可以 customElements.get('rf-ai-host') 观测到），
  // 与文件顶部"不往页面对象挂属性"的克制略有出入：这里挂的是**一个注册名**，
  // 不携带数据、不改变页面行为，且没有替代方案（闭环见 docs/local-page-support.md）。
  try {
    if (!customElements.get('rf-ai-host')) {
      // 必须是 class 而不是 function + Reflect.construct 的 ES5 写法：
      // 后者在"元素已经创建、随后被升级"这条路径上返回的是一个**新**实例，
      // 页面上留下的旧节点原型链是坏的（实测 `host.matches is not a function`）。
      customElements.define('rf-ai-host', class RfAiHost extends HTMLElement {});
    }
  } catch (e) {}

  /**
   * 把 wrapper 收到的 arguments 原样转交给原方法。
   *
   * 不用直接 `orig.apply(this, arguments)`：TS 会按**最后一个重载**校验 apply 的元组，
   * 而这里必须保留「调用方传了几个参数就转几个」的原语义（open/send/fetch 都有可选参数）。
   */
  function invoke(fn: unknown, self: unknown, args: IArguments): unknown {
    return (fn as (...a: unknown[]) => unknown).apply(self, Array.from(args));
  }

  var MAX = 150;
  var consoleBuf: ConsoleEntry[] = [];
  var netBuf: NetEntry[] = [];

  function push<T>(buf: T[], entry: T) {
    buf.push(entry);
    if (buf.length > MAX) buf.shift();
  }

  function textOf(v: unknown): string {
    return String(v == null ? '' : v).slice(0, 2000);
  }

  function stackOf() {
    try {
      var s = new Error().stack || '';
      // 去掉首行 "Error"，以及本文件自身的帧（stackOf / rfConsoleHook / rfFetchHook 等）。
      // 后者很关键：只保留 12 行，若前两行都是我们自己的帧，等于把页面真正有用的
      // 调用位置挤出窗口 —— 而 initiator 的价值恰恰是「页面哪一行发起了这个请求」。
      //
      // 同时按**函数名**匹配，不只按路径：命名函数表达式在栈里可能以函数名出现，
      // 而匿名写法会显示成 `console.<computed>`（见 rfConsoleHook 处的说明）。
      // 只按路径剥会漏掉那些形式，于是扩展的帧照样混进页面的报错栈。
      var SELF = /lib\/page\/debug-hook\.js|\brf(Console|Fetch|Xhr)\w*/;
      var lines = s.split('\n');
      if (lines[0] && lines[0].indexOf('Error') === 0) lines.shift();
      while (lines.length && SELF.test(lines[0])) lines.shift();
      return lines.slice(0, 12).join('\n').slice(0, 1800);
    } catch (e) {
      return '';
    }
  }

  // 单条 console 参数的序列化预算。
  // 为什么必须有上界：本钩子注入到**每一个** http/https 页面的**每一个** frame，
  // 且挂的是 console.log 这种页面里最热的函数。原实现是把每个参数完整
  // JSON.stringify 之后才在 textOf 里截到 2000 字 —— 也就是说
  // `console.log(hugeObject)` 会把整个对象图完整走一遍再丢掉，
  // 循环里打日志的页面会实打实地被拖慢。
  var ARG_BUDGET = 400;
  var NODE_BUDGET = 200; // 单个参数最多展开多少节点（硬上界：遍历次数有上限）
  var MAX_DEPTH = 3;
  var MAX_KEYS = 20;
  var MAX_ITEMS = 10;

  function clipStr(s: unknown, n: number): string {
    const text = String(s == null ? '' : s);
    return text.length > n ? text.slice(0, n) + '…' : text;
  }

  // 深度 / 宽度 / 节点数三重受限的浅拷贝：把「无界遍历」变成「有界遍历」。
  // JSON.stringify 没有提前中止的机制，所以必须先降规模再序列化。
  function shrink(v: unknown, depth: number, budget: { left: number }): unknown {
    if (budget.left <= 0) return '[…]';
    budget.left -= 1;
    if (v === null || v === undefined) return v;
    var t = typeof v;
    if (t === 'string') return clipStr(v, 120);
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'function') return '[Function ' + ((v as Function).name || 'anonymous') + ']';
    if (t === 'symbol' || t === 'bigint') return clipStr(String(v), 60);
    if (depth >= MAX_DEPTH) return Array.isArray(v) ? '[Array]' : '[Object]';
    if (Array.isArray(v)) {
      var arr: unknown[] = [];
      var n = Math.min(v.length, MAX_ITEMS);
      for (var i = 0; i < n; i++) {
        // 逐项 try：页面的 Proxy / getter 可能抛错，也可能非常贵
        try { arr.push(shrink(v[i], depth + 1, budget)); } catch (e) { arr.push('[unreadable]'); }
      }
      // ⚠ 省略标记必须用 `⟨…省略 N 项⟩` 这种**一眼可辨的元信息形态**，
      // 不能写成 `…共 N 项`：它被 push 进**数据数组**里，与真实元素长得一模一样，
      // 读者会把省略说明当成一个真的值（本仓库真发生过）。
      // 本文件是 MAIN world 裸脚本（不能 import 扩展模块），所以这里写字面量 ——
      // `tests/omit-mark.test.mjs` 有一条门禁钉住"与 transcript.js 的形态一致"。
      if (v.length > n) arr.push('⟨…省略 ' + v.length + ' 项⟩');
      return arr;
    }
    var out: Record<string, unknown> = {};
    var keys: string[];
    var record = v as Record<string, unknown>;
    try { keys = Object.keys(record); } catch (e) { return '[Object]'; }
    var m = Math.min(keys.length, MAX_KEYS);
    for (var k = 0; k < m; k++) {
      try { out[keys[k]] = shrink(record[keys[k]], depth + 1, budget); } catch (e) { out[keys[k]] = '[unreadable]'; }
    }
    // 同上：键名也要一眼看出是元信息，别让它看起来像一个真实字段
    if (keys.length > m) out['⟨…省略字段⟩'] = '共 ' + keys.length + ' 个字段';
    return out;
  }

  function stringify(args: ArrayLike<unknown>): string {
    try {
      var parts = [];
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (typeof a === 'string') {
          parts.push(clipStr(a, ARG_BUDGET));
          continue;
        }
        var text;
        try {
          text = JSON.stringify(shrink(a, 0, { left: NODE_BUDGET }));
        } catch (e) {
          text = null;
        }
        if (text === undefined || text === null) {
          try { text = Object.prototype.toString.call(a); } catch (e2) { text = '[unserializable]'; }
        }
        parts.push(clipStr(text, ARG_BUDGET));
      }
      return parts.join(' ');
    } catch (e) {
      return '';
    }
  }

  // console.*（error/warn 附带调用栈）
  var pageConsole = console as unknown as Record<string, (...data: unknown[]) => void>;
  ['error', 'warn', 'log', 'info'].forEach(function (level) {
    var orig = pageConsole[level];
    // 具名函数表达式：与下面的 rfFetchHook 同一个理由。
    // 写成匿名时，`console[level] = function () {}` 这种**计算属性赋值**会被推断成
    // `console.<computed>` —— 实测 GitHub 的报错栈里就是这么显示的：
    //   extensions://…/lib/page/debug-hook.js (console.<computed>):131:27
    // 那个名字既看不出是扩展（反而像浏览器内部帧），又会让人误判成扩展 bug。
    // 命名之后栈里直接显示 rfConsoleHook，一眼可辨。
    pageConsole[level] = function rfConsoleHook() {
      try {
        var entry: ConsoleEntry = { level: level, text: textOf(stringify(arguments)), at: Date.now() };
        if (level === 'error' || level === 'warn') entry.stack = stackOf();
        push(consoleBuf, entry);
      } catch (e) {}
      if (orig) invoke(orig, console, arguments);
    };
  });

  // 未捕获异常 / Promise 拒绝
  window.addEventListener('error', function (e) {
    try {
      var msg = e && e.message ? e.message : 'unknown error';
      if (e && e.filename) msg += ' @ ' + e.filename + ':' + (e.lineno || 0) + ':' + (e.colno || 0);
      var st = (e && e.error && e.error.stack) ? e.error.stack : '';
      push(consoleBuf, { level: 'error', text: textOf(msg), stack: textOf(st), at: Date.now() });
    } catch (e2) {}
  });
  window.addEventListener('unhandledrejection', function (e) {
    try {
      var r = e && e.reason;
      var st = (r && r.stack) ? r.stack : '';
      push(consoleBuf, { level: 'error', text: textOf('Unhandled rejection: ' + (r && r.message ? r.message : r)), stack: textOf(st), at: Date.now() });
    } catch (e2) {}
  });

  // fetch（附带发起位置 initiator）
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    // 具名函数表达式：页面自身的报错栈里会显示 rfFetchHook，而不是 "window.fetch"。
    // ⚠ 外层变量**不能**同名（TITA-86 实测）：`var rfFetchHook = function rfFetchHook()` 经
    //   esbuild 打包后会变成 `var rfFetchHook = rfFetchHook2`，函数 name 也跟着变成
    //   rfFetchHook2 —— 栈里的可辨识名就没了。换个外层名字，内层显式名才保得住。
    // 这不是洁癖 —— 未具名时，页面上任何一次网络失败的最内层帧都长得像「扩展的 fetch」，
    // 会让人与页面的错误上报系统都误判成扩展 bug（实际案例：MSN 文章的 "Failed to fetch"
    // 栈顶就是本文件，排查时不得不先证明它跟我们无关）。
    var fetchWrapper = function rfFetchHook(input: RequestInfo | URL, init?: RequestInit) {
      var start = Date.now();
      var asRequest = input as { url?: string; method?: string } | null;
      var url = typeof input === 'string' ? input : (asRequest && asRequest.url) || '';
      var method = (init && init.method) || (asRequest && asRequest.method) || 'GET';
      var initiator = stackOf();
      // 显式以 window 作为 this：fetch 要求 this 是全局对象。
      // 依赖「本 IIFE 非严格模式、this 会被强制成全局」过于脆弱 ——
      // 一旦将来有人在文件顶部加 'use strict'，this 会变成 undefined，这里就会抛 Illegal invocation。
      var p = invoke(origFetch, window, arguments) as Promise<Response>;
      try {
        p.then(
          function (resp) {
            push(netBuf, { url: textOf(url), method: method, status: resp.status, ok: resp.ok, ms: Date.now() - start, initiator: initiator, at: Date.now() });
            return resp;
          },
          function (err) {
            // 只记录，不重新抛出：页面拿到的是原始 promise（return p），
            // 若在此 throw 会让 p.then 的派生 promise 变成未处理拒绝，污染页面控制台。
            push(netBuf, { url: textOf(url), method: method, error: textOf(err && err.message ? err.message : err), ms: Date.now() - start, initiator: initiator, at: Date.now() });
            return undefined;
          }
        ).catch(function () {});
      } catch (e) {}
      return p;
    };
    window.fetch = fetchWrapper;
  }

  // XMLHttpRequest
  if (typeof XMLHttpRequest !== 'undefined') {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    // 用 WeakMap 保存每个请求的状态，而不是往 XHR 实例上挂 __rfNet：
    // 主世界钩子跑在**别人的页面**上，给页面对象写属性是可被观测的副作用
    // （页面若枚举自身属性、或恰好用了同名属性，就会撞车）。WeakMap 不留下任何可见痕迹。
    var xhrState = new WeakMap<XMLHttpRequest, { method: string; url: string | URL; start: number; initiator?: string }>();
    XMLHttpRequest.prototype.open = function rfXhrOpen(method: string, url: string | URL) {
      try {
        xhrState.set(this, { method: method, url: url, start: 0 });
      } catch (e) {}
      return invoke(origOpen, this, arguments);
    };
    XMLHttpRequest.prototype.send = function rfXhrSend() {
      var self = this;
      var st = xhrState.get(self);
      if (st) {
        st.start = Date.now();
        st.initiator = stackOf();
      }
      self.addEventListener('loadend', function () {
        try {
          var r: { url?: string | URL; method?: string; start?: number; initiator?: string } = xhrState.get(self) || {};
          push(netBuf, {
            url: textOf(r.url),
            method: r.method || 'GET',
            status: self.status,
            ok: self.status >= 200 && self.status < 400,
            ms: Date.now() - (r.start || Date.now()),
            initiator: r.initiator || '',
            at: Date.now(),
          });
        } catch (e) {}
      });
      return invoke(origSend, this, arguments);
    };
  }

  // ---- DOM 元素 → 框架源码位置（React / Vue / Svelte）----
  function fiberSource(el: FrameworkElement) {
    try {
      var keys = Object.keys(el);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf('__reactFiber$') === 0 || keys[i].indexOf('__reactInternalInstance$') === 0) {
          var node = el[keys[i]];
          var depth = 0;
          while (node && depth < 40) {
            if (node._debugSource && node._debugSource.fileName) {
              return {
                framework: 'react',
                file: node._debugSource.fileName,
                line: node._debugSource.lineNumber,
                column: node._debugSource.columnNumber,
                component: (node.type && (node.type.displayName || node.type.name)) || undefined,
              };
            }
            node = node.return;
            depth++;
          }
        }
      }
    } catch (e) {}
    return null;
  }

  function resolveElementSource(el: FrameworkElement | null) {
    if (!el) return null;
    var r = fiberSource(el);
    if (r) return r;
    try {
      var vk = Object.keys(el).find(function (k) { return k.indexOf('__vueParentComponent') === 0; });
      if (vk && el[vk] && el[vk].type && el[vk].type.__file) {
        return { framework: 'vue', file: el[vk].type.__file, component: el[vk].type.name || el[vk].type.__name };
      }
    } catch (e) {}
    try {
      if (el.__vue__ && el.__vue__.$options && el.__vue__.$options.__file) {
        return { framework: 'vue', file: el.__vue__.$options.__file };
      }
    } catch (e) {}
    try {
      if (el.__svelte_meta && el.__svelte_meta.loc) {
        return { framework: 'svelte', file: el.__svelte_meta.loc.file, line: el.__svelte_meta.loc.line, column: el.__svelte_meta.loc.char };
      }
    } catch (e) {}
    return null;
  }

  // 只把响应发给本次请求的 MessagePort（若提供），否则退回 window.postMessage 广播。
  function sendReply(port: MessagePort | null, id: unknown, data: unknown) {
    var msg = { __rfDebugRes: true, id: id, data: data };
    try {
      if (port) port.postMessage(msg);
      else window.postMessage(msg, '*');
    } catch (err) {}
  }

  // 隔离世界按需读取缓冲 / 解析元素源码
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || !d.__rfDebugReq) return;
    var port = (e.ports && e.ports[0]) || null;
    var data;
    if (d.kind === 'element-source') {
      var el = null;
      try {
        if (d.selector) el = document.querySelector(d.selector);
      } catch (err) {
        el = null;
      }
      data = resolveElementSource(el);
    } else {
      data = d.kind === 'network' ? netBuf : consoleBuf;
      data = data.slice(-MAX);
    }
    sendReply(port, d.__rfDebugReq, data);
  });
})();
