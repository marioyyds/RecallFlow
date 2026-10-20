// 工具审批条（`renderApprovalPrompt` / `describeApprovalRequest`）。
//
// 为什么单独给这一块写单测：它是**用户唯一能看到的「Agent 要动你的页面了」**。
// 在此之前它只有 golden.spec 里的 E2E 覆盖（走真实端口 + 真实点击），
// 而这里有三条错了都不会报错、只会**静默泄露或静默放行**的性质：
//
//   ① type_text 的 value 必须遮蔽 —— 否则用户输入的密码 / 证件号直接印在屏幕上；
//   ② run_javascript 的代码必须整段出现 —— 用户批准的正是这段代码，
//      省略等于让他批准一段自己没看见的东西；
//   ③ allowSession === false 时不许出现「本任务内允许」按钮 —— 少了这条，
//      「只准一次」的工具会变成一个可以一键放行整轮任务的按钮。
//
// 另外把「点按钮 → postMessage 什么」也钉住：审批的载荷（once / session / reject + callId）
// 是页面与后台之间唯一的契约，改错一个字符串就是「用户点了拒绝，任务继续跑」。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.mjs';
import { installChrome, restoreChrome } from './helpers/chrome-stub.mjs';

let seq = 0;

/**
 * 起一份全新的 chat.js 实例（模块级状态很多，见 chat-panel-smoke.test.mjs 的说明）。
 * 这里不调 initAssistant：被测的两个函数不依赖面板，只要模块能加载即可。
 */
async function boot() {
  const dom = installDomStub();
  const prevChrome = installChrome({});
  const mod = await import('../lib/page/chat.js?case=approval-' + (seq += 1));
  return {
    dom,
    mod,
    box: () => dom.document.createElement('div'),
    conn: () => {
      const conn = { messages: [], postMessage(m) { this.messages.push(m); } };
      return conn;
    },
    close() { dom.restore(); restoreChrome(prevChrome); },
  };
}

// ---------------------------------------------------------------- 展示什么

test('describeApprovalRequest：type_text 的输入内容必须遮蔽（隐私）', async () => {
  const app = await boot();
  try {
    const v = app.mod.describeApprovalRequest('type_text', { ref: 'e12', value: 'hunter2-my-password' }, 'medium', true);
    assert.ok(!v.argsJson.includes('hunter2'), '明文口令绝不能出现在审批条里：' + v.argsJson);
    assert.match(v.argsJson, /输入内容已隐藏/, '必须明确告诉用户「这里本该有内容，被隐藏了」');
    assert.match(v.argsJson, /e12/, '遮蔽的只是值，目标元素仍然要显示出来（否则用户不知道往哪输入）');
  } finally {
    app.close();
  }
});

test('describeApprovalRequest：run_javascript 的代码整段给出，参数区不重复', async () => {
  const app = await boot();
  try {
    const code = 'document.querySelectorAll(".ad").forEach((n) => n.remove());';
    const v = app.mod.describeApprovalRequest('run_javascript', { code, tabId: 7 }, 'high', true);
    assert.equal(v.longText, code, '要执行的代码必须逐字、完整地出现在长文本区');
    assert.match(v.longLabel, /完整代码/);
    assert.ok(!v.argsJson.includes('querySelectorAll'), '参数区不能再把整段代码重复一遍（会把真正的参数挤没了）');
    assert.match(v.argsJson, /完整内容见下方/, '要有一句话指向下面的代码块');
    assert.match(v.argsJson, /tabId/, '其余参数照常显示');
  } finally {
    app.close();
  }
});

test('describeApprovalRequest：save_skill 的措辞与 run_javascript 不同（后果不一样）', async () => {
  const app = await boot();
  try {
    const v = app.mod.describeApprovalRequest('save_skill', { name: 'x', content: '正文…' }, 'high', false);
    assert.match(v.longLabel, /技能正文/);
    assert.match(v.longLabel, /今后/, '要让用户知道这份正文会进入今后的系统提示，不只是这一次');
    assert.equal(v.longText, '正文…');
  } finally {
    app.close();
  }
});

test('describeApprovalRequest：风险等级映射（用户靠这个词决定要不要点）', async () => {
  const app = await boot();
  try {
    const label = (risk) => app.mod.describeApprovalRequest('open_tab', {}, risk, true).riskLabel;
    assert.equal(label('high'), '高风险');
    assert.equal(label('medium'), '需确认');
    assert.equal(label('external'), '外部操作');
    // 缺省 / 未知一律按「外部操作」—— 不能因为不认识就显示成「低风险」
    assert.equal(label(undefined), '外部操作');
    assert.equal(label('whatever'), '外部操作');
  } finally {
    app.close();
  }
});

test('describeApprovalRequest：allowSession=false 时不给批量放行按钮', async () => {
  const app = await boot();
  try {
    assert.equal(app.mod.describeApprovalRequest('run_userscript', {}, 'high', false).showSession, false);
    assert.equal(app.mod.describeApprovalRequest('run_userscript', {}, 'high', true).showSession, true);
    // 旧调用点可能不传 → 默认给（与改动前一致）
    assert.equal(app.mod.describeApprovalRequest('run_userscript', {}, 'high', undefined).showSession, true);
  } finally {
    app.close();
  }
});

test('describeApprovalRequest：没有参数时不出参数行（空 JSON 对用户零信息）', async () => {
  const app = await boot();
  try {
    assert.equal(app.mod.describeApprovalRequest('list_tabs', {}, 'medium', true).argsJson, '');
    assert.equal(app.mod.describeApprovalRequest('list_tabs', null, 'medium', true).argsJson, '');
  } finally {
    app.close();
  }
});

test('describeApprovalRequest：脏数据不抛（args 可能是字符串 / 数组 / 缺字段）', async () => {
  const app = await boot();
  try {
    for (const args of [null, undefined, 'oops', 42, []]) {
      const v = app.mod.describeApprovalRequest('click_element', args, 'medium', true);
      assert.equal(typeof v.argsJson, 'string', 'args=' + JSON.stringify(args));
    }
    // 长文本字段存在但是空的 → 不该渲染代码块（空的 <pre> 会让人以为有东西没显示出来）
    assert.equal(app.mod.describeApprovalRequest('run_javascript', { code: '' }, 'high', true).longText, '');
    assert.equal(app.mod.describeApprovalRequest('run_javascript', { code: '' }, 'high', true).longLabel, '');
  } finally {
    app.close();
  }
});

// ---------------------------------------------------------------- 点下去意味着什么

test('renderApprovalPrompt：点「允许一次」→ once（不是 session）', async () => {
  const app = await boot();
  try {
    const box = app.box();
    const conn = app.conn();
    assert.equal(app.mod.renderApprovalPrompt(box, conn, 'call-1', 'click_element', { ref: 'e1' }, 'medium', true), true);
    assert.match(box.innerHTML, /click_element/, '必须写出要执行的是哪个工具');
    assert.match(box.innerHTML, /执行前需要你的确认/);
    box.querySelector('.tool-approve').emit('click', {});
    assert.deepEqual(conn.messages, [{ type: 'tool-approval', callId: 'call-1', decision: 'once' }]);
    assert.equal(box.style.display, 'none', '决定之后审批条必须收起来（否则用户会以为还没生效）');
  } finally {
    app.close();
  }
});

test('renderApprovalPrompt：点「本任务内允许」→ session', async () => {
  const app = await boot();
  try {
    const box = app.box();
    const conn = app.conn();
    app.mod.renderApprovalPrompt(box, conn, 'call-2', 'annotate', {}, 'medium', true);
    box.querySelector('.tool-approve-session').emit('click', {});
    assert.deepEqual(conn.messages, [{ type: 'tool-approval', callId: 'call-2', decision: 'session' }]);
  } finally {
    app.close();
  }
});

test('renderApprovalPrompt：点「拒绝」→ reject', async () => {
  const app = await boot();
  try {
    const box = app.box();
    const conn = app.conn();
    app.mod.renderApprovalPrompt(box, conn, 'call-3', 'run_userscript', { name: 'x' }, 'high', false);
    box.querySelector('.tool-reject').emit('click', {});
    assert.deepEqual(conn.messages, [{ type: 'tool-approval', callId: 'call-3', decision: 'reject' }]);
  } finally {
    app.close();
  }
});

test('renderApprovalPrompt：allowSession=false 时按钮**不存在**（不是隐藏）', async () => {
  const app = await boot();
  try {
    const box = app.box();
    app.mod.renderApprovalPrompt(box, app.conn(), 'call-4', 'run_userscript', {}, 'high', false);
    assert.equal(box.querySelector('.tool-approve-session'), null, '「本任务内允许」必须真的不渲染，而不是样式藏起来');
    assert.ok(box.querySelector('.tool-approve'), '「允许一次」仍然要在');
    assert.ok(box.querySelector('.tool-reject'), '「拒绝」仍然要在');
  } finally {
    app.close();
  }
});

test('renderApprovalPrompt：连接已断（postMessage 抛错）时不能把异常冒出去', async () => {
  const app = await boot();
  try {
    const box = app.box();
    const conn = { postMessage() { throw new Error('Extension context invalidated.'); } };
    app.mod.renderApprovalPrompt(box, conn, 'call-5', 'click_element', {}, 'medium', true);
    // 扩展重载后端口断开是**常态**：点一下按钮就抛一个未捕获异常，用户会看到控制台红一片
    box.querySelector('.tool-approve').emit('click', {});
    assert.equal(box.style.display, 'none', '即使发送失败，审批条也要收起来 —— 留在原地会让人反复点');
  } finally {
    app.close();
  }
});

test('renderApprovalPrompt：缺 box / 缺 conn 时返回 false 且不抛', async () => {
  const app = await boot();
  try {
    assert.equal(app.mod.renderApprovalPrompt(null, app.conn(), 'c', 'x', {}, 'medium', true), false);
    assert.equal(app.mod.renderApprovalPrompt(app.box(), null, 'c', 'x', {}, 'medium', true), false);
    assert.equal(app.mod.renderApprovalPrompt(app.box(), app.conn(), 'c', 'x', {}, 'medium', true), true);
  } finally {
    app.close();
  }
});

test('renderApprovalPrompt：代码里的尖括号必须转义（审批条是 innerHTML 拼的）', async () => {
  const app = await boot();
  try {
    const box = app.box();
    const evil = 'document.write("</pre><img src=x onerror=alert(1)>")';
    app.mod.renderApprovalPrompt(box, app.conn(), 'call-6', 'run_javascript', { code: evil }, 'high', true);
    // 桩的 innerHTML 是**真解析**的，所以这里能真的验证「有没有被当成标签」
    assert.equal(box.querySelector('img'), null, '代码里的标签名不能被渲染成真元素（XSS）');
    assert.ok(box.innerHTML.includes('&lt;'), '尖括号要以实体形式出现');
  } finally {
    app.close();
  }
});
