// 运行流事件归约与广播中心。
//
// 为什么要单独一层：流式事件原先只发往发起 run 的那个 MessagePort，
// 其他标签页只能等 saveConversation 后重新读正文。这里把“事件 → 可渲染状态”
// 做成纯函数，SW 与跟随标签页共用同一份归约逻辑：
//   · SW：积累权威快照，按 40ms 合并正文/思考增量后广播；
//   · 跟随页：应用同样的增量；发现序号断层时重新取 snapshot。

export const RUN_TEXT_FLUSH_MS = 40;

export function createRunState(input) {
  const data = input || {};
  return {
    runId: String(data.runId || ''),
    sessionId: String(data.sessionId || ''),
    ownerTabId: data.ownerTabId == null ? null : Number(data.ownerTabId),
    instruction: String(data.instruction || ''),
    status: 'running',
    cursor: 0,
    startedAt: Number(data.startedAt) || Date.now(),
    updatedAt: Number(data.updatedAt) || Date.now(),
    content: '',
    narration: '',
    reasoning: '',
    parts: [],
    plan: [],
    citations: Array.isArray(data.citations) ? data.citations.slice() : [],
    progress: { state: '', step: 0, max: 0 },
    tokens: 0,
    approval: null,
    error: '',
  };
}

function endReasoning(state) {
  if (!state.reasoning) return;
  state.parts.push({ type: 'thinking', text: state.reasoning });
  state.reasoning = '';
}

function flushNarration(state) {
  if (!state.narration) return;
  state.parts.push({ type: 'narration', text: state.narration });
  state.narration = '';
}

function pushNotice(state, text, color) {
  const value = String(text || '').trim();
  if (!value) return;
  state.parts.push({ type: 'notice', text: value, color: color || '' });
}

function pushStepNotice(state, text, color) {
  endReasoning(state);
  flushNarration(state);
  pushNotice(state, text, color);
}

/**
 * 把一个 Agent 事件归约进 run 状态。
 *
 * 这里刻意不保存 screenshot 的 dataUrl：图片可能几百 KB，逐帧同步会把广播打爆。
 * 跟随页会看到“截图已生成”的步骤，最终消息仍以发起页落盘的内容为准。
 */
export function applyRunEvent(state, event) {
  if (!state || !event || typeof event !== 'object') return state;
  switch (event.type) {
    case 'citations':
      state.citations = Array.isArray(event.citations) ? event.citations.slice() : [];
      break;
    case 'reasoning':
      if (event.text) state.reasoning += String(event.text);
      break;
    case 'chunk':
      endReasoning(state);
      if (event.text) {
        const text = String(event.text);
        state.content += text;
        state.narration += text;
      }
      break;
    case 'tool-call':
      endReasoning(state);
      flushNarration(state);
      state.parts.push({
        type: 'tool-call',
        callId: String(event.callId || ''),
        name: String(event.name || ''),
        args: event.args && typeof event.args === 'object' ? event.args : {},
        risk: String(event.risk || 'unknown'),
      });
      if (event.requiresApproval) {
        state.approval = {
          callId: String(event.callId || ''),
          name: String(event.name || ''),
        };
      }
      break;
    case 'tool-result':
      endReasoning(state);
      flushNarration(state);
      state.parts.push({
        type: 'tool-result',
        callId: String(event.callId || ''),
        name: String(event.name || ''),
        status: String(event.status || ''),
        result: String(event.result || ''),
      });
      if (state.approval && state.approval.callId === String(event.callId || '')) state.approval = null;
      break;
    case 'screenshot':
      pushStepNotice(state, '📷 已生成截图' + (event.label ? '：' + event.label : ''), '#6b7280');
      break;
    case 'agent-state':
      state.progress.state = String(event.state || event.status || '');
      if (Number.isFinite(Number(event.step)) && Number(event.step) > 0) state.progress.step = Number(event.step);
      if (Number.isFinite(Number(event.maxSteps)) && Number(event.maxSteps) > 0) state.progress.max = Number(event.maxSteps);
      break;
    case 'usage':
      state.tokens = Number(event.totalTokens) || 0;
      break;
    case 'plan':
      state.plan = Array.isArray(event.plan) ? event.plan.slice() : [];
      break;
    case 'stuck-warning':
      pushStepNotice(state, '⚠ ' + (event.message || '动作暂未产生可观察进展'), '#b45309');
      break;
    case 'tool-disabled':
      pushStepNotice(state, '⛔ 已停止使用工具「' + (event.name || '') + '」：' + (event.reason || ''), '#6b7280');
      break;
    case 'budget-exceeded':
      pushStepNotice(state, '⏹ ' + (event.message || 'Agent 已达到安全上限并停止'), '#b91c1c');
      break;
    case 'tab-switched':
      pushStepNotice(state, '↗ 已切换标签页：' + (event.title || event.url || 'tabId=' + event.tabId), '');
      break;
    case 'tabs-closed':
      if (Array.isArray(event.tabIds) && event.tabIds.length) {
        pushStepNotice(state, '🗑 任务结束，已自动关闭 ' + event.tabIds.length + ' 个本次打开的标签页', '#6b7280');
      }
      break;
    case 'tabs-close-pending': {
      const count = Array.isArray(event.tabIds) ? event.tabIds.length : 0;
      if (count) {
        pushStepNotice(state, '🗂 任务结束，将在最终回复保存后关闭 ' + count + ' 个辅助标签页', '#6b7280');
      }
      break;
    }
    case 'intent':
      pushStepNotice(state, '🧭 意图识别：' + (event.label || event.intent || '普通对话'), '');
      break;
    case 'intent-upgraded':
      pushStepNotice(state, '🔄 已切换为' + (event.label || '资料研究') + '模式，可用浏览器/网络工具继续', '');
      break;
    case 'verify': {
      const text = event.ok
        ? '✓ 完成前校验通过' + (event.reason ? '：' + event.reason : '')
        : '⚠ 校验未通过：' + (event.reason || '目标可能未达成') + (event.missing ? '（还差：' + event.missing + '）' : '');
      pushStepNotice(state, text, event.ok ? '#16a34a' : '#b45309');
      break;
    }
    case 'skill':
      if (Array.isArray(event.skills) && event.skills.length) {
        pushStepNotice(state, '🛠 启用技能：' + event.skills.map((s) => s.title || s.name).join('、'), '');
      }
      break;
    case 'error':
      endReasoning(state);
      state.status = 'error';
      state.error = String(event.error || '任务失败（未提供错误信息）');
      break;
    case 'end':
      endReasoning(state);
      state.status = 'ended';
      break;
    default:
      break;
  }
  return state;
}

/** 跟随页使用的临时助手消息；正式落盘消息仍由发起页负责。 */
export function runStateToAssistantMessage(state) {
  if (!state) return null;
  let parts = (state.parts || []).map((p) => Object.assign({}, p));
  if (state.reasoning) parts.push({ type: 'thinking', text: state.reasoning, live: true });
  if (state.narration) parts.push({ type: 'narration', text: state.narration });
  if (state.error) parts.push({ type: 'notice', text: state.error, color: '#e74c3c' });
  if (state.approval) {
    parts.push({
      type: 'notice',
      text: '等待发起标签页确认工具「' + state.approval.name + '」',
      color: '#b45309',
    });
  }
  const bound = bindCitationsToText(parts, state.citations);
  return {
    role: 'assistant',
    content: '',
    parts: bound.parts,
    plan: Array.isArray(state.plan) ? state.plan.slice() : [],
    citations: bound.citations,
    live: true,
    liveStatus: state.status,
    // 与发起页一致：流式过程中正文可以出现引用徽章，但底部“参考来源”只在收尾后显示。
    showCitations: state.status !== 'running',
  };
}

function citeNumber(inner) {
  const m = String(inner || '').match(/(\d{1,2})\s*$/);
  return m ? Number(m[1]) : null;
}

/**
 * 跟随页在流式期间只能拿到 run 级引用集合；来源可能已登记、但回答还没写 [n]。
 * 这里按正文首次出现顺序过滤并重编号，行为与发起页收尾时的 renumberCitationsAcross 一致：
 * 没有任何正文引用时，citations 必须为空，界面才不会凭空出现“参考来源”。
 */
function bindCitationsToText(parts, citations) {
  const list = Array.isArray(citations) ? citations : [];
  const collect = /[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g;
  const order = [];
  const seen = new Set();
  for (const part of parts) {
    if (!part || (part.type !== 'narration' && part.type !== 'text') || !part.text) continue;
    collect.lastIndex = 0;
    let m;
    while ((m = collect.exec(String(part.text)))) {
      const n = citeNumber(m[1]);
      if (n === null || seen.has(n)) continue;
      seen.add(n);
      order.push(n);
    }
  }
  const oldToNew = new Map();
  const cited = [];
  for (const old of order) {
    const found = list.find((c) => Number(c && c.index) === old);
    if (!found) continue;
    oldToNew.set(old, cited.length + 1);
    cited.push(Object.assign({}, found, { index: cited.length + 1 }));
  }
  if (!cited.length) return { parts, citations: [] };
  const replace = (text) => {
    const src = String(text || '');
    return src.replace(/[\uFF3B\u005B]([^\]]*?)[\uFF3D\u005D]/g, (whole, inner) => {
      const old = citeNumber(inner);
      if (old === null || !oldToNew.has(old)) return whole;
      const label = String(inner).replace(/\s*\d+\s*$/, '');
      return '[' + label + oldToNew.get(old) + ']';
    });
  };
  const nextParts = parts.map((p) => {
    if (!p || (p.type !== 'narration' && p.type !== 'text') || !p.text) return p;
    return Object.assign({}, p, { text: replace(p.text) });
  });
  return { parts: nextParts, citations: cited };
}

function cloneSnapshot(snapshot) {
  if (!snapshot) return null;
  return JSON.parse(JSON.stringify(snapshot));
}

export class RunStreamHub {
  constructor(options) {
    const opts = options || {};
    this.flushMs = Math.max(0, Number(opts.flushMs) || RUN_TEXT_FLUSH_MS);
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.onStart = typeof opts.onStart === 'function' ? opts.onStart : () => {};
    this.onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : () => {};
    this.onEnd = typeof opts.onEnd === 'function' ? opts.onEnd : () => {};
    this.setTimer = typeof opts.setTimer === 'function' ? opts.setTimer : setTimeout;
    this.clearTimer = typeof opts.clearTimer === 'function' ? opts.clearTimer : clearTimeout;
    this.maxRuns = Math.max(1, Number(opts.maxRuns) || 20);
    this.runs = new Map();
  }

  begin(input) {
    const data = input || {};
    const runId = String(data.runId || '');
    if (!runId) return null;
    const existing = this.runs.get(runId);
    if (existing) return this.snapshot(runId);
    const state = createRunState(Object.assign({}, data, { startedAt: this.now() }));
    const rec = { state, pending: [], timer: null };
    this.runs.set(runId, rec);
    this._prune();
    const snapshot = this.snapshot(runId);
    this.onStart(snapshot);
    return snapshot;
  }

  push(runId, event) {
    const rec = this.runs.get(String(runId || ''));
    if (!rec || !event) return;
    applyRunEvent(rec.state, event);
    rec.state.updatedAt = this.now();
    if (event.type === 'chunk' || event.type === 'reasoning') {
      this._bufferText(rec, event);
      if (!rec.timer) {
        rec.timer = this.setTimer(() => this.flush(runId), this.flushMs);
      }
      return;
    }
    this.flush(runId);
    this._publish(rec, event);
  }

  _bufferText(rec, event) {
    const last = rec.pending[rec.pending.length - 1];
    if (last && last.type === event.type) {
      last.text += String(event.text || '');
      return;
    }
    rec.pending.push({ type: event.type, text: String(event.text || '') });
  }

  flush(runId) {
    const rec = this.runs.get(String(runId || ''));
    if (!rec) return;
    if (rec.timer) {
      this.clearTimer(rec.timer);
      rec.timer = null;
    }
    const pending = rec.pending.splice(0);
    for (const event of pending) this._publish(rec, event);
  }

  _publish(rec, event) {
    rec.state.cursor += 1;
    rec.state.updatedAt = this.now();
    this.onDelta({
      runId: rec.state.runId,
      sessionId: rec.state.sessionId,
      ownerTabId: rec.state.ownerTabId,
      cursor: rec.state.cursor,
      event: Object.assign({}, event),
    });
  }

  finish(runId, status) {
    const rec = this.runs.get(String(runId || ''));
    if (!rec) return null;
    this.flush(runId);
    if (status) rec.state.status = String(status);
    rec.state.updatedAt = this.now();
    const snapshot = this.snapshot(runId);
    this.onEnd(snapshot);
    return snapshot;
  }

  findBySession(sessionId) {
    const wanted = String(sessionId || '');
    if (!wanted) return null;
    let completed = null;
    for (const [runId, rec] of this.runs) {
      if (rec.state.sessionId !== wanted) continue;
      if (rec.state.status === 'running') {
        // snapshot 必须包含此刻所有已归约文本。若还有未 flush 的增量，
        // 先推进 cursor 再取快照；否则新订阅者会同时从 snapshot 和下一批 delta
        // 看到同一段文字（实测表现为思考文本重复一遍）。
        this.flush(runId);
        return cloneSnapshot(rec.state);
      }
      completed = rec.state;
    }
    return completed ? cloneSnapshot(completed) : null;
  }

  snapshot(runId) {
    const rec = this.runs.get(String(runId || ''));
    return rec ? cloneSnapshot(rec.state) : null;
  }

  clear(runId) {
    const rec = this.runs.get(String(runId || ''));
    if (rec && rec.timer) this.clearTimer(rec.timer);
    this.runs.delete(String(runId || ''));
  }

  _prune() {
    if (this.runs.size <= this.maxRuns) return;
    for (const [id, rec] of this.runs) {
      if (this.runs.size <= this.maxRuns) break;
      if (rec.state.status !== 'running') this.clear(id);
    }
  }
}
