// Application-level adapter for long-lived AI stream ports.
import { RunChannel } from '../../assistant/run-channel.ts';
import type { RunControllerLike } from '../agent/run-registry.ts';
import { sanitizeMessages } from '../../shared/surrogates.ts';

type Dyn = Record<string, any>;
type RunController = RunControllerLike;

export interface AiStreamDependencies {
  runRegistry: any;
  runHub: any;
  agentRunner: any;
  runLifecycle: any;
  runStats: any;
  registerRunCleanup(runId: unknown, event: Record<string, any>): void;
  clearRunAbortTimer(runId: unknown): void;
  requestRunStop(params: Record<string, any>, requesterTabId: number | null | undefined): any;
  scheduleAbortIfNoReattach(runId: unknown, tabId: number | null | undefined): void;
  loadAgentSession(runId: string): Promise<any>;
  getAISettings(): Promise<any>;
  getBook(): Promise<any>;
  buildAiMessages(action: any, payload: any, settings: any, book: any, normalizeHistory: any): any;
  normalizeHistory: any;
  logError(message: string, details: Record<string, any>): void;
}

/**
 * Owns one AI stream connection: agent execution, reattachment, generic chat
 * streaming, and connection-scoped abort semantics.
 */
export function handleAiStreamConnection(port: any, deps: AiStreamDependencies) {
  const {
    runRegistry,
    runHub,
    agentRunner,
    runLifecycle,
    runStats,
    registerRunCleanup,
    clearRunAbortTimer,
    requestRunStop,
    scheduleAbortIfNoReattach,
    loadAgentSession,
    getAISettings,
    getBook,
    buildAiMessages,
    normalizeHistory,
    logError,
  } = deps;
  if (port.name !== 'ai-stream') return;

  if (port.name !== 'ai-stream') return;

  const senderTabId = port.sender && port.sender.tab ? port.sender.tab.id : null;
  // 只有真正发起 run 的 port 才需要 controller。query-run / reattach 这类
  // 临时 port 若也建 controller，会在断开时把别人的 run abort 掉。
  let controller: RunController | null = null;
  let attachedRunId = '';
  const ensureController = () => {
    if (!controller) {
      controller = new AbortController() as RunController;
      if (senderTabId) runRegistry.setController(senderTabId, controller);
    }
    return controller;
  };
  port.onDisconnect.addListener(() => {
    // 刷新/导航只摘终端，不结束 run；新页面会在宽限内 reattach。
    if (attachedRunId) {
      const channel = runRegistry.channelFor(attachedRunId);
      if (channel) channel.detach(port);
      const rec = runRegistry.runFor(senderTabId);
      if (rec && String(rec.runId || '') === attachedRunId) {
        scheduleAbortIfNoReattach(attachedRunId, senderTabId);
        return;
      }
    }
    // 没有绑定 run 的 port（query-run 等）断开不产生副作用；
    // 真正 abort 只留给显式停止、标签页关闭和宽限超时。
    if (controller && !controller.__rfFinished) {
      try {
        runStats.aborts += 1;
        controller.abort();
      } catch (e) {}
    }
  });

  port.onMessage.addListener(async (payload: any) => {
    let aborted = false;
    try {
      // 停止：面板显式请求中止 run，并标记为不可续跑。
      if (payload && payload.type === 'stop') {
        const tr = runRegistry.runFor(senderTabId);
        const stopped = requestRunStop({ runId: tr && tr.runId, sessionId: tr && tr.sessionId }, senderTabId);
        // 已经处于收尾/停止中的 run 仍要 abort 一次兜底，保证端口断开前的意图不丢。
        if (!stopped.ok && controller && !controller.__rfFinished) {
          try {
            runStats.aborts += 1;
            controller.abort();
          } catch (e) {}
        }
        return;
      }
      // 整页刷新后的新面板：查询本 tab 是否有可续跑的 run。
      if (payload && payload.type === 'query-run') {
        const tr = runRegistry.runFor(senderTabId);
        const reply = (m: Dyn) => { try { port.postMessage(Object.assign({ type: 'run-state' }, m)); } catch (e) {} };
        if (!tr || !tr.resumable || !tr.runId) {
          reply({ runId: '', resumable: false, live: false, pending: false, instruction: '' });
          return;
        }
        // 端口断开后 run 仍活着：新面板直接 reattach，不启动第二次 agent 请求。
        const liveSnapshot = runHub.snapshot(tr.runId);
        const liveChannel = runRegistry.channelFor(tr.runId);
        if (liveChannel && liveSnapshot && liveSnapshot.status === 'running') {
          reply({
            runId: String(tr.runId),
            resumable: true,
            live: true,
            pending: false,
            instruction: liveSnapshot.instruction || '',
            snapshot: liveSnapshot,
          });
          return;
        }
        try {
          const s = await loadAgentSession(tr.runId);
          // abort 与落盘是异步的：会话还没写出来时告诉面板"稍后重试"，避免竞态误判"没有任务"。
          if (!s) { reply({ runId: '', resumable: false, live: false, pending: true, instruction: '' }); return; }
          const instruction = String(s.instruction || '');
          const dead = ['completed', 'failed', 'cancelled', 'timeout'].includes(s.status);
          // 把 SW 侧已归约的运行快照一并交给新面板：刷新前已经发生的工具步骤、
          // 叙述与思考都还在这里面。只回 runId 的话，新面板只能从"续跑之后"
          // 开始显示，用户会看到前半轮凭空消失。
          const snapshot = runHub.snapshot(tr.runId);
          reply({
            runId: instruction && !dead ? tr.runId : '',
            resumable: Boolean(instruction) && !dead,
            live: false,
            finished: Boolean(dead || !instruction),
            pending: false,
            instruction,
            snapshot: snapshot || null,
          });
        } catch (e) {
          reply({ runId: '', resumable: false, live: false, pending: false, instruction: '' });
        }
        return;
      }
      // 新页面接管仍然活着的 run：把输出终端从旧 port 切到新 port。
      if (payload && payload.type === 'reattach') {
        const runId = String(payload.runId || '');
        const channel = runId ? runRegistry.channelFor(runId) : null;
        const snapshot = runId ? runHub.snapshot(runId) : null;
        const attachFailed = (reason: string) => {
          try {
            port.postMessage({ type: 'reattach-failed', runId, reason, snapshot });
          } catch (e) {}
        };
        if (!runId || !channel || !snapshot || snapshot.status !== 'running') {
          attachFailed(snapshot ? '该任务已结束' : '没有可接管的运行');
          return;
        }
        clearRunAbortTimer(runId);
        attachedRunId = runId;
        runStats.reattaches += 1;
        // 先挂上但暂停发送，再把快照交给新面板，最后放行 attach 之后的事件。
        if (!channel.attach(port, { paused: true })) {
          attachFailed('无法绑定页面连接');
          return;
        }
        try {
          port.postMessage({
            type: 'reattached',
            runId,
            sessionId: snapshot.sessionId,
            snapshot,
          });
        } catch (e) {
          attachFailed('页面连接已断开');
          return;
        }
        channel.resume();
        return;
      }
      // 工具审批消息由 waitForToolApproval 的临时监听器处理，不能作为新的对话请求。
      if (payload && payload.type === 'tool-approval') return;
      // 心跳：保持 service worker 存活（长任务期间），不触发新请求。
      if (payload && payload.type === 'keepalive') return;
      // E2E 专用：从**后台侧**断开当前端口，用于验证面板的断线重连。
      // 为什么必须从后台侧断：实测面板自己调用 port.disconnect() 并不会触发
      // 它自己的 onDisconnect（本端主动断开不走该事件），因此那是**测不到**的路径。
      // 而后台侧断开正是真实场景（MV3 worker 被回收）。
      if (payload && payload.type === 'e2e-drop-port') {
        // 先让本轮 abort 落盘（模拟 worker 被回收），再断开端口。
        try {
          runStats.aborts += 1;
          if (controller) controller.abort();
        } catch (e) {}
        setTimeout(() => {
          try { port.disconnect(); } catch (e) {}
        }, 120);
        return;
      }
      // 断线重连的就绪探针：面板在重连前用它确认「中断的会话已落盘」。
      // 为什么必须有：面板的 onDisconnect 与后台 persist({phase:'interrupted'}) 是并发的。
      // 若重连早于落盘，runAgentStream 的 canResume 为 false，会把重连当成**一次新任务**
      // 从头开始 —— 用户会看到重复执行，且历史里同一条指令出现两次。
      if (payload && payload.type === 'session-ready') {
        let ready = false;
        try {
          ready = Boolean(await loadAgentSession(String(payload.runId || '')));
        } catch (e) {
          ready = false;
        }
        try { port.postMessage({ type: 'session-ready', ready }); } catch (e) {}
        return;
      }
      const settings = await getAISettings();
      if (!settings.apiKey) {
        port.postMessage({ type: 'error', needSetup: true, error: '尚未配置 API Key，请点击插件图标 → 设置页填写。' });
        return;
      }
      const book = await getBook();
      if (payload.action === 'agent') {
        const tabId = port.sender && port.sender.tab && port.sender.tab.id;
        const runId = payload.runId || 'run-' + Date.now().toString(36);
        payload.runId = runId;
        const sessionId = String(payload.sessionId || '');
        // 同一个 run 已经活着：这是刷新后/断线重连的重复请求，不是新任务。
        // 直接接管到现有通道，绝不能并发启动第二个 runAgentStream。
        const liveSnapshot = runHub.snapshot(runId);
        const existingChannel = runRegistry.channelFor(runId);
        if (existingChannel && liveSnapshot && liveSnapshot.status === 'running') {
          clearRunAbortTimer(runId);
          runStats.reattaches += 1;
          attachedRunId = String(runId);
          if (existingChannel.attach(port, { paused: true })) {
            try {
              port.postMessage({
                type: 'reattached',
                runId,
                sessionId: liveSnapshot.sessionId || sessionId,
                snapshot: liveSnapshot,
              });
            } catch (e) {}
            existingChannel.resume();
          }
          return;
        }
        console.log('[RecallFlow] agent run start:', (payload.question || '').slice(0, 40), 'tabId=' + tabId, 'session=' + sessionId);
        runStats.starts += 1;
        const channel = existingChannel || new RunChannel();
        runRegistry.setChannel(runId, channel);
        const runController = ensureController();
        if (!channel.attach(port, {})) {
          port.postMessage({ type: 'error', error: '无法绑定 Agent 输出通道。' });
          return;
        }
        attachedRunId = String(runId);
        if (tabId) {
          runRegistry.setRun(tabId, {
            runId,
            resumable: true,
            sessionId,
            channel,
            controller: runController,
          });
        }
        if (sessionId) {
          runHub.begin({
            runId,
            sessionId,
            ownerTabId: tabId,
            instruction: payload.question || payload.text || '',
          });
        }
        try {
          await agentRunner.run({
            port: channel,
            payload,
            settings,
            book,
            signal: runController.signal,
            tabId,
            observeEvent: (event: Dyn) => {
              if (event && event.type === 'tabs-close-pending') registerRunCleanup(runId, event);
              if (sessionId) {
                try {
                  runHub.push(runId, event);
                } catch (e) {
                  runStats.hubErrors = (runStats.hubErrors || 0) + 1;
                  runStats.lastHubError = String((e as Error | null)?.message || e);
                }
              }
            },
          });
          console.log('[RecallFlow] agent run finished');
          // abort 既可能是用户停止，也可能是页面刷新/端口断开；不能一律报 completed。
          if (sessionId) runHub.finish(runId, runController.signal.aborted ? 'cancelled' : 'completed');
          runController.__rfFinished = true;
          clearRunAbortTimer(runId);
          runRegistry.deleteChannel(runId);
          attachedRunId = '';
        } catch (e) {
          const detail = (e as Error | null)?.stack || String(e);
          console.error('[RecallFlow] agent run error:', detail);
          // 把真实错误回传前端，避免只看到「转圈」或笼统报错。
          try { port.postMessage({ type: 'error', error: 'Agent 运行出错：' + ((e as Error | null)?.message || String(e)) }); } catch (err) {}
          try { port.postMessage({ type: 'end' }); } catch (err) {}
          if (sessionId) {
            runHub.push(runId, { type: 'error', error: 'Agent 运行出错：' + ((e as Error | null)?.message || String(e)) });
            runHub.push(runId, { type: 'end' });
            runHub.finish(runId, runController.signal.aborted ? 'cancelled' : 'failed');
          }
          runController.__rfFinished = true;
          clearRunAbortTimer(runId);
          runRegistry.deleteChannel(runId);
          attachedRunId = '';
        }
        return;
      }
      const messages = buildAiMessages(payload.action, payload, settings, book, normalizeHistory);
      if (!messages) {
        port.postMessage({ type: 'error', error: '未知操作：' + payload.action });
        return;
      }

      // 发送引用来源元数据给前端（在流式响应开始前）
      if (messages._citations && messages._citations.length) {
        port.postMessage({ type: 'citations', citations: messages._citations });
      }

      const url = settings.baseUrl.replace(/\/+$/, '') + '/chat/completions';
      // 出站消毒：内容里只要有一个孤立代理（切裂的代理对），服务端会在**解析请求体**阶段
      // 整单拒收 400（而且 400 不重试）。面板这条闲聊路径同样会带上页面文本，必须过一遍。
      try {
        sanitizeMessages(messages);
      } catch (e) {}
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + settings.apiKey,
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          temperature: 0.3,
          stream: true,
        }),
        // 非 agent 分支没有 ensureController()，这里保留原有行为（null 时照旧抛错），
        // 类型迁移批不改语义；见交付评论的「已知遗留」。
        signal: controller!.signal,
      });

      if (!resp.ok) {
        let detail = '';
        try {
          const j = await resp.json();
          detail = j.error && j.error.message ? j.error.message : JSON.stringify(j);
        } catch (e) {
          detail = await resp.text();
        }
        port.postMessage({ type: 'error', error: 'DeepSeek 请求失败 (' + resp.status + '): ' + detail });
        return;
      }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta && delta.content) {
              port.postMessage({ type: 'chunk', text: delta.content });
            }
          } catch (e) {
            logError('Failed to parse SSE chunk', { data, error: (e as Error).message });
          }
        }
      }
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim();
          if (data !== '[DONE]') {
            try {
              const json = JSON.parse(data);
              const delta = json.choices && json.choices[0] && json.choices[0].delta;
              if (delta && delta.content) {
                port.postMessage({ type: 'chunk', text: delta.content });
              }
            } catch (e) {
              logError('Failed to parse final SSE chunk', { data, error: (e as Error).message });
            }
          }
        }
      }
      // ⚠ 原名是未声明的 `aborted`（TS2304）：运行时走到这里必然 ReferenceError，
      // 被下面的 catch 再吞一次。这里按显然的意图取 controller 的 aborted —— 这是本批
      // **唯一**的运行时修复，交付评论单列（类型迁移批原则上不改语义）。
      aborted = Boolean(controller && controller.signal.aborted);
      if (!aborted) port.postMessage({ type: 'end' });
    } catch (e) {
      if (aborted) return;
      port.postMessage({ type: 'error', error: (e as Error).message });
    }
  });

}
