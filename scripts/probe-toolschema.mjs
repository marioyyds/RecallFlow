// 定位 ToolSchema 与它的字段（上一个探针没在 schema.d.ts 里找到它）。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const TOOLS = 'C:\\Users\\mario\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-tools\\lib\\types';

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

console.log('=== 哪些文件声明/引用了 ToolSchema ===');
for (const f of files(TOOLS)) {
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (/ToolSchema/.test(l)) {
      console.log('  ' + f.replace(TOOLS + '\\', '') + ':' + (i + 1) + '  ' + l.trim().slice(0, 130));
    }
  });
}

console.log('');
console.log('=== 打印 ToolSchema 的定义体（若在本包内）===');
for (const f of files(TOOLS)) {
  const lines = readFileSync(f, 'utf8').split('\n');
  const at = lines.findIndex((l) => /(interface|type)\s+ToolSchema\b/.test(l));
  if (at < 0) continue;
  console.log('--- ' + f.replace(TOOLS + '\\', '') + ' 第 ' + (at + 1) + ' 行 ---');
  let depth = 0;
  for (let i = at; i < lines.length && i < at + 40; i++) {
    console.log('  ' + lines[i].replace(/\s+$/, '').slice(0, 140));
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (i > at && depth <= 0) break;
  }
}
