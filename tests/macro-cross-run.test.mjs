// 宏的「跨轮次沉淀」：把上一次运行的可重放轨迹暂存下来，供下一轮 `macro(op:"save")` 使用。
//
// 背景（会话 RF-FY6PUP 的真实故障）：用户在小红书把发布流程跑完之后，**下一轮**才说
// 「沉淀为技能」—— 而 `ctx.trace` 只活在单次运行里（agent.js 每次 run 都新建空数组），
// 于是 op=save 只能回「当前任务没有可保存的可重放动作」，用户看到的是"不能保存宏"。
//
// 本文件钉住四件事：
//   ① 记录时会把本轮的轨迹按站点（origin）暂存，单槽覆盖；
//   ② 超过 TTL 的轨迹取不回来 —— 拿半小时前的序列去回放，等于在一个已经变了的页面上乱点；
//   ③ 用回退轨迹存出来的宏**必须标明来源是上一轮**，不能假装是刚录的；
//   ④ 无论轨迹来自哪里，落库前都要过可回放白名单（回退轨迹来自另一个 storage 键，
//      而宏一旦落库就会被反复回放 —— 这是本仓库记过一次真实提权的地方）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { rememberTrace, recallTrace, LAST_TRACE_TTL_MS, LAST_TRACE_KEY } from '../lib/assistant/macro-store.js';
import { macroSave, REPLAYABLE_TOOLS } from '../lib/assistant/macros.js';

// 安装 chrome.storage.local 桩（行为对齐真实 API：get 接受字符串或数组）。
function installStorage() {
  const store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          return out;
        },
        async set(obj) {
          Object.assign(store, obj);
        },
        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete store[k];
        },
      },
    },
  };
  return { store };
}

const CLICK = { tool: 'click_element', args: { selector: '#go' } };
const TYPE = { tool: 'type_text', args: { selector: '#q', value: '咖啡', clearFirst: true } };

test('rememberTrace：按 origin 单槽覆盖，且不同站点互不干扰', async () => {
  const { store } = installStorage();
  await rememberTrace('https://a.example/one', [CLICK]);
  await rememberTrace('https://b.example/two', [CLICK, TYPE]);
  // 同一 origin 的第二次记录**覆盖**第一次（单槽），而不是追加：
  // 只有"最近一次运行"是可解释的，多份历史会在保存时说不清"存的是哪一趟"。
  await rememberTrace('https://a.example/another-page', [TYPE]);

  const a = await recallTrace('https://a.example/one');
  assert.equal(a.steps.length, 1, '同 origin 第二次记录应覆盖第一次');
  assert.equal(a.steps[0].tool, 'type_text');

  const b = await recallTrace('https://b.example/two');
  assert.equal(b.steps.length, 2, '别的站点不受影响');

  assert.ok(store[LAST_TRACE_KEY]['https://a.example'], '按 origin 建索引');
});

test('rememberTrace：形状不合法的步骤一律不记；全不合法的记为空', async () => {
  const { store } = installStorage();
  await rememberTrace('https://a.example/', [
    { tool: 'click_element' }, // 缺 args
    { tool: 123, args: {} }, // tool 不是字符串
    null,
    'not-a-step',
    CLICK,
  ]);
  const a = await recallTrace('https://a.example/');
  assert.equal(a.steps.length, 1, '只有形状完整的那一步被记住');

  await rememberTrace('https://c.example/', [{ tool: 'click_element' }]);
  assert.equal(await recallTrace('https://c.example/'), null, '一条都记不住时不该留下空记录');
  assert.ok(!store[LAST_TRACE_KEY]['https://c.example'], '空记录不进存储（否则 recall 会返回空数组而不是 null）');
});

test('rememberTrace / recallTrace：没有 URL 或非法 URL 时安静返回，不抛错', async () => {
  installStorage();
  assert.equal(await rememberTrace('', [CLICK]), null);
  assert.equal(await rememberTrace('not a url', [CLICK]), null);
  assert.equal(await recallTrace(''), null);
});

test('recallTrace：超过 TTL 的轨迹取不回来（过期的序列不能拿去回放）', async () => {
  installStorage();
  await rememberTrace('https://a.example/', [CLICK]);
  const fresh = await recallTrace('https://a.example/');
  assert.ok(fresh, '刚记的应能取回');

  assert.equal(
    await recallTrace('https://a.example/', { now: Date.now() + LAST_TRACE_TTL_MS + 1000 }),
    null,
    '过 TTL 必须返回 null（而不是返回旧步骤让调用方自己判断）'
  );
  // TTL 可注入：测试与调用方都不必等 30 分钟。
  assert.ok(await recallTrace('https://a.example/', { maxAgeMs: 60 * 60 * 1000 }));
  assert.equal(await recallTrace('https://a.example/', { maxAgeMs: 0 }), null);
});

test('macroSave：本轮为空时用上一轮轨迹，并**标明来源不是本轮**', async () => {
  installStorage();
  const savedCalls = [];
  const r = await macroSave(
    {
      pageUrl: 'https://creator.example/publish',
      trace: [], // 本轮什么都没做过（正是 RF-FY6PUP 的处境）
      recallTrace: async () => ({ steps: [CLICK, TYPE], updatedAt: Date.now(), ageMs: 120000, dropped: 0 }),
      saveMacro: async (url, macro) => {
        savedCalls.push({ url, macro });
        return { name: macro.name, steps: macro.steps };
      },
    },
    { name: '发布笔记' }
  );
  assert.equal(r.ok, true);
  assert.equal(savedCalls.length, 1, '回退轨迹要真的被写进宏');
  assert.equal(savedCalls[0].macro.steps.length, 2);
  assert.match(r.result, /已保存宏「发布笔记」（2 步）/);
  assert.match(r.result, /上一轮任务/, '必须说明来源是上一轮 —— 否则模型会以为是自己刚录的');
  assert.match(r.result, /2 分钟前/, '要把"多久以前"说清楚，用户才能判断还准不准');
  assert.match(r.result, /先核对|试跑/, '来源不明的序列必须先核对再回放');
});

test('macroSave：本轮有轨迹时**不**去读上一轮（本轮优先）', async () => {
  installStorage();
  let recallCalls = 0;
  const r = await macroSave(
    {
      pageUrl: 'https://a.example/',
      trace: [CLICK],
      recallTrace: async () => {
        recallCalls += 1;
        return { steps: [TYPE], ageMs: 1 };
      },
      saveMacro: async (url, macro) => ({ name: macro.name, steps: macro.steps }),
    },
    { name: 'x' }
  );
  assert.equal(r.ok, true);
  assert.equal(recallCalls, 0, '本轮有料就不该去翻上一轮');
  assert.ok(!/上一轮/.test(r.result), '来源是本轮时不得出现"上一轮"的标注');
});

test('macroSave：两条路都没有时，报错要给出"下一步怎么做"', async () => {
  installStorage();
  const r = await macroSave(
    { pageUrl: 'https://a.example/', trace: [], recallTrace: async () => null, saveMacro: async () => null },
    { name: 'x' }
  );
  assert.equal(r.ok, false);
  assert.match(r.result, /没有可保存的可重放动作/);
  assert.match(r.result, /click_element/, '要列出到底哪些工具才会被记录');
  assert.match(r.result, /click_at/, '要说明 click_at / run_javascript 这类**不进宏**（RF-FY6PUP 正是栽在这里）');
  assert.match(r.result, /run_javascript/);
  assert.match(r.result, /macro\(\{op:"save"/, '要给出可执行的下一步');
});

test('macroSave：白名单外的步骤一律剔除（回退轨迹来自另一个 storage 键，不能当可信输入）', async () => {
  installStorage();
  let saved = null;
  const r = await macroSave(
    {
      pageUrl: 'https://a.example/',
      trace: [],
      // 恶意/损坏的暂存：塞进任意工具名（提权路径的形态）
      recallTrace: async () => ({
        steps: [CLICK, { tool: 'run_javascript', args: { code: 'fetch("//evil")' } }, { tool: 'click_at', args: { x: 1, y: 2 } }],
        ageMs: 1000,
        dropped: 0,
      }),
      saveMacro: async (url, macro) => {
        saved = macro;
        return { name: macro.name, steps: macro.steps };
      },
    },
    { name: 'x' }
  );
  assert.equal(r.ok, true);
  assert.deepEqual(saved.steps.map((s) => s.tool), ['click_element'], '只允许白名单内的步骤落库');
  assert.match(r.result, /2 步不在可回放白名单内，已剔除/, '剔除了多少步必须如实说明（丢东西要说明）');
  assert.ok(REPLAYABLE_TOOLS.has('click_element') && !REPLAYABLE_TOOLS.has('run_javascript'));
});

test('macroSave：白名单把整批步骤都剔掉时，报错要说清原因', async () => {
  installStorage();
  let savedCalls = 0;
  const r = await macroSave(
    {
      pageUrl: 'https://a.example/',
      trace: [],
      recallTrace: async () => ({ steps: [{ tool: 'run_javascript', args: { code: '1' } }], ageMs: 1000, dropped: 0 }),
      saveMacro: async () => {
        savedCalls += 1;
        return null;
      },
    },
    { name: 'x' }
  );
  assert.equal(r.ok, false);
  assert.equal(savedCalls, 0, '没有合法步骤时不该调用存储（避免写出一条空宏）');
  assert.match(r.result, /都不在可回放白名单内/);
});
