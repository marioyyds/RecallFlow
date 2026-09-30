// 抽取 DSH 类型声明里的关键接口体，供实现插件时照抄（避免 shell 引号问题）。
import { readFileSync, existsSync } from 'node:fs';

const BASE = 'C:\\Users\\mario\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai';

function show(file, startRe, maxLines = 30) {
  const p = BASE + '\\' + file;
  if (!existsSync(p)) {
    console.log('  ✗ 文件不存在: ' + file);
    return;
  }
  const lines = readFileSync(p, 'utf8').split('\n');
  const at = lines.findIndex((l) => startRe.test(l));
  console.log('=== ' + file + (at < 0 ? '  ✗ 未找到 ' + startRe : '  (第 ' + (at + 1) + ' 行)'));
  if (at < 0) return;
  let depth = 0;
  for (let i = at; i < lines.length && i < at + maxLines; i++) {
    const l = lines[i];
    console.log('  ' + l.replace(/\s+$/, '').slice(0, 150));
    depth += (l.match(/\{/g) || []).length - (l.match(/\}/g) || []).length;
    if (i > at && depth <= 0) break;
  }
}

console.log('########## 一、工具注册 ##########');
show('dsh-tools\\lib\\types\\index.d.ts', /interface Context \{/, 14);
show('dsh-tools\\lib\\types\\index.d.ts', /interface ToolDefinition/, 30);
show('dsh-tools\\lib\\types\\schema.d.ts', /interface ToolSchema/, 34);
show('dsh-tools\\lib\\types\\index.d.ts', /ToolOutputDefinition/, 16);

console.log('');
console.log('########## 二、Web 服务与路由 ##########');
show('dsh-host-webserver\\lib\\types\\index.d.ts', /interface Context \{/, 14);
show('dsh-host-webserver\\lib\\types\\index.d.ts', /interface WebRoute \{/, 14);
show('dsh-host-webserver\\lib\\types\\index.d.ts', /export declare class WebServer/, 20);
