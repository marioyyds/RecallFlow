// 调研：谁实现了「往会话发消息」的 prompt()，插件该怎么拿到它？
// 已知：agent.session.prompt 不是函数（探针实测），所以要找真正的归属。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SCOPE = 'C:\\Users\\mario\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai';
const PATTERNS = [
  { name: 'prompt(content', re: /prompt\s*\(\s*content/ },
  { name: 'SessionController 类', re: /class\s+\w*SessionController\w*\s/ },
  { name: 'ISession 接口', re: /interface\s+ISession\b/ },
  { name: 'ctx.inject 里出现 session', re: /inject\s*\(\s*\[\s*['"][^'"]*session[^'"]*['"]/i },
  { name: '服务名 session(s)', re: /(?:readonly\s+)?session(?:s)?\s*:\s*(?:TypertLookup|SessionStore|\w*Controller)/ },
];

function dirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

const hits = new Map();
function walk(dir, depth, pkg) {
  if (depth > 4) return;
  for (const entry of dirs(dir)) {
    const sub = join(dir, entry);
    if (entry === 'node_modules' || entry === '.git') continue;
    let st;
    try {
      st = statSync(sub);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(sub, depth + 1, depth === 0 ? entry : pkg);
    } else if (/\.(d\.ts|mjs|js)$/.test(entry)) {
      let text = '';
      try {
        text = readFileSync(sub, 'utf8');
      } catch {
        continue;
      }
      if (text.length > 2_000_000) continue;
      const lines = text.split('\n');
      for (const p of PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
          if (!p.re.test(lines[i])) continue;
          const key = p.name;
          if (!hits.has(key)) hits.set(key, []);
          const arr = hits.get(key);
          if (arr.length >= 8) break;
          arr.push(pkg + ' :: ' + entry + ':' + (i + 1) + '  ' + lines[i].trim().slice(0, 110));
        }
      }
    }
  }
}

walk(SCOPE, 0, '');

for (const [name, arr] of hits) {
  console.log('=== ' + name + ' ===');
  for (const line of arr) console.log('  ' + line);
  console.log('');
}
if (!hits.size) console.log('（没有命中）');
