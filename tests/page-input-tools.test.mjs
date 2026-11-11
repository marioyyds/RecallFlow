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
  splitTrustedText,
} from '../lib/application/agent/page-input-tools.ts';

/** 造一套假依赖，并记录每次调用（便于断言"有没有升级 CDP"）。 */
function mkDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    ctx: { tabId: 7, lastSnapshot: { fingerprint: 'fp-before' } },
    cdp: {
      evaluate: async (tabId, expr) => {
        calls.push({ op: 'cdp.evaluate', tabId, expr });
        if (String(expr).includes('dispatchEditablePaste')) {
          calls.push({ op: 'cdp.paste', status: deps.pasteStatus });
          return deps.pasteStatus;
        }
        if (!expr.includes('rf-read-editable')) return undefined;
        const i = Math.min(deps.readIndex, deps.readValues.length - 1);
        deps.readIndex += 1;
        return deps.readValues[i];
      },
      evaluateInFrame: async (tabId, frameId, expr) => {
        calls.push({ op: 'cdp.evaluateInFrame', tabId, frameId, expr });
        if (String(expr).includes('dispatchEditablePaste')) {
          calls.push({ op: 'cdp.paste', status: deps.pasteStatus });
          return deps.pasteStatus;
        }
        if (!expr.includes('rf-read-editable')) return undefined;
        const i = Math.min(deps.readIndex, deps.readValues.length - 1);
        deps.readIndex += 1;
        return deps.readValues[i];
      },
      pressKey: async (tabId, key, mods) => calls.push({ op: 'cdp.pressKey', tabId, key, mods }),
      insertText: async (tabId, text) => calls.push({ op: 'cdp.insertText', tabId, text }),
    },
    pasteStatus: 'dispatched',
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
  assert.match(r.result, /已用 CDP 事务式输入 3 个字符/);
  const ops = deps.calls.map((c) => c.op);
  assert.ok(ops.includes('cdp.evaluate'), '应聚焦目标元素');
  assert.ok(ops.includes('cdp.insertText'), '应插入文本');
  assert.ok(deps.calls.some((c) => c.op === 'cdp.insertText' && c.text === 'abc'));
});

test('type_text：clearFirst=true 时先用 DOM 全选建立事务边界', async () => {
  const deps = mkDeps({ contentResult: { ok: false }, readValues: ['', 'x'] });
  await typeText(deps, { value: 'x', clearFirst: true });
  const focus = deps.calls.find(
    (c) => c.op === 'cdp.evaluate' && String(c.expr).includes('el.select()')
  );
  assert.ok(focus, '应在可信输入前全选目标内容，做事务式替换');
  assert.ok(!deps.calls.some((c) => c.op === 'cdp.pressKey'), '不应依赖 Ctrl+A 的焦点副作用');
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
  const r = await typeText(deps, { clearFirst: true });
  const ins = deps.calls.find((c) => c.op === 'cdp.insertText');
  assert.equal(ins, undefined, '清空操作不应插入字符串 "null"');
  assert.equal(r.strategy, 'cdp-clear-only');
});

test('type_text：富文本多行正文一次性事务写入，不再逐行按 Enter', async () => {
  const deps = mkDeps({
    contentResult: { ok: false, matchesIntent: false, partial: true },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: ['', '第一行\n第二行'],
  });
  const r = await typeText(deps, { value: '第一行\n第二行', clearFirst: true });
  const inserted = deps.calls.filter((c) => c.op === 'cdp.insertText').map((c) => c.text);
  assert.deepEqual(inserted, ['第一行\n第二行'], '块内换行应保留在同一个可信输入事务中');
  assert.ok(!deps.calls.some((c) => c.op === 'cdp.pressKey' && c.key === 'Enter'), '不应逐行重入编辑器');
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'cdp-transactional');
  assert.equal(r.matchesIntent, true);
});

test('type_text：内容脚本半写入后，用 valueBefore 恢复基线再整体写入', async () => {
  const expected = '已有开头\n新正文';
  const deps = mkDeps({
    contentResult: {
      ok: false,
      matchesIntent: false,
      partial: true,
      valueBefore: '已有开头',
    },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: [expected],
  });
  const r = await typeText(deps, { value: '\n新正文' });
  const inserted = deps.calls.filter((c) => c.op === 'cdp.insertText').map((c) => c.text);
  assert.deepEqual(inserted, [expected]);
  assert.equal(r.ok, true);
  assert.equal(r.strategy, 'cdp-transactional');
});

test('splitTrustedText：长正文按段落切块且保留原文', () => {
  const text = ('段落一\n' + '填充'.repeat(700) + '\n段落三').repeat(2);
  const chunks = splitTrustedText(text, 1200);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 1200));
  assert.equal(chunks.join(''), text);
});

test('type_text：CDP 富文本回读使用逻辑 DOM 文本，不按 innerText 的排版空行验收', async () => {
  const deps = mkDeps({
    contentResult: { ok: false, matchesIntent: false, partial: true },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: ['', 'A\n\nB'],
  });
  const r = await typeText(deps, { value: 'A\n\nB', clearFirst: true });
  const readExpr = deps.calls.find(
    (c) => c.op === 'cdp.evaluate' && String(c.expr).includes('rf-read-editable')
  );
  assert.ok(readExpr, '应执行富文本回读');
  assert.match(String(readExpr.expr), /function readContentEditableText/);
  assert.doesNotMatch(String(readExpr.expr), /el\.innerText/);
  assert.equal(r.ok, true);
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
  assert.match(r.result, /CDP 事务式输入未达到预期/);
  assert.match(r.result, /不要原样重试同一路径/);
});

test('type_text：长正文换行被编辑器吞掉时，用一次真实 paste 重写并回读确认', async () => {
  const deps = mkDeps({
    contentResult: { ok: false, matchesIntent: false, partial: true },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    // 三次回读：基线、insertText 之后（段落换行被归一化）、paste 之后（结构正确）
    readValues: ['', '第一行第二行', '第一行\n第二行'],
  });
  const r = await typeText(deps, { value: '第一行\n第二行', clearFirst: true });
  assert.equal(r.ok, true, 'paste 重写后回读一致就必须算成功：' + r.result);
  assert.equal(r.matchesIntent, true);
  assert.match(r.strategy, /\+paste$/, 'strategy 必须标明走过 paste：' + r.strategy);
  assert.ok(deps.calls.some((c) => c.op === 'cdp.paste' && c.status === 'dispatched'));
  assert.ok(
    deps.calls.some(
      (c) => c.op === 'cdp.evaluate' && String(c.expr).includes('dispatchEditablePaste')
    ),
    '应注入自包含的 paste 派发器'
  );
  assert.ok(
    !deps.calls.some((c) => c.op === 'cdp.pressKey' && c.key === 'Enter'),
    '仍然不许逐行按 Enter 重入编辑器'
  );
});

test('type_text：paste 之后仍不一致时必须失败（不许假报成功）', async () => {
  const deps = mkDeps({
    contentResult: { ok: false },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: ['', '第一行', '第一行'],
  });
  const r = await typeText(deps, { value: '第一行\n第二行', clearFirst: true });
  assert.equal(r.ok, false);
  assert.equal(r.partial, true);
  assert.match(r.strategy, /\+paste$/);
  assert.match(r.result, /未达到预期/);
  assert.match(r.result, /不要原样重试同一路径/);
});

test('type_text：单行值不触发 paste 重写（只在换行敏感的场景才多花一次往返）', async () => {
  const deps = mkDeps({
    contentResult: { ok: false },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: ['', '别的'],
  });
  const r = await typeText(deps, { value: '第一行', clearFirst: true });
  assert.equal(r.ok, false);
  assert.ok(!deps.calls.some((c) => c.op === 'cdp.paste'), '单行值不该触发 paste');
  assert.equal(r.strategy, 'cdp-transactional');
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

test('type_text：paste 之前必须先清空（否则编辑器把新内容追加成两倍）', async () => {
  const deps = mkDeps({
    contentResult: { ok: false, matchesIntent: false, partial: true },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: ['', '第一行第二行', '第一行\n第二行'],
  });
  const r = await typeText(deps, { value: '第一行\n第二行', clearFirst: true });
  assert.equal(r.ok, true);
  const inserts = deps.calls.filter((c) => c.op === 'cdp.insertText');
  assert.equal(inserts[0].text, '第一行\n第二行', '先做一次整体写入');
  assert.equal(inserts[1].text, '', 'paste 前必须用空串替换选区，得到干净基线');
  const pasteAt = deps.calls.findIndex((c) => c.op === 'cdp.paste');
  const clearAt = deps.calls.findIndex((c) => c.op === 'cdp.insertText' && c.text === '');
  assert.ok(clearAt >= 0 && pasteAt > clearAt, '清空必须发生在 paste 之前：' + JSON.stringify(deps.calls.map((c) => c.op)));
});

test('type_text：回读比期望长（重复写入）时不再叠加 paste，并按内容不一致报错', async () => {
  const deps = mkDeps({
    contentResult: { ok: false },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: ['', '第一行第五行第二行'],
  });
  const r = await typeText(deps, { value: '第一行\n第二行', clearFirst: true });
  assert.equal(r.ok, false);
  assert.equal(r.whitespaceOnly, false);
  assert.ok(!deps.calls.some((c) => c.op === 'cdp.paste'), '内容已经变长时不该再 paste');
  assert.doesNotMatch(r.result, /差异只在换行\/空白/);
});

test('type_text：只差换行/空白时判失败，但把原因说清楚（不算写对）', async () => {
  const deps = mkDeps({
    contentResult: { ok: false },
    resolveTarget: async () => ({ selector: '#q', contentEditable: true }),
    readValues: ['', '第一行第二行', '第一行第二行'],
  });
  const r = await typeText(deps, { value: '第一行\n第二行', clearFirst: true });
  assert.equal(r.ok, false, 'Markdown 的换行是结构，不能判成功');
  assert.equal(r.whitespaceOnly, true);
  assert.match(r.result, /差异只在换行\/空白/);
  assert.match(r.verification.reason, /归一化/);
});

test('press_key：合成成功但没有可观测变化时，不得把「已派发」当成功证据', async () => {
  const deps = mkDeps({ getPageSnapshot: async () => ({ fingerprint: 'fp-before' }) });
  const r = await pressKey(deps, { key: 'a', modifiers: ['CTRL'] });
  assert.equal(r.ok, true, '按键本身确实发出去了，不该报失败');
  assert.equal(r.hadEffect, false);
  assert.equal(r.verification.verified, false, '没变化就不能声称已验证');
  assert.match(r.result, /没有观测到页面\/字段变化/);
  assert.match(r.result, /先点击它或确认编辑器已聚焦/, '必须给出可执行的补救提示');
});

test('press_key：观测到变化时保留内容脚本的结果（不额外改写）', async () => {
  const deps = mkDeps();
  const r = await pressKey(deps, { key: 'Enter' });
  assert.equal(r.ok, true);
  assert.equal(r.result, '合成成功');
  assert.equal(r.hadEffect, undefined, '有变化时不该覆盖内容脚本的既有字段');
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
