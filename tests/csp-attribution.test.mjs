// 归因门禁：拦住 `run_javascript` 沙箱 eval 的是 **MV3 扩展自身的 CSP**，不是页面的。
//
// ## 为什么值得一条门禁
//
// 全仓曾有近十处把这件事写成"**受页面 CSP 约束**"✗（工具描述、技能、错误文案、README、
// 内部注释）。它把一个**我们自己的、稳定的限制**说成一个**页面相关、看起来偶发**的限制，
// 于是读者会得出两个错误结论：
//   · "换个页面试试" —— 换哪个页面都一样 ✗
//   · "关掉 CDP 也能做简单读取" —— 一次也做不了 ✗
//
// ## 证据（实测，不是推断）
//
// 在**完全没有 CSP 响应头**的夹具页（`/coord`）上，直接调用内容脚本的 `kbRunJavaScript`：
//
//     ok:false  Evaluating a string as JavaScript violates the following Content Security Policy
//     directive because 'unsafe-eval' is not an allowed source of script:
//     script-src 'self' 'wasm-unsafe-eval' 'inline-speculation-rules' http://localhost:* http:…
//
// 那条 directive 是**扩展自己的**（MV3 默认策略），页面没有任何 CSP。
// 也就是说"受限沙箱"这条路径**在任何页面上都跑不起来**，`run_javascript` **必须**有 CDP。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(p, 'utf8');

/** 会走到用户/模型眼前的文本（描述、技能、错误文案、README）。 */
const SURFACES = [
  'lib/assistant/tool-schemas.js',
  'lib/assistant/skill-defs.js',
  'lib/assistant/code-access-tools.js',
  'lib/assistant/page-command-tools.js',
  'lib/page/commands.js',
  'README.md',
  // 中文 README 是 README.md 的逐节副本：文本搬走后不能因此逃出这道门禁。
  'README.zh-CN.md',
  'docs/e2e-testing-guide.md',
];

test('不许再把"沙箱 eval 被拒"归因给页面的 CSP（那是扩展自身的 MV3 CSP）', () => {
  const bad = [];
  for (const f of SURFACES) {
    const src = read(f);
    src.split('\n').forEach((line, i) => {
      // 只盯"沙箱/eval 被 CSP 拦住"这类归因，不管"页面主世界不受页面 CSP 限制"（那是对的）
      if (!/(沙箱|eval|run_javascript)/.test(line)) return;
      if (!/页面 ?CSP|页面未放行|受页面|多数站点.*CSP/.test(line)) return;
      // 允许"（与页面无关）"这类**纠正性**表述
      if (/与页面无关|不是页面|页面并没有|与页面 ?CSP 无关/.test(line)) return;
      if (/不受页面 ?CSP 限制/.test(line)) return; // 说主世界不受页面 CSP 限制，正确
      bad.push(f + ':' + (i + 1) + '  ' + line.trim().slice(0, 110));
    });
  }
  assert.deepEqual(
    bad,
    [],
    '这些地方仍把限制归因给页面（换任何页面都一样，且关掉 CDP 一次也跑不了）：\n  ' + bad.join('\n  ')
  );
});

test('错误文案必须点明"扩展自身的 CSP / 需要 CDP"，而不是只说"页面未放行"', () => {
  const src = read('lib/assistant/code-access-tools.js');
  assert.match(src, /MV3 扩展自身的 CSP 不允许 eval/, '未开 CDP 时的失败文案要给出正确归因');
  assert.match(src, /需要页面主世界执行（CDP）/, '并要直接说明需要开 CDP');
  assert.ok(!/沙箱执行被页面 CSP 阻止/.test(src), '不该再出现旧的错误归因文案');
});

test('技能与工具描述都要写明"这条工具需要 CDP"（否则模型会以为关掉 CDP 也能读）', () => {
  const schema = read('lib/assistant/tool-schemas.js');
  assert.match(schema, /这条工具需要开启 CDP|需要开启 CDP|需 CDP/, 'run_javascript 的描述要点明需要 CDP');
  const skill = read('lib/assistant/skill-defs.js');
  assert.match(skill, /这条工具需要开启 CDP|要开 CDP 才能跑/, 'page-world 技能要点明需要 CDP');
});

test('这条门禁本身有牙齿：旧的归因写法必须被判为不合格', () => {
  const guilty = (line) => {
    if (!/(沙箱|eval|run_javascript)/.test(line)) return false;
    if (!/页面 ?CSP|页面未放行|受页面|多数站点.*CSP/.test(line)) return false;
    if (/与页面无关|不是页面|页面并没有|与页面 ?CSP 无关/.test(line)) return false;
    if (/不受页面 ?CSP 限制/.test(line)) return false;
    return true;
  };
  assert.equal(guilty('沙箱依赖 eval 而受页面 CSP 约束，被阻止时会自动改用页面主世界执行。'), true, '旧写法要被抓');
  assert.equal(guilty('sandbox 依赖 eval，而 MV3 扩展自身的 CSP 不允许 eval（与页面无关）。'), false, '纠正后的写法不该被抓');
  assert.equal(guilty('page：在页面主世界执行（需 CDP），不受页面 CSP 限制。'), false, '"不受页面 CSP 限制"是正确的，不该误报');
});

test('这条结论本身要有实据（夹具页上确实没有 CSP 响应头）', () => {
  // 若哪天夹具页开始带 CSP，上面那条"与页面无关"的结论就失去依据 —— 这里钉住前提。
  const src = read('tests/e2e/fixtures/server.mjs');
  assert.match(src, /url\.startsWith\('\/csp'\)[\s\S]{0,200}Content-Security-Policy/, '只有 /csp 路由才带 CSP 头');
});
