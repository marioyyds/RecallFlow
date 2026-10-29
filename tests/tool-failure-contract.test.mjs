// 工具失败的**契约**门禁：失败必须带 `ok: false`，且文案要说清下一步。
//
// ## 起因（B 站那次的实测转写）
//
// 转写里有这样一行 —— 注意它前面是 **✓**：
//
//     - read_current_page {"visibleOnly":true} → ✓ 读取页面失败：Could not establish connection...
//
// `ok` 是**下游信号**：失败摘除、卡死检测、完成校验、模型的自我纠错都读它。
// 标成成功 → 模型以为"读到了、只是内容为空"，于是换了 5 种读法才自己悟出"这个站读不了"。
//
// 更荒唐的是：**同一个文件里 8 行之下**的 `getPageSnapshotTool` 一直写得很对
//（`ok:false` + 可操作文案）—— 所以这是不一致，不是设计取舍。
//
// [docs/tool-design.md](../../docs/tool-design.md) §7 早就写明：
// 「`ok: false` 时，结果文本必须告诉模型**下一步能做什么**，而不是干巴巴报错」。
// 也就是说：**代码违反了自己文档的契约**，而且没有任何门禁拦它。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isContentScriptUnreachable, describeContentScriptUnreachable } from '../lib/shared/diagnostics.ts';
import { readCurrentPage } from '../lib/application/agent/page-read-tools.ts';
import { runJavascript } from '../lib/application/agent/code-access-tools.ts';
import { sourcePath } from './source-path.mjs';

const read = (p) => fs.readFileSync(sourcePath(p), 'utf8');

// ---------------- 源码级：失败返回必须带 ok:false ----------------

test('不许有「裸失败返回」：以失败文案为 result 的 return 必须带 ok:false', () => {
  const files = fs
    .readdirSync('lib/application/agent')
    .filter((f) => f.endsWith('.ts'))
    .map((f) => 'lib/application/agent/' + f)
    .concat([
      'lib/shared/diagnostics.ts',
      'lib/shared/format/page-results.ts',
      'lib/shared/format/picked.ts',
      'lib/shared/dom/html.ts',
      'lib/shared/text.ts',
    ]);
  // 失败语义的用词（不要只写「失败」—— 实测第一版就因为漏了「未知/无法」而少抓 3 处）
  const FAILURE_WORDS = '失败|错误|未知|无法|非法|不正确';
  const bad = [];
  for (const f of files) {
    read(f)
      .split('\n')
      .forEach((line, i) => {
        const t = line.trim();
        if (!t.startsWith('return { result:')) return;
        if (!new RegExp(FAILURE_WORDS).test(t)) return;
        bad.push(f + ':' + (i + 1) + '  ' + t.slice(0, 90));
      });
  }
  assert.deepEqual(
    bad,
    [],
    '这些 return 返回的是失败文案却没有 ok:false（下游会以为调用成功）：\n  ' + bad.join('\n  ')
  );
});

test('这条门禁本身有牙齿：裸失败返回会被抓，正常的失败返回不会误报', () => {
  const FAILURE_WORDS = '失败|错误|未知|无法|非法|不正确';
  const check = (line) => {
    const t = line.trim();
    if (!t.startsWith('return { result:')) return false;
    if (!new RegExp(FAILURE_WORDS).test(t)) return false;
    return true;
  };
  assert.equal(check("return { result: '读取页面失败：' + e.message };"), true, '裸失败必须被抓');
  assert.equal(check("return { result: '未知工具：' + name };"), true, '「未知」也算失败（第一版就是漏在这里）');
  assert.equal(check("return { ok: false, result: '无法定位当前标签页。' };"), false, '带 ok:false 的不该被抓');
  assert.equal(check("return { result: '当前页面正文：' + text };"), false, '成功返回不该被抓');
  assert.equal(check('return { result: out || \'（空结果）\' };'), false, '空结果不是失败');
});

// ---------------- 行为级：失败要带 ok:false，文案要可操作 ----------------

test('read_current_page：内容脚本连不上时，返回 ok:false 且给出替代路线', async () => {
  // ⚠ 刻意**只给最小 deps**：翻译器是纯函数、由模块直接 import，
  // 不需要调用方注入 —— 否则既有调用方全都得跟着改（本次实测就是这样挂了两条既有测试）。
  const deps = {
    ctx: { tabId: 7 },
    sendTabMessage: async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  };
  const r = await readCurrentPage(deps, {});
  assert.equal(r.ok, false, '失败必须带 ok:false —— 否则转写里会显示成 ✓');
  assert.match(r.result, /读取页面失败/);
  // 必须告诉模型下一步能做什么（docs/tool-design.md §7）
  assert.match(r.result, /get_ax_snapshot/, '要指出不经内容脚本的 CDP 工具');
  assert.match(r.result, /run_javascript/, '要指出页面世界执行这条退路');
  assert.match(r.result, /不要反复重试同一条路/, '要给出停止条件 —— 实测模型在这类站点上连试了 8 次');
});

test('run_javascript：同一类失败同样是 ok:false + 可操作文案', async () => {
  const deps = {
    ctx: { tabId: 7 },
    executeContentAction: async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
    isCspEvalBlockError: () => false,
    cdpAllowed: () => true,
    evaluateInPageWorld: async () => ({ ok: true, result: '' }),
  };
  const r = await runJavascript(deps, { code: 'return 1' });
  assert.equal(r.ok, false);
  assert.match(r.result, /执行 JS 失败/);
  assert.match(r.result, /get_ax_snapshot|run_javascript/, '要给出替代路线');
});

// ---------------- 翻译器本身 ----------------

test('isContentScriptUnreachable：认出这一族错误，不误伤别的', () => {
  for (const m of [
    'Could not establish connection. Receiving end does not exist.',
    'Could not establish connection',
    'The message port closed before a response was received.',
    'receiving end does not exist', // 大小写不敏感
  ]) {
    assert.equal(isContentScriptUnreachable(m), true, m + ' 应被认出');
  }
  for (const m of ['页面超时', '', null, undefined, 'CDP 无法附加到该标签页']) {
    assert.equal(isContentScriptUnreachable(m), false, String(m) + ' 不该被误判');
  }
});

test('describeContentScriptUnreachable：连不上→可操作文案；其它错误→原样带前缀', () => {
  const t = describeContentScriptUnreachable('Receiving end does not exist.', '读取页面失败：');
  assert.match(t, /^读取页面失败：/);
  assert.match(t, /没有可用的内容脚本/);
  assert.match(t, /get_ax_snapshot/);
  // 非连接类错误必须**原样**保留原因，不能被这套文案吃掉（否则真因就丢了）
  const other = describeContentScriptUnreachable('CDP 无法附加到该标签页', '读取页面失败：');
  assert.equal(other, '读取页面失败：CDP 无法附加到该标签页');
});

test('翻译器与用户脚本运行时的判定同源（同一族错误，两处认得的结果必须一致）', () => {
  // userscript 运行时用同一套正则决定"先注入 runner.js 再重试"。
  // 两处判定若漂移，就会出现"某条路认得、另一条不认得"，所以这里钉住同源。
  const mgr = read('lib/userscript/manager.js');
  assert.match(
    mgr,
    /Receiving end does not exist\|Could not establish connection\|message port closed/,
    '运行时那份判定仍应是同一族；若改动了请同步 isContentScriptUnreachable'
  );
  const diagnostics = read('lib/shared/diagnostics.ts');
  assert.match(diagnostics, /export function isContentScriptUnreachable/);
});
