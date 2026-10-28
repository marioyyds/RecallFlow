import { createLruCache } from '../../shared/lru.ts';

export interface ScreenshotViewPorts {
  load(id: string): Promise<{ dataUrl?: string } | null>;
  escape(value: unknown): string;
  getPanel(): any;
  canRepaint(): boolean;
  onRepaint(): void;
  cacheSize?: number;
}

/** Renders persisted screenshots and owns their bounded in-memory cache. */
export class PanelScreenshotView {
  readonly cache: ReturnType<typeof createLruCache>;
  lightboxOpen = false;
  private readonly pending = new Set<string>();
  private readonly missingIds = new Set<string>();
  private readonly ports: ScreenshotViewPorts;

  constructor(ports: ScreenshotViewPorts) {
    this.ports = ports;
    this.cache = createLruCache(ports.cacheSize || 30);
  }

  private caption(meta: any): string {
    const value = meta || {};
    const parts = [];
    if (value.label) parts.push(String(value.label));
    if (value.width && value.height) parts.push(value.width + '×' + value.height);
    if (value.bytes) parts.push(Math.round(Number(value.bytes) / 1024) + 'KB');
    return parts.join(' · ');
  }

  private hydrate(id: string): void {
    if (!id || this.cache.get(id) || this.pending.has(id) || this.missingIds.has(id)) return;
    this.pending.add(id);
    this.ports
      .load(id)
      .then((shot) => {
        if (shot && shot.dataUrl) this.cache.set(id, shot.dataUrl);
        else this.missingIds.add(id);
      })
      .catch(() => this.missingIds.add(id))
      .finally(() => {
        this.pending.delete(id);
        if (this.ports.canRepaint()) this.ports.onRepaint();
      });
  }

  html(meta: any): string {
    const value = meta || {};
    const id = String(value.id || '');
    const url = id ? this.cache.get(id) : '';
    if (!url) {
      const missing = id && this.missingIds.has(id);
      if (id && !missing) this.hydrate(id);
      return (
        '<div class="agent-shot gone">🖼 截图' +
        (value.label ? '（' + this.ports.escape(String(value.label)) + '）' : '') +
        '：' +
        (!id
          ? '缺少截图标识，无法从共享存储恢复'
          : missing
            ? '共享存档已过期或已被清理'
            : '正在从共享会话加载图片…') +
        '</div>'
      );
    }
    return (
      '<div class="agent-shot"><img src="' +
      this.ports.escape(url) +
      '" alt="' +
      this.ports.escape(String(value.label || '页面截图')) +
      '" loading="lazy"><span class="agent-shot-cap">🖼 ' +
      this.ports.escape(this.caption(value)) +
      ' · 点击放大</span></div>'
    );
  }

  element(meta: any): Element | null {
    const wrap = document.createElement('div');
    wrap.innerHTML = this.html(meta);
    return wrap.firstElementChild;
  }

  openLightbox(url: unknown): void {
    const panel = this.ports.getPanel();
    if (!url || !panel) return;
    const box = document.createElement('div');
    box.className = 'shot-lightbox';
    const image = document.createElement('img');
    image.src = String(url);
    box.appendChild(image);
    box.addEventListener('click', () => {
      box.remove();
      this.lightboxOpen = false;
    });
    this.lightboxOpen = true;
    panel.appendChild(box);
  }
}
