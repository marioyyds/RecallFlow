// 可行性调研：DSH 的依赖树里有没有现成的 WebSocket 库？
// 为什么用脚本而不是 shell 单行：PowerShell 的引号转义已经坑了我很多次了。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DSH_ROOT = 'C:\\Users\\mario\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh';
const NPM_ROOT = 'C:\\Users\\mario\\AppData\\Roaming\\npm\\node_modules';

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

console.log('=== 1) DSH 依赖里是否有 ws / websocket ===');
const candidates = ['ws', 'websocket', 'isomorphic-ws', 'uWebSockets.js', 'socket.io'];
for (const root of [join(DSH_ROOT, 'node_modules'), NPM_ROOT]) {
  for (const name of candidates) {
    const p = join(root, name);
    if (existsSync(p)) {
      let version = '?';
      try {
        version = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).version;
      } catch {}
      console.log('  ✓ ' + p + '  (v' + version + ')');
    }
  }
}

console.log('');
console.log('=== 2) dsh-host-webserver 自己的依赖 ===');
try {
  const pkg = JSON.parse(readFileSync(join(DSH_ROOT, 'node_modules', '@deepseek-ai', 'dsh-host-webserver', 'package.json'), 'utf8'));
  for (const [k, v] of Object.entries(pkg.dependencies || {})) console.log('  ' + k + ' → ' + v);
} catch (e) {
  console.log('  读取失败: ' + e.message);
}

console.log('');
console.log('=== 3) 哪些 DSH 包 import 了 ws（它的 API 长什么样可参照）===');
const scope = join(DSH_ROOT, 'node_modules', '@deepseek-ai');
let hits = 0;
function walk(dir, depth) {
  if (depth > 3 || hits > 12) return;
  for (const name of listDirs(dir)) {
    const sub = join(dir, name);
    for (const f of ['lib/index.js', 'index.js', 'lib/index.mjs']) {
      const p = join(sub, f);
      if (!existsSync(p)) continue;
      let text = '';
      try {
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const m = text.match(/from\s*['"]ws['"]|require\(\s*['"]ws['"]\s*\)/);
      if (m) {
        console.log('  ✓ ' + name + '/' + f + '  →  ' + m[0]);
        hits++;
      }
    }
    if (name.startsWith('dsh-')) walk(sub, depth + 1);
  }
}
walk(scope, 0);
if (!hits) console.log('  （没有直接命中；可能被压缩/间接引用）');

console.log('');
console.log('=== 4) 全局 npm 根下有没有 ws（插件从 link: 位置能否 resolve 到）===');
for (const name of candidates) {
  const p = join(NPM_ROOT, name);
  if (existsSync(p)) console.log('  ✓ ' + p);
}
