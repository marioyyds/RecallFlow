// DSH 客户端 UI 插件（浏览器侧）的测试。
//
// 做法：这是浏览器代码（入口是 window.__ModuleLoader__.load），本地也没装 React ——
// 所以这里搭一套**最小替身**把真实文件跑起来：
//   · 假 window.__ModuleLoader__ 捕获工厂函数
//   · 假 require('react')：createElement 返回普通对象，useState/useEffect/useReducer 用最小实现
//   · 假 fetch：可控地返回面板回合
// 然后用**组件函数本身**断言渲染结果。比"在别处抄一份逻辑来测"可靠得多 ——
// 测的就是真正会发布的那份代码。
import test from 'node:test';
import assert from 'node:assert/strict';

const CLIENT_PATH = '../integrations/dsh-client-recallflow-panel/client.js';

// 全局替换定时器，且**不还原**。
// 教训：第一版把桩放在 loadPlugin 里、finally 还原 —— 但客户端的轮询是在**组件 effect
// 运行时**才创建的（晚于 loadPlugin 返回），于是真实 setInterval 照样被创建，
// node 进程因此永不退出，测试表现为挂起（实测两次）。
// 本文件只需要 setTimeout（在 renderTurn 里）继续可用，所以只替换 interval 两个。
const intervalCalls = [];
globalThis.setInterval = (fn, ms) => {
  intervalCalls.push(ms);
  return { __fake: true };
};
globalThis.clearInterval = () => {};

/** 控制台捕获缓冲（见 loadPlugin）。 */
const consoleLines = [];

/** 最小 React 替身。函数组件里用到的三个 hook 都实现为可直接求值的形式。 */
function makeFakeReact() {
  return {
    createElement(type, props, children) {
      // 允许 children 是数组或单值（真实 React 也接受）
      const kids = children === undefined ? [] : Array.isArray(children) ? children : [children];
      return { type, props: props || {}, children: kids };
    },
    useState(init) {
      // 组件里只用了「初始值即快照」这一种形态
      return [typeof init === 'function' ? init() : init, () => {}];
    },
    useReducer(_reducer, init) {
      return [init, () => {}];
    },
    // 真 React 在提交后运行 effect；替身**当场运行**（忽略清理函数）。
    // 这一点很关键：客户端把轮询启动放在 effect 里，若替身不跑 effect，
    // fetch 永远不会发生，测试就会测出一个与真实行为无关的结论。
    useEffect(fn) {
      if (typeof fn === 'function') fn();
    },
  };
}

/**
 * 模拟一次「轮次末尾挂载」：渲染一次，然后等异步 fetch 落地。
 * 真实时序是：turnTail 在每轮末尾挂载一次 → 首轮挂载时数据可能还没到（返回 null）
 * → 轮询把数据拿到后，**下一轮**挂载时才会出卡片。所以这里按两次挂载来测。
 */
async function renderTurn(component) {
  const out = component({});
  await new Promise((r) => setTimeout(r, 25));
  return out;
}

/** 装载真实的 client.js，返回它的插件对象。 */
async function loadPlugin({ fetchImpl }) {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(cfg) {
        captured = cfg;
      },
    },
    addEventListener() {},
  };
  globalThis.fetch = fetchImpl;
  // 捕获控制台输出：客户端的诊断是**外部唯一**能区分
  // "插件没加载"/"加载了但取数失败"/"取数成功只是没内容" 的线索。
  consoleLines.length = 0;
  globalThis.console = {
    info: (...a) => consoleLines.push({ level: 'info', text: a.join(' ') }),
    warn: (...a) => consoleLines.push({ level: 'warn', text: a.join(' ') }),
    log: () => {},
    error: () => {},
  };

  // 每次以全新模块装载，避免模块级状态（shownUpTo / latest）在用例之间串味
  const url = new URL(CLIENT_PATH + '?t=' + Math.random(), import.meta.url).href;
  await import(url);
  assert.ok(captured, 'client.js 应当调用 window.__ModuleLoader__.load');
  const react = makeFakeReact();
  const factory = captured.factory;
  const req = (id) => {
    if (id === 'react') return react;
    throw new Error('未预期的 require: ' + id);
  };
  return { plugin: factory(req), id: captured.id, intervalCalls };
}

/** 用假 slots 捕获注册的组件。 */
function captureComponent(plugin) {
  let component = null;
  let def = null;
  const ctx = {
    slots: {
      inject(name, fn) {
        assert.equal(name, 'conversation.chat.turnTail');
        return fn();
      },
      register(d, c) {
        def = d;
        component = c;
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  assert.ok(component, '应当注册一个组件到 conversation.chat.turnTail');
  return { component, def };
}

/** 把渲染树里的文本拼出来，便于断言。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.children);
}

const bridgeOk = (turns) => async () => ({
  ok: true,
  json: async () => ({ ok: true, total: turns.length, turns }),
});

test('插件形状：id 与插槽注册契约正确（不冒充用户消息，只贡献一个 turnTail 条目）', async () => {
  const { plugin, id } = await loadPlugin({ fetchImpl: bridgeOk([]) });
  assert.equal(id, 'dsh-client-recallflow-panel');
  assert.equal(plugin.name, 'recallflow-panel-ui');
  assert.deepEqual(plugin.inject, ['slots']);
  const { def } = captureComponent(plugin);
  assert.equal(def.name, 'conversation.chat.turnTail');
  assert.equal(def.id, 'recallflow-panel-ui');
  // 契约要求每条贡献有唯一 id；且不得使用 user 角色伪装（本插件根本不产生消息）
  assert.ok(typeof def.inject === 'function');
});

test('面板没有新回合时返回 null（插槽契约：无内容的条目返回 null，否则每轮都会重复刷屏）', async () => {
  const { plugin } = await loadPlugin({
    fetchImpl: bridgeOk([{ role: 'user', text: '旧消息', at: 1000 }]),
  });
  const { component } = captureComponent(plugin);
  // 第一轮：数据还没到（首轮挂载时轮询刚启动）→ 不出卡片
  const first = await renderTurn(component);
  assert.equal(first, null, '数据未到达时不应凭空出卡片');
  // 第二轮：数据已缓存 → 出卡片
  const second = component({});
  assert.ok(second, '数据到达后的下一轮应展示这张卡片');
  assert.ok(textOf(second).includes('旧消息'), textOf(second));
  // 第三轮：同一批内容不得重复出现（进度已推进）
  const third = component({});
  assert.equal(third, null, '同一批内容不应在后续轮次重复出现');
});

test('渲染内容标明「另一个 agent」且带角色前缀（不得让面板的话看起来像用户说的）', async () => {
  const { plugin } = await loadPlugin({
    fetchImpl: bridgeOk([
      { role: 'user', text: '面板里用户问的话', at: 2000 },
      { role: 'panel', text: '面板助手的回答', at: 2001 },
    ]),
  });
  const { component } = captureComponent(plugin);
  await renderTurn(component); // 首轮把数据拉进来
  const tree = component({});
  const text = textOf(tree);
  assert.ok(text.includes('浏览器 RecallFlow 面板'), text);
  assert.ok(text.includes('另一个助手 agent'), '必须标明是另一个 agent：' + text);
  assert.ok(text.includes('👤 你在面板：面板里用户问的话'), text);
  assert.ok(text.includes('💬 面板助手：面板助手的回答'), text);
});

test('只取最近若干条并对单条限长（面板是窄条，长回答会把对话撑爆）', async () => {
  const turns = [];
  for (let i = 0; i < 10; i++) turns.push({ role: 'user', text: 'T' + i + ':' + 'x'.repeat(400), at: 3000 + i });
  const { plugin } = await loadPlugin({ fetchImpl: bridgeOk(turns) });
  const { component } = captureComponent(plugin);
  await renderTurn(component); // 首轮把数据拉进来
  const text = textOf(component({}));
  assert.ok(!text.includes('T6:'), '旧的不应出现：' + text.slice(0, 120));
  assert.ok(text.includes('T9:'), '最新的应出现');
  assert.ok(text.length < 1200, '总长应受控，实际 ' + text.length);
});

test('桥接不可达时静默不出卡片（绝不因为拿不到面板数据而影响 DSH 界面）', async () => {
  const { plugin } = await loadPlugin({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const { component } = captureComponent(plugin);
  assert.equal(await renderTurn(component), null);
  assert.equal(component({}), null);
});

test('桥接返回非 2xx 时同样静默（例如远程来源被 CORS 挡住、或桥接是旧代码）', async () => {
  const { plugin } = await loadPlugin({ fetchImpl: async () => ({ ok: false, status: 401 }) });
  const { component } = captureComponent(plugin);
  assert.equal(await renderTurn(component), null);
  assert.equal(component({}), null);
});

test('装载时在控制台留一行（否则"没加载"与"加载了但没数据"外部无法区分）', async () => {
  const { plugin } = await loadPlugin({ fetchImpl: bridgeOk([]) });
  captureComponent(plugin);
  const info = consoleLines.find((l) => l.level === 'info' && l.text.includes('已装载'));
  assert.ok(info, '装载时应有 info 日志，实际：' + JSON.stringify(consoleLines));
  assert.ok(info.text.includes('conversation.chat.turnTail'), info.text);
});

test('取数失败时打印原因（404 特别指出可能是桥接旧代码）—— 这是外部唯一能看出原因的线索', async () => {
  const { plugin } = await loadPlugin({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  const { component } = captureComponent(plugin);
  await renderTurn(component);
  const warn = consoleLines.find((l) => l.level === 'warn');
  assert.ok(warn, '应打印警告，实际：' + JSON.stringify(consoleLines));
  assert.ok(warn.text.includes('404'), warn.text);
  assert.ok(warn.text.includes('旧代码'), '404 时应提示桥接可能是旧代码：' + warn.text);
});

test('跨源被挡时的报错要带上最可能的原因（浏览器只给笼统的 Failed to fetch）', async () => {
  const { plugin } = await loadPlugin({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  const { component } = captureComponent(plugin);
  await renderTurn(component);
  const warn = consoleLines.find((l) => l.level === 'warn');
  assert.ok(warn, '应打印警告');
  assert.ok(warn.text.includes('CORS'), '应提示 CORS 这个最可能的原因：' + warn.text);
});

test('同一种失败只打印一次（轮询每 4 秒一次，不能刷屏）', async () => {
  let calls = 0;
  const { plugin } = await loadPlugin({
    fetchImpl: async () => {
      calls++;
      throw new TypeError('Failed to fetch');
    },
  });
  const { component } = captureComponent(plugin);
  await renderTurn(component);
  const first = consoleLines.filter((l) => l.level === 'warn').length;
  // 再渲染几轮，触发更多次轮询
  await renderTurn(component);
  await renderTurn(component);
  const after = consoleLines.filter((l) => l.level === 'warn').length;
  assert.ok(calls >= 1, '应当真的尝试过取数');
  assert.equal(after, first, '同样的失败不应重复打印（实测会刷屏）');
});
