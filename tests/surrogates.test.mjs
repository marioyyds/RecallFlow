// 孤立代理对（lone surrogate）事故的回归测试。
//
// 事故形态（2026-10-16，会话 RF-YBKAN7）：工具结果按 **UTF-16 码元下标**截断，切在星形平面
// 字符（`𝑦 𝒜 𝐺`，各占 2 个码元）中间 ⇒ 消息里留下半个字符 ⇒ `JSON.stringify` 把它转义成
// `\ud835` ⇒ 服务端在**解析请求体**阶段整单拒收 400，而它的原因是一句**纯文本**，
// 被"先 resp.json() 再 resp.text()"的旧写法丢掉（第二次读抛 "Body is unusable"），
// 于是日志表现为「400 且冒号后一片空白」——把两次排查都引向了"结构非法"这个错误方向。
// 400 又不在重试白名单里 ⇒ 整个 run 一次即死，坏内容还留在历史里（续跑必炸）。
//
// 本文件钉四件事：
//   ① 切片不再切裂字符（表格单元格 / 折叠 / expand_result / 证据文本）
//   ② 出站前兜底消毒，并且**就地修历史**（只修这次请求的话，续跑还会再炸）
//   ③ 服务端原话必须带出来（"先 text 再 JSON.parse"的顺序不能再被改回去）
//   ④ 静态契约：三条出站路径都必须过消毒，五个高风险切片点都必须用安全切片
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourcePath } from './source-path.mjs';
import fs from 'node:fs';

import {
  hasLoneSurrogate,
  loneSurrogateIndexes,
  sanitizeLoneSurrogates,
  sanitizeMessages,
  sliceSafe,
  rangeSafe,
} from '../lib/shared/surrogates.ts';
import { formatTableText } from '../lib/shared/table.ts';
import { buildCollapsed, collapseOldToolResults } from '../lib/assistant/context.ts';
import { expandResult } from '../lib/assistant/run-state-tools.ts';
import { streamAgentStep } from '../lib/assistant/agent.ts';

// 用 fromCharCode 构造，**绝不把裸代理写进本文件**（那会让测试文件自己就不是合法 UTF-8）。
const PAIR = String.fromCharCode(0xd835, 0xdc66); // 𝑦（U+1D466）：2 个码元
const HIGH = String.fromCharCode(0xd835); // 高位代理单独出现 = 半个字符
const LOW = String.fromCharCode(0xdc66); // 低位代理单独出现 = 半个字符
const SETTINGS = { baseUrl: 'https://api.example.com', model: 'm', apiKey: 'k', requestTimeoutMs: 5000 };
const ORIGINAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------- ① 消毒原语

test('① sanitizeLoneSurrogates：只动孤立代理，合法字符对原样保留', () => {
  assert.equal(hasLoneSurrogate(PAIR), false, '合法配对不是孤立代理');
  assert.equal(hasLoneSurrogate('a' + HIGH + 'b'), true);
  assert.equal(hasLoneSurrogate('a' + LOW + 'b'), true);
  assert.deepEqual(loneSurrogateIndexes('a' + HIGH + 'b' + LOW), [1, 3]);

  const clean = 'x' + PAIR + 'y';
  assert.equal(sanitizeLoneSurrogates(clean), clean, '干净内容必须原样返回（出站高频调用，不做无谓复制）');
  const dirty = 'a' + HIGH + 'b';
  const fixed = sanitizeLoneSurrogates(dirty);
  assert.equal(hasLoneSurrogate(fixed), false);
  assert.equal(fixed, 'a\uFFFDb', '替换成 U+FFFD：既不再是非法 Unicode，也仍然如实标出"这里少了个字符"');
});

test('① sanitizeMessages：content / 嵌套 part / tool_calls 参数里的孤立代理都要清掉', () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"v":"' + HIGH + '"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '| y | ' + HIGH + 'x |' },
    { role: 'user', content: [{ type: 'text', text: 'see ' + LOW }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
  ];
  const before = messages[2].content.length;
  const out = sanitizeMessages(messages);
  assert.equal(out.count, 3, '三处（工具参数 / 工具结果 / 视觉 part 文本）都要被数到');
  assert.equal(hasLoneSurrogate(messages[1].tool_calls[0].function.arguments), false);
  assert.equal(hasLoneSurrogate(messages[2].content), false);
  assert.equal(messages[2].content.length, before, '替换而不是删除：长度不变（删掉会让文本静默变短）');
  assert.equal(hasLoneSurrogate(messages[3].content[0].text), false);
  assert.equal(messages[3].content[1].image_url.url, 'data:image/png;base64,AAAA', '非消息字段不被改动');
  assert.equal(out.messages, messages, '就地修同一个数组（循环内几十处闭包共享它）');

  const already = [{ role: 'user', content: 'ok' }];
  assert.equal(sanitizeMessages(already).count, 0);
  assert.equal(sanitizeMessages(null).count, 0, '非数组输入必须安全');
});

// ---------------------------------------------------------------- ② 安全切片

test('② sliceSafe：任意区间都不会切裂代理对（穷举）', () => {
  const s = 'A' + PAIR + 'B' + PAIR + PAIR + 'C' + HIGH.length + LOW.length;
  let checked = 0;
  for (let a = 0; a <= s.length; a++) {
    for (let b = a; b <= s.length; b++) {
      const piece = sliceSafe(s, a, b);
      assert.equal(hasLoneSurrogate(piece), false, '区间 [' + a + ',' + b + ') 切出了孤立代理');
      checked += 1;
    }
  }
  assert.equal(checked, ((s.length + 1) * (s.length + 2)) / 2, '必须真的穷举了所有区间');
  assert.equal(sliceSafe(s, 1, 3), PAIR, '完整包住一对时原样返回');
  // 两端的方向是**刻意不同**的：
  //   起点落在配对中间 → 回退，把整对一起带上（否则开头的字符会莫名消失）
  assert.equal(sliceSafe(s, 2, 3), PAIR, '起点落在低位上 → 回退到高位，整对一起带上');
  //   终点落在配对中间 → 前移，把整对排除（所有调用点都是"上限"语义，不能超）
  assert.equal(sliceSafe(s, 1, 2), '', '终点落在低位上 → 前移排除这一对，绝不给半个字符');
});

test('② rangeSafe：回退后必须如实报出**实际**区间（不能沿用请求的 offset）', () => {
  const s = 'A'.repeat(10) + PAIR + 'B'.repeat(10);
  const r = rangeSafe(s, 11, 15); // 11 落在配对的低位上
  assert.equal(r.start, 10, '起点回退到高位，整对一起带上');
  assert.equal(hasLoneSurrogate(r.text), false);
  assert.equal(r.length, s.length, 'length 报的是全文长度（"共 N 字符"要准）');
});

// ---------------------------------------------------------------- ③ 事故点的行为回归

test('③ formatTableText：这是事故的触发点 —— 第 60 个码元切在字符中间也不再产生孤立代理', () => {
  // 造出"截断上限正好落在高位代理上"的单元格：前 59 个 ASCII + 一个星形字符
  const cell = 'x'.repeat(59) + PAIR + 'tail';
  // 先证明**旧写法确实会出事**（否则这条用例没有牙齿）
  assert.equal(hasLoneSurrogate(cell.slice(0, 60)), true, '前置：旧写法（裸 slice）确实会产生孤立代理');

  const text = formatTableText({ headers: [], rows: [[cell]] }, { maxCellChars: 60 });
  assert.equal(hasLoneSurrogate(text), false, '修后：整段输出不许有孤立代理');
  const renderedCell = text.replace(/^\| /, '').replace(/ \|$/, '');
  assert.ok(renderedCell.endsWith('…'), '截断标注必须还在：' + JSON.stringify(text));
  assert.ok(renderedCell.length <= 61, '上限语义不变（只可能少一个字符，不会超）：' + renderedCell.length);
  assert.equal(renderedCell, 'x'.repeat(59) + '…', '被切掉的正是那个完整星形字符（半个都不要）');

  // 上限扫一遍：任何 maxCellChars 都不许切裂（页面文本里星形字符密度可以很高）
  const dense = (PAIR + '𝑦𝒜').repeat(40);
  for (let n = 4; n <= 80; n++) {
    assert.equal(hasLoneSurrogate(formatTableText({ headers: [], rows: [[dense]] }, { maxCellChars: n })), false, 'maxCellChars=' + n);
  }
});

test('③ 折叠（buildCollapsed / collapseOldToolResults）：头尾切片都不许切裂', () => {
  // 让尾部 -150 的起点正好落在配对的低位上：len - 150 = 高位下标 + 1
  const content = 'A'.repeat(300) + 'C'.repeat(200) + PAIR + 'D'.repeat(149);
  assert.equal(content.length, 651);
  // 前置：旧的裸 slice(-150) 会以孤立低位开头
  assert.equal(hasLoneSurrogate(content.slice(-150)), true, '前置：裸 slice(-tail) 确实会切裂');

  const folded = buildCollapsed(content, 300, 150);
  assert.equal(hasLoneSurrogate(folded), false, '修后：折叠结果不许有孤立代理');
  assert.ok(folded.length < content.length, '仍然要更短（折叠的意义）');
  assert.ok(folded.includes('D'.repeat(149)), '尾部内容仍要在（只是不再从半个字符开始）');

  const messages = [{ role: 'tool', tool_call_id: 'c', content: content }];
  collapseOldToolResults(messages, 0, 300, 150);
  assert.equal(hasLoneSurrogate(messages[0].content), false, '走折叠主入口也一样');
});

test('③ expand_result：模型给的 offset 落在配对中间时，取回的内容与区间都对得上', () => {
  const full = 'A'.repeat(10) + PAIR + 'B'.repeat(40);
  const ctx = { resultStore: new Map([['res-1', full]]), resultIds: new Set(['res-1']) };
  // 前置：模型按码元数会给 11（落在低位上），裸 slice 从这里开始就是半个字符
  assert.equal(hasLoneSurrogate(String(full).slice(11, 11 + 200)), true, '前置：offset=11 的裸 slice 确实会切裂');

  const r = expandResult(ctx, { id: 'res-1', offset: 11, limit: 200 });
  assert.equal(r.ok, true);
  assert.equal(hasLoneSurrogate(r.result), false, '修后：回执正文不许有孤立代理');
  assert.match(r.result, /\[10,/, '区间必须如实报成 10 起（回退后就别再说 11 了）：' + r.result.slice(0, 40));
  assert.match(r.result, /共 52 字符/, '总长仍是全文长度');
});

// ---------------------------------------------------------------- ④ 请求路径

function sseResponse(lines) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read() {
            if (i >= lines.length) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: enc.encode(lines[i++] + '\n') });
          },
        };
      },
    },
    async text() {
      return '';
    },
  };
}

test('④ 400 的纯文本原因必须原样带出来（不能再被 json→text 的顺序吞成空白）', async () => {
  const serverText =
    'Failed to parse the request body as JSON: messages[3].content: unexpected end of hex escape at line 1 column 71';
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    // 服务端对"解析阶段拒绝"回的是**纯文本**：json() 会抛，而且抛完体就没了 ——
    // 这正是旧写法丢原因的现场（text() 会抛 Body is unusable）。
    async json() {
      throw new SyntaxError('Unexpected token F, "Failed to "... is not valid JSON');
    },
    async text() {
      return serverText;
    },
  });
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r' },
  ];
  const out = await streamAgentStep(null, SETTINGS, messages, undefined, [], () => {});
  assert.ok(out.error.includes('unexpected end of hex escape'), '服务端原话必须在报错里：' + out.error);
  assert.ok(out.error.includes('messages[3].content'), '字段路径也要在（这就是出错位置）');
  assert.ok(out.error.includes('请求形状'), '形状仍然要带上');
  assert.ok(/解析请求体/.test(out.error), '要说清这是"解析阶段被拒"，别让下一个人再往"结构非法"上猜');
  assert.ok(/未发现孤立代理/.test(out.error), '本次发送前历史是干净的，就要直说（省掉一轮返工）');
});

test('④ 出站消毒：历史里的孤立代理在发送前被清掉，且历史本身被就地修好', async () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: '看这个表格' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'inspect_element', arguments: '{"op":"table"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '| (3) | | 𝐺 plan ( 𝑠 𝑡 ) ∈ Σ ∗ , 𝐽 route ( 𝑠 𝑡 , 𝒜 𝑡 ) ∈ ' + HIGH + '… |' },
  ];
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    sentBody = opts.body;
    return sseResponse(['data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]']);
  };
  const events = [];
  const out = await streamAgentStep(null, SETTINGS, messages, undefined, [], (e) => events.push(e));

  assert.equal(out.error, undefined, '剥掉非法字符后应当正常拿到回答');
  assert.equal(hasLoneSurrogate(messages[3].content), false, '历史必须被就地修好（否则续跑每轮都要再炸一次）');
  // 请求体里不许再出现孤立代理的转义：JSON.stringify 会把孤立代理转成 \udXXX，
  // 而合法字符对是**原样输出**的 —— 所以扫这个模式就够。
  assert.doesNotMatch(sentBody, /\\ud[89ab][0-9a-f]{2}/i, '请求体里不许有孤立代理转义：' + String(sentBody).slice(0, 200));
  assert.ok(sentBody.includes('𝐽 route'), '正常内容不许被误伤');
  assert.ok(
    events.some((e) => e.type === 'verify' && /孤立代理/.test(String(e.reason || ''))),
    '要如实告诉用户"我改过你的历史"（静默修复是这类事故第二次发生的原因）'
  );
});

// ---------------------------------------------------------------- ⑤ 静态契约

test('⑤ 静态契约：三条出站路径都过消毒，五个高风险切片点都用安全切片', () => {
  const read = (p) => fs.readFileSync(sourcePath(p), 'utf8');
  const paths = [
    ['lib/assistant/agent.ts', read('lib/assistant/agent.ts')],
    ['lib/assistant/llm.ts', read('lib/assistant/llm.ts')],
    ['entries/background.ts', read('entries/background.ts')],
  ];
  for (const [name, src] of paths) {
    // 迁移期：specifier 可能是 `.js` 或 `.ts`（模块改名后 import 侧跟着改），两种都认。
    assert.match(src, /surrogates\.(?:js|ts)/, name + ' 必须复用 surrogates 模块（别各写一份判据）');
    assert.match(src, /sanitizeMessages\(/, name + ' 出站前必须消毒');
  }

  // 这几个点是**按码元下标截断页面原文**的地方，是事故的高发区。
  // 用正则钉住"不许再出现裸 slice"：改回去就会红（和 vision-wiring 那类门禁同款）。
  assert.doesNotMatch(read('lib/assistant/agent.ts'), /\.slice\(0,\s*3000\)/, 'agent.js 的两处 3000 字截断都要走 sliceSafe');
  assert.doesNotMatch(read('lib/shared/table.ts'), /\.slice\(0,\s*maxCellChars\)/, '表格单元格截断必须走 sliceSafe（本次事故的触发点）');
  assert.doesNotMatch(read('lib/assistant/context.ts'), /body\.slice\(/, '折叠的头尾切片必须走 sliceSafe');
  assert.doesNotMatch(read('lib/assistant/run-state-tools.ts'), /String\(text\)\.slice\(/, 'expand_result 必须走 rangeSafe（offset 由模型给）');
  assert.doesNotMatch(read('lib/assistant/tools.ts'), /fromCharCode\(parseInt\(/, 'HTML 数字实体必须用 fromCodePoint');
});
