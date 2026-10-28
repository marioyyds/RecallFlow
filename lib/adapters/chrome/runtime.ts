import type { RuntimePort } from '../../application/ports/runtime.ts';
import type { GenericRuntimeMessage } from '../../application/contracts/messages.ts';

export interface ChromeRuntimeLike {
  runtime: {
    lastError?: { message?: string } | null;
    sendMessage(message: unknown, callback: (response: unknown) => void): void;
  };
}

/**
 * Chrome runtime 消息适配器。
 *
 * 业务代码只看到 Promise 和结构化响应；callback、lastError 与异常边界都留在适配器内。
 */
export class ChromeRuntimeAdapter implements RuntimePort {
  private readonly api: ChromeRuntimeLike;

  constructor(api: ChromeRuntimeLike = chrome) {
    this.api = api;
  }

  request<T = Record<string, unknown>>(message: GenericRuntimeMessage): Promise<T> {
    return new Promise<T>((resolve) => {
      try {
        this.api.runtime.sendMessage(message, (response) => {
          const error = this.api.runtime.lastError;
          if (error) {
            resolve({
              ok: false,
              error: error.message || '与扩展后台通信失败',
            } as T);
            return;
          }
          resolve((response || { ok: false, error: '扩展后台无响应' }) as T);
        });
      } catch (error) {
        resolve({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } as T);
      }
    });
  }
}

export function createChromeRuntimeAdapter(api: ChromeRuntimeLike = chrome): RuntimePort {
  return new ChromeRuntimeAdapter(api);
}
