#!/usr/bin/env node
// 为已有评测产物补生成可读轨迹：
//   node scripts/summarize-agent-traces.mjs <run-dir> [more-run-dirs...]
//
// 原始 agent_trace.jsonl 不变；写 agent_trace.steps.jsonl 与 agent_trace.md。
import fs from 'node:fs';
import path from 'node:path';
import { writeReadableTrace } from '../integrations/webarena/trace.mjs';

function traceDirs(root) {
  const out = [];
  const visit = (dir) => {
    if (fs.existsSync(path.join(dir, 'agent_trace.jsonl')) && fs.existsSync(path.join(dir, 'agent_trace.meta.json'))) {
      out.push(dir);
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) visit(path.join(dir, entry.name));
    }
  };
  visit(root);
  return out;
}

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('用法：node scripts/summarize-agent-traces.mjs <run-dir> [...]');
  process.exit(2);
}

let total = 0;
for (const raw of roots) {
  const root = path.resolve(process.cwd(), raw);
  if (!fs.existsSync(root)) {
    console.error('目录不存在：' + root);
    process.exitCode = 1;
    continue;
  }
  for (const dir of traceDirs(root)) {
    const result = writeReadableTrace(dir);
    total += 1;
    console.log(path.relative(process.cwd(), dir) + ' → ' + result.readable_steps + ' 步');
  }
}
console.log('完成：' + total + ' 条轨迹');
