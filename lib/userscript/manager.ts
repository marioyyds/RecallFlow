// 用户脚本管理器（后台）：安装 / 更新 / 启停 / 卸载 + chrome.scripting 动态注册。
import { parseUserscriptMetadata, hashId } from './metadata.ts';
import { buildMatchPatterns, normalizeMatchPattern } from './match.ts';
import { listScripts, getScript, saveScript, removeScript } from './store.ts';
import type { UserscriptScript } from './store.ts';
import { fetchText, searchGreasyFork } from './greasyfork.ts';
import { getUserscriptSettings } from './settings.ts';

/** `@run-at` 的油猴取值 → `chrome.scripting` 的 `runAt` 取值。未知值回退 idle（最稳）。 */
const RUN_AT_MAP: Record<string, string> = {
  'document-start': 'document_start',
  'document-end': 'document_end',
  'document-idle': 'document_idle',
  'context-menu': 'document_idle',
};

function runAtValue(runAt: unknown): string {
  return RUN_AT_MAP[String(runAt || 'document-idle')] || 'document_idle';
}

/** `catch` 到的东西是 unknown —— 统一在这里取 message，避免 `e.message` 直接报错。 */
function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 让 chrome.scripting 的注册状态与存储一致：多退少补。
export async function syncUserscriptRegistrations(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.registerContentScripts) return;
  const scripts = (await listScripts()).filter((s) => s.enabled && Array.isArray(s.matches) && s.matches.length);
  let existing: chrome.scripting.RegisteredContentScript[] = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts();
  } catch (e) {
    existing = [];
  }
  const existingIds = new Set(existing.map((s) => s.id));
  const wantedIds = new Set(scripts.map((s) => s.id));
  const toRemove = Array.from(existingIds).filter((id) => id.startsWith('us-') && !wantedIds.has(id));
  if (toRemove.length) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: toRemove });
    } catch (e) {
      // 忽略注册表竞态
    }
  }
  const toAdd = scripts
    .filter((s) => !existingIds.has(s.id))
    .map((s) => ({
      id: s.id,
      matches: s.matches,
      excludeMatches: Array.isArray(s.excludeMatches) && s.excludeMatches.length ? s.excludeMatches : undefined,
      js: ['lib/userscript/runner.js'],
      runAt: runAtValue(s.runAt),
      allFrames: !s.noframes,
    }));
  for (const item of toAdd) {
    try {
      await chrome.scripting.registerContentScripts([item as chrome.scripting.RegisteredContentScript]);
    } catch (e) {
      console.warn('[RecallFlow] 注册脚本失败', item.id, errMessage(e));
    }
  }
}

/** 由脚本代码构建的可安装对象：元信息 + 已下载的 @require / @resource。 */
export interface DownloadedScript extends UserscriptScript {
  id: string;
  matches: string[];
  grants: string[];
  requires: string[];
  resources: Record<string, string>;
  requiresCode: string[];
  warnings: string[];
  sourceUrl: string;
  updateURL: string;
  code: string;
}

// 由脚本代码构建可安装对象（解析元信息 + 下载 @require/@resource）。
async function buildScriptFromCode(code: string, sourceUrl: string): Promise<DownloadedScript> {
  const meta = parseUserscriptMetadata(code);
  if (!meta.valid) throw new Error('脚本缺少有效的 // ==UserScript== 元信息：' + sourceUrl);
  const { patterns, warnings } = buildMatchPatterns(meta);
  if (!patterns.length) {
    throw new Error('脚本没有可注册的 @match/@include 规则：' + sourceUrl);
  }
  // 脚本未声明 @run-at 时，回退到用户设置页选择的默认运行时机。
  const settings = await getUserscriptSettings();

  // @require：安装时下载并内联，避免运行时跨域。
  const requiresCode: string[] = [];
  const requireWarnings: string[] = [];
  for (const req of meta.require || []) {
    try {
      requiresCode.push(await fetchText(req));
    } catch (e) {
      requireWarnings.push('无法下载依赖：' + req);
    }
  }

  // @resource：下载并缓存文本（GM_getResourceText 使用）。
  const resources: Record<string, string> = {};
  for (const entry of meta.resource || []) {
    const sp = entry.indexOf(' ');
    const name = sp > 0 ? entry.slice(0, sp).trim() : '';
    const url = sp > 0 ? entry.slice(sp + 1).trim() : '';
    if (!name || !/^https?:\/\//i.test(url)) continue;
    try {
      resources[name] = await fetchText(url);
    } catch (e) {
      requireWarnings.push('无法下载资源：' + name);
    }
  }

  const id = 'us-' + hashId(meta.name, meta.namespace || '', sourceUrl);
  return {
    id,
    name: meta.name,
    version: meta.version || '0',
    namespace: meta.namespace || '',
    description: meta.description || '',
    author: meta.author || '',
    icon: meta.icon || '',
    homepageURL: meta.homepageURL || '',
    runAt: meta.runAt || settings.defaultRunAt,
    noframes: meta.noframes,
    matches: patterns,
    excludeMatches: (meta.exclude || [])
      .map((p) => normalizeMatchPattern(p))
      .filter((p): p is string => Boolean(p)),
    grants: meta.grant || [],
    requires: meta.require || [],
    resources,
    code,
    requiresCode,
    sourceUrl,
    updateURL: meta.updateURL || meta.downloadURL || sourceUrl,
    warnings: warnings.concat(requireWarnings),
  };
}

async function downloadScript(sourceUrl: string): Promise<DownloadedScript> {
  const code = await fetchText(sourceUrl);
  return buildScriptFromCode(code, sourceUrl);
}

function previewFrom(downloaded: DownloadedScript) {
  return {
    id: downloaded.id,
    name: downloaded.name,
    version: downloaded.version,
    description: downloaded.description,
    author: downloaded.author,
    icon: downloaded.icon,
    homepageURL: downloaded.homepageURL,
    matches: downloaded.matches,
    grants: downloaded.grants,
    requires: downloaded.requires,
    warnings: downloaded.warnings,
  };
}

async function saveDownloaded(downloaded: DownloadedScript): Promise<UserscriptScript> {
  const existing = await getScript(downloaded.id);
  const script = Object.assign(
    { installedAt: existing ? existing.installedAt : Date.now() },
    downloaded,
    { id: downloaded.id, updatedAt: Date.now(), enabled: existing ? existing.enabled : true }
  );
  await saveScript(script);
  await syncUserscriptRegistrations();
  return script;
}

/**
 * 安装（或覆盖更新）一个脚本。existing 用于保留用户启停状态。
 */
export async function installFromUrl(sourceUrl: string) {
  const downloaded = await downloadScript(sourceUrl);
  return { ok: true, script: await saveDownloaded(downloaded) };
}

// 从粘贴的代码安装（便于测试与本地脚本）。
export async function installFromCode(code: string, sourceLabel?: string) {
  const downloaded = await buildScriptFromCode(code, sourceLabel || '粘贴代码');
  return { ok: true, script: await saveDownloaded(downloaded) };
}

// 安装前预览：只解析不保存，供权限确认。
export async function previewScript(sourceUrl: string) {
  const downloaded = await downloadScript(sourceUrl);
  return { ok: true, preview: previewFrom(downloaded) };
}

export async function previewCode(code: string) {
  const downloaded = await buildScriptFromCode(code, '粘贴代码');
  return { ok: true, preview: previewFrom(downloaded) };
}

export async function updateScript(id: string) {
  const existing = await getScript(id);
  if (!existing) return { ok: false, error: '脚本不存在：' + id };
  const source = existing.updateURL || existing.sourceUrl || '';
  const installed = await installFromUrl(source);
  if (!installed.script) return { ok: false, error: '更新失败：' + id };
  installed.script.enabled = existing.enabled;
  await saveScript(installed.script);
  await syncUserscriptRegistrations();
  return { ok: true, script: installed.script, updated: true };
}

// 全部更新：逐个检查，返回成功/失败数量与首几条错误。
export async function updateAllScripts() {
  const scripts = await listScripts();
  const results = { total: scripts.length, updated: 0, failed: 0, errors: [] as string[] };
  for (const s of scripts) {
    try {
      await updateScript(s.id);
      results.updated += 1;
    } catch (e) {
      results.failed += 1;
      if (results.errors.length < 3) results.errors.push(String(s.name) + '：' + errMessage(e));
    }
  }
  return results;
}

export async function setScriptEnabled(id: string, enabled: unknown) {
  const script = await getScript(id);
  if (!script) return { ok: false, error: '脚本不存在：' + id };
  script.enabled = Boolean(enabled);
  await saveScript(script);
  await syncUserscriptRegistrations();
  return { ok: true, script };
}

export async function uninstallScript(id: string) {
  await removeScript(id);
  await syncUserscriptRegistrations();
  return { ok: true };
}

interface TabRunResult {
  ok: boolean;
  error?: string;
  result?: string;
}

// Agent 工具：让某个已安装脚本在当前标签页立即运行（不要求 URL 匹配）。
export async function runUserscriptOnTab(tabId: number, scriptId: string): Promise<TabRunResult> {
  if (!tabId) return { ok: false, error: '无法定位当前标签页' };
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: '脚本不存在：' + scriptId };
  if (!script.enabled) return { ok: false, error: '脚本已停用：' + script.name };
  const deliver = () =>
    new Promise<TabRunResult>((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'userscript:runNow', script }, (res: TabRunResult | undefined) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false, error: '页面无响应' });
      });
    });
  let res = await deliver();
  // 页面还没有注入运行时：先注入 runner.js，再执行。
  if (!res.ok && /Receiving end does not exist|Could not establish connection|message port closed/i.test(res.error || '')) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/userscript/runner.js'] });
      res = await deliver();
    } catch (e) {
      return { ok: false, error: '注入脚本运行时失败：' + errMessage(e) };
    }
  }
  return res;
}

export async function searchScripts(q: string) {
  return searchGreasyFork(q);
}

/** GM_xmlhttpRequest 的请求描述（来自页面侧的 GM 垫片）。 */
export interface UserscriptXhrDetails {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  data?: unknown;
}

/**
 * GM_xmlhttpRequest 的后台实现：受 host_permissions 约束。
 */
export async function userscriptXhr(details: UserscriptXhrDetails | null | undefined) {
  const url = String((details && details.url) || '');
  if (!/^https?:\/\//i.test(url)) return { error: '仅支持 http/https：' + url };
  try {
    const resp = await fetch(url, {
      method: String(details?.method || 'GET').toUpperCase(),
      headers: (details && details.headers && typeof details.headers === 'object') ? details.headers : undefined,
      body: details?.data !== undefined ? (details.data as BodyInit) : undefined,
      redirect: 'follow',
    });
    const responseText = await resp.text();
    return {
      status: resp.status,
      statusText: resp.statusText,
      responseText,
      finalUrl: resp.url || url,
      ok: true,
    };
  } catch (e) {
    return { error: errMessage(e) + '（目标域名需在 manifest.json 的 host_permissions 中授权）' };
  }
}

export { listScripts };
