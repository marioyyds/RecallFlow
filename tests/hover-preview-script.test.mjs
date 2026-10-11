// `infinite-scroll-hover-preview` 脚本化路径的**重试判据**门禁。
//
// ## 为什么需要它（实测数据）
//
// 这条 E2E 有一个**既有的、与本轮改动无关的** flake：`docs/real-model-eval-log.md` 末节记录过 ——
// 用**未改动的 HEAD** 起 worktree、同一条用例 `--repeat-each=3`，**2 红 1 绿**，
// 失败行与文案逐字相同（工具结果里没有 `SO-8842`）。
//
// 成因写在夹具里（`server.mjs` 的 `#peek` 注释）：CDP 注入的 hover **随时会被本机真实鼠标事件重置**，
// 于是"hover 之后能不能读到预览"这件事**取决于运气**。脚本能做的只有两件事：
//   ① 读**耐久证据**（页面留下的「最近一次查看」`#peek`，而不是"当下还 hover 着才有的 popover"）；
//   ② 读失败时**如实重试**、次数有上界、上界到了**如实报告**（不许谎报成功）。
//
// 而"重试"这件事本身极易写错，且**错了不会有任何报错**：判据一旦写成"整轮里出现过某文案"
// （粘性），它就会**永远为真** —— 后面的重试逻辑被吃掉，甚至把整轮里任意一次「等待元素超时」
// 都当成"刚 hover 失败"，于是一两次历史超时就能把 hover 额度**一次性烧掉**，
// 直接走到"读不到订单号"的放弃分支。表现就是这条用例时红时绿，而**看起来像模型/环境的问题**。
//
// 本文件把这几条判据钉住，并用**构造的假源码**证明"粘性判据 + 一次性烧掉额度"会被判不合格。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync('tests/e2e/fixtures/server.mjs', 'utf8');

/** 取 `infinite-scroll-hover-preview` 那段脚本块（从它的分派 if 到下一条剧本的注释为止）。 */
function hoverScriptBlock(src) {
  const start = src.indexOf("userText.includes(PLAYBOOKS['infinite-scroll-hover-preview'].trigger)");
  assert.ok(start > -1, '找不到 infinite-scroll-hover-preview 的分派块');
  const rest = src.slice(start);
  const end = rest.indexOf('// 剧本：视频播放器状态');
  return end > 0 ? rest.slice(0, end) : rest;
}

const BLOCK = hoverScriptBlock(SRC);

test('重试判据只看**最后一条**工具结果（不许用"整轮里出现过"的粘性判据）', () => {
  // 反例（就是修复前的写法）：`/等待元素超时/.test(seen)` / `toolResults.some(...)` ——
  // 一旦印过一次就永远为真，重试逻辑会被历史吃掉。
  assert.ok(
    /const lastTimedOut\s*=\s*\/等待元素超时\/\.test\(last\)/.test(BLOCK),
    '「这次 hover 超时了吗」必须只看最后一条工具结果'
  );
  assert.ok(
    !/\/等待元素超时\/\.test\(seen\)/.test(BLOCK),
    '不许把「等待元素超时」在**整轮历史**里搜（粘性判据：一次超时会被反复算成新的失败）'
  );
});

test('重试用**页面耐久证据**判断成败：`#peek` 里必须出现目标订单号', () => {
  assert.ok(/peekIsTarget/.test(BLOCK), '成败必须以 `#peek` 里有没有目标订单号为准');
  assert.ok(
    /\.includes\('SO-8842'\)/.test(BLOCK),
    '判据必须钉住目标订单号本身（只看"有没有订单号"会读到别的行）'
  );
  // 重试时**先直接读**（读得越早越好），而不是再花一个往返去 wait_for_element
  assert.ok(
    /toolStep\(res, 'inspect_element', \{ op: 'text', selector: '#peek' \}\)/.test(BLOCK),
    '重试路径必须包含"直接读 #peek"这一步'
  );
});

test('重试次数**有上界**，到顶要**如实报告**（不许无限重 hover，也不许谎报成功）', () => {
  assert.ok(/hovers < 4/.test(BLOCK), '重试必须有上界（4 次）');
  assert.ok(/hovers >= 4/.test(BLOCK), '到上界必须有专门的分支');
  assert.ok(
    /悬停 4 次都没读到目标预览/.test(BLOCK),
    '到上界要**如实报告读不到**（这是"不许谎报"的那一条）'
  );
  // 上界分支必须是 finalText（结束这一轮），不能继续发工具调用
  const giveUpAt = BLOCK.indexOf('hovers >= 4');
  assert.ok(
    BLOCK.slice(giveUpAt, giveUpAt + 300).includes('finalText'),
    '到上界必须结束这一轮（finalText），而不是继续重试'
  );
});

test('"不 hover 读不到"这条结构性质没有被削弱：重试仍然只走可信 hover', () => {
  // 脚本里唯一产生预览的手段是 hover_element（合成事件在读之前就被夹具拒绝）
  assert.ok(/toolStep\(res, 'hover_element'/.test(BLOCK), '重试用的仍然必须是 hover_element');
  assert.ok(
    !/run_javascript|__feed\.revealedText|#pv-/.test(BLOCK),
    '脚本不许绕过 hover 直接从页面读预览（那会把"必须可信 hover"这条性质弄没）'
  );
});

// ---------------------------------------------------------------- 判据本身（供"牙齿"测试复用）
//
// 把上面几条判据写成**可对任意源码片段求值**的函数，这样"假源码必须被判不合格"用的
// 是**同一份判据**（而不是另写一套 —— 另写一套的测试是空转的）。
const problemsIn = (block) => {
  const out = [];
  if (!/const lastTimedOut\s*=\s*\/等待元素超时\/\.test\(last\)/.test(block)) out.push('timeout-not-last-only');
  if (/\/等待元素超时\/\.test\(seen\)/.test(block)) out.push('sticky-history-timeout');
  if (!/peekIsTarget/.test(block)) out.push('no-peek-target-check');
  if (!/\.includes\('SO-8842'\)/.test(block)) out.push('no-target-order');
  if (!/toolStep\(res, 'inspect_element', \{ op: 'text', selector: '#peek' \}\)/.test(block)) out.push('no-direct-read');
  if (!/hovers < 4/.test(block)) out.push('no-retry-bound');
  if (!/hovers >= 4/.test(block)) out.push('no-bound-branch');
  if (!/悬停 4 次都没读到目标预览/.test(block)) out.push('no-honest-giveup');
  if (!/toolStep\(res, 'hover_element'/.test(block)) out.push('no-trusted-hover');
  if (/run_javascript|__feed\.revealedText|#pv-/.test(block)) out.push('bypasses-hover');
  return out;
};

test('这条门禁有牙齿：粘性判据 / 无上界 / 绕过 hover 这三类都必须被判不合格', () => {
  // 真源码先证明判据不是"永远报错"
  assert.deepEqual(problemsIn(BLOCK), [], '真源码应当合格');

  // ① 粘性写法：把"这次超时了吗"改成在**整轮历史**里搜（修复前的写法）
  const sticky = BLOCK.replace('const lastTimedOut = /等待元素超时/.test(last);', 'const lastTimedOut = /等待元素超时/.test(seen);');
  assert.notEqual(sticky, BLOCK, '样例替换必须真的生效（否则这条牙齿测试是空转）');
  assert.ok(problemsIn(sticky).includes('timeout-not-last-only'), '粘性写法必须被抓：' + problemsIn(sticky));
  assert.ok(problemsIn(sticky).includes('sticky-history-timeout'), '整轮历史搜索必须被抓：' + problemsIn(sticky));

  // ② 把"成败判据"从 `#peek` 里有没有目标订单号，退化成"有没有订单号"
  const loose = BLOCK.replace(".includes('SO-8842')", ".includes('订单号')");
  assert.ok(problemsIn(loose).includes('no-target-order'), '判据退化成"有没有订单号"必须被抓：' + problemsIn(loose));

  // ③ 没有上界（无限重 hover）
  const noBound = BLOCK.replace(/hovers < 4/g, 'true').replace(/hovers >= 4/g, 'false');
  const p3 = problemsIn(noBound);
  assert.ok(p3.includes('no-retry-bound'), '没有上界必须被抓：' + p3);
  assert.ok(p3.includes('no-bound-branch'), '没有到顶分支必须被抓：' + p3);

  // ④ 绕过 hover（直接从页面读预览）—— 那会把"必须可信 hover"这条性质弄没
  const bypass = BLOCK + "\n      toolStep(res, 'run_javascript', { code: 'window.__feed.revealedText' });\n";
  assert.ok(problemsIn(bypass).includes('bypasses-hover'), '绕过 hover 必须被抓：' + problemsIn(bypass));
});
