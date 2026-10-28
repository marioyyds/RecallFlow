import type { TabSummary, TabsPort } from '../../application/ports/tabs.ts';

export interface ChromeTabsLike {
  tabs: {
    query(queryInfo: Record<string, unknown>, callback: (tabs: TabSummary[]) => void): void;
    create(properties: { url: string }, callback?: (tab: TabSummary) => void): void;
  };
  runtime: { lastError?: { message?: string } | null };
}

export class ChromeTabsAdapter implements TabsPort {
  private readonly api: ChromeTabsLike;

  constructor(api: ChromeTabsLike = chrome) {
    this.api = api;
  }

  query(queryInfo: Record<string, unknown>): Promise<TabSummary[]> {
    return new Promise((resolve) => {
      try {
        this.api.tabs.query(queryInfo, (tabs) => {
          resolve(this.api.runtime.lastError ? [] : tabs || []);
        });
      } catch (error) {
        resolve([]);
      }
    });
  }

  open(url: string): Promise<number | undefined> {
    return new Promise((resolve) => {
      try {
        this.api.tabs.create({ url }, (tab) => {
          resolve(this.api.runtime.lastError ? undefined : tab?.id);
        });
      } catch (error) {
        resolve(undefined);
      }
    });
  }
}

export function createChromeTabsAdapter(api: ChromeTabsLike = chrome): TabsPort {
  return new ChromeTabsAdapter(api);
}
