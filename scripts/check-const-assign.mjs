// 扫描「对 const 声明重新赋值」这一类运行时崩溃。
//
// 动机：agent.js 曾出现 `const deterministicFails` 却在后面 `+= 1`，
// 一旦走到那条分支整个 agent run 直接崩掉（Assignment to constant variable）。
// node --check 抓不到（语法合法），单测也覆盖不到那条深层分支 ——
// 属于一类**静态可查但没人查**的 bug。
//
// 为什么不用现成 linter：本仓库没有安装任何 JS 解析器（acorn/espree/typescript 都没有），
// 为这一个检查引入依赖不划算。因此用两层保守策略，目标是**零误报**：
//   第一层：字符串剥离 —— 逐字符跟踪 ' " ` 三种引号与转义，把字符串内容替换成空白，
//           否则 `'<button title="x">'` 里的 `title=` 会被当成对 const title 的赋值（实测 38 处误报全来自此）。
//   第二层：声明收集 —— 识别 const/let/var（含无初始化形式 `let m;`）、function/class 名、函数参数。
//           只有「全部声明都是 const 且从未作为参数」的名字，其非声明处的赋值才报告。
//
// 已知局限（宁可漏报不误报）：不做真正的词法作用域分析，因此同名跨作用域遮蔽时会漏报；
// 模板字符串里的 ${} 插值按字符串处理，若插值内含赋值会漏报。
//
// 正则字面量：**已识别**（2024 实测踩到才补的）。此前 `/id=(\d+)/` 里的 `id=`
// 会被读成对某个 `const id` 的赋值 —— 写测试时"变量名叫 id、断言里又有 `id="`"
// 就必然误报，而文件头当时给的规避办法是"别把局部变量命名为正则里出现的短名字"
// （把约束推给使用者，且没人会记得）。
// 现在按标准启发式判定 `/` 是正则还是除号（见 isRegexStart）：
//   · 前一个有意义字符是 `( , = : [ ! & | ? { } ;` 之一，或行首；
//   · 或前一个标识符是 return / typeof / case / in / of / instanceof / new / delete /
//     void / do / else / yield / await 这类"后面可以跟正则"的关键字。
// 识别不出来时**按除号处理**（保持保守：宁可漏报，也不把整行代码吃掉造成假阴性）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 扫描范围：**仓库根目录**，而不是只有 lib/。
//
// 原先 ROOTS = ['lib', 'integrations/opencode/recallflow-mcp'] 且只收 `.js`，
// 于是 background.js / content.js / popup.js / userscripts.js / skills-page.js
// 以及**所有 `.mjs`**（含 scripts/ 与 tests/）都在盲区之外。
// 这个检查当初是为了抓 agent.js 里那个 `const deterministicFails` 被 `+= 1` 的崩溃
// —— 它恰好位于 lib/ 内，所以能工作，但那是**运气而非设计**：
// 同一类错误写在这几个根文件里就永远不会被发现。
const ROOTS = ['.'];
// 跳过依赖、忽略目录与**构建产物**；同时纳入 .mjs（本仓库的测试与门禁脚本都是 .mjs）。
//
// `content.js` 是 `scripts/build-content.mjs` 生成的打包产物（源码在 entries/content.js），
// 必须排除：① 检查产物等于检查生成器，源码才是改动的对象；
// ② 产物里字符串/正则的长行会被本检查器的保守剥离策略误判 ——
//    实测扫出 3721 处假阳性，把真正的信号淹没了。
const SKIP = /node_modules|[\\/]\.git[\\/]|[\\/]test-results[\\/]|[\\/]playwright-report[\\/]|[\\/]dist[\\/]|\.min\.js$/;
// 生成物（源码在 entries/ 下）；按相对路径精确排除，避免误伤未来同名源码。
const GENERATED = new Set(['content.js']);
const EXTENSIONS = ['.js', '.mjs'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (SKIP.test(p)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (EXTENSIONS.some((ext) => e.name.endsWith(ext))) out.push(p);
  }
  return out;
}

// `/` 前面出现这些字符时，它只能是**正则开始**（不可能是除号）
const REGEX_PREV_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n', '']);
// 这些关键字后面可以跟正则字面量（`return /x/`、`typeof /x/`…）
const REGEX_PREV_WORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await',
]);

/**
 * 判断代码模式下遇到的 `/` 是正则字面量的开始，还是除号。
 * 识别不出来时返回 false（**保守**：按除号处理，宁可漏报也不吃掉真正的代码）。
 */
function isRegexStart(prevChar, prevWord) {
  if (REGEX_PREV_CHARS.has(prevChar)) return true;
  return REGEX_PREV_WORDS.has(prevWord);
}

/** 把字符串/模板/注释/正则内容替换成等长空白（保持行列结构），返回按行数组。 */
export function stripStringsAndComments(src) {
  const out = [];
  let mode = null; // null | "'" | '"' | '`' | '//' | '/*' | '/re/'
  let line = '';
  let prevChar = ''; // 行内最近一个"有意义的"代码字符
  let prevWord = ''; // 行内最近一个标识符
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === '//') {
      if (c === '\n') {
        mode = null;
        out.push(line);
        line = '';
        continue;
      }
      line += c === '\t' ? '\t' : ' ';
      continue;
    }
    if (mode === '/*') {
      if (c === '*' && n === '/') {
        mode = null;
        line += '  ';
        i++;
        continue;
      }
      if (c === '\n') {
        out.push(line);
        line = '';
        continue;
      }
      line += ' ';
      continue;
    }
    if (mode === '/re/') {
      // 正则内部：逐字符吃空白，处理 \ 转义与 [...] 字符类（类里的 / 不结束正则）
      if (c === '\n') {
        // 正则字面量不能跨行 —— 说明前面判断错了，退回到"按代码处理"
        mode = null;
        out.push(line);
        line = '';
        continue;
      }
      if (c === '\\') {
        line += '  ';
        i++;
        continue;
      }
      if (c === '[') {
        // 字符类：一直吃到 ] 为止
        line += ' ';
        i++;
        while (i < src.length && src[i] !== ']' && src[i] !== '\n') {
          if (src[i] === '\\') {
            line += '  ';
            i += 2;
            continue;
          }
          line += ' ';
          i++;
        }
        if (i < src.length && src[i] === ']') line += ' ';
        continue;
      }
      if (c === '/') {
        mode = null;
        line += c;
        prevChar = c;
        continue;
      }
      line += ' ';
      continue;
    }
    if (mode) {
      // 字符串内部
      if (c === '\\') {
        line += '  ';
        i++;
        continue;
      }
      if (c === mode) {
        mode = null;
        line += c;
        continue;
      }
      if (c === '\n') {
        // 未闭合的普通字符串（语法错误）或模板换行
        out.push(mode === '`' ? line + ' ' : line);
        line = mode === '`' ? '' : line;
        continue;
      }
      line += ' ';
      continue;
    }
    // 正常代码
    if (c === '/' && n === '/') {
      mode = '//';
      line += '  ';
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      mode = '/*';
      line += '  ';
      i++;
      continue;
    }
    if (c === '/' && isRegexStart(prevChar, prevWord)) {
      mode = '/re/';
      line += c;
      prevChar = '';
      prevWord = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      mode = c;
      line += c;
      prevChar = '';
      continue;
    }
    if (c === '\n') {
      out.push(line);
      line = '';
      prevChar = '\n';
      prevWord = '';
      continue;
    }
    line += c;
    if (!/\s/.test(c)) {
      prevChar = c;
      if (/[\w$]/.test(c)) prevWord = (/[\w$]+$/.exec(line) || [''])[0];
      else prevWord = '';
    }
  }
  out.push(line);
  return out;
}

export function findConstAssignments(roots = ROOTS) {
  const findings = [];
  const files = [];
  let scanned = 0;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root)) {
      const relForSkip = path.relative(process.cwd(), file).split(path.sep).join('/');
      if (GENERATED.has(relForSkip)) continue;
      scanned++;
      files.push(path.relative(process.cwd(), file).split(path.sep).join('/'));
      const lines = stripStringsAndComments(fs.readFileSync(file, 'utf8'));
      const decls = new Map();
      const note = (name, kind, lineNo) => {
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) return;
        if (!decls.has(name)) decls.set(name, { constLines: new Set(), mutable: false, isParam: false });
        const d = decls.get(name);
        if (kind === 'const') d.constLines.add(lineNo);
        else if (kind === 'let' || kind === 'var') d.mutable = true;
        else if (kind === 'param') d.isParam = true;
      };

      for (let i = 0; i < lines.length; i++) {
        const code = lines[i];
        // 声明：允许有/无初始化，允许 of/in
        for (const m of code.matchAll(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?=[=;,)\]}])/g)) note(m[2], m[1], i + 1);
        for (const m of code.matchAll(/\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) note(m[2], m[1], i + 1);
        // 解构声明：`let [sw] = ...` / `const { a, b } = ...` / `const [a, b] = ...`。
        // 为什么必须单独处理：上面的正则要求标识符后紧跟 `=` 或 `,` 等，
        // 而解构声明是 `名 空格 [/{`。漏掉它会有两个后果：
        //   ① 该名字的 const/let 声明未被登记 → 对它的赋值被漏报（假阴性）；
        //   ② 若同一文件另有 `const 同名`（不同作用域），会把别处的赋值算到它头上（假阳性）。
        // 实测：tests/e2e/golden.spec.mjs 的 `let [sw]` 与另一个作用域的 `const sw`
        // 合并成「const 被赋值」，即是第 ② 类。
        for (const m of code.matchAll(/\b(const|let|var)\s*([[{]([^\]}]*)[\]}])/g)) {
          for (const raw of m[3].split(',')) {
            // 取 `a` / `a: b` / `a = 1` / `...rest` 中的绑定名
            const nm = raw
              .trim()
              .replace(/^\.\.\./, '')
              .replace(/\s*[:=][\s\S]*$/, '')
              .replace(/[^\w$]/g, '');
            if (nm) note(nm, m[1], i + 1);
          }
        }
        for (const m of code.matchAll(/\b(function|class)\s+([A-Za-z_$][\w$]*)/g)) note(m[2], 'let', i + 1);
        for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
          for (const raw of m[1].split(',')) {
            const nm = raw.trim().replace(/=.*$/, '').replace(/^\.\.\./, '').replace(/[:?].*$/, '').trim();
            if (nm) note(nm, 'param', i + 1);
          }
        }
      }

      for (const [name, d] of decls) {
        if (d.mutable || d.isParam || d.constLines.size === 0) continue;
        const esc = name.replace(/\$/g, '\\$&');
        const assignRe = new RegExp('(?<![\\w$.])' + esc + '\\s*(?:\\+\\+|--|[+\\-*/%&|^]?=(?!=))');
        for (let i = 0; i < lines.length; i++) {
          const lineNo = i + 1;
          if (d.constLines.has(lineNo)) continue; // 声明行不算赋值
          if (!assignRe.test(lines[i])) continue;
          findings.push({ file, line: lineNo, name, declLine: [...d.constLines][0], text: lines[i].trim().slice(0, 100) });
        }
      }
    }
  }
  return { findings, scanned, files };
}

// CLI：仅在直接执行时输出报告并设定退出码（被测试 import 时不产生副作用）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { findings, scanned } = findConstAssignments();
  console.log('扫描 ' + scanned + ' 个文件');
  if (!findings.length) {
    console.log('  未发现「对 const 赋值」 ✓');
  } else {
    console.log('  发现 ' + findings.length + ' 处：');
    for (const f of findings) {
      console.log('  ' + f.file + ':' + f.line + '  [' + f.name + ' 声明于第 ' + f.declLine + ' 行]');
      console.log('      ' + f.text);
    }
  }
  process.exit(findings.length ? 1 : 0);
}
