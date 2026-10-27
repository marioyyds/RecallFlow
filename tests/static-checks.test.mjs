// 静态检查门禁：把「只能在运行时炸」的一类 bug 提前拦住。
//
// 起因是一个真实崩溃：agent.js 里 `const deterministicFails` 却在后面 `+= 1`，
// 于是「完成断言判定失败」这条分支一走到就抛 Assignment to constant variable，
// 整个 agent run 直接挂掉。要命的是：
//   - node --check 抓不到（语法完全合法）
//   - 400 项单测也抓不到（那条分支需要真实 agent 运行 + 特定失败场景）
// 也就是说，这类 bug 之前**没有任何一层能发现它**。这里补上那一层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findConstAssignments } from '../scripts/check-const-assign.mjs';

test('不存在「对 const 声明重新赋值」的代码（运行时必崩且其他层抓不到）', () => {
  const { findings, scanned } = findConstAssignments();
  assert.ok(scanned > 20, '前置：应扫描到足够多的文件，实际 ' + scanned);
  const detail = findings.map((f) => f.file + ':' + f.line + '  ' + f.name + '（声明于第 ' + f.declLine + ' 行）').join('\n  ');
  assert.deepEqual(findings, [], '发现对 const 的赋值，运行时必抛 Assignment to constant variable：\n  ' + detail);
});

test('创建出来的元素必须被挂载（"建了但忘了 append"是静默失效）', () => {
  // 真实近失：本轮给面板加「导出完整」按钮时，先把 createElement 与事件都写好了，
  // 却没写 `foot.appendChild(copyFullBtn)` —— 代码能跑、语法没错、按钮**永远不出现**，
  // 而症状是"功能没做"，很容易被误判成"用户没找到按钮"。
  // 判据：`const X = document.createElement(...)` 之后，X 必须出现在某个挂载调用里。
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
    }
  };
  if (existsSync('lib')) walk('lib');
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // 逐个变量名收集：`const x = document.createElement(...)`
    for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\(/g)) {
      const name = m[1];
      // 挂载方式：appendChild / append / insertBefore / replaceChild / prepend / after / before
      const mounted = new RegExp('\\b(appendChild|append|insertBefore|replaceChild|prepend|after|before)\\s*\\(\\s*' + name + '\\b');
      // 也允许自己被返回或被别的容器收走（例如作为返回值、或赋给 innerHTML 之外的用法）
      const escaped = new RegExp('\\breturn\\s+' + name + '\\b');
      if (mounted.test(src) || escaped.test(src)) continue;
      bad.push(f + '  变量 ' + name);
    }
  }
  assert.ok(files.length > 20, '前置：应扫描到足够多的文件，实际 ' + files.length);
  assert.deepEqual(bad, [], '这些元素创建后从未被挂载（静默失效）：\n  ' + bad.join('\n  '));
});

test('这条门禁本身有牙齿：建了不挂载会被抓，正常挂载不误报', () => {
  const mounted = (src, name) =>
    new RegExp('\\b(appendChild|append|insertBefore|replaceChild|prepend|after|before)\\s*\\(\\s*' + name + '\\b').test(src) ||
    new RegExp('\\breturn\\s+' + name + '\\b').test(src);
  const created = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.createElement\(/g;
  const names = (src) => [...src.matchAll(created)].map((m) => m[1]);
  // 建了但没挂载 → 名字会出现在 names 里、mounted 为 false
  const badSrc = "const b = document.createElement('button');\nb.addEventListener('click', go);";
  assert.deepEqual(names(badSrc), ['b']);
  assert.equal(mounted(badSrc, 'b'), false, '未挂载必须被判为未挂载');
  // 正常挂载
  const okSrc = "const b = document.createElement('button');\nfoot.appendChild(b);";
  assert.equal(mounted(okSrc, 'b'), true);
  // 作为返回值交给调用方挂载也算
  assert.equal(mounted("const b = document.createElement('div');\nreturn b;", 'b'), true);
  // 名字相似但不相同不能误判
  assert.equal(mounted('parent.appendChild(bb);', 'b'), false, 'appendChild(bb) 不等于挂载 b');
});

test('注释不许把下一行代码吃掉（注释里出现"紧贴着声明关键字"的形态）', () => {
  // 真实踩到的坑：编辑时把 `// 注释……。` 与下一行 `function installStorage() {` **接在了一起**，
  // 于是那个函数整体变成**注释的一部分**，函数体成了顶层代码。
  // 后果与诊断成本都很坏：node --check 报的是 `Illegal return statement`，
  // 行号指向**函数体内部**，离真正的错处（那行注释）几十行 —— 一眼看不出。
  //
  // 判据要精确，否则会误伤正常注释。试过"关键字前不是空格/斜杠"这一版，结果**全是误报**：
  // 本仓库大量注释用反引号**引用代码**（如「让既有的 `import { … }` 无需改动」），
  // 反引号紧贴关键字同样会被那一版抓走。收紧为：
  //   · 只有**非 ASCII 字符**（中文散文 / 中文标点）**紧贴着**声明关键字才算 —— 那才是"少换行"的真实形态；
  //   · 于是 `。function`（少换行）被抓，`` `import {``（正常引用）与「见 function foo」（有空格）都不会误报。
  const DECL = /[^\x00-\x7F](function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|class\s+\w+|import\s*\{|export\s+(?:function|const|class))/;
  const roots = ['lib', 'tests', 'scripts'];
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js)$/.test(e.name)) files.push(p);
    }
  };
  for (const r of roots) if (existsSync(r)) walk(r);
  for (const f of ['background.js', 'popup.js', 'options.js', 'manager.js', 'skills-page.js', 'userscripts.js']) {
    if (existsSync(f)) files.push(f);
  }
  const bad = [];
  for (const f of files) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const t = line.trim();
        if (!t.startsWith('//')) return;
        if (DECL.test(t)) bad.push(f + ':' + (i + 1) + '  ' + t.slice(0, 100));
      });
  }
  assert.ok(files.length > 50, '前置：应扫描到足够多的文件，实际 ' + files.length);
  assert.deepEqual(bad, [], '这些注释把下一行代码吃掉了（多半是编辑时删掉了换行）：\n  ' + bad.join('\n  '));
});

test('这条门禁本身有牙齿：少换行的形态会被抓，正常引用注释不会误报', () => {
  const DECL = /[^\x00-\x7F](function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=|class\s+\w+|import\s*\{|export\s+(?:function|const|class))/;
  // 真实形态：中文句号紧贴 function（= 少了换行）
  assert.equal(DECL.test('// 安装 chrome.storage.local 桩（行为对齐真实 API）。function installStorage() {'), true, '少换行必须被抓');
  assert.equal(DECL.test('//只留最近N步。const x = 1'), true, '中文紧贴也要抓');
  // 正常注释不该误报 —— 这几条都是本仓库里真实存在、且第一版判据误抓过的形态
  assert.equal(DECL.test('// 见 function buildToolTrail 的说明'), false, '有空格，正常引用');
  assert.equal(DECL.test("// 这里**再导出**，让既有的 `import { ... } from './tools.js'` 无需改动；"), false, '反引号引用代码');
  assert.equal(DECL.test('// 取最后一个 `lastPlan = [];`，第一个是顶部的 `let lastPlan = []` 声明。'), false, '反引号引用代码');
  assert.equal(DECL.test('//     run_javascript({ code:"const s=document.querySelector(\'#ship\');'), false, '引号里的代码');
  assert.equal(DECL.test('// 用 const 声明常量'), false, '有空格');
});

test('扫描范围覆盖根目录文件与 .mjs（原先只有 lib/ 与 .js，靠运气才抓到那个崩溃）', () => {
  // 原先 ROOTS=['lib','integrations/opencode/recallflow-mcp'] 且只收 .js：
  // background.js / popup.js 以及**所有 .mjs**（含门禁脚本自身）都是盲区。
  // 这里把「覆盖面」本身钉住 —— 否则将来有人把范围改回去，不会有人发现。
  const { files, scanned } = findConstAssignments();
  assert.ok(scanned > 100, '应扫描整个仓库（含根目录与 tests/scripts），实际 ' + scanned);
  for (const expected of ['background.js', 'popup.js']) {
    assert.ok(files.includes(expected), '根目录文件应被扫描：' + expected);
  }
  // content.js 现在是 scripts/build-content.mjs 的**构建产物**，源码在 entries/content.ts。
  // 检查产物等于检查生成器，因此源码必须被扫描、产物必须被跳过（否则 3721 处假阳性）。
  assert.ok(files.includes('entries/content.ts'), '内容脚本源码应被扫描');
  assert.ok(!files.includes('content.js'), '构建产物不应被扫描（会产生大量假阳性）');
  assert.ok(files.some((f) => f.endsWith('.mjs')), '应扫描 .mjs 文件（门禁脚本与测试都是 .mjs）');
  assert.ok(files.some((f) => f.startsWith('scripts/')), '应扫描 scripts/');
  assert.ok(!files.some((f) => f.includes('node_modules')), '不应扫描 node_modules');
});

test('解构声明被正确识别（否则会同时产生漏报与误报）', () => {
  // 实测：`let [sw]` 与另一作用域的 `const sw` 曾被合并成「const 被赋值」而误报。
  const dir = mkdtempSync(join(tmpdir(), 'rf-const-'));
  try {
    // 正例：const 被赋值 → 必须报出
    writeFileSync(join(dir, 'positive.mjs'), 'const x = 1;\nfunction f(){ x += 1; }\n');
    // 反例：let 同名 → 不报
    writeFileSync(join(dir, 'let-ok.js'), 'let y = 1;\ny = 2;\n');
    // 反例：解构 const 未被赋值 → 不报
    writeFileSync(join(dir, 'destructure-ok.js'), 'const { a } = o;\nconst [b] = arr;\nconsole.log(a, b);\n');
    const { findings } = findConstAssignments([dir]);
    assert.deepEqual(
      findings.map((f) => f.name),
      ['x'],
      '只应报出真正被赋值的 const，实际：' + JSON.stringify(findings.map((f) => f.name))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('正则字面量里出现 `名字=` 不能被当成对 const 的赋值（实测误报）', () => {
  // 起因：写测试时 `const id = …` 加上断言里的正则 `/id="([^"]+)"/` ——
  // 剥离器不识别正则字面量，于是 `id=` 被读成对 const id 的赋值。
  // 文件头当时给的规避办法是"别把局部变量命名为正则里出现的短名字"（把约束推给使用者）。
  const dir = mkdtempSync(join(tmpdir(), 'rf-const-re-'));
  try {
    // 反例①：声明在正则之前（赋值符在正则里）
    writeFileSync(join(dir, 're-before.mjs'), 'const id = 1;\nconst RE = /id="([^"]+)"/;\nconsole.log(id, RE);\n');
    // 反例②：正则前面是 return（关键字后可以跟正则）
    writeFileSync(
      join(dir, 're-after-return.mjs'),
      'const id = 2;\nfunction f(s){ return /id=(\\d+)/.test(s); }\nconsole.log(id, f);\n'
    );
    // 反例③：正则前是等号（`const re = /x=1/`）
    writeFileSync(join(dir, 're-after-eq.mjs'), 'const kv = 3;\nconst re2 = /kv=3/;\nconsole.log(kv, re2);\n');
    const { findings } = findConstAssignments([dir]);
    assert.deepEqual(
      findings.map((f) => f.name),
      [],
      '正则字面量里的 `名字=` 不该被当成赋值，实际误报：' + JSON.stringify(findings.map((f) => f.name))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('识别正则不能把除号误判成正则（否则会吃掉整行，造成假阴性）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rf-const-div-'));
  try {
    // 除号后面仍有真正的 const 赋值 —— 必须被抓到（若把 `/` 误判成正则，这一行会被整段吃掉）
    writeFileSync(
      join(dir, 'division.mjs'),
      'const total = 10 / 2;\nconst n = 1;\nfunction g(){ n = total / 5; }\n'
    );
    // 真正的赋值（普通情形）也必须照旧抓到
    writeFileSync(join(dir, 'plain.mjs'), 'const m = 0;\nm += 1;\n');
    const { findings } = findConstAssignments([dir]);
    assert.deepEqual(
      findings.map((f) => f.name).sort(),
      ['m', 'n'],
      '除号不该吃掉后面的代码，实际：' + JSON.stringify(findings.map((f) => f.name))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
