// 流式渲染接线的源码级门禁。
//
// 为什么需要它：把「每 token 重绘」改回「每帧一次」之后，如果有人日后在 chunk 分支里
// 图省事直接写一句 `fitPanelHeight()` 或 `innerHTML = renderAnswer(...)`，
// **功能完全正常**、测试也全绿，只是超线性开销悄悄回来了。
// 这和本仓库既有的「对 const 赋值」「请求前缀稳定性」是同一类问题：
// 静态可查、但没人查。所以在这里钉住。
//
// 取分支正文用「按同级分支标记切行」而不是括号配对：本文件里有
// `/[.*+?^${}()|[\]\\]/` 这类**正则字面量**，里面的 {} 会被朴素计数当成真括号
//（实测三次切分全部失败）。分支的首尾本来就由 `} else if (resp.type === '…') {`
// 这类同级标记界定，按行切比数括号更可靠。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC_PATH = 'lib/page/chat.js';
// 按行做源码分析前必须先剥掉 \r：本文件在 Windows 工作区是 CRLF，
// 只按 '\n' 切会留下行尾的 \r，`lines[i] === '  }'` 这种精确比较会全部落空（实测踩到）。
const src = fs.readFileSync(SRC_PATH, 'utf8');
const lines = src.split('\n').map((l) => l.replace(/\r$/, ''));

/** 取 [startMarker 所在行, endMarker 所在行) 之间的正文。 */
function sliceBetween(startMarker, endMarker) {
  const s = lines.findIndex((l) => l.includes(startMarker));
  assert.notEqual(s, -1, '找不到起始标记：' + startMarker);
  const e = lines.findIndex((l, i) => i > s && l.includes(endMarker));
  assert.ok(e > s, '找不到结束标记：' + endMarker);
  return lines.slice(s, e).join('\n');
}

/** 从一个函数头取到它自己的收尾行（同级缩进的 `}`）。 */
function sliceFunction(header, closingIndent) {
  const s = lines.findIndex((l) => l.includes(header));
  assert.notEqual(s, -1, '找不到函数：' + header);
  const close = closingIndent + '}';
  for (let i = s + 1; i < lines.length; i++) {
    if (lines[i] === close) return lines.slice(s, i + 1).join('\n');
  }
  throw new Error('函数未找到收尾行：' + header);
}

const chunkBranch = sliceBetween("resp.type === 'chunk'", "resp.type === 'end'");
const endBranch = sliceBetween("resp.type === 'end'", "resp.type === 'error'");
const endStreamBody = sliceFunction('function endStream()', '  ');

// ---------------------------------------------------------------- chunk 分支

test('chunk 分支里只有一处布局调用，且必须在 schedule 回调内', () => {
  const calls = chunkBranch.match(/fitPanelHeight\(\)/g) || [];
  assert.equal(calls.length, 1, 'chunk 分支应恰好有一处 fitPanelHeight（实测 ' + calls.length + ' 处）——多出来的那句就是逐 token 强制回流');

  const schedAt = chunkBranch.indexOf("streamRender.schedule('layout'");
  assert.notEqual(schedAt, -1, 'layout 必须通过 streamRender.schedule 合并');
  assert.ok(
    chunkBranch.indexOf('fitPanelHeight()') > schedAt,
    'fitPanelHeight() 出现在 schedule 之前 —— 说明它是直接执行的，没被合并'
  );
});

test('chunk 分支里只有一处正文重绘，且必须在 schedule 回调内', () => {
  const calls = chunkBranch.match(/innerHTML = renderAnswer\(/g) || [];
  assert.equal(calls.length, 1, 'chunk 分支应恰好有一处正文重绘（实测 ' + calls.length + ' 处）');

  const schedAt = chunkBranch.indexOf("streamRender.schedule('answer'");
  assert.notEqual(schedAt, -1, 'answer 必须通过 streamRender.schedule 合并');
  assert.ok(
    chunkBranch.indexOf('innerHTML = renderAnswer(') > schedAt,
    '正文重绘出现在 schedule 之前 —— 说明它是直接执行的，逐 token 全量重解析又回来了'
  );
});

test('chunk 分支里只有一处自动滚动，且必须在 layout 回调内', () => {
  const calls = chunkBranch.match(/panelBody\.scrollTop =/g) || [];
  assert.equal(calls.length, 1, 'chunk 分支应恰好有一处 scrollTop 赋值，实测 ' + calls.length);
  const schedAt = chunkBranch.indexOf("streamRender.schedule('layout'");
  assert.ok(chunkBranch.indexOf('panelBody.scrollTop =') > schedAt, 'scrollTop 必须在 layout 回调里');
});

test('解析入口只出现在 schedule 回调里（不经合并的解析一律视为退化）', () => {
  const all = chunkBranch.match(/renderAnswer\(|renderMarkdown\(/g) || [];
  assert.equal(all.length, 1, '解析入口应只有一处，实测 ' + all.length + ' 处');
});

// ---------------------------------------------------------------- end 分支

test('end 分支必须先 flush 再写最终版（否则会被排队中的流式渲染覆盖）', () => {
  const flushAt = endBranch.indexOf('streamRender.flush()');
  const finalAt = endBranch.indexOf('innerHTML = renderAnswer(');
  assert.notEqual(flushAt, -1, 'end 分支必须先 flush 掉仍在排队的流式渲染');
  assert.notEqual(finalAt, -1, 'end 分支应有最终渲染');
  assert.ok(flushAt < finalAt, 'flush 必须在最终渲染之前，否则最后一帧会用旧文本覆盖最终版');
});

// ---------------------------------------------------------------- 收尾出口

test('endStream 会丢弃仍在排队的渲染（状态已被重置，晚到的回调没有意义）', () => {
  const cancelAt = endStreamBody.indexOf('streamRender.cancel()');
  assert.notEqual(cancelAt, -1, 'endStream 是唯一的收尾出口，必须在这里 cancel');
  const resetAt = endStreamBody.indexOf('pendingContentEl = null');
  assert.notEqual(resetAt, -1, 'endStream 应重置 pendingContentEl');
  assert.ok(cancelAt < resetAt, 'cancel 应在清空 pending 状态之前，否则只是巧合而非保证');
});

test('接线用 render-scheduler 提供的调度器，而不是就地手写 rAF', () => {
  assert.ok(
    /import\s*\{[^}]*createFrameScheduler[^}]*\}\s*from\s*'\.[^']*render-scheduler\.js'/.test(src),
    '应从 ./render-scheduler.js 引入 createFrameScheduler'
  );
  assert.ok(/createFrameScheduler\(\)/.test(src), '应实例化一个帧级调度器');
});
