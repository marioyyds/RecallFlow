import {
  buildTraceGraphLayout,
  distanceToTraceGraphEdge,
  moveTraceGraphEdge,
  moveTraceGraphNode,
  type TraceGraphLayout,
  type TraceGraphLayoutEdge,
  type TraceGraphLayoutNode,
  type TraceGraphView,
} from './tracegraph-view.ts';

interface CanvasTheme {
  background: string;
  card: string;
  border: string;
  primary: string;
  primarySoft: string;
  text: string;
  textSub: string;
  textFaint: string;
  danger: string;
}

interface CanvasScene {
  view: TraceGraphView | null;
  layout: TraceGraphLayout | null;
  x: number;
  y: number;
  scale: number;
  selectedNode: string | null;
  selectedEdgeId: string | null;
  drag: null | {
    mode: 'pan' | 'node' | 'edge';
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    nodeName?: string;
    nodeStartX?: number;
    nodeStartY?: number;
    edgeId?: string;
    edgeStartOffset?: number;
  };
}

export interface TraceGraphCanvasCallbacks {
  onSelectNode(node: TraceGraphLayoutNode, layout: TraceGraphLayout): void;
  onSelectEdge(edge: TraceGraphLayoutEdge, layout: TraceGraphLayout): void;
  onClearSelection(): void;
}

export interface TraceGraphCanvasController {
  render(view: TraceGraphView): void;
  clear(): void;
  fit(resetScale?: boolean): void;
  zoom(factor: number, anchorX?: number, anchorY?: number): void;
  selectEdge(edgeId: string): boolean;
  selectNode(nodeName: string): boolean;
  clearSelection(): void;
  getLayout(): TraceGraphLayout | null;
}

const MIN_SCALE = 0.28;
const MAX_SCALE = 3.2;

function color(style: CSSStyleDeclaration, key: string, fallback: string): string {
  return style.getPropertyValue(key).trim() || fallback;
}

function themeFor(host: HTMLElement): CanvasTheme {
  const style = getComputedStyle(host);
  return {
    background: color(style, '--bg', '#fff'),
    card: color(style, '--card', '#fff'),
    border: color(style, '--border', '#d8dde6'),
    primary: color(style, '--primary', '#4a90d9'),
    primarySoft: color(style, '--primary-soft', 'rgba(74,144,217,.12)'),
    text: color(style, '--text', '#1f2937'),
    textSub: color(style, '--text-sub', '#4b5563'),
    textFaint: color(style, '--text-faint', '#6b7280'),
    danger: color(style, '--danger', '#e74c3c'),
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function edgeColor(edge: TraceGraphLayoutEdge, theme: CanvasTheme): string {
  if (edge.risk === 'high') return theme.danger;
  if (edge.risk === 'medium') return '#d97706';
  return theme.primary;
}

function curvePoint(
  curve: TraceGraphLayoutEdge['curve'],
  t: number
): { x: number; y: number } {
  const inverse = 1 - t;
  return {
    x:
      inverse ** 3 * curve.x1 +
      3 * inverse ** 2 * t * curve.c1x +
      3 * inverse * t ** 2 * curve.c2x +
      t ** 3 * curve.x2,
    y:
      inverse ** 3 * curve.y1 +
      3 * inverse ** 2 * t * curve.c1y +
      3 * inverse * t ** 2 * curve.c2y +
      t ** 3 * curve.y2,
  };
}

function drawArrow(
  context: CanvasRenderingContext2D,
  edge: TraceGraphLayoutEdge,
  colorValue: string
) {
  const before = curvePoint(edge.curve, 0.985);
  const tip = curvePoint(edge.curve, 1);
  const angle = Math.atan2(tip.y - before.y, tip.x - before.x);
  const size = 8;
  context.beginPath();
  context.moveTo(tip.x, tip.y);
  context.lineTo(
    tip.x - Math.cos(angle - 0.48) * size,
    tip.y - Math.sin(angle - 0.48) * size
  );
  context.lineTo(
    tip.x - Math.cos(angle + 0.48) * size,
    tip.y - Math.sin(angle + 0.48) * size
  );
  context.closePath();
  context.fillStyle = colorValue;
  context.fill();
}

export function createTraceGraphCanvas(
  host: HTMLElement,
  callbacks: TraceGraphCanvasCallbacks
): TraceGraphCanvasController {
  let canvas: HTMLCanvasElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeFrame = 0;
  let bound = false;
  const scene: CanvasScene = {
    view: null,
    layout: null,
    x: 0,
    y: 0,
    scale: 1,
    selectedNode: null,
    selectedEdgeId: null,
    drag: null,
  };

  function ensureCanvas(): HTMLCanvasElement {
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.className = 'tracegraph-interactive-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    canvas.setAttribute(
      'aria-label',
      '可交互 TraceGraph。拖动背景平移，滚轮缩放，拖动节点调整布局，点击边查看详情。'
    );
    host.replaceChildren(canvas);
    bindInteractions();
    return canvas;
  }

  function screenPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = host.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function worldPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const point = screenPoint(event);
    const viewBox = scene.layout?.viewBox || { x: 0, y: 0 };
    return {
      x: (point.x - scene.x) / scene.scale + viewBox.x,
      y: (point.y - scene.y) / scene.scale + viewBox.y,
    };
  }

  function nodeAt(point: { x: number; y: number }): TraceGraphLayoutNode | null {
    const nodes = scene.layout?.nodes || [];
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      if (
        point.x >= node.x &&
        point.x <= node.x + node.width &&
        point.y >= node.y &&
        point.y <= node.y + node.height
      ) {
        return node;
      }
    }
    return null;
  }

  function edgeAt(point: { x: number; y: number }): TraceGraphLayoutEdge | null {
    const edges = scene.layout?.edges || [];
    const threshold = 11 / Math.max(0.5, scene.scale);
    let nearest: TraceGraphLayoutEdge | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const edge of edges) {
      const distance = distanceToTraceGraphEdge(edge, point);
      if (distance <= threshold && distance < nearestDistance) {
        nearest = edge;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  function resizeBitmap() {
    const current = ensureCanvas();
    const width = Math.max(1, Math.floor(host.clientWidth));
    const height = Math.max(1, Math.floor(host.clientHeight));
    const ratio = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    current.width = Math.floor(width * ratio);
    current.height = Math.floor(height * ratio);
    current.style.width = width + 'px';
    current.style.height = height + 'px';
  }

  function draw() {
    if (!scene.layout) return;
    const current = ensureCanvas();
    resizeBitmap();
    const context = current.getContext('2d');
    if (!context) return;
    const ratio = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    const theme = themeFor(host);
    host.dataset.canvasX = String(scene.x);
    host.dataset.canvasY = String(scene.y);
    host.dataset.zoom = String(scene.scale);
    host.dataset.viewBoxX = String(scene.layout.viewBox.x);
    host.dataset.viewBoxY = String(scene.layout.viewBox.y);
    host.dataset.viewBoxWidth = String(scene.layout.viewBox.width);
    host.dataset.viewBoxHeight = String(scene.layout.viewBox.height);
    host.dataset.nodeCount = String(scene.layout.nodes.length);
    host.dataset.edgeCount = String(scene.layout.edges.length);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, host.clientWidth, host.clientHeight);
    context.save();
    context.translate(scene.x, scene.y);
    context.scale(scene.scale, scene.scale);
    context.translate(-scene.layout.viewBox.x, -scene.layout.viewBox.y);

    const selectedNode = scene.layout.nodes.find(
      (node) => node.name === scene.selectedNode
    ) || null;
    const relatedNodes = new Set<string>();
    const relatedEdges = new Set<string>();
    if (selectedNode) {
      relatedNodes.add(selectedNode.name);
      for (const edge of scene.layout.edges) {
        if (edge.from === selectedNode.name || edge.to === selectedNode.name) {
          relatedNodes.add(edge.from);
          relatedNodes.add(edge.to);
          relatedEdges.add(edge.id);
        }
      }
    }
    const selectedEdge = scene.layout.edges.find(
      (edge) => edge.id === scene.selectedEdgeId
    ) || null;
    if (selectedEdge) {
      relatedNodes.add(selectedEdge.from);
      relatedNodes.add(selectedEdge.to);
    }
    const hasSelection = Boolean(selectedNode || selectedEdge);

    for (const edge of scene.layout.edges) {
      const related = selectedEdge
        ? edge.id === selectedEdge.id
        : !selectedNode || relatedEdges.has(edge.id);
      context.globalAlpha = hasSelection && !related ? 0.16 : 1;
      const stroke = edgeColor(edge, theme);
      context.beginPath();
      context.moveTo(edge.curve.x1, edge.curve.y1);
      context.bezierCurveTo(
        edge.curve.c1x,
        edge.curve.c1y,
        edge.curve.c2x,
        edge.curve.c2y,
        edge.curve.x2,
        edge.curve.y2
      );
      context.strokeStyle = edge.status === 'verified' ? stroke : theme.textFaint;
      context.lineWidth =
        selectedEdge?.id === edge.id ? 3.4 : related && hasSelection ? 2.5 : 1.7;
      context.setLineDash(edge.status === 'verified' ? [] : [6, 5]);
      context.stroke();
      context.setLineDash([]);
      drawArrow(context, edge, edge.status === 'verified' ? stroke : theme.textFaint);

      const target = edge.targetLabel
        ? ' · ' + truncate(edge.targetLabel, 20)
        : '';
      const lane = edge.parallelCount > 1
        ? ' ' + (edge.parallelIndex + 1) + '/' + edge.parallelCount
        : '';
      const label = truncate(edge.tool + target + lane, 38);
      context.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
      const metrics = context.measureText(label);
      const paddingX = 4;
      const labelX = edge.labelX - metrics.width / 2 - paddingX;
      const labelY = edge.labelY - 10;
      context.globalAlpha = hasSelection && !related ? 0.12 : 0.94;
      context.fillStyle = theme.background;
      context.fillRect(labelX, labelY, metrics.width + paddingX * 2, 14);
      context.fillStyle = theme.textSub;
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillText(label, labelX + paddingX, edge.labelY - 3);
    }

    for (const node of scene.layout.nodes) {
      const selected = node.name === scene.selectedNode;
      const related = !hasSelection || relatedNodes.has(node.name);
      context.globalAlpha = hasSelection && !related ? 0.2 : 1;
      context.save();
      context.shadowColor = 'rgba(15, 23, 42, .12)';
      context.shadowBlur = selected ? 12 : 6;
      context.shadowOffsetY = 3;
      roundedRect(context, node.x, node.y, node.width, node.height, 12);
      context.fillStyle = selected ? theme.primarySoft : theme.card;
      context.fill();
      context.restore();
      roundedRect(context, node.x, node.y, node.width, node.height, 12);
      context.strokeStyle = selected ? theme.primary : theme.border;
      context.lineWidth = selected ? 2.4 : 1.2;
      context.stroke();

      context.fillStyle = theme.text;
      context.font = '650 12px "Segoe UI", "Microsoft YaHei", sans-serif';
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillText(truncate(node.name, 23), node.x + 13, node.y + 22, node.width - 26);
      context.fillStyle = theme.textFaint;
      context.font = '10px "Segoe UI", "Microsoft YaHei", sans-serif';
      context.fillText(
        '入 ' + node.incoming + ' · 出 ' + node.outgoing,
        node.x + 13,
        node.y + 42,
        node.width - 26
      );
    }
    context.restore();
  }

  function fit(resetScale = false) {
    if (!scene.layout) return;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    const viewBox = scene.layout.viewBox;
    const fitScale = Math.min(
      1,
      Math.max(0.2, (width - 42) / viewBox.width),
      Math.max(0.2, (height - 42) / viewBox.height)
    );
    if (
      resetScale ||
      !Number.isFinite(scene.scale) ||
      scene.scale < MIN_SCALE ||
      scene.scale > MAX_SCALE
    ) {
      scene.scale = Math.max(MIN_SCALE, fitScale);
    }
    scene.x = (width - viewBox.width * scene.scale) / 2 - viewBox.x * scene.scale;
    scene.y = (height - viewBox.height * scene.scale) / 2 - viewBox.y * scene.scale;
    host.dataset.zoom = String(scene.scale);
    const level = document.getElementById('tracegraph-zoom-level');
    if (host.id === 'tracegraph-dialog-canvas' && level) {
      level.textContent = Math.round(scene.scale * 100) + '%';
    }
    draw();
  }

  function zoom(
    factor: number,
    anchorX = host.clientWidth / 2,
    anchorY = host.clientHeight / 2
  ) {
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scene.scale * factor));
    if (Math.abs(next - scene.scale) < 0.001) return;
    const worldX = (anchorX - scene.x) / scene.scale;
    const worldY = (anchorY - scene.y) / scene.scale;
    scene.scale = next;
    scene.x = anchorX - worldX * next;
    scene.y = anchorY - worldY * next;
    const level = document.getElementById('tracegraph-zoom-level');
    if (host.id === 'tracegraph-dialog-canvas' && level) {
      level.textContent = Math.round(scene.scale * 100) + '%';
    }
    host.dataset.zoom = String(scene.scale);
    draw();
  }

  function selectNode(nodeName: string): boolean {
    if (!scene.layout) return false;
    const node = scene.layout.nodes.find((item) => item.name === nodeName);
    if (!node) return false;
    scene.selectedNode = node.name;
    scene.selectedEdgeId = null;
    draw();
    callbacks.onSelectNode(node, scene.layout);
    return true;
  }

  function selectEdge(edgeId: string): boolean {
    if (!scene.layout) return false;
    const edge = scene.layout.edges.find((item) => item.id === edgeId);
    if (!edge) return false;
    scene.selectedNode = null;
    scene.selectedEdgeId = edge.id;
    draw();
    callbacks.onSelectEdge(edge, scene.layout);
    return true;
  }

  function clearSelection() {
    scene.selectedNode = null;
    scene.selectedEdgeId = null;
    draw();
    callbacks.onClearSelection();
  }

  function bindInteractions() {
    if (bound) return;
    bound = true;
    host.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !canvas) return;
      const point = worldPoint(event);
      const node = nodeAt(point);
      const edge = node ? null : edgeAt(point);
      scene.drag = {
        mode: node ? 'node' : edge ? 'edge' : 'pan',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        ...(node
          ? { nodeName: node.name, nodeStartX: node.x, nodeStartY: node.y }
          : edge
            ? { edgeId: edge.id, edgeStartOffset: edge.laneOffset }
            : {}),
      };
      host.classList.toggle('is-panning', scene.drag.mode === 'pan');
      host.classList.toggle('is-node-dragging', scene.drag.mode === 'node');
      canvas.setPointerCapture?.(event.pointerId);
      canvas.focus();
      event.preventDefault();
    });

    host.addEventListener('pointermove', (event) => {
      if (!scene.drag) {
        const node = nodeAt(worldPoint(event));
        const edge = node ? null : edgeAt(worldPoint(event));
        host.classList.toggle('has-interactive-target', Boolean(node || edge));
        return;
      }
      const drag = scene.drag;
      const dx = event.clientX - drag.lastX;
      const dy = event.clientY - drag.lastY;
      if (Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY) > 3) {
        drag.moved = true;
      }
      if (drag.mode === 'pan') {
        scene.x += dx;
        scene.y += dy;
        draw();
      } else if (drag.mode === 'node' && drag.nodeName && scene.layout) {
        const worldDX = (event.clientX - drag.startX) / scene.scale;
        const worldDY = (event.clientY - drag.startY) / scene.scale;
        scene.layout = moveTraceGraphNode(
          scene.layout,
          drag.nodeName,
          Number(drag.nodeStartX || 0) + worldDX,
          Number(drag.nodeStartY || 0) + worldDY
        );
        draw();
      } else if (drag.mode === 'edge' && drag.edgeId && scene.layout) {
        const worldDY = (event.clientY - drag.startY) / scene.scale;
        scene.layout = moveTraceGraphEdge(
          scene.layout,
          drag.edgeId,
          Number(drag.edgeStartOffset || 0) + worldDY
        );
        draw();
      }
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
    });

    const finish = (event: PointerEvent) => {
      const drag = scene.drag;
      if (!drag) return;
      scene.drag = null;
      host.classList.remove('is-panning', 'is-node-dragging');
      canvas?.releasePointerCapture?.(event.pointerId);
      if (drag.mode === 'node' && drag.nodeName) {
        selectNode(drag.nodeName);
      } else if (drag.mode === 'edge' && drag.edgeId) {
        selectEdge(drag.edgeId);
      } else if (drag.mode === 'pan' && !drag.moved) {
        clearSelection();
      }
    };
    host.addEventListener('pointerup', finish);
    host.addEventListener('pointercancel', (event) => {
      scene.drag = null;
      host.classList.remove('is-panning', 'is-node-dragging');
      canvas?.releasePointerCapture?.(event.pointerId);
    });
    host.addEventListener('wheel', (event) => {
      event.preventDefault();
      const point = screenPoint(event);
      zoom(Math.exp(-event.deltaY * 0.0014), point.x, point.y);
    }, { passive: false });
    host.addEventListener('dblclick', (event) => {
      const point = worldPoint(event);
      if (nodeAt(point) || edgeAt(point)) return;
      fit(true);
    });
    host.addEventListener('keydown', (event) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoom(1.2);
      } else if (event.key === '-') {
        event.preventDefault();
        zoom(1 / 1.2);
      } else if (event.key === '0') {
        event.preventDefault();
        fit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearSelection();
      }
    });
  }

  function render(view: TraceGraphView) {
    scene.view = view;
    scene.layout = buildTraceGraphLayout(view);
    scene.selectedNode = null;
    scene.selectedEdgeId = null;
    ensureCanvas();
    if (!resizeObserver && typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(() => draw());
      });
      resizeObserver.observe(host);
    }
    requestAnimationFrame(() => fit(true));
  }

  function clear() {
    if (canvas) canvas.remove();
    canvas = null;
    scene.view = null;
    scene.layout = null;
    scene.selectedNode = null;
    scene.selectedEdgeId = null;
  }

  return {
    render,
    clear,
    fit,
    zoom,
    selectEdge,
    selectNode,
    clearSelection,
    getLayout: () => scene.layout,
  };
}
