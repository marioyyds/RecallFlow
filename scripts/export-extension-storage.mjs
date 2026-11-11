#!/usr/bin/env node
// 从浏览器 profile 里导出 RecallFlow 的 tracegraph.v2（以及 JEV 诊断、设置摘要）。
//
// 用法：
//   node scripts/export-extension-storage.mjs
//   node scripts/export-extension-storage.mjs --profile "Profile 4" --browser edge
//   node scripts/export-extension-storage.mjs --id <extension-id> --out .jev-eval/graph.json
//
// 为什么要拷一份 LevelDB 再读：浏览器运行时持有 LOCK，直接打开拿不到一致的快照；
// 复制到临时目录后用 classic-level 只读打开，浏览器继续写也不影响。
// 扩展 id 默认从 Preferences / Secure Preferences 里按路径或名字匹配 "RecallFlow"。
//
// 依赖：classic-level（devDependency）。没有它时脚本会给出明确提示。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { browser: 'edge', profile: 'Profile 4', id: '', out: '', match: 'RecallFlow' };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--browser') args.browser = argv[++i] || args.browser;
    else if (item === '--profile') args.profile = argv[++i] || args.profile;
    else if (item === '--id') args.id = argv[++i] || '';
    else if (item === '--out') args.out = argv[++i] || '';
    else if (item === '--match') args.match = argv[++i] || args.match;
    else if (item === '--help' || item === '-h') args.help = true;
  }
  return args;
}

function profileBase(browser) {
  const local = process.env.LOCALAPPDATA;
  if (!local) return '';
  if (browser === 'chrome') return path.join(local, 'Google', 'Chrome', 'User Data');
  return path.join(local, 'Microsoft', 'Edge', 'User Data');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function discoverExtensionIds(profileDir, match) {
  const needle = String(match || '').toLowerCase();
  const found = [];
  for (const name of ['Secure Preferences', 'Preferences']) {
    const data = readJson(path.join(profileDir, name));
    const settings = data && data.extensions && data.extensions.settings;
    if (!settings || typeof settings !== 'object') continue;
    for (const [id, value] of Object.entries(settings)) {
      const extPath = String(value && value.path || '');
      const manifestName = String(value && value.manifest && value.manifest.name || '');
      const hay = [extPath, manifestName, String(value && value.manifest && value.manifest.short_name || '')]
        .map((item) => String(item || '').toLowerCase()).join(' ');
      if (needle && hay.includes(needle)) found.push({ id, source: name, path: extPath });
    }
  }
  // 同名/同前缀的多个副本很常见（例如另一个工作目录里的 RecallFlow）。
  // 当前仓库路径完全一致的排最前，其余按发现顺序继续尝试。
  const self = path.resolve(ROOT).toLowerCase();
  found.sort((a, b) => {
    const aExact = path.resolve(a.path || '').toLowerCase() === self ? 0 : 1;
    const bExact = path.resolve(b.path || '').toLowerCase() === self ? 0 : 1;
    return aExact - bExact;
  });
  return found;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/export-extension-storage.mjs [--browser edge|chrome] [--profile "Profile 4"] [--id <id>] [--out <file>]');
    process.exit(0);
  }

  let ClassicLevel;
  try {
    ({ ClassicLevel } = await import('classic-level'));
  } catch {
    console.error('缺少依赖 classic-level。先运行：npm install --save-dev classic-level');
    process.exit(1);
  }

  const base = profileBase(args.browser);
  const profileDir = base && path.join(base, args.profile);
  if (!profileDir || !fs.existsSync(profileDir)) {
    console.error('找不到浏览器 profile：' + (profileDir || '(LOCALAPPDATA 未设置)'));
    console.error('用 --profile 指定实际 profile 目录名（如 "Default" / "Profile 1"）。');
    process.exit(1);
  }
  const candidates = args.id
    ? [{ id: args.id, source: 'argument', path: '' }]
    : discoverExtensionIds(profileDir, args.match);
  if (!candidates.length) {
    console.error('未在 profile 里找到名字/路径匹配 "' + args.match + '" 的扩展。');
    console.error('用 --id <扩展 id> 直接指定；id 可在 chrome://extensions 看到。');
    process.exit(1);
  }

  const wanted = new Set(['recallflow.tracegraph.v2', 'jevDiagnostics.v1', 'aiSettings']);
  let found = null;
  let values = null;
  for (const candidate of candidates) {
    const storageDir = path.join(profileDir, 'Local Extension Settings', candidate.id);
    if (!fs.existsSync(storageDir)) {
      console.log('skip ' + candidate.id + '：没有 Local Extension Settings');
      continue;
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-storage-'));
    fs.cpSync(storageDir, tmp, { recursive: true, force: true });
    const db = new ClassicLevel(tmp, { readOnly: true, keyEncoding: 'binary', valueEncoding: 'binary' });
    const read = {};
    try {
      await db.open();
      for await (const [key, value] of db.iterator()) {
        const name = Buffer.from(key).toString('utf8');
        if (wanted.has(name)) read[name] = Buffer.from(value).toString('utf8');
      }
    } finally {
      await db.close().catch(() => {});
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    if (read['recallflow.tracegraph.v2']) {
      found = candidate;
      values = read;
      break;
    }
    console.log('skip ' + candidate.id + '：没有 recallflow.tracegraph.v2');
  }

  if (!found || !values) {
    console.error('所有候选扩展里都没有 recallflow.tracegraph.v2（traceGraph 可能从未开启过）。');
    process.exit(1);
  }

  const outFile = path.resolve(ROOT, args.out || '.jev-eval/tracegraph-export.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, values['recallflow.tracegraph.v2']);

  if (values['jevDiagnostics.v1']) {
    fs.writeFileSync(path.join(path.dirname(outFile), 'jev-diagnostics.json'), values['jevDiagnostics.v1']);
  }
  if (values.aiSettings) {
    fs.writeFileSync(path.join(path.dirname(outFile), 'ai-settings-export.json'), values.aiSettings);
  }

  const graph = JSON.parse(values['recallflow.tracegraph.v2']);
  const sites = Object.entries(graph);
  const stats = sites.map(([site, item]) => ({
    site,
    edges: (item.l1 && item.l1.edges || []).length,
    records: (item.records || []).length,
    states: (item.l0 && item.l0.states || []).length,
    planSteps: (item.records || []).filter((record) => record.planStep).length,
    updatedAt: item.updatedAt,
  }));
  console.log('extension id : ' + found.id + ' (' + found.source + ')');
  console.log('exported     : ' + outFile + ' (' + fs.statSync(outFile).size + ' bytes)');
  for (const row of stats) {
    console.log('site         : ' + row.site + ' edges=' + row.edges + ' records=' + row.records +
      ' states=' + row.states + ' planStep=' + row.planSteps +
      ' updatedAt=' + new Date(row.updatedAt).toISOString());
  }
  console.log('diagnostics  : ' + (values['jevDiagnostics.v1'] ? 'exported' : 'not found'));
}

await main();