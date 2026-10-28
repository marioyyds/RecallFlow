export interface TabSummary {
  id?: number;
  url?: string;
  title?: string;
}

export interface TabsPort {
  query(queryInfo: Record<string, unknown>): Promise<TabSummary[]>;
  open(url: string): Promise<number | undefined>;
}
