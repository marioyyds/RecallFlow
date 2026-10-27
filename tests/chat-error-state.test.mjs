// 「这一轮失败了」的渲染与入库。
//
// 失败是这个助手最常见的非正常收尾（API 报错、校验反复不过、端口断开……），
// 而它此前**只有 E2E 间接碰过一次**。两条规则错了都不会报错，只会让用户丢掉东西：
//
//   ① 已经流出正文时，错误必须**追加**，不能覆盖 ——
//      原实现无条件 `pendingContentEl.textContent = errText`，于是「回答读到一半报错」
//      会让刚看完的回答当场从屏幕上消失，只剩一行红字；而它其实还在 conversation 里，
//      重开面板又会冒出来，前后还不一致。
//   ② 失败轮次入库时必须带上**已经流出的正文** ——
//      正文只累积在 pendingNarration，要等 'end' 才进 parts，而失败根本走不到 'end'。
//      不带的话，一次中途失败就把用户看到的整段回答从记录里抹掉。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.mjs';
import { installChrome, restoreChrome } from './helpers/chrome-stub.mjs';

let seq = 0;

async function boot(chromeOpts = {}) {
  const dom = installDomStub();
  const prevChrome = installChrome(chromeOpts);
  const mod = await import('../lib/page/chat.ts?case=errorel-' + (seq += 1));
  const make = (tag) => dom.document.createElement(tag);
  return {
    dom,
    mod,
    make,
    /** 造一个「对话流里已有一段正文」的场景。 */
    flowWithAnswer(answerText) {
      const flow = make('div');
      const answer = make('div');
      answer.className = 'agent-content';
      answer.textContent = answerText;
      flow.appendChild(answer);
      return { flow, answer };
    },
    close() { dom.restore(); restoreChrome(prevChrome); },
  };
}

// ---------------------------------------------------------------- 渲染规则

test('renderRunError：已经流出正文时**追加**，不许覆盖（用户正在读那半截）', async () => {
  const app = await boot();
  try {
    const { flow, answer } = app.flowWithAnswer('这里是我已经看了两屏的回答');
    const errEl = app.mod.renderRunError(flow, answer, '请求失败：网络中断', true);
    assert.ok(errEl, '要返回写入错误的元素');
    assert.equal(answer.textContent, '这里是我已经看了两屏的回答', '半截回答绝不能消失');
    assert.equal(errEl.textContent, '请求失败：网络中断');
    assert.equal(errEl.style.color, '#e74c3c', '错误要一眼能认出来');
    assert.equal(flow.childNodes.length, 2, '错误必须是**新增的一块**，不是替换');
  } finally {
    app.close();
  }
});

test('renderRunError：还没有正文时复用占位元素（它可能还停在「正在输入」）', async () => {
  const app = await boot();
  try {
    const { flow, answer } = app.flowWithAnswer('');
    const errEl = app.mod.renderRunError(flow, answer, '请求失败：鉴权失败', false);
    assert.equal(errEl, answer, '没有正文就原地改，不必多插一个空块');
    assert.equal(answer.textContent, '请求失败：鉴权失败');
    assert.equal(flow.childNodes.length, 1);
  } finally {
    app.close();
  }
});

test('renderRunError：拿不到对话流时不抛（面板可能已关）', async () => {
  const app = await boot();
  try {
    assert.equal(app.mod.renderRunError(null, null, '出错了', false), null);
    assert.equal(app.mod.renderRunError(null, null, '出错了', true), null);
  } finally {
    app.close();
  }
});

test('renderRunError：错误文本里的标签不会被当成 HTML（用的是 textContent）', async () => {
  const app = await boot();
  try {
    const { flow, answer } = app.flowWithAnswer('前文');
    const errEl = app.mod.renderRunError(flow, answer, '<img src=x onerror=alert(1)>', true);
    assert.equal(errEl.querySelector('img'), null, '错误文本来自后台/上游，不能当 HTML 解释');
    assert.ok(errEl.textContent.includes('<img'), '原样显示成文本才对');
  } finally {
    app.close();
  }
});

// ---------------------------------------------------------------- 「打开设置」出口

test('buildOpenSettingsButton：点一下就去打开设置页（缺少 API Key 时唯一的出口）', async () => {
  const sent = [];
  const app = await boot({
    overrides: {
      runtime: {
        id: 'ok',
        getURL: (p) => p,
        getManifest: () => ({ manifest_version: 3 }),
        onMessage: { addListener() {} },
        sendMessage: async (m) => { sent.push(m); },
      },
    },
  });
  try {
    const btn = app.mod.buildOpenSettingsButton();
    assert.equal(btn.textContent, '打开设置');
    btn.emit('click', {});
    assert.deepEqual(sent, [{ type: 'openOptions' }], '必须请求后台打开设置页 —— 这是用户唯一的自救入口');
  } finally {
    app.close();
  }
});

test('buildOpenSettingsButton：上下文失效（sendMessage 抛错）不得冒泡', async () => {
  const app = await boot({
    overrides: {
      runtime: {
        id: 'gone',
        getURL: (p) => p,
        getManifest: () => ({ manifest_version: 3 }),
        onMessage: { addListener() {} },
        sendMessage() { throw new Error('Extension context invalidated.'); },
      },
    },
  });
  try {
    const btn = app.mod.buildOpenSettingsButton();
    btn.emit('click', {}); // 扩展刚被更新时这是常态：抛出去就是一条未捕获异常
  } finally {
    app.close();
  }
});
