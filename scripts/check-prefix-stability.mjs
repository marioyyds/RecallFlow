// 静态门禁：agent 主循环的**请求前缀稳定性**契约。
//
// 背景：DeepSeek 的上下文缓存是「请求前缀级」的 —— 从 token 0 开始逐字节匹配。
// agent 循环天然是 append-only 的（每轮只在末尾追加 assistant 消息与工具结果），
// 本该是前缀缓存最理想的场景。但只要有人在**历史中部**改写一条消息，
// 从那个位置起的所有内容都会变成新前缀，缓存全部失效、整段历史重新 prefill。
// 这类改动功能上完全正确、测试也全绿，唯一的症状是「越跑越慢」—— 属于
// 和 check-const-assign 同一类「静态可查但没人查」的问题，所以在这里钉死。
//
// 本检查强制的不变式（针对 lib/assistant/agent.js）：
//   R1  绝不出现 `messages[0] = ...`：messages[0] 是前缀起点，改写它等于全量失效。
//       曾经 promoteToResearch 就是这么干的，改为在末尾追加 system 消息。
//   R2  绝不出现 unshift / shift / pop / sort / reverse：这些都会移动或删除已有位置。
//   R3  `messages.splice` 全文**最多一处**，且必须出现在主循环之前，并位于
//       injectPlanMessage 内 —— 即「计划消息一次性注入」这一个已知例外。
//   R4  计划注入只允许在主循环之前调用一次；循环内不得再调用。
//
// 已知局限（宁可漏报不误报）：这是词法检查，不做调用图分析。
// 如果有人在循环内调用某个「内部会改写历史中部」的函数，本检查抓不到 ——
// 那正是当年 syncPlanMessage 的形态。因此 ① 这类改动请把改写点集中到
// injectPlanMessage，② 行为层另有 tests/agent-prompt.test.mjs 与
// tests/prefix-stability.test.mjs 兜底。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripStringsAndComments } from './check-const-assign.mjs';

export const TARGET = 'lib/assistant/agent.js';
const LOOP_RE = /for\s*\(\s*let\s+iter\s*=\s*resumeIteration/;
const PLAN_FN_RE = /const\s+injectPlanMessage\s*=/;

/** 从 startIdx 行开始，找到第一个平衡的 `}` 所在行号（含嵌套块）。 */
function findBlockEnd(lines, startIdx) {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
        if (started && depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

export function findPrefixMutations(target = TARGET) {
  const findings = [];
  const push = (line, rule, text) => findings.push({ line, rule, text: String(text).trim().slice(0, 110) });

  if (!fs.existsSync(target)) {
    return { findings: [{ line: 0, rule: 'R0', text: '目标文件不存在：' + target }], scanned: 0 };
  }

  const lines = stripStringsAndComments(fs.readFileSync(target, 'utf8'));

  const loopStart = lines.findIndex((l) => LOOP_RE.test(l));
  if (loopStart < 0) {
    // 主循环改名/重构后这里会失效 —— 必须报错而不是静默通过，否则门禁形同虚设。
    push(0, 'R0', '未找到主循环（' + LOOP_RE + '），检查已失效，请同步更新 scripts/check-prefix-stability.mjs');
    return { findings, scanned: lines.length };
  }
  const loopEnd = findBlockEnd(lines, loopStart);

  const planFnStart = lines.findIndex((l) => PLAN_FN_RE.test(l));

  for (let i = 0; i < lines.length; i++) {
    const code = lines[i];
    const lineNo = i + 1;

    // R1：改写前缀起点
    if (/messages\s*\[\s*0\s*\]\s*=(?!=)/.test(code)) {
      push(lineNo, 'R1', code);
    }

    // R2：移动/删除已有位置
    const bad = code.match(/messages\s*\.\s*(unshift|shift|pop|sort|reverse)\s*\(/);
    if (bad) push(lineNo, 'R2', code);

    // R3：splice 只允许计划消息的一次性注入
    if (/messages\s*\.\s*splice\s*\(/.test(code)) {
      if (planFnStart < 0 || i < planFnStart) {
        push(lineNo, 'R3', 'splice 出现在 injectPlanMessage 之外：' + code);
      } else if (i >= loopStart && i <= loopEnd) {
        push(lineNo, 'R3', 'splice 出现在主循环内：' + code);
      }
    }
  }

  // R3 补充：全文只能有一处 splice
  const splices = lines.filter((l) => /messages\s*\.\s*splice\s*\(/.test(l));
  if (splices.length > 1) {
    push(0, 'R3', '全文出现 ' + splices.length + ' 处 messages.splice（只允许计划注入这一处）');
  }

  // R4：计划注入只能在主循环之前调用
  for (let i = 0; i < lines.length; i++) {
    if (/injectPlanMessage\s*\(\s*\)/.test(lines[i])) {
      if (i >= loopStart && i <= loopEnd) push(i + 1, 'R4', '主循环内再次注入计划：' + lines[i]);
    }
  }

  return { findings, scanned: lines.length };
}

// CLI：仅在直接执行时输出报告并设定退出码（被测试 import 时不产生副作用）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { findings } = findPrefixMutations();
  if (!findings.length) {
    console.log('请求前缀稳定性检查通过 ✓（' + TARGET + '）');
  } else {
    console.log('发现 ' + findings.length + ' 处可能破坏请求前缀缓存的写法：');
    for (const f of findings) console.log('  ' + TARGET + ':' + f.line + '  [' + f.rule + ']  ' + f.text);
  }
  process.exit(findings.length ? 1 : 0);
}
