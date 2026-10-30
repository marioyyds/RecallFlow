// page-read-tools.js：页面读取族（C-1 拆出的第 8 族）—— Agent 的"眼睛"。
//
// 抽取的收益：这一族有三条**踩过坑才写成**的语义，以前埋在巨型 switch 里：
//   1. 核查模式（传 checkTexts）只回答"文案还在不在/可见吗"，**不返回正文、不登记引用**；
//   2. 404 / 无内容页**不登记参考来源**（否则真正引用的内容被推到高序号）；
//   3. includeFrames 合并子框架后**仍要过体积预算**（否则绕开快照自身的字符预算）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listFramesRaw,
  prefixFrameRefs,
  isCrossOriginFrame,
  mergeFrameCapabilities,
  formatCapabilityHint,
  readCurrentPage,
  getPageSnapshotTool,
  listFrames,
  PAGE_READ_TOOLS,
  handlePageReadTool,
} from '../lib/application/agent/page-read-tools.ts';

test('能力提示把快照元数据翻成下一步工具（而不是重复清单）', () => {
  const hint = formatCapabilityHint({
    customElements: { count: 2, samples: [{ tag: 'xhs-publish-btn', selector: 'xhs-publish-btn' }] },
    shadowHosts: { count: 1, samples: [{ tag: 'rf-search', selector: 'rf-search' }] },
    editables: { count: 1, samples: [{ selector: '#editor', kind: 'prosemirror' }] },
    scrollContainers: { count: 1, samples: [{ selector: '#list', scrollTop: 0 }] },
  });
  assert.match(hint, /inspect_element\(\{op:"query"\}\)/);
  assert.match(hint, /xhs-publish-btn/);
  assert.match(hint, /type_text/);
  assert.match(hint, /prosemirror/);
  assert.match(hint, /scroll_page\(\{selector:"…", y:600\}\)/);
  assert.match(hint, /不要为此调用 run_javascript/);
});

test('没有特殊能力时不给任何提示（避免每份快照都塞废话）', () => {
  assert.equal(formatCapabilityHint(null), '');
  assert.equal(formatCapabilityHint({}), '');
  assert.equal(formatCapabilityHint({ customElements: { count: 0, samples: [] } }), '');
});

test('合并子框架能力：计数相加，样本带 frameId，且给子框架留位置', () => {
  const merged = mergeFrameCapabilities(
    {
      customElements: {
        count: 8,
        samples: [
          { tag: 'top-a', selector: 'top-a' },
          { tag: 'top-b', selector: 'top-b' },
          { tag: 'top-c', selector: 'top-c' },
          { tag: 'top-d', selector: 'top-d' },
        ],
      },
    },
    [
      { frameId: 3, capabilities: { customElements: { count: 2, samples: [{ tag: 'frame-btn', selector: '#fb' }] } } },
      { frameId: 5, capabilities: { customElements: { count: 1, samples: [{ tag: 'frame-editor', selector: '#ed' }] } } },
    ]
  );
  assert.equal(merged.customElements.count, 11, '顶层 + 两个子框架的计数都要算进去');
  assert.deepEqual(
    merged.customElements.samples.map((s) => s.tag),
    ['top-a', 'top-b', 'frame-btn', 'frame-editor'],
    '顶层最多留 2 条，其余名额给各子框架'
  );
  assert.equal(merged.customElements.samples[2].frameId, 3);
  assert.equal(merged.customElements.samples[3].frameId, 5);
});

test('同源 iframe 不重复合并能力（顶层扫描已穿透），跨源才合并', () => {
  assert.equal(isCrossOriginFrame('https://a.test/p', 'https://a.test/frame'), false);
  assert.equal(isCrossOriginFrame('http://127.0.0.1:7802/', 'http://127.0.0.1:7803/frame'), true);
  assert.equal(isCrossOriginFrame('https://a.test/', 'not a url'), true, '解析失败按跨源处理');
});

test('子框架能力提示必须给出 frameId 的下一步，而不是只报个总数', () => {
  const hint = formatCapabilityHint({
    scrollContainers: {
      count: 2,
      samples: [
        { selector: '#top', frameId: undefined },
        { selector: '#inner', frameId: 7 },
      ],
    },
  });
  assert.match(hint, /frame 7/);
  assert.match(hint, /get_page_snapshot\(\{frameId:N\}\)/);
  assert.match(hint, /自动路由/);
  // 框架内的选择器是局部作用域，顶层 scroll_page({selector}) 找不到它 ——
  // 提示必须改成"先取该框架的 ref，再按 ref 滚"。
  assert.match(hint, /scroll_page\(\{ref, y:600\}\)/);
  assert.doesNotMatch(hint, /用 scroll_page\(\{selector:"…", y:600\}\) 直接滚它/);
});

test('顶层与子框架都有自定义元素时，提示里两者都要出现', () => {
  // 只取前两条样本时，若前两条都是顶层的，子框架条目就会被藏起来 ——
  // 合计 count 里有它、提示里却没有，模型不会去读那个框架。
  const hint = formatCapabilityHint({
    customElements: {
      count: 3,
      samples: [
        { tag: 'top-a', selector: 'top-a' },
        { tag: 'top-b', selector: 'top-b' },
        { tag: 'frame-btn', selector: '#fb', frameId: 7 },
      ],
    },
  });
  assert.match(hint, /top-a/);
  assert.match(hint, /frame 7 · frame-btn/);
});

function mkDeps(overrides = {}) {
  const calls = [];
  const deps = {
    calls,
    ctx: { tabId: 7, pageUrl: 'https://a.test/p' },
    chrome: {
      scripting: {
        executeScript: async (opts) => {
          calls.push({ op: 'executeScript', opts });
          return deps.framesResult;
        },
      },
    },
    framesResult: [
      { frameId: 0, result: { href: 'https://a.test/', title: '主站', isTop: true } },
      { frameId: 3, result: { href: 'https://b.test/f', title: '子框架', isTop: false } },
    ],
    cdpAllowed: () => false,
    sendTabMessage: async (tabId, msg) => {
      calls.push({ op: 'sendTabMessage', msg });
      return deps.pageText;
    },
    pageText: { text: '正文内容', title: '页面标题', url: 'https://a.test/p', visibility: null },
    getPageSnapshot: async (tabId, opts) => {
      calls.push({ op: 'getPageSnapshot', opts });
      return deps.snapshot;
    },
    snapshot: { elements: [{ ref: 'rf-1' }], text: 'x'.repeat(100), counts: {}, mainContent: null },
    getPendingDialogs: () => [],
    trimElementsToBudget: (els) => ({ elements: els, omittedBySize: 0 }),
    formatVisibilityReport: (v) => (v ? '可见性报告' : ''),
    formatCurrentPageResult: (o) => '结果:' + (o.text || o.textLength || '核查'),
    splitIntoChunks: () => ['块1'],
    citationTitleFor: (t, u) => t || u,
    ...overrides,
  };
  return deps;
}

test('PAGE_READ_TOOLS 覆盖三个工具名', () => {
  assert.deepEqual([...PAGE_READ_TOOLS].sort(), ['get_page_snapshot', 'list_frames', 'read_current_page']);
});

test('handlePageReadTool：不属于本族返回 null', async () => {
  assert.equal(await handlePageReadTool('inspect_element', {}, mkDeps()), null);
});

// ---------------------------------------------------------------- listFramesRaw / prefixFrameRefs

test('listFramesRaw：一次拿到所有框架（含跨域），并带上 frameId', async () => {
  const deps = mkDeps();
  const frames = await listFramesRaw(deps, 7);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].frameId, 0);
  assert.equal(frames[0].isTop, true);
  assert.equal(frames[1].frameId, 3);
  assert.equal(frames[1].href, 'https://b.test/f');
  const call = deps.calls.find((c) => c.op === 'executeScript');
  assert.equal(call.opts.target.allFrames, true, '必须注入所有框架，否则拿不到跨域 iframe');
});

test('listFramesRaw：executeScript 失败时返回空数组（不抛）', async () => {
  const deps = mkDeps({
    chrome: { scripting: { executeScript: async () => { throw new Error('无权限'); } } },
  });
  assert.deepEqual(await listFramesRaw(deps, 7), []);
});

test('prefixFrameRefs：只给子框架加前缀（顶层 frameId=0 不加）', () => {
  const snap = { elements: [{ ref: 'rf-1' }, { ref: 'rf-2' }] };
  assert.equal(prefixFrameRefs(snap, 0), snap, 'frameId=0 应原样返回同一个对象');
  const tagged = prefixFrameRefs(snap, 3);
  assert.deepEqual(tagged.elements.map((e) => e.ref), ['f3:rf-1', 'f3:rf-2'], '跨框架 ref 必须全局唯一');
  assert.equal(tagged.frameId, 3);
  assert.deepEqual(snap.elements.map((e) => e.ref), ['rf-1', 'rf-2'], '不得就地改写原快照');
});

test('prefixFrameRefs：非法 frameId / 空快照时原样返回', () => {
  const snap = { elements: [] };
  assert.equal(prefixFrameRefs(null, 3), null);
  assert.equal(prefixFrameRefs(snap, 'x'), snap);
  assert.equal(prefixFrameRefs(snap, null), snap);
});

// ---------------------------------------------------------------- read_current_page

test('read_current_page：无 tabId 时明确失败', async () => {
  const deps = mkDeps({ ctx: {} });
  const r = await readCurrentPage(deps, {});
  assert.match(r.result, /无法定位当前标签页/);
});

test('read_current_page：正常模式返回正文 + 按块登记引用', async () => {
  const deps = mkDeps();
  const r = await readCurrentPage(deps, {});
  assert.match(r.result, /结果:/);
  assert.ok(Array.isArray(r.citations));
  assert.equal(r.citations[0].source, 'page');
  assert.equal(r.citations[0].title, '页面标题');
  assert.equal(r.citations[0].url, 'https://a.test/p');
});

test('**关键**：核查模式（传 checkTexts）不返回正文、也不登记引用', async () => {
  // 调用方只想知道"这几段文案还在不在/可不可见"，给它整页正文是浪费 token 且会污染引用编号。
  const deps = mkDeps({
    pageText: { text: '很长的正文', title: 'T', url: 'u', visibility: { ok: true } },
  });
  const r = await readCurrentPage(deps, { checkTexts: ['校验分两层'] });
  assert.ok(!r.citations, '核查模式不应登记引用');
  assert.ok(!/很长的正文/.test(r.result), '核查模式不应返回整页正文');
});

test('read_current_page：checkTexts 全为空串时**不**进核查模式（避免误判）', async () => {
  const deps = mkDeps({
    pageText: { text: '正文', title: 'T', url: 'u', visibility: { ok: true } },
  });
  const r = await readCurrentPage(deps, { checkTexts: ['', '  ', null] });
  assert.ok(Array.isArray(r.citations), '空 checkTexts 应走正常正文路径');
});

test('read_current_page：正文为空时给出可读提示（不返回空结果）', async () => {
  const deps = mkDeps({ pageText: { text: '', title: 'T' } });
  const r = await readCurrentPage(deps, {});
  assert.match(r.result, /未能读取页面正文/);
  assert.ok(!r.citations);
});

test('**关键**：404 页面不登记为参考来源（否则真正引用的内容被推到高序号）', async () => {
  const deps = mkDeps({ pageText: { text: '页面不存在', title: '404 Not Found', url: 'https://a.test/x' } });
  const r = await readCurrentPage(deps, {});
  assert.deepEqual(r.citations, [], '404 不该产生引用');
});

test('read_current_page：无标题页面用 citationTitleFor 解析标题（不回落到正文开头）', async () => {
  let seen = null;
  const deps = mkDeps({
    pageText: { text: '正文', title: '', url: 'https://a.test/README.md' },
    citationTitleFor: (t, u) => { seen = { t, u }; return 'README.md'; },
  });
  const r = await readCurrentPage(deps, {});
  assert.deepEqual(seen, { t: '', u: 'https://a.test/README.md' }, '应把空标题与 URL 一起交给纯函数');
  assert.equal(r.citations[0].title, 'README.md');
});

test('read_current_page：内容脚本抛错时返回可读失败', async () => {
  const deps = mkDeps({ sendTabMessage: async () => { throw new Error('未注入'); } });
  const r = await readCurrentPage(deps, {});
  assert.match(r.result, /读取页面失败：未注入/);
});

// ---------------------------------------------------------------- get_page_snapshot

test('get_page_snapshot：无 tabId 时失败', async () => {
  const r = await getPageSnapshotTool(mkDeps({ ctx: {} }), {});
  assert.equal(r.ok, false);
  assert.match(r.result, /无法定位当前标签页/);
});

test('**关键**：页面有未处理对话框时先提示处理（快照读不到有效内容）', async () => {
  const deps = mkDeps({
    cdpAllowed: () => true,
    getPendingDialogs: () => [{ type: 'alert', message: '确定吗' }],
  });
  const r = await getPageSnapshotTool(deps, {});
  assert.equal(r.ok, true);
  assert.equal(r.snapshot, null);
  assert.match(r.result, /未处理的对话框/);
  assert.match(r.result, /handle_dialog/, '应给出可执行的下一步');
  assert.equal(deps.calls.filter((c) => c.op === 'getPageSnapshot').length, 0, '有对话框时不该去读快照');
});

test('get_page_snapshot：未开 CDP 时**跳过**对话框检查（不能用未开启的能力判阻塞）', async () => {
  const deps = mkDeps({ cdpAllowed: () => false, getPendingDialogs: () => [{ type: 'alert', message: 'x' }] });
  const r = await getPageSnapshotTool(deps, {});
  assert.ok(r.snapshot, '未开 CDP 时不应因对话框而阻断快照');
});

test('get_page_snapshot：显式 frameId 只读该框架，并给 ref 加前缀', async () => {
  const deps = mkDeps();
  const r = await getPageSnapshotTool(deps, { frameId: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.snapshot.frameId, 3);
  assert.deepEqual(r.snapshot.elements.map((e) => e.ref), ['f3:rf-1']);
  const call = deps.calls.find((c) => c.op === 'getPageSnapshot');
  assert.equal(call.opts.frameId, 3, '必须把 frameId 传给内容脚本');
});

test('get_page_snapshot：指定框架读不到时明确失败', async () => {
  const deps = mkDeps({ getPageSnapshot: async () => null });
  const r = await getPageSnapshotTool(deps, { frameId: 9 });
  assert.equal(r.ok, false);
  assert.match(r.result, /未能读取该框架的 DOM 快照（frameId=9/);
});

test('get_page_snapshot：正文容器提醒（隐藏广告时别把正文一起藏了）', async () => {
  const deps = mkDeps({
    snapshot: { elements: [], text: '', counts: {}, mainContent: { selector: '.article', textLength: 3000 } },
  });
  const r = await getPageSnapshotTool(deps, {});
  assert.match(r.result, /疑似正文容器：\.article/);
  assert.match(r.result, /不要整体隐藏它或其祖先/);
});

test('get_page_snapshot：透传 query / cursor，并输出区域轮廓与继续读取提示', async () => {
  const deps = mkDeps({
    snapshot: {
      elements: [{ ref: 'rf-1' }],
      text: '',
      counts: { omittedByLimit: 9 },
      outline: {
        regions: [
          {
            selector: '#results',
            tag: 'section',
            label: '搜索结果',
            interactive: 18,
            inViewport: 3,
            textLength: 900,
          },
        ],
        totalRegions: 1,
        omittedRegions: 0,
      },
      nextCursor: 20,
    },
  });
  const r = await getPageSnapshotTool(deps, { query: '价格', cursor: 20, maxText: 0 });
  const call = deps.calls.find((c) => c.op === 'getPageSnapshot');
  assert.equal(call.opts.query, '价格');
  assert.equal(call.opts.cursor, 20);
  assert.equal(call.opts.maxText, 0);
  assert.match(r.result, /页面区域轮廓/);
  assert.match(r.result, /get_page_snapshot\(\{cursor:20/);
  assert.match(r.result, /inspect_element\(\{op:"query"/);
});

test('**关键**：includeFrames 合并子框架后仍要过体积预算', async () => {
  // 否则多个框架的元素一起塞进来，会绕开快照自身的 SNAPSHOT_CHAR_BUDGET。
  let trimmedWith = null;
  const deps = mkDeps({
    snapshot: { elements: [{ ref: 'a' }], text: 'y'.repeat(500), counts: { omittedBySize: 2 }, mainContent: null },
    getPageSnapshot: async (tabId, opts) => {
      if (opts.frameId === 3) return { elements: [{ ref: 'b' }], text: '' };
      return deps.snapshot;
    },
    trimElementsToBudget: (els, textLen) => { trimmedWith = { count: els.length, textLen }; return { elements: els.slice(0, 1), omittedBySize: 5 }; },
  });
  const r = await getPageSnapshotTool(deps, { includeFrames: true });
  assert.equal(r.ok, true);
  assert.ok(trimmedWith, '必须调用 trimElementsToBudget');
  assert.equal(trimmedWith.count, 2, '应先把顶层与子框架元素合并再裁剪');
  assert.equal(trimmedWith.textLen, 500, '应把正文长度一起传给预算函数');
  assert.equal(r.snapshot.counts.omittedBySize, 7, '省略数应累加（原有 2 + 本次 5）');
  assert.equal(r.snapshot.frames.length, 2, '应把框架清单也附回去');
  assert.match(r.result, /已合并 1 个子框架/);
  assert.match(r.result, /f<frameId>: 前缀/);
});

test('includeFrames：同源框架已由顶层穿透，不重复合并或重复发正文请求', async () => {
  const deps = mkDeps({
    framesResult: [
      { frameId: 0, result: { href: 'https://a.test/', title: '主站', isTop: true } },
      { frameId: 3, result: { href: 'https://a.test/frame', title: '同源', isTop: false } },
    ],
    snapshot: {
      url: 'https://a.test/',
      elements: [{ ref: 'rf-1' }],
      text: '',
      counts: {},
      mainContent: null,
    },
  });
  const r = await getPageSnapshotTool(deps, { includeFrames: true });
  const frameReads = deps.calls.filter((c) => c.op === 'getPageSnapshot' && c.opts.frameId === 3);
  assert.equal(frameReads.length, 0, '顶层已穿透同源框架，不应再单独读一次');
  assert.equal(r.snapshot.elements.length, 1, '同源元素不得以两个 ref 重复出现');
  assert.match(r.result, /同源框架 3 已由顶层快照穿透读取/);
});

test('includeFrames：子框架读不到时如实报告，不把"未读"说成"已合并"', async () => {
  const deps = mkDeps({
    framesResult: [
      { frameId: 0, result: { href: 'https://a.test/', title: '主站', isTop: true } },
      { frameId: 3, result: { href: 'https://b.test/f', title: '子框架', isTop: false } },
      { frameId: 4, result: { href: 'https://b.test/dyn', title: '动态框架', isTop: false } },
    ],
    getPageSnapshot: async (tabId, opts) => {
      if (opts.frameId === 3) return { elements: [{ ref: 'b' }], text: '' };
      if (opts.frameId === 4) throw new Error('Could not establish connection. Receiving end does not exist.');
      return deps.snapshot;
    },
  });
  const r = await getPageSnapshotTool(deps, { includeFrames: true });
  assert.equal(r.ok, true);
  assert.match(r.result, /已合并 1 个子框架/);
  assert.match(r.result, /frameId=4/, '必须点名没读到的框架');
  assert.match(r.result, /补注入也失败/);
  assert.deepEqual(r.snapshot.frameRead, { read: [3], failed: [4], total: 2 });
});

test('get_page_snapshot：读快照抛错时返回可读失败', async () => {
  const deps = mkDeps({ getPageSnapshot: async () => { throw new Error('注入失败'); } });
  const r = await getPageSnapshotTool(deps, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /读取 DOM 快照失败：注入失败/);
});

test('get_page_snapshot：内容脚本不可达时给出可操作的下一步', async () => {
  const deps = mkDeps({
    getPageSnapshot: async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    },
  });
  const r = await getPageSnapshotTool(deps, {});
  assert.equal(r.ok, false);
  assert.match(r.result, /没有可用的内容脚本/);
  assert.match(r.result, /get_ax_snapshot/);
  assert.match(r.result, /不要反复重试同一条路/);
});

// ---------------------------------------------------------------- list_frames

test('list_frames：列出框架并给出用法指引', async () => {
  const r = await listFrames(mkDeps());
  assert.equal(r.ok, true);
  assert.equal(r.frames.length, 2);
  assert.match(r.result, /\[顶层 frameId=0\] 主站/);
  assert.match(r.result, /\[frameId=3\] 子框架/);
  assert.match(r.result, /includeFrames:true/);
});

test('list_frames：拿不到框架时失败（不返回空列表）', async () => {
  const r = await listFrames(mkDeps({ framesResult: [] }));
  assert.equal(r.ok, false);
  assert.match(r.result, /未获取到页面框架信息/);
});

test('list_frames：无 tabId 时失败', async () => {
  const r = await listFrames(mkDeps({ ctx: {} }));
  assert.equal(r.ok, false);
});
