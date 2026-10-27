// 一次 run 的稳定输出通道。
//
// 为什么需要它：`chrome.runtime.Port` 的生命周期属于**页面文档** —— 整页刷新会换一个
// 新 port，而 run 本身（模型请求、工具执行、审批等待）不该跟着页面一起死。
// 这里把「run 的输出口」抽象成可换终端的通道：
//   · runAgentStream 只认 postMessage / onMessage，不关心当前是真 port 还是已经 detach；
//   · 新页面 reattach 时把通道挂到新 port 上，后续事件继续直送新页面；
//   · 旧 port 断开只摘终端，不 abort run。
//
// 关键取舍：**断开期间不缓存事件**。runHub 已经保存了完整快照，reattach 时先发快照，
// 再把 attach 之后的事件按顺序送出；缓存反而会与快照重复（实测最典型的症状是
// 思考/正文重复一段）。
export class RunChannel {
  declare port: any;
  declare portListener: any;
  declare listeners: Set<any>;
  declare paused: boolean;
  declare queued: any[];
  declare onMessage: any;

  constructor() {
    this.port = null;
    this.portListener = null;
    this.listeners = new Set();
    this.paused = false;
    this.queued = [];
    const listeners = this.listeners;
    this.onMessage = {
      addListener: (fn: any) => {
        if (typeof fn === 'function') listeners.add(fn);
      },
      removeListener: (fn: any) => {
        listeners.delete(fn);
      },
    };
  }

  /** 当前是否挂在某个页面的 port 上。 */
  isAttached() {
    return Boolean(this.port);
  }

  /**
   * 挂到新 port。`paused:true` 用于 reattach：先发送快照，再 `resume()` 放行
   * attach 之后产生的事件，避免快照与实时事件交错。
   */
  attach(port: any, options: any) {
    if (!port) return false;
    const opts = options || {};
    this.detach();
    this.port = port;
    this.paused = opts.paused === true;
    this.portListener = (message: any) => this.emit(message);
    try {
      port.onMessage.addListener(this.portListener);
    } catch (e: any) {
      this.port = null;
      this.portListener = null;
      return false;
    }
    return true;
  }

  /** 摘掉终端。传入 port 时只在它仍是当前终端时生效（防止旧 port 的迟到 disconnect 摘掉新 port）。 */
  detach(port?: any) {
    if (port && this.port !== port) return;
    if (this.port && this.portListener) {
      try {
        this.port.onMessage.removeListener(this.portListener);
      } catch (e: any) {}
    }
    this.port = null;
    this.portListener = null;
    this.paused = false;
    this.queued = [];
  }

  /** 发给当前页面；没有终端时直接丢弃（runHub 快照仍是权威）。 */
  postMessage(message: any) {
    if (this.paused) {
      this.queued.push(message);
      return;
    }
    if (!this.port) return;
    try {
      this.port.postMessage(message);
    } catch (e: any) {
      // 端口刚好断开：保留 run，下一个 reattach 会从快照恢复。
    }
  }

  /** 放行 paused 期间积压的事件（按到达顺序）。 */
  resume() {
    this.paused = false;
    const pending = this.queued.splice(0);
    for (const message of pending) this.postMessage(message);
  }

  /** 把页面发来的消息交给 run 内部监听器（waitForToolApproval 等）。 */
  emit(message: any) {
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (e: any) {}
    }
  }
}
