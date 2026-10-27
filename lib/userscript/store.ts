// 用户脚本持久化：chrome.storage.local 中的 CRUD。

export const USERSCRIPTS_KEY = 'recallflow.userscripts.v1';

/** 一条已安装的用户脚本。字段全部可选 —— 数据来自用户粘贴的 `.user.js` 头与 GreasyFork，
 *  没有任何一层会校验形状，因此消费者一律按「可能缺字段」处理。 */
export interface UserscriptScript {
  id: string;
  name?: string;
  version?: string;
  namespace?: string;
  description?: string;
  author?: string;
  icon?: string;
  homepageURL?: string;
  runAt?: string;
  noframes?: boolean;
  matches?: string[];
  excludeMatches?: string[];
  grants?: string[];
  requires?: string[];
  resources?: Record<string, string>;
  code?: string;
  requiresCode?: string[];
  sourceUrl?: string;
  updateURL?: string;
  warnings?: string[];
  enabled?: boolean;
  installedAt?: number;
  updatedAt?: number;
  [key: string]: unknown;
}

export type UserscriptMap = Record<string, UserscriptScript>;

function storage() {
  return typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
}

export async function listScripts(): Promise<UserscriptScript[]> {
  const area = storage();
  if (!area) return [];
  const data = await area.get(USERSCRIPTS_KEY);
  const map = (data[USERSCRIPTS_KEY] || {}) as UserscriptMap;
  return Object.values(map).sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
}

export async function getScript(id: string): Promise<UserscriptScript | null> {
  const area = storage();
  if (!area || !id) return null;
  const data = await area.get(USERSCRIPTS_KEY);
  const map = (data[USERSCRIPTS_KEY] || {}) as UserscriptMap;
  return map[id] || null;
}

export async function saveScript(script: UserscriptScript): Promise<UserscriptScript | null> {
  const area = storage();
  if (!area || !script || !script.id) return null;
  const data = await area.get(USERSCRIPTS_KEY);
  const map = (data[USERSCRIPTS_KEY] || {}) as UserscriptMap;
  map[script.id] = script;
  await area.set({ [USERSCRIPTS_KEY]: map });
  return script;
}

export async function removeScript(id: string): Promise<boolean> {
  const area = storage();
  if (!area || !id) return false;
  const data = await area.get(USERSCRIPTS_KEY);
  const map = (data[USERSCRIPTS_KEY] || {}) as UserscriptMap;
  if (!map[id]) return false;
  delete map[id];
  await area.set({ [USERSCRIPTS_KEY]: map });
  await area.remove('recallflow.userscript-values.' + id).catch(() => {});
  return true;
}
