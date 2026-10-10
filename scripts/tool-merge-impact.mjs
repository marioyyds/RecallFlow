// C-4 影响面分析：统计「工具从 55 重切到约 28」的各候选分组中，
// 每个工具名在本仓库里的**字面量引用**分布。
//
// 为什么需要它：合并工具会改动对外契约（Schema + 权限元数据 + 执行器），
// 而"改动会波及哪些文件"此前只能靠人肉搜索。把它量出来后，
// 合并/不合并的取舍才有依据 —— 这是别人的产品决策，但决策需要成本数据。
//
// 用法：node scripts/tool-merge-impact.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 分组**直接从注册表派生**，不手写名字。
//
// 为什么必须这样：本脚本的第一版我按文档印象手写了分组，结果 10 个名字根本不存在
//（`type_at` / `add_skill` / `list_knowledge` / `get_element_attribute` / `hover_at` …），
// 于是那一版的全部数字都是错的 —— 而它看起来完全正常。
// 这正是本仓库反复出现的那类问题：**报告看起来有数据，但数据描述的不是这个系统**。
// 改成从 TOOL_REGISTRY 取真名，并在开头显式校验每个名字都存在，不存在就直接报错。
import { TOOL_REGISTRY } from '../lib/assistant/tools.js';

const ALL_NAMES = new Set(TOOL_REGISTRY.map((t) => t.name));

const GROUPS = {
  '视觉标注': ['highlight_text', 'outline_element', 'set_element_style', 'clear_page_overlays'],
  '元素检查': ['get_element_text', 'get_attribute', 'get_page_snapshot', 'get_ax_snapshot', 'list_frames'],
  '知识库': ['search_knowledge_base', 'list_knowledge_base', 'get_entry', 'add_entry', 'remove_entry'],
  '宏': ['save_macro', 'list_macros', 'run_macro'],
  '用户脚本': ['list_userscripts', 'search_userscripts', 'install_userscript', 'run_userscript'],
  '技能': ['load_skill', 'install_skill'],
  '诊断': ['read_console', 'read_network', 'get_element_source'],
  '指针': ['click_at', 'hover_element', 'drag_element'],
  '标签页': ['list_tabs', 'switch_tab', 'open_tab'],
};

// 硬校验：任何名字不在注册表里就是脚本自身的错误，立刻失败而不是输出漂亮但错的数字。
const bad = [];
for (const [g, names] of Object.entries(GROUPS)) {
  for (const n of names) if (!ALL_NAMES.has(n)) bad.push(g + ' → ' + n);
}
if (bad.length) {
  console.error('以下名字不在 TOOL_REGISTRY 中（分组写错了）：\n  ' + bad.join('\n  '));
  process.exit(2);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'test-results', 'playwright-report', 'dist']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|json|md)$/.test(e.name)) files.push(p);
  }
})(ROOT);

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

console.log('仓库内文件扫描数：' + files.length + '\n');

for (const [label, names] of Object.entries(GROUPS)) {
  console.log('== ' + label + '（' + names.length + ' 个） ==');
  let groupTotal = 0;
  for (const n of names) {
    // 只统计"作为工具名被引用"的位置：带引号的字符串字面量、或代码里的 name === 'x'
    const re = new RegExp('([\'"`])' + n + '\\1', 'g');
    let hits = 0;
    const byFile = new Map();
    for (const f of files) {
      if (rel(f) === 'content.js') continue; // 打包产物
      const s = fs.readFileSync(f, 'utf8');
      const m = s.match(re);
      if (m && m.length) {
        hits += m.length;
        byFile.set(rel(f), m.length);
      }
    }
    groupTotal += hits;
    const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([f, c]) => f + '(' + c + ')').join(' ');
    console.log('  ' + n.padEnd(24) + ' 引用 ' + String(hits).padStart(3) + ' 处  ' + top);
  }
  console.log('  小计：' + groupTotal + ' 处引用\n');
}

// 哪些文件是"工具名集中出现"的地方 —— 合并时必须同步改这些
console.log('== 工具名出现最多的文件（合并时必须同步） ==');
const perFile = new Map();
const ALL = Object.values(GROUPS).flat();
for (const f of files) {
  if (rel(f) === 'content.js') continue;
  const s = fs.readFileSync(f, 'utf8');
  let c = 0;
  for (const n of ALL) {
    const re = new RegExp('([\'"`])' + n + '\\1', 'g');
    const m = s.match(re);
    if (m) c += m.length;
  }
  if (c) perFile.set(rel(f), c);
}
for (const [f, c] of [...perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log('  ' + String(c).padStart(4) + '  ' + f);
}
