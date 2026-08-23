// 用户脚本元信息解析：提取 // ==UserScript== 头中的键值对（@match / @grant / @require 等）。

const DEFAULT_GRANTS = ['GM_addStyle', 'GM_setValue', 'GM_getValue'];

export function emptyMetadata() {
  return {
    name: '',
    namespace: '',
    version: '',
    description: '',
    author: '',
    match: [],
    include: [],
    exclude: [],
    require: [],
    resource: [],
    grant: [],
    runAt: '',
    noframes: false,
    updateURL: '',
    downloadURL: '',
    homepageURL: '',
    icon: '',
  };
}

/**
 * 解析用户脚本代码中的元信息块。
 * @param {string} code
 * @returns {Object} metadata（含 valid 标记）
 */
export function parseUserscriptMetadata(code) {
  const meta = emptyMetadata();
  const m = String(code || '').match(/\/\/\s*==UserScript==\s*([\s\S]*?)\/\/\s*==\/UserScript==/i);
  if (!m) return Object.assign(meta, { valid: false, error: '未找到 // ==UserScript== 元信息块' });
  const body = m[1];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('//')) continue;
    const content = line.replace(/^\/\/\s*/, '');
    const idx = content.indexOf(' ');
    const key = (idx < 0 ? content : content.slice(0, idx)).trim();
    const value = idx < 0 ? '' : content.slice(idx + 1).trim();
    const keys = key.split(':');
    const k = (keys[0] || '').replace(/^@/, '');
    const sub = keys[1] || '';
    switch (k) {
      case 'name':
        if (!sub && !meta.name) meta.name = value;
        else if (sub === 'zh-CN' && !meta.name) meta.name = value;
        break;
      case 'namespace': meta.namespace = value; break;
      case 'version': meta.version = value; break;
      case 'description': if (!sub) meta.description = value; break;
      case 'author': meta.author = value; break;
      case 'match': meta.match.push(value); break;
      case 'include': meta.include.push(value); break;
      case 'exclude': meta.exclude.push(value); break;
      case 'require': meta.require.push(value); break;
      case 'resource': meta.resource.push(value); break;
      case 'grant': meta.grant.push(value); break;
      case 'run-at': meta.runAt = value; break;
      case 'noframes': meta.noframes = !value || /true|1/i.test(value); break;
      case 'updateURL': meta.updateURL = value; break;
      case 'downloadURL': meta.downloadURL = value; break;
      case 'homepageURL': meta.homepageURL = value; break;
      case 'icon': if (!sub) meta.icon = value; break;
      default: break;
    }
  }
  // 未显式声明 grant 时按油猴惯例提供最基础 API。
  if (!meta.grant.length) meta.grant = DEFAULT_GRANTS.slice();
  return Object.assign(meta, { valid: Boolean(meta.name) });
}

export function hashId(...parts) {
  const text = parts.join('|');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
