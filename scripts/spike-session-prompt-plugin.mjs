// 可行性探针：从 DSH 插件里调用 session.prompt()，看它是否产生**真正的用户消息**，
// 以及是否能**唤醒空闲会话**（这是 inject 做不到、而面板主动开口必须做到的事）。
//
// 用法：dsh headless --patch <包含本文件的 patch.yml>（**不传消息**，以验证唤醒能力）
// 证据：本文件自己订阅 session/event，把看到的事件原文打印出来 —— 不靠外部推断。
export const name = 'spike-session-prompt';
export const inject = ['agents'];

const STAMP = 'SPIKE-' + Date.now();

export function apply(ctx, config = {}) {
  const log = (m) => {
    // 直接写 stdout：headless 运行时的 stdout 就是我们的证据通道
    console.log('[spike] ' + m);
  };

  log('插件已装载；将调用的探针文本 = ' + STAMP);

  let subscribed = false;
  ctx.on('agent/created', (payload) => {
    void (async () => {
      try {
        const agent = payload && payload.agent;
        log('agent/created：agent 存在=' + !!agent + ' sessionId=' + (agent && agent.sessionId));
        if (!agent) return;

        if (!subscribed) {
          subscribed = true;
          ctx.on('session/event', (session, ev) => {
            if (!ev || !ev.type) return;
            const data = ev.data || {};
            const role = data.role === undefined ? '-' : String(data.role);
            const kind = data.source && data.source.kind ? String(data.source.kind) : '-';
            let text = '';
            try {
              const parts = Array.isArray(data.content) ? data.content : [];
              text = parts.map((p) => (p && p.type === 'text' ? p.text : '[' + (p && p.type) + ']')).join(' ');
            } catch {
              text = '';
            }
            // 只打印与本探针相关或消息类事件，避免刷屏
            if (/message|prompt|inbox/i.test(String(ev.type))) {
              log('session/event type=' + ev.type + ' role=' + role + ' source.kind=' + kind +
                  ' rpcId=' + (data.source && data.source.rpcId ? String(data.source.rpcId).slice(0, 12) : '-') +
                  ' text=' + JSON.stringify(text.slice(0, 90)));
            }
          });
        }

        const session = agent.session;
        log('agent.session 存在=' + !!session +
            ' session.prompt 是函数=' + (typeof (session && session.prompt) === 'function') +
            ' agent.inject 是函数=' + (typeof agent.inject === 'function'));

        if (session && typeof session.prompt === 'function') {
          try {
            const ret = await session.prompt([{ type: 'text', text: STAMP }], 'queue');
            log('session.prompt() 正常返回：' + JSON.stringify(ret).slice(0, 240));
          } catch (err) {
            log('session.prompt() 抛错：' + String((err && err.message) || err));
          }
        } else {
          log('拿不到 session.prompt —— 需要换一条路（agent.inject 或 ctx.session 查找）');
          // 退一步：只验证 inject 的对照行为（已知它不唤醒空闲会话）
          try {
            if (typeof agent.inject === 'function') {
              agent.inject(Object.freeze({
                id: 'spike-' + Math.random().toString(36).slice(2),
                role: 'user',
                content: [{ type: 'text', text: STAMP + '-VIA-INJECT' }],
                source: { kind: 'user', rpcId: 'spike-rpc' },
              }));
              log('已改用 agent.inject（对照）');
            }
          } catch (e) {
            log('inject 也失败：' + String((e && e.message) || e));
          }
        }
      } catch (e) {
        log('agent/created 处理异常：' + String((e && e.message) || e));
      }
    })();
  });

  log('已订阅 agent/created');
}
