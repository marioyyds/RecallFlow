/** 知识库领域的稳定数据契约；不得反向依赖存储、UI 或 Agent。 */
export interface KnowledgeItem {
  id: string;
  type: string;
  title: string;
  url: string;
  platform: string;
  platformName: string;
  status: number | string;
  note: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export type KnowledgeBook = Record<string, KnowledgeItem>;

export interface CitationMeta {
  index: number;
  source: string;
  id: string;
  title: string;
  type: string;
  url: string;
  snippet: string;
  isOverview: boolean;
}
