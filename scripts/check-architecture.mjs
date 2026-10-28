// 架构门禁：检查静态依赖图、循环依赖和稳定基础层的反向引用。
//
// 这里检查的是**源码依赖方向**，不是运行期调用方向。Composition Root 可以依赖
// Application 与 Adapters；Application 只能依赖稳定契约和明确允许的协作者；
// shared 基础层不得反向依赖上层能力。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['entries', 'lib'];

const LAYER_DEPS = {
  domain: new Set(['domain']),
  shared: new Set(['shared', 'domain']),
  application: new Set(['application', 'domain', 'shared', 'backend', 'userscript']),
  presentation: new Set(['presentation', 'application', 'domain', 'shared', 'ui']),
  adapter: new Set(['adapter', 'domain', 'application', 'shared', 'backend', 'userscript', 'bridge']),
  ui: new Set(['ui', 'application', 'domain', 'shared']),
  backend: new Set(['backend', 'adapter', 'shared', 'domain']),
  userscript: new Set(['userscript', 'adapter', 'backend', 'shared', 'domain']),
  bridge: new Set(['bridge', 'adapter', 'application', 'presentation', 'backend', 'userscript', 'shared', 'domain']),
  composition: null,
};

export function layerOf(file) {
  const normalized = String(file).replaceAll('\\', '/');
  if (normalized.startsWith('entries/')) return 'composition';
  const match = /^lib\/([^/]+)\//.exec(normalized);
  if (!match) return 'other';
  if (match[1] === 'domain') return 'domain';
  if (match[1] === 'application') return 'application';
  if (match[1] === 'adapters') return 'adapter';
  if (match[1] === 'ui') return 'ui';
  if (match[1] === 'shared') return 'shared';
  if (match[1] === 'assistant') return 'application';
  if (match[1] === 'page') return 'presentation';
  if (match[1] === 'backend') return 'backend';
  if (match[1] === 'userscript') return 'userscript';
  if (match[1] === 'bridge') return 'bridge';
  return 'other';
}

function listSourceFiles(root = ROOT) {
  const out = [];
  function walk(relative) {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const next = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile() && next.endsWith('.ts') && !next.endsWith('.d.ts')) out.push(next);
    }
  }
  for (const sourceRoot of SOURCE_ROOTS) walk(sourceRoot);
  return out.sort();
}

function importsOf(text) {
  const specs = [];
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /export\s+[^;]*?from\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

function resolveImport(from, specifier, existing) {
  if (!specifier.startsWith('.')) return null;
  let target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier.split('?')[0]));
  if (!target.endsWith('.ts')) target += '.ts';
  return existing.has(target) ? target : null;
}

export function buildDependencyGraph(files, readFile = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8')) {
  const existing = new Set(files);
  const graph = new Map(files.map((file) => [file, []]));
  for (const file of files) {
    const targets = [];
    for (const specifier of importsOf(readFile(file))) {
      const target = resolveImport(file, specifier, existing);
      if (target) targets.push(target);
    }
    graph.set(file, [...new Set(targets)]);
  }
  return graph;
}

export function findDependencyCycles(graph) {
  let index = 0;
  const stack = [];
  const active = new Set();
  const indices = new Map();
  const lowLinks = new Map();
  const cycles = [];

  function visit(node) {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    active.add(node);

    for (const next of graph.get(node) || []) {
      if (!indices.has(next)) {
        visit(next);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
      } else if (active.has(next)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(next)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      active.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1) cycles.push(component.sort());
  }

  for (const file of graph.keys()) if (!indices.has(file)) visit(file);
  return cycles;
}

export function findLayerViolations(graph) {
  const violations = [];
  for (const [from, targets] of graph) {
    const fromLayer = layerOf(from);
    const allowed = LAYER_DEPS[fromLayer];
    if (!allowed) continue;
    for (const to of targets) {
      if (to.startsWith('entries/')) {
        violations.push({ code: 'entry-reverse-import', from, to });
        continue;
      }
      const toLayer = layerOf(to);
      if (!allowed.has(toLayer)) violations.push({ code: 'layer-direction', from, to, fromLayer, toLayer });
    }
  }
  return violations;
}

export function analyzeArchitecture(readFile) {
  const files = listSourceFiles();
  const graph = buildDependencyGraph(files, readFile);
  return {
    files,
    graph,
    cycles: findDependencyCycles(graph),
    violations: findLayerViolations(graph),
  };
}

function main() {
  const result = analyzeArchitecture();
  const json = process.argv.includes('--json');
  if (json) {
    console.log(JSON.stringify({
      files: result.files.length,
      cycles: result.cycles,
      violations: result.violations,
    }, null, 2));
  } else {
    if (!result.cycles.length && !result.violations.length) {
      console.log(`架构依赖检查通过 ✓（${result.files.length} 个源码文件，0 个循环，0 个跨层违规）`);
    }
    for (const cycle of result.cycles) console.log('[cycle] ' + cycle.join(' <-> '));
    for (const item of result.violations) {
      console.log(`[${item.code}] ${item.from} -> ${item.to}（${item.fromLayer || 'lib'} -> ${item.toLayer || 'entry'}）`);
    }
  }
  process.exit(result.cycles.length || result.violations.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
