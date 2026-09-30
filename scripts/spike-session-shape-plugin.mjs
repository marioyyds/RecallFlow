// 探针 v2：直接测运行时形状，而不是靠 grep 猜「谁能发消息进会话」。
//
// 已知（v1 实测）：agent.session.prompt 不是函数。
// 本轮要回答：能发消息的入口到底在哪 —— ctx 上的会话服务？agent 上的别的方法？
//
// 做法：把候选对象的键、原型链上的方法名、以及 ctx 上与 session/session 相关的服务名全打印出来。
export const name = 'spike-session-shape';
export const inject = ['agents'];

function describe(label, obj) {
  if (obj === null || obj === undefined) {
    console.log('[spike] ' + label + ' = ' + String(obj));
    return;
  }
  let own = [];
  try {
    own = Object.keys(obj);
  } catch {
    own = ['<keys 不可枚举>'];
  }
  let protoMethods = [];
  try {
    let p = Object.getPrototypeOf(obj);
    const seen = new Set();
    while (p && p !== Object.prototype && seen.size < 60) {
      for (const k of Object.getOwnPropertyNames(p)) {
        if (k === 'constructor') continue;
        if (typeof obj[k] === 'function' || (obj[k] && typeof obj[k] === 'object')) seen.add(k);
      }
      p = Object.getPrototypeOf(p);
    }
    protoMethods = [...seen];
  } catch (e) {
    protoMethods = ['<原型不可读: ' + e.message + '>'];
  }
  console.log('[spike] ' + label + ' 自有键=[' + own.slice(0, 24).join(', ') + ']');
  console.log('[spike] ' + label + ' 原型上的成员=[' + protoMethods.slice(0, 40).join(', ') + ']');
}

export function apply(ctx, config = {}) {
  const log = (m) => console.log('[spike] ' + m);

  log('插件装载');
  // ctx 上与 session 有关的服务名（Cordis 的服务是 ctx 上的属性）
  try {
    const ctxKeys = Object.keys(ctx).filter((k) => /session|agent|prompt|turn/i.test(k));
    log('ctx 上相关键=[' + ctxKeys.join(', ') + ']');
    const proto = new Set();
    let p = Object.getPrototypeOf(ctx);
    while (p && p !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(p)) if (/session|agent|prompt|turn/i.test(k)) proto.add(k);
      p = Object.getPrototypeOf(p);
    }
    log('ctx 原型上相关成员=[' + [...proto].join(', ') + ']');
  } catch (e) {
    log('ctx 形状读取失败: ' + e.message);
  }

  ctx.on('agent/created', (payload) => {
    void (async () => {
      const agent = payload && payload.agent;
      log('--- agent/created ---');
      describe('agent', agent);
      describe('agent.session', agent && agent.session);
      describe('agent.ctx', agent && agent.ctx);

      // 试着从 ctx 拿会话服务
      for (const name of ['sessions', 'session', 'sessionStore', 'sessionController', 'prompt']) {
        let v;
        try {
          v = ctx[name];
        } catch (e) {
          log('ctx.' + name + ' 读取抛错: ' + e.message);
          continue;
        }
        if (v === undefined) {
          log('ctx.' + name + ' = undefined');
          continue;
        }
        log('ctx.' + name + ' 类型=' + (typeof v) + (typeof v === 'object' ? '' : ' 值=' + String(v).slice(0, 60)));
        if (typeof v === 'object' && v) describe('ctx.' + name, v);
      }

      // agent 上是否有别的方法能发消息
      const candidates = ['prompt', 'send', 'submit', 'inject', 'cancel', 'handle'];
      for (const m of candidates) {
        let t = 'n/a';
        try {
          t = typeof (agent && agent[m]);
        } catch (e) {
          t = '读取抛错';
        }
        log('agent.' + m + ' → ' + t);
      }
    })();
  });

  log('已订阅 agent/created');
}
