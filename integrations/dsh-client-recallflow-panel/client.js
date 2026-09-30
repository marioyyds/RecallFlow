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
      var shownUpTo = 0;
      var listeners = new Set();
      var timer = null;

      function pull() {
        return fetch(BRIDGE + '/panel-turns?limit=20', { headers: { 'X-RecallFlow-Token': TOKEN } })
          .then(function (r) {
            return r.ok ? r.json() : null;
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
          .catch(function () {
            // 桥接没起来 / 不是本机来源：静默。面板不出现即可，绝不影响 DSH 本体。
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

      function newTurns() {
        return latest.filter(function (t) {
          return Number(t && t.at ? t.at : 0) > shownUpTo;
        });
      }

      function row(t, i) {
        var who = t.role === 'user' ? '👤 你在面板：' : '💬 面板助手：';
        var text = String(t.text == null ? '' : t.text).replace(/\s+/g, ' ').trim();
        if (text.length > ROW_CHARS) text = text.slice(0, ROW_CHARS) + '…';
        return React.createElement(
          'div',
          {
            key: 'row' + i,
            style: { marginTop: i === 0 ? 0 : 4, lineHeight: 1.5, wordBreak: 'break-word' },
          },
          who + text
        );
      }

      function PanelTail() {
        // 只订阅「有新数据」的通知；真正的刷新由模块级轮询驱动。
        var force = React.useReducer(function (x) {
          return x + 1;
        }, 0)[1];
        React.useEffect(function () {
          listeners.add(force);
          ensurePolling();
          return function () {
            listeners.delete(force);
          };
        }, []);

        // 关键：在**挂载时拍一次快照**并把进度推进，
        // 这样同一批新内容只会出现在它到达的那一轮里，后续轮次自然返回 null。
        // （若在 render 里推进进度，会引入渲染期副作用，StrictMode 下还会重复触发。）
        var snap = React.useState(function () {
          var fresh = newTurns();
          if (fresh.length) {
            shownUpTo = fresh.reduce(function (m, t) {
              return Math.max(m, Number(t.at || 0));
            }, shownUpTo);
          }
          return fresh.slice(-MAX_ROWS);
        })[0];

        if (!snap.length) return null;

        return React.createElement(
          'div',
          {
            style: {
              margin: '8px 0 4px',
              padding: '8px 10px',
              border: '1px solid rgba(127,143,164,.45)',
              borderLeft: '3px solid #7f8fa4',
              borderRadius: '6px',
              background: 'rgba(127,143,164,.08)',
              fontSize: '12px',
              color: 'inherit',
              opacity: 0.92,
            },
            title: '来自浏览器里的 RecallFlow 面板（另一个助手 agent 的对话，不是用户对本会话说的话）',
          },
          [
            React.createElement(
              'div',
              { key: 'head', style: { fontWeight: 600, marginBottom: 4 } },
              '📣 浏览器 RecallFlow 面板'
            ),
            React.createElement(
              'div',
              { key: 'sub', style: { opacity: 0.7, marginBottom: 6 } },
              '与另一个助手 agent 的对话 · 不是用户对本会话说的话'
            ),
          ].concat(snap.map(row))
        );
      }

      return {
        name: 'recallflow-panel-ui',
        inject: ['slots'],
        apply: function (ctx) {
          ctx.slots.inject('conversation.chat.turnTail', function () {
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
