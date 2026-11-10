import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  buildTraceGraphLayout,
  distanceToTraceGraphEdge,
  formatTraceGraphAge,
  moveTraceGraphEdge,
  moveTraceGraphNode,
  traceGraphCurvePoint,
  parseTraceGraphView,
} from '../../lib/ui/options/tracegraph-view.ts';
import { createTraceGraphCanvas } from '../../lib/ui/options/tracegraph-canvas.ts';

function graph(overrides = {}) {
  return {
    version: 2,
    siteKey: 'https://example.com',
    updatedAt: 1_000_000,
    ttlMs: 60_000,
    l0: {
      states: [
        {
          id: 's.1',
          name: 'ProductPage',
          urlPattern: '/*.html',
          staticAtoms: ['button', 'input:text'],
          dynamicAtoms: [],
        },
        {
          id: 's.2',
          name: 'CartPage',
          urlPattern: '/checkout/cart',
          staticAtoms: ['button'],
          dynamicAtoms: [],
        },
      ],
      operations: [],
    },
    l1: {
      edges: [
        {
          id: 'e.1',
          from: 'ProductPage',
          to: 'CartPage',
          g: '点击 Add to Cart',
          action: {
            tool: 'click_element',
            argsTemplate: { selector: '#add' },
            risk: 'low',
          },
          slots: [],
          s: { semanticAnchor: { name: 'Add to Cart' } },
          r: 'low',
          phiMinus: [{ kind: 'url_pattern', expr: '/*.html', source: 'structured' }],
          phiPlus: { kind: 'url_pattern', expr: '/checkout/cart', source: 'structured' },
          provenance: {
            recordIds: ['r.1'],
            verifiedAt: 1_000_000,
            siteKey: 'https://example.com',
            ttlMs: 60_000,
          },
          status: 'verified',
        },
      ],
    },
    records: [{ id: 'r.1' }],
    patchLog: [],
    ...overrides,
  };
}

test('Canvas 渲染器可创建且不依赖 SVG', () => {
  assert.equal(typeof createTraceGraphCanvas, 'function');
  const css = fs.readFileSync('options.css', 'utf8');
  assert.doesNotMatch(css, /\.tracegraph-svg|\.tg-node|\.tg-edge-path/);
});

test('TraceGraph visualization parses display data and age', () => {
  const view = parseTraceGraphView(graph(), 1_030_000);
  assert.ok(view);
  assert.equal(view.siteKey, 'https://example.com');
  assert.equal(view.states.length, 2);
  assert.equal(view.edges.length, 1);
  assert.equal(view.edges[0].tool, 'click_element');
  assert.equal(view.edges[0].recordCount, 1);
  assert.equal(formatTraceGraphAge(view.ageMs), '30 秒前');
});

test('TraceGraph visualization rejects malformed storage data', () => {
  assert.equal(parseTraceGraphView(null), null);
  assert.equal(parseTraceGraphView({ version: 1 }), null);
  assert.equal(parseTraceGraphView({ version: 2, siteKey: '', l0: {}, l1: {} }), null);
});

test('TraceGraph layout is deterministic and tolerates cycles', () => {
  const raw = graph();
  raw.l0.states.push({
    id: 's.3',
    name: 'SearchPage',
    urlPattern: '/search',
    staticAtoms: ['input:text'],
    dynamicAtoms: [],
  });
  raw.l1.edges.push(
    {
      ...raw.l1.edges[0],
      id: 'e.2',
      from: 'CartPage',
      to: 'ProductPage',
    },
    {
      ...raw.l1.edges[0],
      id: 'e.3',
      from: 'SearchPage',
      to: 'ProductPage',
    }
  );
  const view = parseTraceGraphView(raw, 1_030_000);
  assert.ok(view);
  const first = buildTraceGraphLayout(view);
  const second = buildTraceGraphLayout(view);
  assert.deepEqual(first, second);
  assert.equal(first.nodes.length, 3);
  assert.equal(first.edges.length, 3);
  assert.ok(first.width >= 620);
  assert.ok(first.height >= 280);
  assert.ok(first.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.ok(first.edges.every((edge) => edge.path.startsWith('M ')));
  const movedNode = moveTraceGraphNode(
    first,
    first.nodes[0].name,
    first.nodes[0].x + 70,
    first.nodes[0].y + 28
  );
  assert.ok(
    movedNode.edges.some(
      (edge, index) =>
        JSON.stringify(edge.curve) !== JSON.stringify(first.edges[index].curve)
    )
  );
  const movedEdge = moveTraceGraphEdge(movedNode, movedNode.edges[0].id, 48);
  assert.equal(movedEdge.edges[0].laneOffset, 48);
  const midpoint = traceGraphCurvePoint(movedEdge.edges[0].curve, 0.5);
  assert.ok(distanceToTraceGraphEdge(movedEdge.edges[0], midpoint) < 1);
  const pathPoints = first.edges.flatMap((edge) => {
    const values = (edge.path.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    return Array.from({ length: Math.floor(values.length / 2) }, (_, index) => ({
      x: values[index * 2],
      y: values[index * 2 + 1],
    }));
  });
  assert.ok(pathPoints.every((point) =>
    point.x >= first.viewBox.x &&
    point.x <= first.viewBox.x + first.viewBox.width &&
    point.y >= first.viewBox.y &&
    point.y <= first.viewBox.y + first.viewBox.height
  ));
});

test('TraceGraph 将同一对状态的平行边分配到不同视觉通道', () => {
  const raw = graph();
  raw.l1.edges.push({
    ...raw.l1.edges[0],
    id: 'e.parallel',
    g: '用搜索词打开购物车',
  });
  const view = parseTraceGraphView(raw, 1_030_000);
  assert.ok(view);
  const layout = buildTraceGraphLayout(view);
  assert.equal(layout.edges.length, 2);
  assert.equal(layout.edges[0].parallelCount, 2);
  assert.equal(layout.edges[1].parallelCount, 2);
  assert.notEqual(layout.edges[0].parallelIndex, layout.edges[1].parallelIndex);
  assert.notEqual(layout.edges[0].path, layout.edges[1].path);
  assert.notEqual(layout.edges[0].labelY, layout.edges[1].labelY);
});

test('设置页包含 TraceGraph 可视化落点与响应式布局', () => {
  const html = fs.readFileSync('options.html', 'utf8');
  const css = fs.readFileSync('options.css', 'utf8');
  for (const id of [
    'tracegraph-site-select',
    'tracegraph-refresh',
    'tracegraph-view-summary',
    'tracegraph-canvas',
    'tracegraph-detail',
  ]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /class="tracegraph-zoom-fab"/);
  assert.match(html, /aria-label="放大查看 TraceGraph"/);
  assert.match(html, /id="tracegraph-delete-site"/);
  assert.match(html, /画布 \/ 节点 \/ 边均可拖动/);
  assert.match(css, /\.tracegraph-frame\s*\{[^}]*grid-template-columns:/s);
  assert.match(css, /\.tracegraph-zoom-fab\s*\{[^}]*background:\s*#e5484d/s);
  assert.match(css, /\.tracegraph-interactive-canvas\s*\{[^}]*touch-action:\s*none/s);
  assert.match(
    css,
    /\.tracegraph-canvas\.is-node-dragging \.tracegraph-interactive-canvas\s*\{[^}]*cursor:\s*move/s
  );
  assert.match(css, /@media \(max-width:\s*620px\)[\s\S]*\.tracegraph-frame\s*\{[^}]*grid-template-columns:\s*1fr/s);
});
