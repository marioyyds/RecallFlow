// 浏览器 ↔ 本地宿主（native messaging）：让服务**随浏览器自动就绪**，用户不用碰终端。
//
// 背景（为什么有这一层）：MCP server 以前必须手动 `node index.js --http` 常驻在 127.0.0.1:7801。
// 对非程序员来说这一步等于"用不了"。改法：扩展通过 connectNative 让浏览器按需启动一个小宿主，
// 由它保证 7801 上有服务在跑；浏览器关掉，宿主进程随之退出（服务默认继续跑，见 host.js 的说明）。
//
// 失败模式与用户可见文案的对应（这里最花心思的地方）：
//   · 宿主没装          → "Specified native messaging host not found."
//   · allowed_origins 不含本扩展 ID → "Access to the specified native messaging host is forbidden."
//   · 宿主起来就挂       → "Native host has exited."
// 这三条原文对用户毫无意义，所以一律翻译成"该做什么"，并且都在设置页可见。
//
// MV3 注意：service worker 会被回收。宿主每 20s 发一条 heartbeat，端口上有消息就能续命；
// 即便被回收，下次 SW 启动会自动重连（本模块在 background.js 里被调用一次即可）。
const HOST_NAME = 'com.recallflow.bridge';

/** 状态存 chrome.storage.local：设置页/面板都能读，且 SW 被回收后仍然在。 */
export const NATIVE_HOST_STATE_KEY = 'recallflow.nativeHost';

const MIN_RETRY_MS = 1000;
// 上限刻意压到 20s：失败原因几乎都是"宿主还没装好/正在被安装器替换"，
// 而拉起本地进程很便宜；退避到 60s 会让"升级完等一分钟才恢复"变成常态（实测踩过）。
// 另外还留了 alarms 每分钟兜底，所以这里不需要靠长退避来省资源。
const MAX_RETRY_MS = 20000;

let port = null;
let retryTimer = null;
let retryDelay = MIN_RETRY_MS;
let lastInboundAt = 0;
let state = { status: 'idle', message: '', hint: '', at: 0, port: null, serverPid: null, serverRunning: false };

// 端口"僵尸"判定阈值：宿主每 heartbeatMs 发一次心跳，超过这么多倍没消息就当端口已死。
// 为什么要这个判据：宿主进程被外部杀掉时，浏览器有时**不会**回调 onDisconnect，
// 于是 port 一直非 null，connect() 被 `if (port) return` 永久挡住 —— 实测踩过：
// 连着杀掉宿主两次后，扩展从此不再重连（launcher.log 里再也没有新的启动记录）。
const HEARTBEAT_MS = 20000;
export const PORT_STALE_MS = Math.round(HEARTBEAT_MS * 2.5) + 10000;

/** 端口是否已经"僵尸"（纯函数，便于单测）。 */
export function isPortStale(hasPort, lastInbound, now, staleMs = PORT_STALE_MS) {
  if (!hasPort) return true;
  return now - lastInbound > staleMs;
}

/** 把浏览器的英文 lastError 翻译成"用户下一步该做什么"。纯函数，便于直测。 */
export function describeLastError(raw) {
  const s = String(raw || '').trim();
  if (!s) return { message: '本地宿主已断开', hint: '点「重启本地服务」；若反复失败，看 %LOCALAPPDATA%\\RecallFlow\\logs\\native-host.log' };
  if (/not found/i.test(s)) {
    return {
      message: '尚未安装本地宿主（浏览器找不到 ' + HOST_NAME + '）',
      hint: '在仓库里跑一次：node scripts/install-native-host.mjs',
    };
  }
  if (/forbidden/i.test(s)) {
    return {
      message: '浏览器拒绝启动宿主：宿主 manifest 的 allowed_origins 不含本扩展 ID',
      hint: '重新运行 node scripts/install-native-host.mjs（它会从浏览器 Profile 自动探测扩展 ID）',
    };
  }
  if (/exited/i.test(s)) {
    return {
      message: '宿主进程刚启动就退出了',
      hint: '多半是 node 路径变了或仓库被移动：重跑安装器；日志见 %LOCALAPPDATA%\\RecallFlow\\logs\\launcher.log',
    };
  }
  return { message: s, hint: '重跑安装器或点「重启本地服务」' };
}

/** 状态 → UI 文案与颜色档。纯函数，便于直测。 */
export function stateLabel(s) {
  const st = s && typeof s === 'object' ? s : {};
  switch (st.status) {
    case 'ready':
      // serverPid 为空不代表异常：服务可能是用户手动启动的（宿主复用别人的实例，不拥有它）。
      return { tone: 'ok', text: '已就绪 · 本地服务运行中' + (st.serverPid ? '（pid ' + st.serverPid + '）' : '') };
    case 'degraded':
      return { tone: 'warn', text: '宿主已连接，但本地服务没在运行' };
    case 'connecting':
      return { tone: 'wait', text: '正在启动本地服务…' };
    case 'unsupported':
      return { tone: 'bad', text: '扩展还没有 nativeMessaging 权限：请在扩展页点「重新加载」' };
    case 'disconnected': {
      const parts = [st.message || '未连接'];
      if (st.hint) parts.push('（' + st.hint + '）');
      return { tone: 'bad', text: parts.join('') };
    }
    default:
      return { tone: 'wait', text: '未检查' };
  }
}

export function getNativeHostState() {
  return state;
}

async function setState(patch, opts) {
  state = Object.assign({}, state, patch, { at: Date.now() });
  // 心跳每 20s 就来一次，若每次都落盘等于让浏览器一辈子在写磁盘；它只是保活信号，
  // 状态本身没变，所以只在内存里刷新即可（设置页要的是"有没有变"，不是心跳计数）。
  if (opts && opts.persist === false) return;
  try {
    await chrome.storage.local.set({ [NATIVE_HOST_STATE_KEY]: state });
  } catch (e) {
    /* 存不下不影响本进程内的状态机 */
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

function send(obj) {
  try {
    port.postMessage(obj);
  } catch (e) {
    /* 端口已断：onDisconnect 会接手 */
  }
}

function connect() {
  if (port) return;
  if (!chrome.runtime || typeof chrome.runtime.connectNative !== 'function') {
    setState({
      status: 'unsupported',
      message: '当前扩展实例没有 nativeMessaging 权限',
      hint: '在 edge://extensions 或 chrome://extensions 点本扩展的「重新加载」',
    });
    return;
  }
  setState({ status: 'connecting', message: '', hint: '' });
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    lastInboundAt = Date.now();
  } catch (e) {
    port = null;
    const d = describeLastError(String((e && e.message) || e));
    setState({ status: 'disconnected', message: d.message, hint: d.hint });
    scheduleRetry();
    return;
  }

  port.onMessage.addListener((msg) => {
    lastInboundAt = Date.now();
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'heartbeat') {
      // 心跳本身就把 SW 的闲置计时器顶回去；顺手把状态刷成最新（不落盘）。
      setState({ status: state.serverRunning === false ? 'degraded' : 'ready', port: msg.port || state.port }, { persist: false });
      return;
    }
    if (msg.type === 'status') {
      const st = msg.status || {};
      retryDelay = MIN_RETRY_MS;
      setState({
        status: st.serverRunning ? 'ready' : 'degraded',
        port: st.port || null,
        serverPid: st.serverPid || null,
        serverRunning: Boolean(st.serverRunning),
        serverOwned: Boolean(st.serverOwned),
        message: msg.message || '',
        hint: '',
        lastAction: msg.action || '',
      });
      return;
    }
    if (msg.type === 'error') {
      setState({ status: 'degraded', message: String(msg.error || '宿主返回错误') });
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    port = null;
    const d = describeLastError(err && err.message);
    setState({ status: 'disconnected', message: d.message, hint: d.hint, serverRunning: false });
    scheduleRetry();
  });

  // 一连上就"确保服务在跑"——这是用户零操作的关键一步。
  send({ type: 'ensure' });
}

/**
 * 启动 / 确保本地宿主已连接（幂等）。
 *
 * 关键：不能简单地 `if (port) return` —— 端口可能是僵尸（见 isPortStale 的说明）。
 * 因此这里按"多久没收到消息"判断，僵尸端口先 disconnect 再重连。
 */
export function startNativeHost() {
  if (port && !isPortStale(true, lastInboundAt, Date.now())) return;
  if (port) {
    // 僵尸端口：主动断开，避免 connect() 被它挡住。
    try {
      port.disconnect();
    } catch (e) {}
    port = null;
  }
  connect();
}

/** 重连一次：设置页的「重启本地服务」用它，也用于清掉退避等待。 */
export function restartNativeHost() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  retryDelay = MIN_RETRY_MS;
  if (port) {
    try {
      port.disconnect();
    } catch (e) {}
    port = null;
  }
  connect();
  return state;
}

/** 请求宿主停止它自己启动的本地服务（不影响手动启动的实例：宿主会明确拒绝）。 */
export function stopNativeServer() {
  if (!port) {
    connect();
    return false;
  }
  send({ type: 'stop' });
  return true;
}
