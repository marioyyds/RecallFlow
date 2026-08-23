// 用户脚本持久化：chrome.storage.local 中的 CRUD。

export const USERSCRIPTS_KEY = 'recallflow.userscripts.v1';

function storage() {
  return typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
}

export async function listScripts() {
  const area = storage();
  if (!area) return [];
  const data = await area.get(USERSCRIPTS_KEY);
  const map = data[USERSCRIPTS_KEY] || {};
  return Object.values(map).sort((a, b) => (b.installedAt || 0) - (a.installedAt || 0));
}

export async function getScript(id) {
  const area = storage();
  if (!area || !id) return null;
  const data = await area.get(USERSCRIPTS_KEY);
  return (data[USERSCRIPTS_KEY] || {})[id] || null;
}

export async function saveScript(script) {
  const area = storage();
  if (!area || !script || !script.id) return null;
  const data = await area.get(USERSCRIPTS_KEY);
  const map = data[USERSCRIPTS_KEY] || {};
  map[script.id] = script;
  await area.set({ [USERSCRIPTS_KEY]: map });
  return script;
}

export async function removeScript(id) {
  const area = storage();
  if (!area || !id) return false;
  const data = await area.get(USERSCRIPTS_KEY);
  const map = data[USERSCRIPTS_KEY] || {};
  if (!map[id]) return false;
  delete map[id];
  await area.set({ [USERSCRIPTS_KEY]: map });
  await area.remove('recallflow.userscript-values.' + id).catch(() => {});
  return true;
}
