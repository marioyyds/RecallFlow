// 导出/交接完整性的源码级门禁。
//
// 为什么必须是源码级：这两个缺陷的本质都是「某条代码路径**少做了一步**」——
//   ① 助手条目只在 'end' 收尾时入库，于是任务进行中导出/交接只能拿到用户消息；
//   ② 错误分支只把错误写进 DOM，从不入库，面板一刷新连错误都没了。
// 它们不会让任何单元测试变红（导出照样产出、面板照样显示），只会在使用时
// 交出一个空包。这与本仓库既有的「对 const 赋值」「请求前缀稳定性」是同一类
// 问题：静态可查、但没人查。
//
// 按行切源码前先剥 \r：Windows 工作区是 CRLF，精确比较会因为行尾 \r 全部落空（实测）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('lib/page/chat.js', 'utf8');
const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));

/** 取 [startMarker 所在行, endMarker 所在行) 之间的正文。 */
function sliceBetween(startMarker, endMarker) {
  const s = lines.findIndex((l) => l.includes(startMarker));
  assert.notEqual(s, -1, '找不到起始标记：' + startMarker);
  const e = lines.findIndex((l, i) => i > s && l.includes(endMarker));
  assert.ok(e > s, '找不到结束标记：' + endMarker);
  return lines.slice(s, e).join('\n');
}

/**
 * 去掉整行注释后再做源码断言。
 * 必须这么做：这些代码块里的注释本身就在描述「必须赶在 endStream() 之前」，
 * 直接 indexOf('endStream()') 会先命中注释里的那次，把顺序判断成反的（实测踩到）。
 */
function stripCommentLines(text) {
  return text
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
}

const errorBranch = stripCommentLines(sliceBetween("resp.type === 'error'", 'conn.onDisconnect.addListener'));
const exportHelper = sliceBetween('function messagesForExport', 'function buildTranscriptMarkdown');

test('错误分支必须把失败轮次写进对话并落盘（否则刷新即丢失）', () => {
  assert.match(
    errorBranch,
    /conversation\.push\(\s*buildFailedTurn/,
    '错误分支没有把失败轮次 push 进 conversation —— 错误只存在于 DOM 里，「导出记录」与「会话交接」都看不到它'
  );
  assert.match(errorBranch, /saveConversation\(\)/, '错误分支没有 saveConversation —— 面板一刷新错误就没了');
});

test('错误分支必须在 endStream() 之前取 pendingParts（它会把状态清空）', () => {
  const pushAt = errorBranch.indexOf('buildFailedTurn');
  const endAt = errorBranch.indexOf('endStream()');
  assert.ok(pushAt !== -1 && endAt !== -1);
  assert.ok(pushAt < endAt, 'buildFailedTurn 必须在 endStream() 之前调用，否则拿不到失败前的工具轨迹');
});

test('错误分支必须保留失败前已发生的工具轨迹', () => {
  assert.match(errorBranch, /buildFailedTurn\(\s*pendingParts/, '失败轮次应带上 pendingParts，否则交接包里看不到它试过什么');
});

test('导出必须带上进行中的轮次，而不是只读已入库的 conversation', () => {
  assert.match(
    exportHelper,
    /buildPartialTurn/,
    'messagesForExport 没有合成进行中的轮次 —— 任务进行中导出/交接会得到一个只有用户消息的空包'
  );
  assert.match(exportHelper, /conversation/, '应在已入库对话的基础上追加，而不是替换');
});

test('「导出记录」与「会话交接」两条路径都走 messagesForExport', () => {
  // 只改一条路径是最容易犯的错：两个功能看起来独立，实际都读 conversation。
  const exportFn = sliceBetween('function buildTranscriptMarkdown', 'function serializeConversation');
  assert.match(exportFn, /conversation:\s*messagesForExport\(\)/, '「导出记录」没有用 messagesForExport()');

  const handoffFn = sliceBetween('async function snapshotHandoff', 'selection: lastText,');
  assert.match(handoffFn, /messages:\s*messagesForExport\(\)/, '「会话交接」没有用 messagesForExport()');
});

test('失败消息在面板重渲染时强制渲染 content（否则错误会被内联文本遮住）', () => {
  const render = sliceBetween('const hasInlineText = parts.some', 'citeSourcesHtml(m.citations)');
  assert.match(render, /!m\.failed/, 'hasInlineText 的短路里没有考虑 m.failed —— 该轮之前有叙述时错误会被整段藏起来');
  assert.match(render, /m\.failed \? ' style="color:#e74c3c"'/, '失败消息重渲染后应保持红色');
});
