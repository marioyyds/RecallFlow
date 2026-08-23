// 用户脚本模块设置：默认值、读取与保存（独立于 AI 设置）。

export const USERSCRIPT_SETTINGS_KEY = 'recallflow.userscript.settings.v1';

export const USERSCRIPT_SETTINGS_DEFAULTS = {
  // 允许 Agent 通过 install_userscript 自动安装脚本。
  agentCanInstall: true,
  // 打开脚本中心或扩展启动时，自动检查全部脚本更新。
  autoCheckUpdates: false,
  // 脚本未显式声明 @run-at 时的默认运行时机。
  defaultRunAt: 'document-idle',
};

export const RUN_AT_OPTIONS = [
  { value: 'document-start', label: '页面加载前（document-start）', hint: '在 DOM 构建前执行，适合拦截请求、尽早改写页面' },
  { value: 'document-end', label: 'DOM 就绪后（document-end）', hint: 'DOM 解析完成、图片等资源仍在加载时执行' },
  { value: 'document-idle', label: '页面空闲时（document-idle）', hint: '页面加载完成后执行，默认且最稳定' },
];

export async function getUserscriptSettings() {
  const d = await chrome.storage.local.get(USERSCRIPT_SETTINGS_KEY);
  const saved = d[USERSCRIPT_SETTINGS_KEY] || {};
  return Object.assign({}, USERSCRIPT_SETTINGS_DEFAULTS, saved);
}

export async function saveUserscriptSettings(patch) {
  const current = await getUserscriptSettings();
  const next = Object.assign({}, current, patch || {});
  await chrome.storage.local.set({ [USERSCRIPT_SETTINGS_KEY]: next });
  return next;
}
