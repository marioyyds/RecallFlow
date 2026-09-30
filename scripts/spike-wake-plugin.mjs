// 探针 v3（决定性）：会话**空闲**时，插件能不能主动开启一轮？
//
// 这是"面板当输入口"的核心性质：inject 明确不唤醒空闲 driver（im 插件源码注释原文），
// 所以必须找到能唤醒的入口。v2 的形状转储显示 agent 原型上有：
//   send / followup / steer / wakeDriver / whenIdle
// 以及我早期的一条笔记：inject 内部走的是 send(input, 'next-step', false)。
//
// 本探针的做法：等 CLI 那一轮**跑完并空闲**（whenIdle），再 send 一条用户消息，
// 然后观察是否产生 (a) user/message 事件、(b) **新一轮的 assistant/message**。
// (b) 成立即证明"能唤醒空闲会话"。
import { randomUUID } from 'node:crypto';

export const name = 'spike-wake';
export const inject = ['agents'];

const STAMP = 'WAKE-' + Date.now();

export function apply(ctx, config = {}) {
  const log = (m) => console.log('[spike] ' + m);

  let userMsgs = 0;
  let assistantMsgs = 0;
  let assistantAfterSend = 0;
  let sentAt = 0;

  ctx.on('session/event', (session, ev) => {
    if (!ev || !ev.type) return;
    const data = ev.data || {};
    let text = '';
    try {
      const parts = Array.isArray(data.content) ? data.content : [];
      text = parts.map((p) => (p && p.type === 'text' ? p.text : '')).join(' ').trim();
    } catch {}
    if (ev.type === 'user/message') {
      userMsgs++;
      log('user/message #' + userMsgs + ' text=' + JSON.stringify(text.slice(0, 70)));
    } else if (ev.type === 'assistant/message') {
      assistantMsgs++;
      if (sentAt) assistantAfterSend++;
      log('assistant/message #' + assistantMsgs + ' text=' + JSON.stringify(text.slice(0, 70)) +
          (sentAt ? '   ← send 之后的第 ' + assistantAfterSend + ' 条' : ''));
    }
  });

  ctx.on('agent/created', (payload) => {
    void (async () => {
      const agent = payload && payload.agent;
      if (!agent) return;
      log('agent/created；等待会话空闲（whenIdle）…');
      try {
        if (typeof agent.whenIdle === 'function') await agent.whenIdle();
      } catch (e) {
        log('whenIdle 抛错: ' + String((e && e.message) || e));
      }
      log('已空闲。此时收到的 user/message 数=' + userMsgs + '，assistant/message 数=' + assistantMsgs);

      const msg = Object.freeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: STAMP }],
        source: { kind: 'user', rpcId: 'spike-wake-rpc' },
      });

      // 签名未知，逐个试并记录哪一种被接受（不猜，实测）。
      const attempts = [
        { label: "send(msg, 'next-turn', true)", fn: () => agent.send(msg, 'next-turn', true) },
        { label: 'send(msg, true)', fn: () => agent.send(msg, true) },
        { label: 'send(msg)', fn: () => agent.send(msg) },
        { label: "steer(msg)", fn: () => agent.steer(msg) },
        { label: 'followup(msg)', fn: () => agent.followup(msg) },
        { label: 'inject(msg) + wakeDriver()', fn: () => { agent.inject(msg); return agent.wakeDriver && agent.wakeDriver(); } },
      ];

      for (const a of attempts) {
        try {
          sentAt = Date.now();
          const r = await a.fn();
          log('★ 已被接受：' + a.label + '  返回=' + JSON.stringify(r === undefined ? null : r).slice(0, 120));
          break;
        } catch (e) {
          log('  拒绝 ' + a.label + ' → ' + String((e && e.message) || e).slice(0, 140));
          sentAt = 0;
        }
      }

      // 给新一轮一点时间
      await new Promise((r) => setTimeout(r, 12000));
      log('=== 结论 ===');
      log('send 之后新增 assistant/message 数 = ' + assistantAfterSend +
          '（>0 即证明：插件能在空闲会话上开启新一轮）');
      log('探针文本是否作为 user/message 出现 = ' +
          (userMsgs > 0 ? '是（共 ' + userMsgs + ' 条 user/message）' : '否'));
    })();
  });

  log('装载完成，探针文本 = ' + STAMP);
}
