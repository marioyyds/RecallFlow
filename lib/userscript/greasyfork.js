// GreasyFork 搜索与脚本代码下载（后台使用，依赖 host_permissions）。

const SEARCH_ENDPOINT = 'https://greasyfork.org/zh-CN/scripts.json';

export async function fetchText(url, timeoutMs = 20000) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const resp = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl ? ctrl.signal : undefined,
      headers: { Accept: 'text/plain, application/javascript, */*' },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 搜索 GreasyFork 脚本。
 * @param {string} q
 * @returns {Promise<Array>} [{name, description, installs, codeUrl, pageUrl, updatedAt}]
 */
export async function searchGreasyFork(q) {
  const keyword = String(q || '').trim();
  if (!keyword) return [];
  const url = SEARCH_ENDPOINT + '?q=' + encodeURIComponent(keyword);
  const text = await fetchText(url);
  let list = [];
  try {
    list = JSON.parse(text);
  } catch (e) {
    throw new Error('GreasyFork 返回的不是有效 JSON');
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((it) => it && it.name && it.code_url)
    .map((it) => ({
      name: String(it.name || '').trim(),
      description: String(it.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180),
      installs: Number(it.total_installs || it.installs || 0),
      codeUrl: String(it.code_url || ''),
      pageUrl: String(it.url || ''),
      updatedAt: it.updated_at || '',
    }));
}

// 把 GreasyFork 的 code_url（如 .../code/xxx.user.js）作为安装源解析。
export function resolveInstallUrl(source) {
  const s = String(source || '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  return '';
}
