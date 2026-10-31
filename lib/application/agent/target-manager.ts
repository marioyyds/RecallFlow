// 统一 Target 管理：集中维护「当前操作目标」（标签页/框架）与浏览器级事件
// （JS 对话框 / 下载 / 文件选择），让 Agent 对弹窗、下载、对话框有统一入口。
import * as cdp from '../../backend/cdp.ts';

/** CDP 事件原样保留的字段（形状由 Chrome 协议决定，扩展侧只读不做静态校验）。 */
type CdpEventRecord = Record<string, unknown>;

interface TargetBucket {
  dialogs: CdpEventRecord[];
  downloads: CdpEventRecord[];
  fileChoosers: CdpEventRecord[];
}

const state = new Map<number, TargetBucket>(); // tabId -> { dialogs, downloads, fileChoosers }
let listening = false;
let restorePromise: Promise<void> | null = null;
const observedDownloadTabs = new Set<number>();
const readyDownloadTabs = new Set<number>();
const DOWNLOADS_STORAGE_KEY = 'recallflow.downloadsByTab.v1';
const MAX_DOWNLOADS_PER_TAB = 100;

function bucket(tabId: number) {
  const id = Number(tabId);
  let rec = state.get(id);
  if (!rec) {
    rec = { dialogs: [], downloads: [], fileChoosers: [] };
    state.set(id, rec);
  }
  return rec;
}

export function initTargetManager() {
  if (!restorePromise) restorePromise = restoreDownloads().catch(() => {});
  if (listening || !cdp.isCdpAvailable() || !chrome.debugger || !chrome.debugger.onEvent) return;
  listening = true;
  if (chrome.debugger.onDetach) {
    chrome.debugger.onDetach.addListener((source) => {
      if (source && source.tabId != null) {
        observedDownloadTabs.delete(Number(source.tabId));
        readyDownloadTabs.delete(Number(source.tabId));
      }
    });
  }
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const sourceTabId = source && source.tabId;
    const observed = Array.from(observedDownloadTabs);
    const tabId = sourceTabId == null
      ? (observed.length === 1 ? observed[0] : null)
      : Number(sourceTabId);
    if (tabId == null || !Number.isInteger(tabId)) return;
    const rec = bucket(tabId);
    if (method === 'Page.javascriptDialogOpening') {
      rec.dialogs.push({ type: (params as Record<string, unknown>).type, message: (params as Record<string, unknown>).message, defaultPrompt: (params as Record<string, unknown>).defaultPrompt, at: Date.now() });
    } else if (
      method === 'Page.downloadWillBegin' ||
      method === 'Browser.downloadWillBegin' ||
      method === 'Page.downloadProgress' ||
      method === 'Browser.downloadProgress'
    ) {
      rec.downloads = mergeDownloadEvent(rec.downloads, method, params as Record<string, unknown>, Date.now());
      persistDownloadsSoon();
    } else if (method === 'Page.fileChooserOpened') {
      rec.fileChoosers.push({ mode: (params as Record<string, unknown>).mode, backendNodeId: (params as Record<string, unknown>).backendNodeId, at: Date.now() });
    }
  });
}

function downloadKey(item: Record<string, unknown>) {
  const guid = String(item.guid || '').trim();
  if (guid) return 'guid:' + guid;
  return 'url:' + String(item.url || '') + '|' + String(item.suggestedFilename || '');
}

/**
 * 合并 Page / Browser 两套下载事件。
 *
 * Chrome 可能同时上报同一个下载的 Page.downloadWillBegin 与
 * Browser.downloadWillBegin；有 guid 时以 guid 去重，没有 guid 时退回 URL+文件名。
 * progress 事件只更新已有记录，更新状态和字节数，不新增没有开始事件的幽灵项。
 */
export function mergeDownloadEvent(
  current: CdpEventRecord[],
  method: string,
  params: Record<string, unknown>,
  at = Date.now()
) {
  const list = Array.isArray(current) ? current.map((item) => ({ ...item })) : [];
  const item = {
    guid: String(params.guid || '').trim() || undefined,
    url: String(params.url || '').trim() || undefined,
    suggestedFilename: String(params.suggestedFilename || '').trim() || undefined,
  };
  const key = downloadKey(item);
  const index = list.findIndex((existing) => downloadKey(existing) === key);
  const isProgress = method.endsWith('downloadProgress');
  if (isProgress) {
    if (index < 0) return list;
    list[index] = {
      ...list[index],
      state: String(params.state || list[index].state || ''),
      receivedBytes: Number(params.receivedBytes) || 0,
      totalBytes: Number(params.totalBytes) || 0,
      updatedAt: at,
    };
    return list;
  }
  if (index >= 0) {
    list[index] = {
      ...list[index],
      ...item,
      updatedAt: at,
    };
    return list;
  }
  list.push({
    ...item,
    state: 'inProgress',
    receivedBytes: 0,
    totalBytes: 0,
    at,
    updatedAt: at,
  });
  return list.slice(-MAX_DOWNLOADS_PER_TAB);
}

/**
 * 幂等开启某个 tab 的下载观测。
 *
 * 关键不是注册 chrome.debugger.onEvent（那只是监听器），而是先 attach 并启用 Page 域；
 * 同时用 Browser.setDownloadBehavior(eventsEnabled:true) 让新版 Chromium 的 Browser 事件
 * 也可用，失败时退回旧 Page 命令。
 */
export async function ensureDownloadObservation(tabId: number, downloadPath?: string) {
  const id = Number(tabId);
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, result: '无法定位当前标签页，下载观测未开启。' };
  }
  initTargetManager();
  if (restorePromise) await restorePromise;
  if (readyDownloadTabs.has(id)) {
    return {
      ok: true,
      result: '下载观测已开启。',
      browserEvents: true,
      pageEvents: true,
      reused: true,
    };
  }
  if (!cdp.isCdpAvailable()) {
    return { ok: false, result: '当前浏览器不支持 chrome.debugger，无法捕获下载事件。' };
  }
  observedDownloadTabs.add(id);
  try {
    await cdp.attach(id);
    await cdp.command(id, 'Page.enable');
    // Page.enable 成功就足以接收 Page.downloadWillBegin。Browser.setDownloadBehavior
    // 需要 browser-level 调试目标，在 chrome.debugger 的 tab session 上通常会返回
    // “Cannot access browser-level commands”；它是增强项，不能反过来否定 Page 域观测。
    readyDownloadTabs.add(id);
    const params: { behavior: string; eventsEnabled: boolean; downloadPath?: string } = {
      behavior: 'allow',
      eventsEnabled: true,
    };
    if (downloadPath) params.downloadPath = downloadPath;
    let browserEvents = true;
    try {
      await cdp.command(id, 'Browser.setDownloadBehavior', params);
    } catch {
      browserEvents = false;
      // 新版 Chromium 里 Page.setDownloadBehavior 也可能被映射成 browser-level
      // 命令而同样失败；保持 Page 事件监听即可，不要因此阻断下载任务。
      await cdp.command(
        id,
        'Page.setDownloadBehavior',
        downloadPath ? { behavior: 'allow', downloadPath } : { behavior: 'allow' }
      ).catch(() => {});
    }
    return {
      ok: true,
      result: '下载观测已开启。',
      browserEvents,
      pageEvents: true,
    };
  } catch (error) {
    observedDownloadTabs.delete(id);
    readyDownloadTabs.delete(id);
    return {
      ok: false,
      result:
        '开启下载观测失败：' +
        String(error && (error as { message?: string }).message || error),
    };
  }
}

export function isDownloadObservationActive(tabId: number) {
  return observedDownloadTabs.has(Number(tabId) || 0);
}

/** 下载/导出任务需要在点击前开启观测，不能等 read_diagnostics 再补。 */
export function shouldObserveDownloads(instruction: unknown) {
  return /(下载|导出|另存为|保存成文件|保存为文件|download|export|save\s+as)/i.test(
    String(instruction || '')
  );
}

export function getPendingDialogs(tabId: number) {
  return bucket(tabId).dialogs;
}
export function clearDialogs(tabId: number) {
  bucket(tabId).dialogs = [];
}
export function getDownloads(tabId: number) {
  return bucket(tabId).downloads;
}
export function clearDownloads(tabId: number) {
  bucket(tabId).downloads = [];
  persistDownloadsSoon();
}
export function getFileChoosers(tabId: number) {
  return bucket(tabId).fileChoosers;
}
export function clearFileChoosers(tabId: number) {
  bucket(tabId).fileChoosers = [];
}

// 处理（接受/取消）当前页面的 JS 对话框（alert/confirm/prompt）。
export async function handleDialog(tabId: number, accept: unknown, promptText?: string) {
  await cdp.handleJavaScriptDialog(tabId, accept !== false, promptText);
  clearDialogs(tabId);
  return { ok: true };
}

// 允许当前标签页下载到指定目录（缺省为浏览器默认下载目录）。
export async function allowDownloads(tabId: number, downloadPath: string | undefined) {
  return ensureDownloadObservation(tabId, downloadPath);
}

function getSessionStorage() {
  try {
    return chrome && chrome.storage && chrome.storage.session;
  } catch {
    return null;
  }
}

async function restoreDownloads() {
  const store = getSessionStorage();
  if (!store || typeof store.get !== 'function') return;
  try {
    const saved = await store.get(DOWNLOADS_STORAGE_KEY);
    const byTab = saved && saved[DOWNLOADS_STORAGE_KEY];
    if (!byTab || typeof byTab !== 'object') return;
    for (const [key, value] of Object.entries(byTab)) {
      const id = Number(key);
      if (!Number.isInteger(id) || !Array.isArray(value)) continue;
      bucket(id).downloads = value.filter((item) => item && typeof item === 'object');
    }
  } catch {}
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persistDownloadsSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistDownloads();
  }, 0);
}

async function persistDownloads() {
  const store = getSessionStorage();
  if (!store || typeof store.set !== 'function') return;
  const byTab: Record<string, CdpEventRecord[]> = {};
  for (const [tabId, rec] of state) {
    if (rec.downloads.length) byTab[String(tabId)] = rec.downloads;
  }
  try {
    await store.set({ [DOWNLOADS_STORAGE_KEY]: byTab });
  } catch {}
}
