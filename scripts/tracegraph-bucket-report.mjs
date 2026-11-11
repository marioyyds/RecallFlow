#!/usr/bin/env node
// tracegraph 候选桶体检：从一份图导出里判断「低置信」主要来自哪种形态。
//
// 用法：
//   node scripts/tracegraph-bucket-report.mjs --graph .jev-eval/graph.json
//   node scripts/tracegraph-bucket-report.mjs --storage storage-dump.json --top 30
//   node scripts/tracegraph-bucket-report.mjs --graph graph.json --json
//
// 接受的输入：
//   1) 单个图对象（含 version / siteKey / l1）
//   2) chrome.storage 导出：{ "recallflow.tracegraph.v2": { "<siteKey>": graph } }
//   3) 图对象数组
//
// 输出：
//   - 每个 siteKey × 状态名：边数、不同录制签名数、每签名平均边数
//   - 同态内两两 Jaccard 相似度（g + 语义锚点 + 工具名），近 1 表示边几乎只差标签
//   - 判定：mixed-buckets（同一状态名混了多个子状态）还是 same-state-many-actions
//
// 这是只读脚本：不读 chrome.storage，不改任何文件。没有真实导出时它只会空跑。
import fs from 'node:fs';

function parseArgs(argv) {
  const args = { graph: '', storage: '', top: 20, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--graph') args.graph = argv[++i] || '';
    else if (item === '--storage') args.storage = argv[++i] || '';
    else if (item === '--top') args.top = Math.max(1, Number(argv[++i]) || 20);
    else if (item === '--json') args.json = true;
    else if (item === '--help' || item === '-h') args.help = true;
  }
  return args;
}

function readJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (error) {
    console.error('cannot read ' + path + ': ' + (error && error.message));
    return null;
  }
}

function looksLikeGraph(value) {
  return Boolean(value) && typeof value === 'object' && value.version === 2 && value.l1;
}

function collectGraphs(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.filter(looksLikeGraph);
  if (looksLikeGraph(input)) return [input];
  const byKey = input['recallflow.tracegraph.v2'];
  if (byKey && typeof byKey === 'object') {
    return Object.values(byKey).filter(looksLikeGraph);
  }
  return Object.values(input).filter(looksLikeGraph);
}

function tokens(edge) {
  const text = [
    String(edge.g || ''),
    String(edge.action && edge.action.tool || ''),
    String(edge.s && edge.s.semanticAnchor && edge.s.semanticAnchor.name || ''),
    String(edge.s && edge.s.semanticAnchor && edge.s.semanticAnchor.text || ''),
  ].join(' ');
  const out = new Set();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    if (word) out.add(word);
  }
  return out;
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function averagePairSimilarity(edges) {
  if (edges.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < edges.length; i += 1) {
    for (let j = i + 1; j < edges.length; j += 1) {
      sum += jaccard(tokens(edges[i]), tokens(edges[j]));
      pairs += 1;
    }
  }
  return pairs ? sum / pairs : 0;
}

function signatureOf(edge, recordIndex) {
  if (Array.isArray(edge.fromSignatures) && edge.fromSignatures.length) {
    return edge.fromSignatures.join(' || ');
  }
  // 旧图没有 fromSignatures 时，按 provenance.recordIds 回查原始证据。
  // 这正是 live 读路径 mergeEdges 的重建依据，所以报告与运行期看到的是同一组签名。
  const derived = (Array.isArray(edge.provenance && edge.provenance.recordIds)
    ? edge.provenance.recordIds
    : [])
    .map((id) => recordIndex.get(String(id)))
    .map((record) => record && record.before && record.before.atomSignature)
    .filter((value) => typeof value === 'string' && value);
  if (derived.length) return [...new Set(derived)].join(' || ');
  return '<legacy:no-signature>';
}

function recordIndexOf(graph) {
  const map = new Map();
  for (const record of Array.isArray(graph.records) ? graph.records : []) {
    if (record && record.id) map.set(String(record.id), record);
  }
  return map;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function report(graphs) {
  const rows = [];
  for (const graph of graphs) {
    const siteKey = String(graph.siteKey || 'unknown');
    const edges = Array.isArray(graph.l1 && graph.l1.edges) ? graph.l1.edges : [];
    const byState = new Map();
    const recordIndex = recordIndexOf(graph);
    for (const edge of edges) {
      const state = String(edge.from || '');
      if (!byState.has(state)) byState.set(state, []);
      byState.get(state).push(edge);
    }
    for (const [state, bucket] of byState) {
      const signatures = new Set(bucket.map((edge) => signatureOf(edge, recordIndex)));
      const legacy = bucket.filter((edge) => signatureOf(edge, recordIndex) === '<legacy:no-signature>').length;
      rows.push({
        siteKey,
        state,
        edges: bucket.length,
        signatures: signatures.size,
        edgesPerSignature: bucket.length / signatures.size,
        similarity: averagePairSimilarity(bucket),
        legacy,
      });
    }
  }
  rows.sort((a, b) => b.edges - a.edges || a.siteKey.localeCompare(b.siteKey));
  const withSignature = rows.filter((row) => row.signatures > 0 && !row.legacy);
  const medianSignatures = median(withSignature.map((row) => row.signatures));
  const sameStateRows = rows.filter((row) => row.edges > 5);
  const medianSimilarity = median(sameStateRows.map((row) => row.similarity));
  const verdict = medianSignatures > 1.5
    ? 'mixed-buckets（同一状态名下混了多个子状态：先落 matchLevel 分层）'
    : 'same-state-many-actions（候选都来自同一状态：先补 purpose / 前置 / 效果证据）';
  return {
    rows,
    summary: {
      sites: new Set(rows.map((row) => row.siteKey)).size,
      states: rows.length,
      edges: rows.reduce((sum, row) => sum + row.edges, 0),
      medianSignaturesPerState: medianSignatures,
      medianSimilarityAmongBusyStates: medianSimilarity,
      verdict,
    },
  };
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('node scripts/tracegraph-bucket-report.mjs --graph <file> [--top N] [--json]');
  process.exit(0);
}
const input = readJson(args.graph) || readJson(args.storage);
if (!input) {
  console.error('no graph input; pass --graph <json> (single graph / storage dump)');
  process.exit(1);
}
const graphs = collectGraphs(input);
if (!graphs.length) {
  console.error('input has no tracegraph.v2 shape');
  process.exit(1);
}
const result = report(graphs);

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const header = ['site', 'state', 'edges', 'signatures', 'edges/sig', 'similarity', 'legacy'];
console.log(header.join('\t'));
for (const row of result.rows.slice(0, args.top)) {
  console.log([
    row.siteKey,
    row.state,
    row.edges,
    row.signatures,
    row.edgesPerSignature.toFixed(2),
    row.similarity.toFixed(2),
    row.legacy,
  ].join('\t'));
}
console.log('');
console.log('states=' + result.summary.states +
  ' edges=' + result.summary.edges +
  ' medianSignatures=' + result.summary.medianSignaturesPerState.toFixed(2) +
  ' medianSimilarity(busy)=' + result.summary.medianSimilarityAmongBusyStates.toFixed(2));
console.log('verdict=' + result.summary.verdict);