export type PanelTheme = 'light' | 'dark';

export interface ThemeEnvironment {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  prefersDark(): boolean;
  watchSystem(listener: () => void): void;
}

const THEME_KEY = 'recallflow-panel-theme';

/** Owns the panel's persisted theme override and its rendered control. */
export class PanelThemeController {
  panel: any = null;
  button: any = null;
  private readonly environment: ThemeEnvironment;

  constructor(environment?: ThemeEnvironment) {
    this.environment = environment || {
      storage: localStorage,
      prefersDark() {
        try {
          return matchMedia('(prefers-color-scheme: dark)').matches;
        } catch {
          return false;
        }
      },
      watchSystem(listener) {
        try {
          const media = matchMedia('(prefers-color-scheme: dark)');
          if (media.addEventListener) media.addEventListener('change', listener);
          else if (media.addListener) media.addListener(listener);
        } catch {}
      },
    };
  }

  init(): void {
    this.environment.watchSystem(() => {
      if (!this.savedOverride()) this.apply();
    });
  }

  savedOverride(): '' | PanelTheme {
    try {
      const value = this.environment.storage.getItem(THEME_KEY);
      return value === 'dark' || value === 'light' ? value : '';
    } catch {
      return '';
    }
  }

  preferred(): PanelTheme {
    const saved = this.savedOverride();
    if (saved) return saved;
    return this.environment.prefersDark() ? 'dark' : 'light';
  }

  apply(): void {
    if (!this.panel) return;
    const mode = this.preferred();
    this.panel.classList.toggle('dark', mode === 'dark');
    if (!this.button) return;
    const override = this.savedOverride();
    const label = override
      ? '主题：' + (mode === 'dark' ? '深色' : '浅色') + '（点击切换）'
      : '主题：跟随系统（点击切换）';
    this.button.textContent = override ? (mode === 'dark' ? '🌙' : '☀️') : '🌗';
    this.button.title = label;
    this.button.setAttribute('aria-label', label);
  }

  cycle(): void {
    const current = this.savedOverride();
    const next = current === '' ? 'dark' : current === 'dark' ? 'light' : '';
    try {
      if (next) this.environment.storage.setItem(THEME_KEY, next);
      else this.environment.storage.removeItem(THEME_KEY);
    } catch {}
    this.apply();
  }
}
