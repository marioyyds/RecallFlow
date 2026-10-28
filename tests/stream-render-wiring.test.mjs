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

const SRC_PATH = 'lib/ui/page/chat.ts';
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
  const calls = chunkBranch.match(/showStreamingAnswer\(/g) || [];
  assert.equal(calls.length, 1, 'chunk 分支应恰好有一处正文重绘（实测 ' + calls.length + ' 处）');

  const schedAt = chunkBranch.indexOf("streamRender.schedule('answer'");
  assert.notEqual(schedAt, -1, 'answer 必须通过 streamRender.schedule 合并');
  assert.ok(
    chunkBranch.indexOf('showStreamingAnswer(') > schedAt,
    '正文重绘出现在 schedule 之前 —— 说明它是直接执行的，逐 token 全量重解析又回来了'
  );
});

test('chunk 分支里只有一处自动滚动，且必须在 layout 回调内', () => {
  // ⚠ 判据从"字面的 `panelBody.scrollTop =`"升级为"置底入口 `pinToBottom()`"：
  //   置底统一收进 `pinToBottom()`（它内部会认 `observerAutoScroll`，并 `markSelfScroll()`
  //   屏蔽掉"容器改高度→浏览器夹紧 scrollTop→派发 scroll"这条把自动跟随误关掉的路径）。
  //   断言意图不变：**这一分支只能有一处置底，且必须排在 layout 回调里**（不能被合并逻辑漏掉）。
  const calls = chunkBranch.match(/pinToBottom\(\)/g) || [];
  assert.equal(calls.length, 1, 'chunk 分支应恰好有一处置底（pinToBottom），实测 ' + calls.length);
  const schedAt = chunkBranch.indexOf("streamRender.schedule('layout'");
  assert.notEqual(schedAt, -1, 'layout 必须通过 streamRender.schedule 合并');
  assert.ok(chunkBranch.indexOf('pinToBottom()') > schedAt, '置底必须在 layout 回调里');
});

test('解析入口只出现在 schedule 回调里（不经合并的解析一律视为退化）', () => {
  const all = chunkBranch.match(/showStreamingAnswer\(|renderAnswer\(|renderMarkdown\(/g) || [];
  assert.equal(all.length, 1, '解析入口应只有一处，实测 ' + all.length + ' 处');
});

test('流式正文不得把游标拼进会被 innerHTML 重建的 Markdown HTML', () => {
  assert.ok(!/renderAnswer\([^\n]*,\s*true\)/.test(src), 'UI 流式重绘不得再使用 renderAnswer(..., true)');
  const helper = sliceFunction('function showStreamingAnswer(', '');
  assert.match(helper, /renderAnswer\(text, citations, false\)/, '正文按非流式 HTML 渲染');
  assert.match(helper, /streamingCursors\.get\(host\)/, '游标必须从 WeakMap 复用');
  assert.match(helper, /parent\.insertBefore\(cursor, host\.nextSibling\)/, '游标应是正文的兄弟节点');
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

/**
 * 取一个函数的**完整**正文：从函数头一直取到下一个顶格行。
 *
 * 不用 `sliceFunction` 的"同级缩进 `}`"来定界 —— fitPanelHeight 的快路径本身就有 `  }`，
 * 朴素定界会把函数切成半截：那样放在函数末尾的置底就永远被判为"不存在"，
 * 于是"把置底删掉"这种退化照样能变绿。
 */
function sliceFunctionBody(header) {
  const s = lines.findIndex((l) => l.includes(header));
  assert.notEqual(s, -1, '找不到函数：' + header);
  let e = s + 1;
  while (e < lines.length) {
    const l = lines[e];
    if (l.trim() !== '' && !/^\s/.test(l)) break;
    e += 1;
  }
  return lines.slice(s, e).join('\n');
}

/** 剥掉注释后再判定据：注释里写"以前是 `scrollTop = scrollHeight`"不该被当成现在的代码。 */
function codeOnly(body) {
  return body
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join('\n');
}

// ---------------------------------------------------------------- 流式布局的成本门禁
//
// 这一组是 TITA-6 那一轮性能收尾**用源码就能查到**的部分。它们的共同点是：
// 退化实现**功能完全正常、现有测试全绿**，只是又回到"每帧多几次强制同步布局"。
// 行为层面的判据（拿真 DOM 数它读了几处几何量）在 tests/streaming-layout-guard.test.mjs。

test('fitPanelHeight 全程只读一次 scrollHeight（收尾置底不允许再读一次）', () => {
  const body = codeOnly(sliceFunctionBody('function fitPanelHeight('));
  const reads = body.match(/scrollHeight/g) || [];
  assert.equal(
    reads.length,
    1,
    'fitPanelHeight 应只在 `bodyNatH = panelBody.scrollHeight` 处取一次几何量，实测 ' +
      reads.length +
      ' 处 —— 多出来的那处就是"写完样式再读一次"的强制同步布局'
  );
  assert.match(body, /panelBody\.scrollTop = BOTTOM_SCROLL_PX/, '置底应写滚动哨兵，而不是先读 scrollHeight');
});

test('pinToBottom 一次布局都不读（置底靠写滚动哨兵）', () => {
  const body = codeOnly(sliceFunctionBody('function pinToBottom()'));
  const reads = body.match(/scrollHeight|offsetHeight|getBoundingClientRect/g) || [];
  assert.deepEqual(reads, [], 'pinToBottom 是被逐帧调用的一行，不允许为了置底读几何量：' + String(reads));
  assert.match(body, /BOTTOM_SCROLL_PX/, '置底应用滚动哨兵（见该常量的说明）');
});

test('流式游标定位不再用 TreeWalker 遍历整段正文', () => {
  const body = sliceFunctionBody('function positionStreamCursor(');
  assert.ok(
    !/createTreeWalker/.test(codeOnly(body)),
    'positionStreamCursor 又用 createTreeWalker 了 —— 那会把整段正文的每个文本节点都走一遍（随正文增长）'
  );
  // 游标定位允许读几何量（absolute 定位必须取 rect），但**找末文本节点**必须是按树深倒着走。
  assert.match(body, /lastNonNullTextNode\(host\)/, '末文本节点应按树深倒着找');
  assert.match(body, /cursorContainingBlock\(host\)/, '包含块必须走缓存，不能每帧爬祖先链做 getComputedStyle');
});

test('fitPanelHeight 必须保留 chrome 测量的复用快路径', () => {
  const body = codeOnly(sliceFunctionBody('function fitPanelHeight('));
  assert.match(body, /reusable\s*&&\s*fitBodyClamped/, '缺少"面板已饱和且 chrome 未变 ⇒ 跳过整次重排"的快路径');
  const resets = src.match(/resetPanelFitCache\(\)/g) || [];
  assert.ok(
    resets.length >= 3,
    '面板销毁/重建时必须让测量缓存失效（需 ≥3 处：面板关闭 / removePanel / openPanel，实测 ' + resets.length + ' 处）'
  );
  assert.match(body, /CHROME_MEASURE_TTL_MS/, '缺少 TTL 兜底：签名拦不住"等长改写 / 子元素自身高度变化"');
  // TTL 的起算点必须是"上一次真实测量"：快路径若把计时续期成"本次命中时间"，
  // 这个兜底就永远不会到期（评审在 d9f69ed 上实测的缺陷），行为判据见
  // tests/streaming-layout-guard.test.mjs 的「TTL 到期必须重新测量」。
  assert.ok(
    !/chromeMeasure\.measuredAt\s*=/.test(body.replace(/chromeMeasure\s*=\s*\{[^}]*\}/g, '')),
    '快路径不许给 `measuredAt` 赋值（那等于每次命中都把 TTL 续期）；只允许更新 `usedAt`'
  );
  assert.match(src, /panelCmdInput/, '面板输入框的引用未接入（签名会漏判"用户打字把输入区撑高"）');
  assert.match(
    codeOnly(sliceFunctionBody('function fitChromeSignature(')),
    /panelCmdInput[\s\S]*\.value/,
    '签名必须计入输入框的**当前 value**：textarea 的 value 不在 textContent 里，只看 textContent.length 会漏判'
  );
});

test('流式正文重绘必须带自适应节流，且被跳过的帧有兜底补画', () => {
  assert.match(chunkBranch, /throttleStreamPaint\(/, 'answer 回调应在重绘前先做节流判定');
  assert.match(
    sliceFunctionBody('function throttleStreamPaint('),
    /setTimeout/,
    '被跳过的帧必须有兜底定时器补画：流式随时可能停住，停住后就不再有 chunk 来排下一次绘制'
  );
  assert.match(
    sliceFunctionBody('function endStream()'),
    /cancelStreamPaintRetry\(\)/,
    '收尾必须取消补画定时器，否则一轮结束后还会空跑一次'
  );
});

test('接线用 render-scheduler 提供的调度器，而不是就地手写 rAF', () => {
  assert.ok(
    /import\s*\{[^}]*createFrameScheduler[^}]*\}\s*from\s*'\.[^']*render-scheduler\.(js|ts)'/.test(src),
    '应从 ./render-scheduler.js 引入 createFrameScheduler'
  );
  assert.ok(/createFrameScheduler\(\)/.test(src), '应实例化一个帧级调度器');
});
