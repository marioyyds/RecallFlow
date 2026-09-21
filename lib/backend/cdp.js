// CDP（Chrome DevTools Protocol）输入/感知层：通过 chrome.debugger 获得「可信事件」与
// 浏览器级能力，弥补内容脚本合成事件的局限（isTrusted=false、跨域 iframe、canvas、
// 虚拟列表、富文本编辑器等）。
//
// 设计原则：
// - 懒附加：仅在真正需要 CDP 时才 attach，任务结束统一 detach（减少「正在调试」提示条）。
// - 可选降级：调用方先尝试内容脚本合成事件，失败或无可观察变化时再走 CDP。
// - 页面世界执行：Runtime.evaluate 默认在主世界执行，不受页面 CSP 限制，且拿不到扩展权限。
import { logError } from '../shared/utils.js';

const PROTOCOL_VERSION = '1.3';
const attached = new Map(); // tabId -> Promise<void>（避免并发重复 attach）

export function isCdpAvailable() {
  return typeof chrome !== 'undefined' && !!chrome.debugger && !!chrome.debugger.sendCommand;
}

// 浏览器主动断开（用户关闭调试条 / 标签关闭 / 导航到不可调试页）时清理缓存。
if (isCdpAvailable() && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) attached.delete(source.tabId);
  });
}

export async function attach(tabId) {
  if (!isCdpAvailable()) throw new Error('当前环境不支持 chrome.debugger（需要 Chromium 内核浏览器）');
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('无效的 tabId：' + tabId);
  if (attached.has(id)) return attached.get(id);
  const task = new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId: id }, PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      // 失败（含 DevTools 已占用）时拒绝，调用方据此回退到内容脚本合成事件。
      if (err) {
        reject(new Error(err.message || '无法附加调试器'));
        return;
      }
      resolve();
    });
  });
  attached.set(id, task);
  try {
    await task;
    // 开启 Page 域，以便接收对话框 / 下载 / 文件选择等事件（供 target-manager 使用）。
    sendRaw(id, 'Page.enable').catch(() => {});
    return task;
  } catch (e) {
    attached.delete(id);
    throw e;
  }
}

export async function detach(tabId) {
  const id = Number(tabId);
  if (!attached.has(id)) return;
  attached.delete(id);
  if (!isCdpAvailable()) return;
  await new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId: id }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}

export function detachAll() {
  for (const id of Array.from(attached.keys())) detach(id).catch(() => {});
}

function sendRaw(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || ('CDP ' + method + ' 失败')));
      else resolve(result);
    });
  });
}

// 附加并发送一条 CDP 命令；失败时附带方法名便于定位。
export async function command(tabId, method, params) {
  await attach(tabId);
  try {
    return await sendRaw(tabId, method, params);
  } catch (e) {
    throw new Error(method + '：' + (e && e.message ? e.message : String(e)));
  }
}

// ---------------- 输入原语（可信事件） ----------------

function modifiersMask(modifiers) {
  const list = Array.isArray(modifiers) ? modifiers.map((m) => String(m).toUpperCase()) : [];
  let mask = 0;
  if (list.includes('ALT')) mask |= 1;
  if (list.includes('CTRL') || list.includes('CONTROL')) mask |= 2;
  if (list.includes('META') || list.includes('CMD') || list.includes('COMMAND')) mask |= 4;
  if (list.includes('SHIFT')) mask |= 8;
  return mask;
}

const KEY_DEFS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

function charKeyDef(ch) {
  const upper = ch.toUpperCase();
  let code = ch;
  if (/[A-Z]/.test(upper)) code = 'Key' + upper;
  else if (/[0-9]/.test(ch)) code = 'Digit' + ch;
  return { key: ch, code, keyCode: upper.charCodeAt(0), text: ch };
}

function keyInfo(key, mask) {
  const def = KEY_DEFS[key] || (/^.$/.test(key) ? charKeyDef(key) : { key, code: key, keyCode: 0 });
  const info = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers: mask,
  };
  if (def.text) info.text = def.text;
  return info;
}

export async function clickAt(tabId, x, y, options = {}) {
  const button = options.button || 'left';
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  const common = { x: Math.round(x), y: Math.round(y), button, modifiers: modifiersMask(options.modifiers) };
  await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: common.x, y: common.y, buttons: 0, modifiers: common.modifiers });
  if (options.clickCount === 2) {
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common, clickCount: 1, buttons });
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, clickCount: 1, buttons: 0 });
  }
  await command(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common, clickCount: options.clickCount || 1, buttons });
  await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, clickCount: options.clickCount || 1, buttons: 0 });
  return { ok: true };
}

export async function moveTo(tabId, x, y, options = {}) {
  await command(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
    buttons: 0,
    modifiers: modifiersMask(options.modifiers),
  });
  return { ok: true };
}

// 拖拽：从 (x1,y1) 到 (x2,y2)，插入中间移动步骤以兼容监听 drag 序列的组件。
export async function drag(tabId, x1, y1, x2, y2) {
  await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x1), y: Math.round(y1), buttons: 0 });
  await command(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x1), y: Math.round(y1), button: 'left', buttons: 1, clickCount: 1 });
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x1 + ((x2 - x1) * i) / steps);
    const y = Math.round(y1 + ((y2 - y1) * i) / steps);
    await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
  }
  await command(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x2), y: Math.round(y2), button: 'left', buttons: 0, clickCount: 1 });
  return { ok: true };
}

// 输入文本：insertText 走输入法通道，对富文本编辑器/受控组件更友好。
export async function insertText(tabId, text) {
  await command(tabId, 'Input.insertText', { text: String(text == null ? '' : text) });
  return { ok: true };
}

export async function pressKey(tabId, key, modifiers) {
  const mask = modifiersMask(modifiers);
  const info = keyInfo(key, mask);
  await command(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, info));
  await command(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, info));
  return { ok: true };
}

// ---------------- 感知原语 ----------------

export async function screenshot(tabId, options = {}) {
  const r = await command(tabId, 'Page.captureScreenshot', {
    format: options.format || 'png',
    quality: options.quality,
    captureBeyondViewport: options.fullPage === true,
  });
  return (r && r.data) || '';
}

export async function getFullAxTree(tabId) {
  await command(tabId, 'Accessibility.enable');
  const r = await command(tabId, 'Accessibility.getFullAXTree');
  return (r && r.nodes) || [];
}

export async function getBoxModel(tabId, backendNodeId) {
  const r = await command(tabId, 'DOM.getBoxModel', { backendNodeId });
  return (r && r.model) || null;
}

// 在页面主世界执行表达式（不受页面 CSP 限制，且没有扩展权限）。
export async function evaluate(tabId, expression, options = {}) {
  const r = await command(tabId, 'Runtime.evaluate', {
    expression: String(expression),
    awaitPromise: options.awaitPromise !== false,
    returnByValue: options.returnByValue !== false,
    userGesture: options.userGesture === true,
  });
  if (r && r.exceptionDetails) {
    const desc = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '页面执行异常';
    throw new Error(desc);
  }
  return r && r.result ? r.result.value : undefined;
}

// 在指定 iframe（含跨域）的主世界执行表达式：先在目标 frame 建一个隔离世界上下文，
// 再在该上下文里求值。frameId 为空/0 时退回主 frame。
export async function evaluateInFrame(tabId, frameId, expression, options = {}) {
  const fid = Number(frameId);
  if (!Number.isInteger(fid) || fid <= 0) return evaluate(tabId, expression, options);
  await command(tabId, 'Page.enable');
  const world = await command(tabId, 'Page.createIsolatedWorld', { frameId: fid, worldName: 'recallflow' });
  const contextId = world && world.executionContextId;
  if (!contextId) throw new Error('无法在目标框架创建执行上下文（frameId=' + fid + '）');
  const r = await command(tabId, 'Runtime.evaluate', {
    expression: String(expression),
    contextId,
    awaitPromise: options.awaitPromise !== false,
    returnByValue: options.returnByValue !== false,
    userGesture: options.userGesture === true,
  });
  if (r && r.exceptionDetails) {
    const desc = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || '页面执行异常';
    throw new Error(desc);
  }
  return r && r.result ? r.result.value : undefined;
}

// 用选择器取元素视口矩形（供 CDP 点击/悬停定位）。
export async function rectForSelector(tabId, selector) {
  const expr =
    '(() => { const el = document.querySelector(' + JSON.stringify(String(selector || '')) + ');' +
    ' if (!el) return null; const r = el.getBoundingClientRect();' +
    ' return { x: r.x, y: r.y, width: r.width, height: r.height, centerX: r.x + r.width / 2, centerY: r.y + r.height / 2 }; })()';
  return evaluate(tabId, expr);
}

export async function uploadFile(tabId, selector, files) {
  await command(tabId, 'DOM.enable');
  const doc = await command(tabId, 'DOM.getDocument', { depth: -1, pierce: true });
  const rootId = doc && doc.root && doc.root.nodeId;
  const q = await command(tabId, 'DOM.querySelector', { nodeId: rootId, selector: String(selector || '') });
  if (!q || !q.nodeId) throw new Error('未找到 file input：' + selector);
  await command(tabId, 'DOM.setFileInputFiles', { files: Array.isArray(files) ? files : [files], nodeId: q.nodeId });
  return { ok: true };
}

export async function getFrameTree(tabId) {
  const r = await command(tabId, 'Page.getFrameTree');
  return (r && r.frameTree) || null;
}

// ---- 跨域 iframe 的坐标解析（供 CDP 按坐标点击子框架元素）----
// CDP 的 getBoxModel 坐标基准在不同 Chromium 版本/场景下可能是「顶层扁平」或「父框架相对」，
// 因此这里同时尝试两种算法，并用顶层 elementFromPoint 命中 iframe 来校验，取正确的一个；
// 都无法可靠命中时返回 null（调用方退回内容脚本合成事件，绝不在错误坐标上点击）。
async function frameParentMap(tabId) {
  const tree = await getFrameTree(tabId);
  const map = new Map();
  const walk = (node) => {
    if (!node || !node.frame) return;
    map.set(node.frame.id, node.frame.parentId || null);
    for (const c of node.childFrames || []) walk(c);
  };
  walk(tree);
  return map;
}

async function frameOffset(tabId, frameId, parentMap) {
  let fid = frameId;
  let x = 0;
  let y = 0;
  let guard = 0;
  while (fid && parentMap.get(fid)) {
    try {
      const owner = await command(tabId, 'DOM.getFrameOwner', { frameId: fid });
      if (owner && owner.backendNodeId) {
        const box = await command(tabId, 'DOM.getBoxModel', { backendNodeId: owner.backendNodeId });
        const q = box && box.content;
        if (q && q.length >= 8) {
          x += Math.min(q[0], q[2], q[4], q[6]);
          y += Math.min(q[1], q[3], q[5], q[7]);
        }
      }
    } catch (e) {}
    fid = parentMap.get(fid);
    if (++guard > 30) break;
  }
  return { x, y };
}

// 通过「框架内选择器 → 远程对象 → nodeId → getBoxModel」拿到元素的坐标（含子框架）。
async function elementBoxCenter(tabId, frameId, selector) {
  await command(tabId, 'DOM.enable');
  await command(tabId, 'Page.enable');
  const world = await command(tabId, 'Page.createIsolatedWorld', { frameId: Number(frameId), worldName: 'recallflow' });
  const contextId = world && world.executionContextId;
  if (!contextId) return null;
  const ev = await command(tabId, 'Runtime.evaluate', {
    expression: 'document.querySelector(' + JSON.stringify(String(selector || '')) + ')',
    contextId,
    returnByValue: false,
  });
  const objId = ev && ev.result && ev.result.objectId;
  if (!objId) return null;
  const node = await command(tabId, 'DOM.requestNode', { objectId: objId });
  const nodeId = node && node.nodeId;
  if (!nodeId) return null;
  const box = await command(tabId, 'DOM.getBoxModel', { nodeId });
  const q = box && box.content;
  if (!q || q.length < 8) return null;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

async function pointHitsIframe(tabId, x, y) {
  const expr =
    '(() => { const el = document.elementFromPoint(' + Math.round(x) + ',' + Math.round(y) + ');' +
    ' return !!el && (el.tagName === "IFRAME" || !!el.closest("iframe")); })()';
  return evaluate(tabId, expr).catch(() => false);
}

// 解析子框架内元素的顶层视口坐标；fallbackCenter 为该元素在自身框架内的坐标。
export async function resolveFrameClickPoint(tabId, frameId, selector, fallbackCenter) {
  const fid = Number(frameId);
  if (!Number.isInteger(fid) || fid <= 0) return fallbackCenter || null;
  const parentMap = await frameParentMap(tabId).catch(() => new Map());
  // 算法 1：getBoxModel 直接给出顶层扁平坐标
  try {
    const c = await elementBoxCenter(tabId, fid, selector);
    if (c && (await pointHitsIframe(tabId, c.x, c.y))) return c;
  } catch (e) {}
  // 算法 2：框架内相对坐标 + 逐层累加的 iframe 偏移
  if (fallbackCenter && Number.isFinite(fallbackCenter.x) && Number.isFinite(fallbackCenter.y)) {
    try {
      const off = await frameOffset(tabId, fid, parentMap);
      const c = { x: off.x + fallbackCenter.x, y: off.y + fallbackCenter.y };
      if (await pointHitsIframe(tabId, c.x, c.y)) return c;
    } catch (e) {}
  }
  return null;
}

export async function handleJavaScriptDialog(tabId, accept, promptText) {
  await command(tabId, 'Page.handleJavaScriptDialog', {
    accept: accept !== false,
    ...(typeof promptText === 'string' ? { promptText } : {}),
  });
  return { ok: true };
}
