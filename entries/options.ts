// 设置页（API Key/模型/RAG/工具审批/快捷语句/MCP）
import {
  AI_SETTINGS_KEY,
  AI_SETTINGS_DEFAULTS,
  JEV_SETTINGS_DEFAULTS,
  getAISettings,
  mergeJevSettings,
  mergeTraceGraphSettings,
  resolveCodeExecutionApproval,
} from '../lib/shared/settings.ts';
import { esc } from '../lib/shared/dom/html.ts';
import { getUserscriptSettings, saveUserscriptSettings } from '../lib/userscript/settings.ts';
import { USERSCRIPTS_KEY } from '../lib/userscript/store.ts';
// 复用后台那一套握手（initialize → notifications/initialized → tools/list），
// 这样「设置页显示的结果」与「Agent 真正连的结果」是同一份代码，不会各说各话。
import { probeMcpServer, MCP_STATUS_STORAGE_KEY } from '../lib/application/agent/mcp.ts';
import { probeJevConnection } from '../lib/application/agent/jev-client.ts';
import { TRACE_GRAPH_KEY } from '../lib/application/agent/trace-graph-types.ts';
import {
  readJevDiagnostic,
  type JevDiagnosticRecord,
} from '../lib/application/agent/jev-diagnostics.ts';
import {
  formatTraceGraphAge,
  parseTraceGraphView,
  type TraceGraphLayout,
  type TraceGraphLayoutEdge,
  type TraceGraphLayoutNode,
  type TraceGraphView,
} from '../lib/ui/options/tracegraph-view.ts';
import {
  createTraceGraphCanvas,
  type TraceGraphCanvasController,
} from '../lib/ui/options/tracegraph-canvas.ts';

/** MCP 服务器配置 / 最近连接结果：字段由 mcp.js 与设置页共同约定。 */
type Dyn = Record<string, any>;

/** 按 id 取元素：id 全部写死在 options.html 里（取不到就是模板坏了，原代码也不检查）。 */
const $ = (id: string): any => document.getElementById(id);

/** 在某个子树里取元素（MCP 行是运行时拼出来的，没有 id）。 */
const $q = (root: Element | Document, selector: string): any => root.querySelector(selector);

let settingsDirty = false;
let settingsLoading = true;
let jevLastDiagnostic: JevDiagnosticRecord | null = null;
let traceGraphViews: TraceGraphView[] = [];

const traceGraphCanvasControllers = new WeakMap<
  HTMLElement,
  TraceGraphCanvasController
>();

async function load() {
  const s = await getAISettings();
  $('api-key').value = s.apiKey;
  $('model').value = s.model;
  $('base-url').value = s.baseUrl;
  $('jev-enabled').checked = s.jev.enabled;
  $('jev-shadow-mode').checked = s.jev.shadowMode;
  $('jev-base-url').value = s.jev.baseUrl;
  $('jev-api-key').value = s.jev.apiKey;
  $('jev-model').value = s.jev.model;
  $('jev-timeout').value = String(s.jev.requestTimeoutMs);
  $('jev-retries').value = String(s.jev.maxRetries);
  $('jev-max-attempts').value = String(s.jev.maxAttemptsPerRun);
  $('jev-max-actions').value = String(s.jev.maxConsecutiveActions);
  $('jev-max-repeated').value = String(s.jev.maxRepeatedActionsWithoutProgress);
  $('jev-max-candidates').value = String(s.jev.maxElementCandidates);
  $('jev-min-edge-confidence').value = String(s.jev.minEdgeConfidence);
  $('jev-schema-version').value = s.jev.schemaVersion;
  $('tracegraph-enabled').checked = s.traceGraph?.enabled === true;
  $('tracegraph-mode').value = s.traceGraph?.mode === 'live' ? 'live' : 'record';
  $('tracegraph-shadow-mode').checked = s.traceGraph?.shadowMode !== false;
  jevLastDiagnostic = await readJevDiagnostic();
  renderJevRuntimeStatus();
  await migrateTraceGraphEdges();
  await refreshTraceGraphExplorer();
  $('rag-enabled').checked = !!s.ragEnabled;
  $('target-lang').value = s.targetLang;
  $('page-context').checked = s.pageContext !== false;
  $('cdp-enabled').checked = s.cdpEnabled !== false;
  $('site-memory').checked = s.siteMemoryEnabled !== false;
  $('verifier-enabled').checked = s.verifierEnabled !== false;
  $('trusted-sites').value = (s.trustedSites || []).join('\n');
  $('tool-approval').checked = s.toolApproval !== false;
  const policy = Object.assign({ read: true, edit: false, commands: false, browser: false, mcp: false }, s.toolApprovalPolicy || {});
  ['read', 'edit', 'commands', 'browser', 'mcp'].forEach((k) => { $('approval-' + k).checked = !!(policy as Record<string, unknown>)[k]; });
  $('approval-notify').checked = s.toolApprovalNotify !== false;
  $('code-exec-approval').value = resolveCodeExecutionApproval(s);
  // 桥接 token：回填真实值，便于用户与 server 端环境变量核对/修改。
  $('bridge-token').value = s.bridgeToken || '';
  syncApprovalPreset();
  const budget: Dyn = (s.agentBudget || {}) as Dyn;
  // 工具调用次数与推理轮数上限已移除（对齐 DSH：不限制做了多少件事），
  // 因此那两个输入框不再存在 —— 留一个没人读的设置就是"静默无效"。
  $('budget-tokens').value = Number.isInteger(Number(budget.maxTotalTokens)) && Number(budget.maxTotalTokens) > 0 ? String(budget.maxTotalTokens) : '';
  $('quick-prompts').value = (s.quickPrompts || AI_SETTINGS_DEFAULTS.quickPrompts).join('\n');
  await loadMcpStatus();
  renderMcp(s.mcpServers || []);

  const us = await getUserscriptSettings();
  $('us-agent-install').checked = us.agentCanInstall !== false;
  $('us-auto-update').checked = !!us.autoCheckUpdates;
  $('us-run-at').value = us.defaultRunAt || 'document-idle';
  renderUserscriptSummary();
  settingsLoading = false;
  setDirty(false);
  initSettingsNav();
}

function renderJevRuntimeStatus() {
  const el = $('jev-runtime-status');
  if (!el) return;
  const enabled = $('jev-enabled').checked;
  const shadow = $('jev-shadow-mode').checked;
  if (!enabled) {
    el.className = 'connection-status error';
    el.textContent = 'JEV 未启用：快思考不会发起任何请求。';
    return;
  }
  let current =
    shadow
      ? '当前为影子模式：JEV 只给出建议，不会执行工具。关闭影子模式后才会进入实际快路径。'
      : '当前为实际执行模式。';
  let className = shadow ? 'connection-status warn' : 'connection-status ok';
  if (!jevLastDiagnostic) {
    el.className = className;
    el.textContent = current + ' 尚未收到 JEV 运行记录。';
    return;
  }
  const d = jevLastDiagnostic;
  const when = d.updatedAt ? new Date(d.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '';
  const attempts = Number.isFinite(Number(d.attempts)) ? '第 ' + d.attempts + ' 次尝试' : '最近一次';
  let latest = '';
  if (d.state === 'act') {
    latest = '执行了 ' + (d.tool || d.outcome || '快动作') + (d.failed ? '，但工具失败' : '');
    className = 'connection-status ' + (d.failed ? 'error' : 'ok');
  } else if (d.state === 'handoff') {
    latest = '已移交慢思考' + (d.reason ? '：' + d.reason : '');
    className = 'connection-status warn';
  } else if (d.state === 'error') {
    latest = '运行失败' + (d.reason ? '：' + d.reason : '');
    className = 'connection-status error';
  } else if (d.state === 'deciding') {
    latest = '正在等待结构化决策';
    className = 'connection-status';
  } else {
    latest = '影子建议：' + (d.tool || d.reason || d.outcome || '无动作');
    className = 'connection-status warn';
  }
  el.className = className;
  el.textContent =
    current + ' 最近运行' + (when ? '（' + when + '）' : '：') + attempts + ' · ' + latest + '。';
}

function formatTraceGraphTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '未知时间';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function traceGraphTargets(expanded = false): {
  canvas: HTMLElement | null;
  detail: HTMLElement | null;
} {
  return expanded
    ? {
        canvas: $('tracegraph-dialog-canvas'),
        detail: $('tracegraph-dialog-detail'),
      }
    : {
        canvas: $('tracegraph-canvas'),
        detail: $('tracegraph-detail'),
      };
}

function selectedTraceGraphView(): TraceGraphView | null {
  const select = $('tracegraph-site-select') as HTMLSelectElement | null;
  if (!select) return null;
  return traceGraphViews.find((item) => item.siteKey === select.value) || null;
}

function traceGraphCanvasController(
  canvas: HTMLElement
): TraceGraphCanvasController {
  const existing = traceGraphCanvasControllers.get(canvas);
  if (existing) return existing;
  const controller = createTraceGraphCanvas(canvas, {
    onSelectNode(node, layout) {
      renderTraceGraphNodeDetail(canvas, node, layout);
    },
    onSelectEdge(edge) {
      renderTraceGraphEdgeDetail(canvas, edge);
    },
    onClearSelection() {
      renderTraceGraphCanvasHint(canvas);
    },
  });
  traceGraphCanvasControllers.set(canvas, controller);
  return controller;
}

async function refreshTraceGraphExplorer() {
  const canvas = $('tracegraph-canvas');
  const summary = $('tracegraph-view-summary');
  const select = $('tracegraph-site-select') as HTMLSelectElement;
  if (!canvas || !summary || !select) return;
  summary.className = 'tracegraph-summary';
  summary.textContent = '正在读取本地 TraceGraph…';
  try {
    const stored = await chrome.storage.local.get(TRACE_GRAPH_KEY);
    const all = stored?.[TRACE_GRAPH_KEY];
    const records = all && typeof all === 'object' && !Array.isArray(all)
      ? Object.values(all)
      : [];
    traceGraphViews = records
      .map((item) => parseTraceGraphView(item))
      .filter((item): item is TraceGraphView => Boolean(item))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const previous = select.value;
    select.replaceChildren();
    if (!traceGraphViews.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '暂无图';
      select.appendChild(option);
      select.disabled = true;
      const expand = $('tracegraph-expand') as HTMLButtonElement | null;
      if (expand) expand.disabled = true;
      const remove = $('tracegraph-delete-site') as HTMLButtonElement | null;
      if (remove) remove.disabled = true;
      ($('tracegraph-dialog') as HTMLDialogElement | null)?.close();
      summary.className = 'tracegraph-summary empty';
      summary.textContent = '本地还没有可展示的 TraceGraph。开启录制并完成一次产生可验证变化的页面动作后，这里会显示状态和边。';
      renderTraceGraphEmpty('暂无轨迹图', '图数据只保存在本地浏览器，不会上传。');
      return;
    }
    for (const view of traceGraphViews) {
      const option = document.createElement('option');
      option.value = view.siteKey;
      option.textContent = view.siteKey;
      select.appendChild(option);
    }
    select.disabled = false;
    select.value = traceGraphViews.some((view) => view.siteKey === previous)
      ? previous
      : traceGraphViews[0].siteKey;
    renderSelectedTraceGraph();
  } catch (error) {
    summary.className = 'tracegraph-summary error';
    summary.textContent =
      '读取 TraceGraph 失败：' +
      (error instanceof Error ? error.message : String(error));
    renderTraceGraphEmpty('无法读取图数据', '请刷新设置页后重试。');
  }
}

async function migrateTraceGraphEdges() {
  try {
    await chrome.runtime.sendMessage({ type: 'tracegraph:rebuild' });
  } catch {
    // The read-only fallback still renders the stored graph if the worker is
    // unavailable; the next TraceGraph load will normalize it again.
  }
}

function renderTraceGraphEmpty(title: string, detail = '') {
  renderTraceGraphEmptyIn($('tracegraph-canvas'), $('tracegraph-detail'), title, detail);
}

function renderTraceGraphEmptyIn(
  canvas: HTMLElement | null,
  detailEl: HTMLElement | null,
  title: string,
  detail = ''
) {
  if (!canvas) return;
  const box = document.createElement('div');
  box.className = 'tracegraph-empty';
  const strong = document.createElement('strong');
  strong.textContent = title;
  box.appendChild(strong);
  if (detail) {
    const span = document.createElement('span');
    span.textContent = detail;
    box.appendChild(span);
  }
  canvas.replaceChildren(box);
  traceGraphCanvasControllers.get(canvas)?.clear();
  if (detailEl) {
    const empty = document.createElement('div');
    empty.className = 'tracegraph-detail-empty';
    empty.textContent = detail || '暂无可查看的状态。';
    detailEl.replaceChildren(empty);
  }
}

function renderSelectedTraceGraph() {
  const view = selectedTraceGraphView();
  const expand = $('tracegraph-expand') as HTMLButtonElement | null;
  const remove = $('tracegraph-delete-site') as HTMLButtonElement | null;
  if (!view) {
    if (expand) expand.disabled = true;
    if (remove) remove.disabled = true;
    ($('tracegraph-dialog') as HTMLDialogElement | null)?.close();
    renderTraceGraphEmpty('暂无可展示的图');
    return;
  }
  if (expand) expand.disabled = !view.states.length || !view.edges.length;
  if (remove) remove.disabled = false;
  const summary = $('tracegraph-view-summary');
  if (summary) {
    summary.className = 'tracegraph-summary active';
    summary.textContent = [
      '本地轨迹图',
      view.states.length + ' 个状态',
      view.edges.length + ' 条边',
      view.recordCount + ' 条原始记录',
      '更新于 ' + formatTraceGraphTime(view.updatedAt),
      formatTraceGraphAge(view.ageMs),
    ].join(' · ');
  }
  renderTraceGraph(view);
  const dialog = $('tracegraph-dialog') as HTMLDialogElement | null;
  if (dialog?.open) renderTraceGraph(view, true);
}

function renderTraceGraph(view: TraceGraphView, expanded = false) {
  const { canvas, detail } = traceGraphTargets(expanded);
  if (!canvas) return;
  if (!view.states.length || !view.edges.length) {
    const title = view.states.length ? '已有状态，但还没有可执行边' : '图里还没有状态';
    const hint = view.states.length
      ? '只有成功且产生可验证变化、同时属于可重放工具的动作，才会生成边。'
      : '继续执行页面动作后刷新；登录、支付和内网页不会构图。';
    renderTraceGraphEmptyIn(canvas, detail, title, hint);
    return;
  }
  traceGraphCanvasController(canvas).render(view);
  renderTraceGraphCanvasHint(canvas);
}

function traceGraphDetailFor(canvas: HTMLElement): HTMLElement | null {
  return canvas.id === 'tracegraph-dialog-canvas'
    ? $('tracegraph-dialog-detail')
    : $('tracegraph-detail');
}

function renderTraceGraphCanvasHint(canvas: HTMLElement) {
  const detail = traceGraphDetailFor(canvas);
  if (!detail) return;
  const layout = traceGraphCanvasControllers.get(canvas)?.getLayout();
  const empty = document.createElement('div');
  empty.className = 'tracegraph-detail-empty';
  empty.textContent = layout
    ? '画布已居中。拖动画布平移，滚轮缩放；拖动节点调整布局，拖动边调整弯曲度，点击节点或边查看详情。'
    : '拖动画布平移，滚轮缩放；点击节点或边查看详情。';
  detail.replaceChildren(empty);
  if (!layout?.nodes.length) return;
  const quick = document.createElement('div');
  quick.className = 'tracegraph-quick-select';
  const label = document.createElement('div');
  label.className = 'tracegraph-detail-section';
  label.textContent = '状态';
  quick.appendChild(label);
  for (const node of layout.nodes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tracegraph-quick-node';
    button.textContent = node.name;
    button.addEventListener('click', () => {
      traceGraphCanvasControllers.get(canvas)?.selectNode(node.name);
    });
    quick.appendChild(button);
  }
  detail.appendChild(quick);
}

function traceGraphEdgeRow(
  canvas: HTMLElement,
  edge: TraceGraphLayoutEdge
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'tracegraph-detail-edge';
  const head = document.createElement('div');
  head.className = 'tracegraph-detail-edge-row';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'tracegraph-detail-edge-title tracegraph-edge-select';
  title.textContent = edge.from + ' → ' + edge.to;
  title.addEventListener('click', () => {
    traceGraphCanvasControllers.get(canvas)?.selectEdge(edge.id);
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tracegraph-inline-delete';
  remove.textContent = '删除边';
  remove.addEventListener('click', () => {
    deleteTraceGraphSelection(
      { edgeIds: [edge.id] },
      '删除这条轨迹边？其对应录制证据也会一并移除。',
      remove
    ).catch(() => {});
  });
  head.append(title, remove);
  row.appendChild(head);
  const meta = document.createElement('div');
  meta.className = 'tracegraph-detail-edge-meta';
  meta.textContent = [
    edge.tool,
    edge.targetLabel ? '目标：' + edge.targetLabel : '',
    edge.risk,
    edge.status,
    edge.slots.length ? '@' + edge.slots.join(', @') : '无 slot',
    edge.recordCount + ' 条记录',
    edge.verifiedAt ? '验证于 ' + formatTraceGraphTime(edge.verifiedAt) : '',
  ].filter(Boolean).join(' · ');
  row.appendChild(meta);
  if (edge.goal) {
    const goal = document.createElement('div');
    goal.className = 'tracegraph-detail-edge-goal';
    goal.textContent = edge.goal;
    row.appendChild(goal);
  }
  const args = document.createElement('code');
  args.className = 'tracegraph-detail-edge-args';
  args.textContent = 'args ' + edge.argsTemplate;
  row.appendChild(args);
  return row;
}

function renderTraceGraphNodeDetail(
  canvas: HTMLElement,
  node: TraceGraphLayoutNode,
  layout: TraceGraphLayout
) {
  const detail = traceGraphDetailFor(canvas);
  if (!detail) return;
  const incident = layout.edges.filter((edge) => edge.from === node.name || edge.to === node.name);
  const head = document.createElement('div');
  head.className = 'tracegraph-detail-head';
  const name = document.createElement('strong');
  name.textContent = node.name;
  const badge = document.createElement('span');
  badge.className = 'tracegraph-detail-badge';
  badge.textContent = '入 ' + node.incoming + ' · 出 ' + node.outgoing;
  head.append(name, badge);
  detail.replaceChildren(head);

  const actions = document.createElement('div');
  actions.className = 'tracegraph-detail-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tracegraph-inline-delete';
  remove.textContent = '删除此节点';
  remove.disabled = incident.length === 0;
  remove.title = incident.length
    ? '删除节点及其全部入边、出边和对应录制证据'
    : '孤立节点可直接删除';
  remove.addEventListener('click', () => {
    deleteTraceGraphSelection(
      { stateNames: [node.name] },
      '删除节点“' + node.name + '”及其全部关联边？对应录制证据也会一并移除。',
      remove
    ).catch(() => {});
  });
  actions.appendChild(remove);
  detail.appendChild(actions);

  const facts = document.createElement('div');
  facts.className = 'tracegraph-detail-facts';
  for (const line of [
    node.urlPattern ? 'URL：' + node.urlPattern : 'URL：未记录',
    '静态 atom：' + node.staticAtoms + ' · 动态 atom：' + node.dynamicAtoms,
  ]) {
    const item = document.createElement('div');
    item.textContent = line;
    facts.appendChild(item);
  }
  detail.appendChild(facts);

  const edgeTitle = document.createElement('div');
  edgeTitle.className = 'tracegraph-detail-section';
  edgeTitle.textContent = incident.length ? '相关边（' + incident.length + '）' : '相关边';
  detail.appendChild(edgeTitle);
  if (!incident.length) {
    const empty = document.createElement('div');
    empty.className = 'tracegraph-detail-empty';
    empty.textContent = '这个状态目前没有已验证的入边或出边。';
    detail.appendChild(empty);
  }
  for (const edge of incident.slice(0, 12)) {
    detail.appendChild(traceGraphEdgeRow(canvas, edge));
  }
  if (incident.length > 12) {
    const more = document.createElement('div');
    more.className = 'tracegraph-detail-empty';
    more.textContent = '另有 ' + (incident.length - 12) + ' 条边未展开。';
    detail.appendChild(more);
  }
}

function renderTraceGraphEdgeDetail(
  canvas: HTMLElement,
  edge: TraceGraphLayoutEdge
) {
  const detail = traceGraphDetailFor(canvas);
  if (!detail) return;
  const head = document.createElement('div');
  head.className = 'tracegraph-detail-head';
  const title = document.createElement('strong');
  title.textContent = edge.from + ' → ' + edge.to;
  const badge = document.createElement('span');
  badge.className = 'tracegraph-detail-badge';
  badge.textContent = edge.tool;
  head.append(title, badge);
  detail.replaceChildren(head);

  const actions = document.createElement('div');
  actions.className = 'tracegraph-detail-actions';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'tracegraph-inline-delete';
  remove.textContent = '删除这条边';
  remove.addEventListener('click', () => {
    deleteTraceGraphSelection(
      { edgeIds: [edge.id] },
      '删除这条轨迹边？其对应录制证据也会一并移除。',
      remove
    ).catch(() => {});
  });
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'tracegraph-inline-secondary';
  back.textContent = '取消选择';
  back.addEventListener('click', () => {
    traceGraphCanvasControllers.get(canvas)?.clearSelection();
  });
  actions.append(remove, back);
  detail.appendChild(actions);

  const facts = document.createElement('div');
  facts.className = 'tracegraph-detail-facts';
  for (const line of [
    'edge：' + edge.id,
    '动作：' + edge.tool + ' · 风险：' + edge.risk,
    edge.targetLabel ? '语义目标：' + edge.targetLabel : '语义目标：未记录',
    'slots：' + (edge.slots.length ? '@' + edge.slots.join(', @') : '无'),
    '证据：' + edge.recordCount + ' 条 · ' + edge.status,
  ]) {
    const item = document.createElement('div');
    item.textContent = line;
    facts.appendChild(item);
  }
  detail.appendChild(facts);
  if (edge.goal) {
    const goal = document.createElement('div');
    goal.className = 'tracegraph-detail-edge-goal';
    goal.textContent = edge.goal;
    detail.appendChild(goal);
  }
  const args = document.createElement('code');
  args.className = 'tracegraph-detail-edge-args';
  args.textContent = 'args ' + edge.argsTemplate;
  detail.appendChild(args);
}

async function deleteTraceGraphSelection(
  selection: { edgeIds?: string[]; stateNames?: string[] },
  confirmation: string,
  trigger?: HTMLButtonElement
) {
  const view = selectedTraceGraphView();
  if (!view || !window.confirm(confirmation)) return;
  if (trigger) trigger.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'tracegraph:delete-selection',
      siteKey: view.siteKey,
      selection,
    });
    if (!response?.ok) throw new Error(response?.error || '删除失败');
    await refreshTraceGraphExplorer();
  } catch (error) {
    if (trigger) trigger.disabled = false;
    const summary = $('tracegraph-view-summary');
    if (summary) {
      summary.className = 'tracegraph-summary error';
      summary.textContent =
        '删除轨迹失败：' + (error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

async function deleteSelectedTraceGraph(trigger?: HTMLButtonElement) {
  const view = selectedTraceGraphView();
  if (!view || !window.confirm('删除 ' + view.siteKey + ' 的整张轨迹图？原始录制证据也会一并移除。')) {
    return;
  }
  if (trigger) trigger.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'tracegraph:delete-site',
      siteKey: view.siteKey,
    });
    if (!response?.ok) throw new Error(response?.error || '删除失败');
    await refreshTraceGraphExplorer();
  } catch (error) {
    if (trigger) trigger.disabled = false;
    const summary = $('tracegraph-view-summary');
    if (summary) {
      summary.className = 'tracegraph-summary error';
      summary.textContent =
        '删除轨迹图失败：' + (error instanceof Error ? error.message : String(error));
    }
  }
}

async function renderUserscriptSummary() {
  const meta = $('us-summary-meta');
  const navCount = $('us-nav-count');
  if (!meta && !navCount) return;
  try {
    const data = await chrome.storage.local.get(USERSCRIPTS_KEY);
    const map = data[USERSCRIPTS_KEY] || {};
    const list = Object.values(map);
    const enabled = list.filter((s) => s.enabled).length;
    if (meta) meta.textContent = `已安装 ${list.length} 个 · 启用 ${enabled} 个 · 停用 ${list.length - enabled} 个`;
    if (navCount) {
      navCount.textContent = String(list.length);
      navCount.classList.toggle('hidden', list.length === 0);
    }
  } catch (e) {
    if (meta) meta.textContent = '已安装 0 个 · 启用 0 个';
  }
}

// 最近一次连接结果（由后台 Agent 运行或本页「测试」写入），按 url|id 索引。
let mcpLastStatus = new Map<string, Dyn>();

function mcpKeyOf(s: Dyn | null | undefined): string {
  return (s && (s.url || '') + '|' + (s.id || '')) || '';
}

async function loadMcpStatus() {
  try {
    const data = await chrome.storage.local.get(MCP_STATUS_STORAGE_KEY);
    const rec = (data && data[MCP_STATUS_STORAGE_KEY]) as Dyn | undefined;
    mcpLastStatus = new Map<string, Dyn>(((rec && rec.servers) || []).map((st: Dyn) => [mcpKeyOf(st), st]));
  } catch (e) {
    mcpLastStatus = new Map();
  }
}

async function saveMcpStatus(st: Dyn) {
  try {
    const data = await chrome.storage.local.get(MCP_STATUS_STORAGE_KEY);
    const rec = ((data && data[MCP_STATUS_STORAGE_KEY]) || { ts: 0, servers: [] }) as Dyn;
    const servers = ((rec && rec.servers) || []).filter((x: Dyn) => mcpKeyOf(x) !== mcpKeyOf(st));
    servers.push(st);
    await chrome.storage.local.set({ [MCP_STATUS_STORAGE_KEY]: { ts: Date.now(), servers } });
  } catch (e) {
    /* 展示用，失败不影响设置本身 */
  }
}

// 失败要给出能动手的指引，而不是一句「连接失败」：MCP 端点没有登录页，
// 403 绝大多数就是 token 没填或与服务端不一致。
function setMcpStatusEl(el: HTMLElement, st: Dyn | null | undefined) {
  if (!st) {
    el.className = 'mcp-status';
    el.textContent = '尚未连接过（点「测试」，或跑一次对话后这里会显示结果）';
    return;
  }
  if (st.ok) {
    el.className = 'mcp-status ok';
    el.textContent = '✓ 已连接：' + st.toolCount + ' 个工具' + (st.ms ? '（' + st.ms + 'ms）' : '');
    return;
  }
  el.className = 'mcp-status bad';
  el.textContent =
    '✗ 连接失败' + (st.status ? '（HTTP ' + st.status + '）' : '') + '：' + (st.error || '未知原因') +
    '。请检查地址是否可达，以及 Bearer Token 是否与服务端一致；MCP 端点用浏览器打开只会得到 401/403，它不是登录页。';
}

function renderMcp(list: Dyn[]) {
  const box = $('mcp-list');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<p class="mcp-empty">尚未配置 MCP 服务器</p>';
    return;
  }
  list.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'mcp-row';
    row.innerHTML =
      '<input class="mcp-id" placeholder="标识(英文)" value="' + esc(s.id || '') + '">' +
      '<input class="mcp-url" placeholder="https://host/mcp" value="' + esc(s.url || '') + '">' +
      '<input class="mcp-token" placeholder="Bearer Token(可选)" value="' + esc((s.headers && s.headers.Authorization || '').replace(/^Bearer\s*/i, '')) + '">' +
      '<button class="mcp-test icon-btn" type="button" title="测试这台服务器能否连通">测试</button>' +
      '<button class="mcp-del icon-btn" title="删除">✕</button>';
    const statusEl = document.createElement('div');
    setMcpStatusEl(statusEl, mcpLastStatus.get(mcpKeyOf(s)));
    row.appendChild(statusEl);
    $q(row, '.mcp-del').addEventListener('click', () => {
      list.splice(i, 1);
      renderMcp(list);
      markDirty();
    });
    $q(row, '.mcp-test').addEventListener('click', async () => {
      // 直接读这一行的当前输入（而不是 collectMcp()[i]）：collectMcp 会跳过
      // 没填 id/url 的行，下标与行号并不一致，取错行会让「测 A 得到 B 的结果」。
      const cfg: Dyn = { id: String($q(row, '.mcp-id').value).trim(), url: String($q(row, '.mcp-url').value).trim() };
      const token = String($q(row, '.mcp-token').value).trim();
      if (token) cfg.headers = { Authorization: 'Bearer ' + token };
      statusEl.className = 'mcp-status';
      statusEl.textContent = '连接中…';
      const st = await probeMcpServer(cfg);
      mcpLastStatus.set(mcpKeyOf(cfg), st);
      setMcpStatusEl(statusEl, st);
      await saveMcpStatus(st);
    });
    box.appendChild(row);
  });
}

function toast(msg: string, ok?: boolean) {
  const st = $('status');
  st.textContent = msg;
  st.className = 'status' + (ok ? ' ok' : '');
  clearTimeout(st._t);
  st._t = setTimeout(() => {
    st.textContent = '';
    st.className = 'status';
  }, 1800);
}

function setDirty(dirty: unknown) {
  settingsDirty = Boolean(dirty);
  const state = $('save-state');
  if (!state) return;
  state.textContent = settingsDirty ? '有未保存修改' : '已保存';
  state.classList.toggle('dirty', settingsDirty);
}

function markDirty() {
  if (settingsLoading) return;
  setDirty(true);
}

function collectSettings() {
  return {
    apiKey: $('api-key').value.trim(),
    model: $('model').value.trim() || AI_SETTINGS_DEFAULTS.model,
    baseUrl: $('base-url').value.trim().replace(/\/+$/, '') || AI_SETTINGS_DEFAULTS.baseUrl,
    jev: mergeJevSettings({
      enabled: $('jev-enabled').checked,
      shadowMode: $('jev-shadow-mode').checked,
      baseUrl: $('jev-base-url').value,
      apiKey: $('jev-api-key').value,
      model: $('jev-model').value,
      requestTimeoutMs: $('jev-timeout').value,
      maxRetries: $('jev-retries').value,
      maxAttemptsPerRun: $('jev-max-attempts').value,
      maxConsecutiveActions: $('jev-max-actions').value,
      maxRepeatedActionsWithoutProgress: $('jev-max-repeated').value,
      maxElementCandidates: $('jev-max-candidates').value,
      minEdgeConfidence: $('jev-min-edge-confidence').value,
      schemaVersion: $('jev-schema-version').value || JEV_SETTINGS_DEFAULTS.schemaVersion,
    }),
    traceGraph: mergeTraceGraphSettings({
      enabled: $('tracegraph-enabled').checked,
      mode: $('tracegraph-mode').value,
      shadowMode: $('tracegraph-shadow-mode').checked,
    }),
    ragEnabled: $('rag-enabled').checked,
    targetLang: $('target-lang').value.trim() || AI_SETTINGS_DEFAULTS.targetLang,
    pageContext: $('page-context').checked,
    cdpEnabled: $('cdp-enabled').checked,
    siteMemoryEnabled: $('site-memory').checked,
    verifierEnabled: $('verifier-enabled').checked,
    trustedSites: $('trusted-sites').value.split(/\r?\n/).map((x: string) => x.trim()).filter(Boolean),
    toolApproval: $('tool-approval').checked,
    toolApprovalPolicy: Object.fromEntries(['read', 'edit', 'commands', 'browser', 'mcp'].map((k) => [k, $('approval-' + k).checked])),
    toolApprovalNotify: $('approval-notify').checked,
    codeExecutionApproval: $('code-exec-approval').value || 'session',
    bridgeToken: $('bridge-token').value.trim(),
    quickPrompts: $('quick-prompts').value.split(/\r?\n/).map((x: string) => x.trim()).filter(Boolean).slice(0, 12),
    mcpServers: collectMcp(),
    agentBudget: {
      ...(Number.isInteger(Number($('budget-tokens').value)) && Number($('budget-tokens').value) > 0 ? { maxTotalTokens: Math.floor(Number($('budget-tokens').value)) } : {}),
    },
  };
}

async function saveSettings() {
  const settings = collectSettings();
  await chrome.storage.local.set({ [AI_SETTINGS_KEY]: settings });
  await saveUserscriptSettings({
    agentCanInstall: $('us-agent-install').checked,
    autoCheckUpdates: $('us-auto-update').checked,
    defaultRunAt: $('us-run-at').value || 'document-idle',
  });
  setDirty(false);
  toast('✓ 已保存', true);
}

$('save-btn').addEventListener('click', () => {
  saveSettings().catch((err) => toast('保存失败：' + (err && err.message ? err.message : '未知错误')));
});

function markSettingsDirty(event: Event) {
  const target = event.target as Element | null;
  if (target?.closest?.('[data-settings-ui]')) return;
  markDirty();
}

document.querySelector('.settings-content')!.addEventListener('input', markSettingsDirty);
document.querySelector('.settings-content')!.addEventListener('change', markSettingsDirty);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveSettings().catch((err) => toast('保存失败：' + (err && err.message ? err.message : '未知错误')));
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!settingsDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

$('toggle-key').addEventListener('click', () => {
  const el = $('api-key');
  el.type = el.type === 'password' ? 'text' : 'password';
  $('toggle-key').textContent = el.type === 'password' ? '👁' : '🙈';
  $('toggle-key').setAttribute('aria-label', el.type === 'password' ? '显示 API Key' : '隐藏 API Key');
  $('toggle-key').setAttribute('aria-pressed', el.type === 'text' ? 'true' : 'false');
});

$('toggle-jev-key').addEventListener('click', () => {
  const el = $('jev-api-key');
  el.type = el.type === 'password' ? 'text' : 'password';
  $('toggle-jev-key').textContent = el.type === 'password' ? '👁' : '🙈';
  $('toggle-jev-key').setAttribute('aria-label', el.type === 'password' ? '显示 JEV API Key' : '隐藏 JEV API Key');
  $('toggle-jev-key').setAttribute('aria-pressed', el.type === 'text' ? 'true' : 'false');
});

['jev-enabled', 'jev-shadow-mode'].forEach((id) => {
  $(id).addEventListener('change', renderJevRuntimeStatus);
});

$('tracegraph-site-select').addEventListener('change', renderSelectedTraceGraph);
$('tracegraph-refresh').addEventListener('click', () => {
  refreshTraceGraphExplorer().catch((error) => {
    const summary = $('tracegraph-view-summary');
    if (summary) {
      summary.className = 'tracegraph-summary error';
      summary.textContent =
        '刷新 TraceGraph 失败：' +
        (error instanceof Error ? error.message : String(error));
    }
  });
});
$('tracegraph-delete-site').addEventListener('click', () => {
  deleteSelectedTraceGraph($('tracegraph-delete-site') as HTMLButtonElement).catch(() => {});
});

$('tracegraph-expand').addEventListener('click', () => {
  const dialog = $('tracegraph-dialog') as HTMLDialogElement | null;
  const view = selectedTraceGraphView();
  if (!dialog || !view || typeof dialog.showModal !== 'function') return;
  if (!dialog.open) dialog.showModal();
  $('tracegraph-expand').setAttribute('aria-pressed', 'true');
  const title = $('tracegraph-dialog-title');
  const summary = $('tracegraph-dialog-summary');
  if (title) title.textContent = 'TraceGraph · ' + view.siteKey;
  if (summary) {
    summary.className = 'tracegraph-summary active';
    summary.textContent = [
      '本地轨迹图',
      view.states.length + ' 个状态',
      view.edges.length + ' 条边',
      view.recordCount + ' 条原始记录',
    ].join(' · ');
  }
  renderTraceGraph(view, true);
});

$('tracegraph-dialog-close').addEventListener('click', () => {
  ($('tracegraph-dialog') as HTMLDialogElement | null)?.close();
});

$('tracegraph-zoom-in').addEventListener('click', () => {
  const canvas = traceGraphTargets(true).canvas;
  if (canvas) traceGraphCanvasControllers.get(canvas)?.zoom(1.2);
});

$('tracegraph-zoom-out').addEventListener('click', () => {
  const canvas = traceGraphTargets(true).canvas;
  if (canvas) traceGraphCanvasControllers.get(canvas)?.zoom(1 / 1.2);
});

$('tracegraph-zoom-reset').addEventListener('click', () => {
  const canvas = traceGraphTargets(true).canvas;
  if (canvas) traceGraphCanvasControllers.get(canvas)?.fit(true);
});

const traceGraphDialog = $('tracegraph-dialog') as HTMLDialogElement | null;
if (traceGraphDialog) {
  traceGraphDialog.addEventListener('click', (event) => {
    if (event.target === traceGraphDialog) traceGraphDialog.close();
  });
  traceGraphDialog.addEventListener('close', () => {
    $('tracegraph-expand').setAttribute('aria-pressed', 'false');
  });
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[TRACE_GRAPH_KEY]) return;
    refreshTraceGraphExplorer().catch(() => {});
  });
}

$('test-jev').addEventListener('click', async () => {
  const status = $('jev-status');
  status.className = 'connection-status';
  const settings = mergeJevSettings({
    baseUrl: $('jev-base-url').value,
    apiKey: $('jev-api-key').value,
    model: $('jev-model').value,
    requestTimeoutMs: $('jev-timeout').value,
    maxRetries: $('jev-retries').value,
    maxAttemptsPerRun: $('jev-max-attempts').value,
    maxConsecutiveActions: $('jev-max-actions').value,
    maxRepeatedActionsWithoutProgress: $('jev-max-repeated').value,
    maxElementCandidates: $('jev-max-candidates').value,
    minEdgeConfidence: $('jev-min-edge-confidence').value,
    schemaVersion: $('jev-schema-version').value,
  });
  if (!settings.apiKey) {
    status.textContent = '请先填写 JEV API Key';
    status.classList.add('error');
    $('jev-api-key').focus();
    return;
  }
  status.textContent = '正在测试…';
  try {
    const probe = await probeJevConnection(settings);
    if (probe.modelListed) {
      status.textContent = '连接成功，模型可用';
      status.classList.add('ok');
    } else if (probe.systemOneVerified) {
      status.textContent = '连接成功，System One 探测通过（当前专用模型未出现在通用目录中）';
      status.classList.add('ok');
    } else {
      status.textContent =
        '连接成功，但当前模型既不在目录中，System One 也未完成验证。';
      status.classList.add('error');
    }
  } catch (error) {
    status.textContent = '连接失败：' + (error instanceof Error ? error.message : String(error));
    status.classList.add('error');
  }
});

function collectMcp() {
  const rows = document.querySelectorAll('#mcp-list .mcp-row');
  const out: Dyn[] = [];
  rows.forEach((r) => {
    const id = String($q(r, '.mcp-id').value).trim();
    const url = String($q(r, '.mcp-url').value).trim();
    const token = String($q(r, '.mcp-token').value).trim();
    if (!id || !url) return;
    const srv: Dyn = { id, url };
    if (token) srv.headers = { Authorization: 'Bearer ' + token };
    out.push(srv);
  });
  return out;
}

$('mcp-add').addEventListener('click', () => {
  const list = collectMcp();
  list.push({ id: '', url: '', headers: {} });
  renderMcp(list);
  markDirty();
});

function syncApprovalPreset() {
  const keys = ['read', 'edit', 'commands', 'browser', 'mcp'];
  const values = keys.map((k) => $('approval-' + k).checked);
  $('approval-preset').value = values.every(Boolean) ? 'all' : values[0] && values.slice(1).every((v) => !v) ? 'safe' : 'custom';
}
$('approval-preset').addEventListener('change', (e: Event) => {
  const picked = (e.target as HTMLSelectElement).value;
  if (picked === 'safe' || picked === 'all') {
    const on = picked === 'all';
    ['read', 'edit', 'commands', 'browser', 'mcp'].forEach((k) => { $('approval-' + k).checked = on || k === 'read'; });
  }
});
document.querySelectorAll('.approval-list input').forEach((el) => el.addEventListener('change', syncApprovalPreset));

$('test-connection').addEventListener('click', async () => {
  const status = $('connection-status');
  const apiKey = $('api-key').value.trim();
  const baseUrl = $('base-url').value.trim().replace(/\/+$/, '') || AI_SETTINGS_DEFAULTS.baseUrl;
  status.className = 'connection-status';
  status.textContent = '正在测试…';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
    const res = await fetch(baseUrl + '/models', {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    status.textContent = '连接成功';
    status.classList.add('ok');
  } catch (err) {
    status.textContent = (err as Error).name === 'AbortError'
      ? '连接超时'
      : '连接失败：' + ((err as Error).message ? (err as Error).message : '未知错误');
    status.classList.add('error');
  } finally {
    clearTimeout(timer);
  }
});

function initSettingsNav() {
  const links = [...document.querySelectorAll('.settings-sidebar a')];
  const sections = links
    .map((link) => ({ link, section: document.querySelector(String(link.getAttribute('href'))) }))
    .filter((item): item is { link: Element; section: Element } => Boolean(item.section));
  if (!sections.length || typeof IntersectionObserver !== 'function') return;
  if (links[0]) links[0].classList.add('active');
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (!visible.length) return;
      const current = sections.find((item) => item.section === visible[0].target);
      if (!current) return;
      links.forEach((link) => link.classList.toggle('active', link === current.link));
    },
    { rootMargin: '-140px 0px -60% 0px', threshold: [0, 1] }
  );
  sections.forEach((item) => observer.observe(item.section));
}

load();
