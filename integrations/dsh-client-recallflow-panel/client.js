// DSH 客户端插件（浏览器侧）：把浏览器 RecallFlow 面板的对话渲染进 DSH 界面。
//
// 形态依据（读实现得出，非猜测）：
//   @deepseek-ai/dsh-client-ui-slots —— 客户端 UI 通过**插槽**贡献组件；
//   插槽契约由拥有者用 SlotMap 声明合并。对话区的候选插槽位于
//   dsh-client-ui-chat/lib/types/client/contract/slots.d.ts：
//     'conversation.chat.turnTail': { kind:'list', scope:'session', owner: TurnTailOwnerProps }
//     → "Ordered feature contributions before a completed Turn's action row.
//        … entries without content return null."
//   活范例：dsh-client-ui-plan/lib/client.js 就往这个插槽注册（ctx.slots.inject + ctx.slots.register）。
//
// 入口格式：客户端入口不是普通 ESM，而是自定义模块加载器外壳
//   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
//   （见该生态里 client 构建脚本产出的包裹；这里**手写**，因此不需要打包器。）
//   `react` 由加载器提供（构建时被标为 external），所以可以直接 require。
//
// 设计要点：turnTail 是 kind:'list'，**每一轮**都会渲染一次。若每次都把面板历史画一遍，
// 对话会被同一块内容刷屏。因此这里记住「上次展示到哪一条」，**只有面板出现新回合时**
// 才返回一张卡片；没有新内容就返回 null（符合插槽契约）。
(function () {
  if (typeof window === 'undefined' || !window.__ModuleLoader__) return;

  window.__ModuleLoader__.load({
    id: 'dsh-client-recallflow-panel',
    factory: function (require) {
      var React = require('react');

      // 桥接地址与 token 与浏览器扩展里保持一致（都是本机常量）。
      // 端口是硬编码的：扩展侧读不到环境变量，这里同理。
      var BRIDGE = 'http://127.0.0.1:7801';
      var TOKEN = 'recallflow-local-bridge-v1';
      var POLL_MS = 4000;
      var MAX_ROWS = 3;
      var ROW_CHARS = 160;

      // 模块级状态：所有轮次的卡片共享同一份"看到哪了"的进度。
      var latest = [];
      // 进度（已展示到哪一条 at）持久化到 localStorage。
      // 用户诉求是"自动同步最好"：每批新内容出现一次即可，不该因为刷新页面而重复出现。
      // 只放在内存里的话，每次 F5 都会把最近一批重新展示一遍（实测会导致同一内容出现多份）。
      var SHOWN_KEY = 'recallflow-panel-ui.shownUpTo';
      var shownUpTo = 0;
      try {
        var savedShown = window.localStorage && window.localStorage.getItem(SHOWN_KEY);
        if (savedShown) shownUpTo = Number(savedShown) || 0;
      } catch (e) {
        /* 隐私模式等场景下 localStorage 可能不可用：退回纯内存进度 */
      }
      function persistShown() {
        try {
          window.localStorage.setItem(SHOWN_KEY, String(shownUpTo));
        } catch (e) {}
      }
      var listeners = new Set();
      var timer = null;
      // 失败原因只在**状态变化**时打印一次，避免每 4 秒刷屏。
      // 为什么要打印：取数失败的原因（CORS 被挡 / 桥接没起来 / 桥接是旧代码没有该端点）
      // 在界面上完全不可见 —— 表现只是"卡片不出现"。有这条日志，
      // 排查者（包括通过扩展 read_console 的 AI）就能直接看出原因。
      var lastFailReason = '';

      function reportFail(reason) {
        if (reason === lastFailReason) return;
        lastFailReason = reason;
        try {
          console.warn('[recallflow-panel-ui] 面板取数失败：' + reason);
        } catch (e) {}
      }

      function pull() {
        return fetch(BRIDGE + '/panel-turns?limit=20', { headers: { 'X-RecallFlow-Token': TOKEN } })
          .then(function (r) {
            if (!r.ok) {
              // 401 = token 不对；404 = 桥接是旧代码（没有这个端点）；
              // 其它多半是 CORS / 未启动。
              reportFail('HTTP ' + r.status + (r.status === 404 ? '（桥接可能是旧代码，没有 /panel-turns）' : ''));
              return null;
            }
            lastFailReason = '';
            return r.json();
          })
          .then(function (d) {
            if (d && Array.isArray(d.turns)) {
              latest = d.turns;
              listeners.forEach(function (fn) {
                try {
                  fn();
                } catch (e) {}
              });
            }
          })
          .catch(function (e) {
            // 跨源被挡时浏览器只给一个笼统的 TypeError: Failed to fetch，
            // 因此这里把"最可能的原因"一并写出来，而不是只丢一个原始错误。
            reportFail(String((e && e.message) || e) + '（桥接未启动，或它还是旧代码、没有对 127.0.0.1/3080 开放只读 CORS）');
          });
      }

      function ensurePolling() {
        if (timer !== null) return;
        pull();
        timer = setInterval(pull, POLL_MS);
        // 页面卸载时清掉，避免在长会话里留下悬挂定时器
        if (typeof window !== 'undefined' && window.addEventListener) {
          window.addEventListener('beforeunload', function () {
            if (timer !== null) clearInterval(timer);
            timer = null;
          });
        }
      }

      // **在模块加载时就启动轮询**，而不是等第一个卡片挂载。
      // 原因：卡片挂在每轮末尾，而挂载才启动轮询的话，首批数据一定晚于那次挂载 ——
      // 于是新装好的插件要等到**下一轮**才显示内容（我最初就是这样，也只能这样测）。
      // 提前到页面加载时开始，第一次轮次挂载时数据通常已经就绪，卡片立刻可见。
      ensurePolling();

      function newTurns() {
        return latest.filter(function (t) {
          return Number(t && t.at ? t.at : 0) > shownUpTo;
        });
      }

      function row(t, i) {
        // 这里要区分**两条不同的轴**（我一度把它们混为一谈）：
        //   ① 「哪一边」（面板 / DSH）—— 用户要求去掉，去掉了 ✓
        //   ② 「谁在说」（用户 / 助手）—— 这是对话的**关系**，不能一起去掉。
        //      用户实测反馈："在渲染的时候，用户和 ai 回复的关系消失了"。
        // 所以现在：用户的话用「你：」起头（角色），助手的话直接呈现（就是"我"在说）。
        // 仍然不写来源（不说这是在哪块屏幕上说的）。
        var isUser = t.role === 'user';
        var text = String(t.text == null ? '' : t.text).replace(/\s+/g, ' ').trim();
        if (text.length > ROW_CHARS) text = text.slice(0, ROW_CHARS) + '…';
        return React.createElement(
          'div',
          {
            key: 'row' + i,
            className: 'recallflow-panel-card-row' + (isUser ? ' recallflow-panel-card-row-user' : ''),
            style: {
              // 与 DSH 原生正文一致：14px / 24px（实测值），行内自适应宽度
              fontSize: '14px',
              lineHeight: '24px',
              wordBreak: 'break-word',
              opacity: isUser ? 0.68 : 1,
              marginTop: i === 0 ? 0 : 2,
            },
          },
          (isUser ? '你：' : '') + text
        );
      }

      // 分层日志：卡片没出现时，必须能区分是「插槽回调没触发」还是「组件没被挂载」，
      // 否则两种情况在外部完全一样（都只是"看不到卡片"）。
      function note(msg) {
        try {
          console.info('[recallflow-panel-ui] ' + msg);
        } catch (e) {}
      }

      function PanelTail() {
        if (!PanelTail.__mountedLogged) {
          PanelTail.__mountedLogged = true;
          // 带上当时缓存里有几条 —— 这能区分"组件挂载了但没数据"与"组件根本没挂载"。
          note('卡片组件已挂载（缓存面板数据 ' + latest.length + ' 条）');
        }
        // 快照放进 state，这样**数据到达后可以在同一轮内出现**。
        //
        // 这里修的是一个实测出来的时序缺陷：组件挂载发生在页面初始渲染时，
        // 而轮询刚启动、fetch 还没回来 —— 若快照只在挂载时用 useState 惰性初值算一次，
        // 这一轮就永远不显示（控制台实测：「卡片组件已挂载（缓存面板数据 0 条）」
        // 「首次计算展示内容：新回合 0 条」）。改为订阅更新后重算。
        var setSnapRef = React.useState(function () {
          return newTurns().slice(-MAX_ROWS);
        });
        var snap = setSnapRef[0];
        var setSnap = setSnapRef[1];

        var force = React.useReducer(function (x) {
          return x + 1;
        }, 0)[1];
        React.useEffect(function () {
          listeners.add(force);
          // 轮询已在模块加载时启动（见 ensurePolling 的调用点）；这里只订阅更新。
          return function () {
            listeners.delete(force);
          };
        }, []);

        React.useEffect(
          function () {
            var onData = function () {
              var fresh = newTurns();
              if (!fresh.length) return;
              if (!PanelTail.__snapLogged) {
                PanelTail.__snapLogged = true;
                note('数据到达后重算：新回合 ' + fresh.length + ' 条');
              }
              setSnap(fresh.slice(-MAX_ROWS));
            };
            listeners.add(onData);
            return function () {
              listeners.delete(onData);
            };
          },
          [setSnap]
        );

        // 进度标记在**卡片真正展示之后**才推进（放在 effect 里，避免渲染期副作用）。
        // 之所以不在算出快照时就推进：那样一旦重渲染就会把自己藏掉（闪烁）。
        // 之所以不放在卸载时推进：DSH 的对话会保留历史轮次，卸载时机不可靠。
        React.useEffect(
          function () {
            if (!snap.length) return;
            shownUpTo = snap.reduce(function (m, t) {
              return Math.max(m, Number(t.at || 0));
            }, shownUpTo);
            persistShown();
          },
          [snap]
        );

        if (!snap.length) return null;

        // 观感目标是"就是 DSH 自己的消息"，因此这里**没有任何标签**：
        // 没有标题、没有"这是另一个 agent"的说明、没有来源前缀、没有边框/底色/缩进。
        // 只保留与原生一致的排版（14px / 24px，实测自原生消息），以及两侧发言的
        // 视觉浓淡差别（见 row()）。
        // 说明：模型侧的注入**仍然**带着"这是另一个 agent"的说明 —— 那是给模型看的、
        // 界面上不可见，两者并不冲突：界面像原生，模型不失真。
        return React.createElement(
          'div',
          {
            className: 'recallflow-panel-card',
            style: {
              margin: '2px 0',
              fontSize: '14px',
              lineHeight: '24px',
              color: 'inherit',
            },
          },
          snap.map(row)
        );
      }

      return {
        name: 'recallflow-panel-ui',
        inject: ['slots'],
        apply: function (ctx) {
          // 装载成功要在控制台留一行：否则"插件没被加载"与"加载了但没数据"
          // 在外部完全无法区分（两种情况的界面表现都是"看不到卡片"）。
          try {
            console.info('[recallflow-panel-ui] 已装载，注册到 conversation.chat.turnTail');
          } catch (e) {}
          ctx.slots.inject('conversation.chat.turnTail', function () {
            note('插槽 conversation.chat.turnTail 回调已触发，开始注册卡片');
            return ctx.slots.register(
              {
                name: 'conversation.chat.turnTail',
                id: 'recallflow-panel-ui',
                // 本组件不需要会话数据：面板内容来自桥接。留空以满足注册契约。
                inject: function () {
                  return {};
                },
              },
              PanelTail
            );
          });
        },
      };
    },
  });
})();
