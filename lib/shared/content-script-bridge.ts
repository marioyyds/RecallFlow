// 内容脚本消息桥：先按 frameId 发消息；若目标框架没有接收端，注入一次 content.js 再重试。
//
// 为什么需要它（会话 RF-45DHH4 实测）：
//   · 切到一个在扩展加载/重载之前就已打开的旧标签页 → "Receiving end does not exist"；
//   · list_frames 用 chrome.scripting 能枚举到动态创建的子框架，但声明式内容脚本
//     并不一定注入过该框架 → 显式 get_page_snapshot({frameId}) 同样连不上。
// 这两种都不是网络问题，靠"再读一次"不会变好；但扩展有 scripting + host 权限，
// 可以在目标框架里补注入 content.js，然后重试原来的消息。
import { isContentScriptUnreachable } from './utils.ts';

// 同一 tab/frame 短时间内只补注入一次：页面确实禁止注入时，避免每个工具调用都
// 重新执行 300KB 的 content.js，把失败变成性能问题。
const INJECT_COOLDOWN_MS = 2000;
const lastInjectAt = new Map<string, number>();

/** 页面侧的 JSON 回包。形状由各工具自己约定（跨上下文消息，扩展侧无从静态校验）。 */
type BridgeReply = Record<string, any>;

function normalizeFrameId(frameId: unknown): number {
  const fid = Number(frameId);
  return Number.isInteger(fid) && fid >= 0 ? fid : 0;
}

/**
 * 发一次消息并等回调。
 *
 * 泛型默认 `Record<string, any>`：返回值是**页面侧的 JSON 回包**，形状由各工具自己约定，
 * 扩展侧没有可静态校验的来源；调用方（lib/assistant/tools.ts）直接读它的字段。
 * 为 20 多个响应形状各写一个 interface 只会把同一份约定搬到两处维护。
 */
function sendOnce<T = BridgeReply>(chromeApi: typeof chrome, tabId: number, message: unknown, frameId: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const callback = (response: T) => {
      if (chromeApi.runtime.lastError) {
        reject(new Error(chromeApi.runtime.lastError.message));
        return;
      }
      resolve(response);
    };
    chromeApi.tabs.sendMessage(tabId, message, { frameId: normalizeFrameId(frameId) }, callback);
  });
}

async function injectContentScript(chromeApi: typeof chrome, tabId: number, frameId: unknown): Promise<boolean> {
  if (!chromeApi || !chromeApi.scripting || typeof chromeApi.scripting.executeScript !== 'function') {
    return false;
  }
  const key = String(tabId) + ':' + normalizeFrameId(frameId);
  const now = Date.now();
  if (now - Number(lastInjectAt.get(key) || 0) < INJECT_COOLDOWN_MS) return false;
  lastInjectAt.set(key, now);
  try {
    await chromeApi.scripting.executeScript({
      target: { tabId: Number(tabId), frameIds: [normalizeFrameId(frameId)] },
      files: ['content.js'],
    });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 发送页面消息；内容脚本不可达时自动补注入并重试一次。
 *
 * 注意：只对 "Receiving end does not exist" 这一族错误做注入，其它失败原样抛回，
 * 避免把页面自身的业务错误误当成"没注入"。
 */
export async function sendTabMessageWithInjection<T = BridgeReply>(
  chromeApi: typeof chrome,
  tabId: number,
  message: unknown,
  frameId: unknown
): Promise<T> {
  try {
    return await sendOnce<T>(chromeApi, tabId, message, frameId);
  } catch (e) {
    if (!isContentScriptUnreachable(e && (e as Error | null)?.message)) throw e;
    const injected = await injectContentScript(chromeApi, tabId, frameId);
    if (!injected) throw e;
    // executeScript 会等脚本执行完；这个短等待只兜住消息监听注册与 API 状态切换的竞态。
    await new Promise((resolve) => setTimeout(resolve, 20));
    return await sendOnce<T>(chromeApi, tabId, message, frameId);
  }
}

/** 仅供测试：清掉补注入冷却记录。 */
export function __resetContentScriptBridgeForTests() {
  lastInjectAt.clear();
}
