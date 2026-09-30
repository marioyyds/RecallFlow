// 取 ToolSchema（在 dsh-llm）、ContentBlock、JsonSchemaNode 的定义体。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SCOPE = 'C:\\Users\\mario\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai';

function allDts(dir, depth = 0, out = []) {
  if (depth > 4 || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) allDts(p, depth + 1, out);
    else if (e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function dumpBody(file, re, max = 44) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((l) => re.test(l));
  if (at < 0) return false;
  console.log('--- ' + file.replace(SCOPE + '\\', '') + ' 第 ' + (at + 1) + ' 行 ---');
  let depth = 0;
  for (let i = at; i < lines.length && i < at + max; i++) {
    console.log('  ' + lines[i].replace(/\s+$/, '').slice(0, 148));
    depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
    if (i > at && depth <= 0) break;
  }
  return true;
}

const targets = [
  { pkg: 'dsh-llm', re: /(interface|type)\s+ToolSchema\b/, label: 'ToolSchema' },
  { pkg: 'dsh-llm', re: /(type|interface)\s+ContentBlock\b/, label: 'ContentBlock' },
  { pkg: 'dsh-tools', re: /(type|interface)\s+JsonSchemaNode\b/, label: 'JsonSchemaNode' },
];

for (const t of targets) {
  console.log('########## ' + t.label + ' ##########');
  let found = false;
  for (const f of allDts(join(SCOPE, t.pkg))) {
    if (dumpBody(f, t.re)) {
      found = true;
      break;
    }
  }
  if (!found) console.log('  ✗ 未找到');
  console.log('');
}
