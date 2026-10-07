#!/usr/bin/env node
/**
 * 删除前消费者扫描：对 docs/deletion-plan.md 里每个待删目标，列出仓库里还有谁引用它。
 *
 * 为什么要有这个脚本：我干过一次 —— 准备删 7801 桥接时才发现 opencode 也在用它，
 * 差点把 opencode 的页面工具**静默**删坏（没报错，只是永远拿不到结果）。
 * 教训是"删之前先核对消费者"，但靠人记会漏。所以把它变成一条命令：
 * 每个目标列出引用点，删除时对着这张表逐个处理，而不是凭印象。
 *
 * **那条桥接后来真的删掉了**（2026-10-08，用户明确说不再用 opencode）——
 * 但"删之前先核对消费者"这条教训与这个脚本都保留：它要防的是**下一个人**重犯。
 * 所以下面这张表里保留的是**当时的判定依据**，路径可能已经不存在，关键词仍然有意义
 * （它们同时也是"不得复活"的反向检查素材）。
 *
 * 用法：node scripts/scan-deletion-consumers.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

/** 待删目标：路径 + 用来找引用的关键词（关键词比路径更能反映"谁在用这个能力"）。 */
const TARGETS = [
  {
    step: '第 2 步',
    what: '客户端卡片插件（整包）',
    path: 'integrations/dsh-client-recallflow-panel',
    keywords: ['dsh-client-recallflow-panel', 'recallflow-panel-ui'],
  },
  {
    step: '第 3 步',
    what: '旧 DSH 插件（注入那条路）',
    path: 'integrations/dsh-plugin-recallflow',
    keywords: ['dsh-plugin-recallflow/index.js', 'recallflow-panel-sync'],
  },
  {
    step: '第 5 步',
    what: 'DSH profile 里的 RecallFlow MCP client（已执行 2026-10-07）',
    path: '(profile, 不在仓库内)',
    keywords: ['recallflow-mcp', 'dsh-mcp-client'],
  },
  {
    step: '第 6 步',
    what: '扩展里的死代码（postPanelTurn / forwardBridgeEvent / rfBridgeEvent / renderBridgeEvent）',
    path: 'lib/bridge/relay.js',
    keywords: ['postPanelTurn', 'forwardBridgeEvent', 'rfBridgeEvent', 'renderBridgeEvent'],
  },
];

/** 不该被当引用的地方：构建产物、备份、本脚本自身、文档（文档是要改，不是要跑）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.dsh', 'dist', 'build']);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|ts|json|yml|yaml|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
console.log('扫描 ' + files.length + ' 个文件（跳过 node_modules/.git 等）\n');

for (const t of TARGETS) {
  console.log('=== ' + t.step + '：' + t.what);
  console.log('    路径：' + t.path);
  const hits = [];
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, '/');
    // 目标自身不算"消费者"
    if (t.path && rel.startsWith(t.path.replace(/\\/g, '/'))) continue;
    if (rel === 'scripts/scan-deletion-consumers.mjs') continue;
    let text = '';
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const kw of t.keywords) {
      if (!text.includes(kw)) continue;
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.includes(kw));
      hits.push('    ' + rel + ':' + (at + 1) + '  ' + lines[at].trim().slice(0, 96));
    }
  }
  if (!hits.length) console.log('    （没有引用者 —— 可以直接删）');
  else {
    console.log('    引用点 ' + hits.length + ' 处：');
    for (const h of hits.slice(0, 24)) console.log(h);
    if (hits.length > 24) console.log('    …还有 ' + (hits.length - 24) + ' 处');
  }
  console.log('');
}

console.log('提醒：文件路径之外，还要看**运行时**消费者。7801 桥接就是典型 ——');
console.log('  仓库里几乎找不到"opencode 在用它"的代码，因为 opencode 是另一个进程。');
console.log('  这类消费者只能靠配置与文档确认。（那条桥接已于 2026-10-08 按用户决定删除；');
console.log('  这条提醒留着，是因为下一个待删目标同样可能有仓库外的运行时消费者。）');
