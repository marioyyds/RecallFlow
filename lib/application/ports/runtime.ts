export interface RuntimePort {
  request<T = Record<string, unknown>>(message: Record<string, unknown>): Promise<T>;
}

export const UNAVAILABLE_RUNTIME_PORT: RuntimePort = {
  async request() {
    return { ok: false, error: '扩展 Runtime 尚未注入' } as never;
  },
};
