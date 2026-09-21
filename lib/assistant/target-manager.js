// 统一 Target 管理：集中维护「当前操作目标」（标签页/框架）与浏览器级事件
// （JS 对话框 / 下载 / 文件选择），让 Agent 对弹窗、下载、对话框有统一入口。
import * as cdp from '../backend/cdp.js';

const state = new Map(); // tabId -> { dialogs: [], downloads: [], fileChoosers: [] }
let listening = false;

function bucket(tabId) {
  const id = Number(tabId);
  let rec = state.get(id);
  if (!rec) {
    rec = { dialogs: [], downloads: [], fileChoosers: [] };
    state.set(id, rec);
  }
  return rec;
}

export function initTargetManager() {
  if (listening || !cdp.isCdpAvailable() || !chrome.debugger || !chrome.debugger.onEvent) return;
  listening = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source && source.tabId;
    if (tabId == null) return;
    const rec = bucket(tabId);
    if (method === 'Page.javascriptDialogOpening') {
      rec.dialogs.push({ type: params.type, message: params.message, defaultPrompt: params.defaultPrompt, at: Date.now() });
    } else if (method === 'Page.downloadWillBegin') {
      rec.downloads.push({ url: params.url, suggestedFilename: params.suggestedFilename, at: Date.now() });
    } else if (method === 'Page.fileChooserOpened') {
      rec.fileChoosers.push({ mode: params.mode, backendNodeId: params.backendNodeId, at: Date.now() });
    }
  });
}

export function getPendingDialogs(tabId) {
  return bucket(tabId).dialogs;
}
export function clearDialogs(tabId) {
  bucket(tabId).dialogs = [];
}
export function getDownloads(tabId) {
  return bucket(tabId).downloads;
}
export function clearDownloads(tabId) {
  bucket(tabId).downloads = [];
}
export function getFileChoosers(tabId) {
  return bucket(tabId).fileChoosers;
}
export function clearFileChoosers(tabId) {
  bucket(tabId).fileChoosers = [];
}

// 处理（接受/取消）当前页面的 JS 对话框（alert/confirm/prompt）。
export async function handleDialog(tabId, accept, promptText) {
  await cdp.handleJavaScriptDialog(tabId, accept !== false, promptText);
  clearDialogs(tabId);
  return { ok: true };
}

// 允许当前标签页下载到指定目录（缺省为浏览器默认下载目录）。
export async function allowDownloads(tabId, downloadPath) {
  const params = { behavior: 'allow', eventsEnabled: true };
  if (downloadPath) params.downloadPath = downloadPath;
  try {
    await cdp.command(tabId, 'Browser.setDownloadBehavior', params);
  } catch (e) {
    try {
      await cdp.command(tabId, 'Page.setDownloadBehavior', downloadPath ? { behavior: 'allow', downloadPath } : { behavior: 'allow' });
    } catch (e2) {}
  }
  return { ok: true };
}
