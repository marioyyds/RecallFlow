// page-input-tools.js：页面输入命令族（C-1 拆出的第 5 族）。
//
// 抽取的收益在这里最明显：这一族的核心语义是**"先合成、失败才升级 CDP"**，
// 而升级条件写错会造成严重后果 —— 若把升级条件写成"没有观测到效果"，
// 就会对真实页面**重复输入/重复按键**。以前这段埋在巨型 switch 里，只能靠真实页面碰运气。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  typeText,
  pressKey,
  thinPageCommand,
  handlePageInputTool,
  PAGE_INPUT_TOOLS,
  THIN_PAGE_COMMANDS,
} from '../lib/assistant/page-input-tools.ts';

/** 造一套假依赖，并记录每次调用（便于断言"有没有升级 CDP"）。 */
function mkDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    ctx: { tabId: 7, lastSnapshot: { fingerprint: 'fp-before' } },
    cdp: {
      evaluate: async (tabId, expr) => {
        calls.push({ op: 'cdp.evaluate', tabId, expr });
        if (!expr.includes('rf-read-editable')) return undefined;
        const i = Math.min(deps.readIndex, deps.readValues.length - 1);
        deps.readIndex += 1;
        return deps.readValues[i];
      },
      evaluateInFrame: async (tabId, frameId, expr) => {
        calls.push({ op: 'cdp.evaluateInFrame', tabId, frameId, expr });
        if (!expr.includes('rf-read-editable')) return undefined;
        const i = Math.min(deps.readIndex, deps.readValues.length - 1);
        deps.readIndex += 1;
        return deps.readValues[i];
      },
      pressKey: async (tabId, key, mods) => calls.push({ op: 'cdp.pressKey', tabId, key, mods }),
      insertText: async (tabId, text) => calls.push({ op: 'cdp.insertText', tabId, text }),
    },
    readValues: ['', 'abc'],
    readIndex: 0,
    cdpAllowed: () => true,
    executeContentAction: async (tabId, action, message, opts) => {
      calls.push({ op: 'content', action, message, opts });
      return deps.contentResult;
    },
    contentResult: { ok: true, result: '合成成功' },
    frameIdFromArgs: () => null,
    resolveTarget: async () => ({ selector: '#q' }),
    rememberTarget: () => calls.push({ op: 'rememberTarget' }),
    getPageSnapshot: async () => ({ fingerprint: 'fp-after' }),
    observedChange: (before, after) =>
      !before || !after ? 'unobservable' : before.fingerprint === after.fingerprint ? 'unchanged' : 'changed',
    buildActionVerification: (observed, reason) => ({ verified: observed === 'changed', changed: observed === 'changed', reason }),
    compactSnapshotSummary: () => '页面摘要',
    summarizeCdpError: (e) => String(e.message).replace(/^[A-Za-z.]+：/, ''),
    ...overrides,
  };
  return deps;
}

test('PAGE_INPUT_TOOLS 覆盖六个工具名', () => {
  assert.deepEqual([...PAGE_INPUT_TOOLS].sort(),
    ['check_box', 'get_attribute', 'press_key', 'select_option', 'type_text', 'wait_for_element']);
});

test('handlePageInputTool：不属于本族返回 null', async () => {
  assert.equal(await handlePageInputTool('click_element', {}, mkDeps()), null);
  assert.equal(await handlePageInputTool('open_tab', {}, mkDeps()), null);
});

test('type_text：合成成功时**不得**碰 CDP（升级只在失败时）', async () => {
  const deps = mkDeps();
  const r = await typeText(deps, { value: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.result, '合成成功');
  assert.ok(!deps.calls.some((c) => String(c.op).startsWith('cdp.')), '合成成功却升级了 CDP：' + JSON.stringify(deps.calls));
});

test('type_text：合成失败时升级到 CDP 可信输入，并按观测算 hadEffect', async () => {
  const deps = mkDeps({ contentResult: { ok: false, result: '合成失败' } });
  const r = await typeText(deps, { value: 'abc' });
  assert.equal(r.ok, true);
  assert.equal(r.cdp, true, '应标记走了 CDP');
  assert.equal(r.hadEffect, true, '前后指纹不同 → hadEffect 应为 true');
  assert.equal(r.verification.changed, true);
  assert.match(r.result, /已用 CDP 可信输入 3 个字符/);
  const ops = deps.calls.map((c) => c.op);
  assert.ok(ops.includes('cdp.evaluate'), '应聚焦目标元素');
  assert.ok(ops.includes('cdp.insertText'), '应插入文本');
  assert.ok(deps.calls.some((c) => c.op === 'cdp.insertText' && c.text === 'abc'));
});

test('type_text：clearFirst=true 时先全选（Ctrl+A）再插入', async () => {
  const deps = mkDeps({ contentResult: { ok: false }, readValues: ['', 'x'] });
  await typeText(deps, { value: 'x', clearFirst: true });
  const press = deps.calls.find((c) => c.op === 'cdp.pressKey');
  assert.ok(press, '应发一次按键');
  assert.equal(press.key, 'a');
  assert.deepEqual(press.mods, ['CTRL']);
});

test('type_text：子框架用 evaluateInFrame 聚焦（否则会聚焦到主框架的错误元素）', async () => {
  const deps = mkDeps({ contentResult: { ok: false }, frameIdFromArgs: () => 3, readValues: ['', 'x'] });
  await typeText(deps, { value: 'x' });
  assert.ok(deps.calls.some((c) => c.op === 'cdp.evaluateInFrame' && c.frameId === 3));
  assert.ok(!deps.calls.some((c) => c.op === 'cdp.evaluate'), '子框架不应走主框架 evaluate');
});

test('type_text：合成后无观测变化时 hadEffect=false（不得谎报）', async () => {
  const deps = mkDeps({
    contentResult: { ok: false },
    readValues: ['', 'x'],
    getPageSnapshot: async () => ({ fingerprint: 'fp-before' }), // 与 before 相同
  });
  const r = await typeText(deps, { value: 'x' });
  assert.equal(r.hadEffect, false);
  assert.equal(r.verification.changed, false);
  assert.equal(r.verification.verified, false, '没观测到变化就不能声称已验证');
});

test('type_text：CDP 不可用时如实返回合成失败（不假装成功）', async () => {
  const deps = mkDeps({ contentResult: { ok: false, result: '合成失败' }, cdpAllowed: () => false });
  const r = await typeText(deps, { value: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.result, '合成失败');
  assert.ok(!deps.calls.some((c) => String(c.op).startsWith('cdp.')), 'CDP 不可用时不该调用它');
});

test('type_text：找不到目标元素时不升级 CDP，返回合成失败原因', async () => {
  const deps = mkDeps({ contentResult: { ok: false, result: '未找到元素' }, resolveTarget: async () => null });
  const r = await typeText(deps, { value: 'x' });
  assert.equal(r.result, '未找到元素');
  assert.ok(!deps.calls.some((c) => c.op === 'cdp.insertText'));
});

test('type_text：contenteditable 场景 value 为 null 时插入空串（不插 "null"）', async () => {
  const deps = mkDeps({ contentResult: { ok: false }, readValues: ['', ''] });
  await typeText(deps, { clearFirst: true });
  const ins = deps.calls.find((c) => c.op === 'cdp.insertText');
  assert.equal(ins.text, '', '缺 value 时应插入空串');
});

test('type_text：富文本多行输入逐行插入，并以 Enter 建立段边界', async () => {
  const deps = mkDeps({
    contentResult: { ok: false, matchesIntent: false, partial: true },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: ['', '第一行\n第二行'],
  });
  const r = await typeText(deps, { value: '第一行\n第二行', clearFirst: true });
  const inserted = deps.calls.filter((c) => c.op === 'cdp.insertText').map((c) => c.text);
  assert.deepEqual(inserted.slice(-2), ['第一行', '第二行'], '应逐行插入，而不是一整段硬塞');
  assert.ok(deps.calls.some((c) => c.op === 'cdp.pressKey' && c.key === 'Enter'), '行间应派发可信 Enter');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'cdp-line-by-line');
  assert.equal(r.matchesIntent, true);
});

test('type_text：CDP 输入后回读不一致必须失败（不许假报成功）', async () => {
  const deps = mkDeps({
    contentResult: { ok: false },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: ['', '第一行'],
  });
  const r = await typeText(deps, { value: '第一行\n第二行', clearFirst: true });
  assert.equal(r.ok, false);
  assert.equal(r.partial, true);
  assert.equal(r.matchesIntent, false);
  assert.match(r.result, /CDP 输入未达到预期/);
  assert.match(r.result, /不要假设已写入/);
});

test('press_key：合成成功不碰 CDP；失败才升级', async () => {
  const ok = mkDeps();
  await pressKey(ok, { key: 'Enter' });
  assert.ok(!ok.calls.some((c) => String(c.op).startsWith('cdp.')), '合成成功却升级了 CDP');

  const fail = mkDeps({ contentResult: { ok: false } });
  const r = await pressKey(fail, { key: 'Enter', modifiers: ['SHIFT'] });
  assert.equal(r.ok, true);
  assert.equal(r.cdp, true);
  const press = fail.calls.find((c) => c.op === 'cdp.pressKey');
  assert.equal(press.key, 'Enter');
  assert.deepEqual(press.mods, ['SHIFT']);
  assert.match(r.result, /已用 CDP 派发按键：Enter/);
});

test('四个薄包装命令：各自的 message 类型与延迟参数正确', async () => {
  const expect = {
    select_option: 'kbSelectOption',
    check_box: 'kbCheckBox',
    wait_for_element: 'kbWaitForElement',
    get_attribute: 'kbGetAttribute',
  };
  for (const [name, message] of Object.entries(expect)) {
    const deps = mkDeps();
    const r = await thinPageCommand(deps, name, { a: 1 });
    assert.equal(r.ok, true, name + ' 应成功');
    const c = deps.calls.find((x) => x.op === 'content');
    assert.equal(c.action, name, name + ' 的 action 应为工具名');
    assert.equal(c.message.type, message, name + ' 的消息类型不对');
    assert.deepEqual(c.message.params, { a: 1 }, name + ' 应原样转发参数');
  }
  // 延迟/校验参数是有意设置的区别：前两个等页面反馈，后两个不等
  assert.deepEqual(THIN_PAGE_COMMANDS.select_option.opts, { delayMs: 100 });
  assert.deepEqual(THIN_PAGE_COMMANDS.check_box.opts, { delayMs: 100 });
  assert.deepEqual(THIN_PAGE_COMMANDS.wait_for_element.opts, { verify: false });
  assert.deepEqual(THIN_PAGE_COMMANDS.get_attribute.opts, { verify: false });
});

test('薄包装命令：失败时给出带中文动作名的可读原因', async () => {
  const deps = mkDeps({
    executeContentAction: async () => { throw new Error('内容脚本未响应'); },
  });
  const r = await thinPageCommand(deps, 'check_box', {});
  assert.equal(r.ok, false);
  assert.match(r.result, /切换复选框失败：内容脚本未响应/);
});

test('薄包装命令：未知名字返回 null（让 executeTool 继续分派）', async () => {
  assert.equal(await thinPageCommand(mkDeps(), 'not_a_tool', {}), null);
});
