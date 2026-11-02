// 按标签页广播消息，并在**内容脚本不在**时补注入一次。
//
// 为什么这件事不该散在 entries/background.ts 里：面板开合与"哪个标签页显示什么"
// 是全浏览器语义，广播是唯一送达路径；而扩展重载 / 更新之后，**此前已打开的标签页**
// 里的内容脚本全部成了孤儿（页面没刷新、脚本已死）——广播对它们只会静默失败，
// 表现就是"切到那个标签页，面板和嵌入层都不跟过来"。这段兜底有两个容易写错的点
// （只对"没有接收端"补注入、同一标签页不能反复注入几百 KB 的脚本），所以单独成模块 + 单测。
//
// ⚠ "message port closed before a response was received" **不是**没有接收端：
// 它说明接收端活着、只是没回话（见 entries/background.ts 里 sendToRunSubscribers 的注释）。
// 对它补注入既没用、会掩盖真正的问题。
import { isNoReceiverError } from './diagnostics.ts';

/** 同一标签页补注入的最小间隔：页面确实禁止注入时，避免每次广播都重跑一遍 content.js。 */
export const INJECT_COOLDOWN_MS = 2000;

type ChromeLike = any;

export interface TabBroadcaster {
  /** 向一个标签页发送广播（不等待响应）；连不上时补注入 content.js，让页面自己恢复。 */
  send(tabId: number, payload: unknown): void;
  /** 仅供测试：清掉补注入冷却记录。 */
  reset(): void;
}

export function createTabBroadcaster(chromeApi: ChromeLike): TabBroadcaster {
  const lastInjectAt = new Map<number, number>();

  function inject(tabId: number) {
    const now = Date.now();
    if (now - Number(lastInjectAt.get(tabId) || 0) < INJECT_COOLDOWN_MS) return;
    lastInjectAt.set(tabId, now);
    try {
      const scripting = chromeApi && chromeApi.scripting;
      if (!scripting || typeof scripting.executeScript !== 'function') return;
      // 只注入顶层框架：面板与悬浮球本来就只在顶层文档构建（见 entries/content.ts
      // 的 isTopFrame 分支），子框架注入一次纯属浪费。
      scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] }, () => {
        void (chromeApi.runtime && chromeApi.runtime.lastError);
      });
    } catch (error) {
      // 注入失败不值得让广播链路抛错：面板本来就是"尽力而为"的界面同步。
    }
  }

  return {
    send(tabId: number, payload: unknown) {
      if (!Number.isInteger(tabId) || tabId <= 0) return;
      try {
        chromeApi.tabs.sendMessage(tabId, payload, { frameId: 0 }, () => {
          const error = chromeApi.runtime && chromeApi.runtime.lastError;
          if (error && isNoReceiverError(error.message)) inject(tabId);
        });
      } catch (error) {
        // sendMessage 本身在极少数情况下同步抛（标签页刚被关掉）；忽略。
      }
    },
    reset() {
      lastInjectAt.clear();
    },
  };
}