// 内容脚本入口源码（**不是**被 manifest 直接加载的文件）。
//
// 为什么要有这个文件：MV3 内容脚本**不能用静态 ES module**，
// 所以此前 content.js 只能写成 `import(chrome.runtime.getURL('lib/...'))` 的动态加载，
// 而这带来两个后果：
//   1. 那些模块必须写进 web_accessible_resources（打包前是 `lib/**/*.js`）——
//      于是**任何网页都能枚举并读取扩展源码**，包括 run_javascript 的黑名单实现；
//   2. 每页都要拉十几次模块（模块瀑布），且没有原子产物。
//
// 现在改成：本文件写**静态 import**（可被 esbuild 顺着解析），由 `scripts/build-content.mjs`
// 打成单文件 `content.js`（classic 脚本、自包含、无任何动态 import），manifest 只加载产物。
// 产物是构建物 —— **不要手工编辑 content.js**，改这里然后重新构建。
import * as pageText from '../lib/application/page/page-text.ts';
import * as commands from '../lib/ui/page/commands.ts';
import * as picker from '../lib/ui/page/picker.ts';
import * as debugCapture from '../lib/ui/page/debug-capture.ts';
import * as chat from '../lib/ui/page/chat.ts';
import { createChromeRuntimeAdapter } from '../lib/adapters/chrome/runtime.ts';
import { createChromeStorageAdapter } from '../lib/adapters/chrome/storage.ts';
import { createBrowserDocumentAdapter } from '../lib/adapters/dom/document.ts';

// 入口在 window 上挂的三样东西：本文件自己约定的全局槽位。
// 声明集中在这里（而不是散落 `as any`）：面板侧（chat.ts）与构建产物的 footer 都依赖它们。
declare global {
  interface Window {
    /** 防重复初始化：内容脚本被同一页面重复注入时只跑一次。 */
    __kbAiLoaded?: boolean;
    /** 打包后共享出去的 debug-capture 实例（面板侧抓控制台快照用）。 */
    __rfDebugCapture?: any;
    /** 入口函数挂载点，由 build-content.mjs 的 footer 在产物末尾调用。 */
    __rfContentInit?: () => void;
  }
}

// 是否顶层文档。注意 `window.top === window` 在跨域 iframe 里会**抛异常**，
// 而原先它没有任何保护 —— 异常会让整段初始化被跳过，表现为"某些页面下面板不出现"。
function detectTopFrame() {
  try {
    return window.top === window;
  } catch (e) {
    return false;
  }
}

export function initContentScript() {
  if (window.__kbAiLoaded) return;
  window.__kbAiLoaded = true;

  // 把已打包进来的模块共享出去，供面板侧（chat.js）直接使用。
  // 为什么必须这样：面板要"在交接的那一刻"抓一份控制台错误快照（见 chat.js 的
  // snapshotHandoff），而它此前是用 `import(chrome.runtime.getURL('lib/page/debug-capture.js'))`
  // 现取模块的。打包成单文件后那个 URL 不再指向任何可用模块 ——
  // 于是交接包里会**静默缺掉控制台错误快照**，而"事后已无法复现的错误"往往正是交接最关键的证据。
  // 通过这个共享引用，面板拿到的是同一个已打包实例，语义与打包前一致。
  window.__rfDebugCapture = debugCapture;

  const isTopFrame = detectTopFrame();

  // 响应后台的即时页面正文读取请求（Agent 工具 read_current_page）
  // 与页面命令请求（Agent 工具 page_command / 用户路径 API）
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'kbGetPageText') {
      const opt = (msg && msg.options) || {};
      const texts = Array.isArray(opt.checkTexts) ? opt.checkTexts : [];
      let payload;
      try {
        // 一次遍历同时产出「正文文本」与「可见性核查」，避免走两遍 DOM。
        payload = pageText.readTextWithVisibility(texts, { visibleOnly: opt.visibleOnly === true });
      } catch (e) {
        payload = { text: pageText.extractPageText(), visibility: null };
      }
      sendResponse({
        text: payload.text,
        visibility: payload.visibility,
        title: document.title || '',
        url: location.href,
      });
      return true;
    }
    if (msg && msg.type === 'kbGetConsole') {
      debugCapture.getDebugBuffer('console').then((entries) => sendResponse({ entries: entries || [] }));
      return true;
    }
    if (msg && msg.type === 'kbGetNetwork') {
      debugCapture.getDebugBuffer('network').then((entries) => sendResponse({ entries: entries || [] }));
      return true;
    }
    if (msg && msg.type === 'kbGetElementSource') {
      const selector = commands.resolveElementSelector(msg.params || {});
      if (!selector) {
        sendResponse({ found: false, reason: '未找到目标元素' });
        return true;
      }
      debugCapture.getElementSource(selector).then((src) => {
        if (src && src.file) sendResponse({ found: true, source: src, selector });
        else sendResponse({ found: false, selector, reason: '未检测到框架源码信息（可能不是 React/Vue/Svelte 开发构建）' });
      });
      return true;
    }
    if (msg && msg.type === 'kbVerifyTargets') {
      sendResponse({ targets: commands.verifyTargets((msg.params && msg.params.targets) || []) });
      return true;
    }
    if (msg && msg.type === 'kbGetPageSnapshot') {
      sendResponse(pageText.extractPageSnapshot(msg.options || {}));
      return true;
    }
    if (msg && msg.type === 'kbResolveTarget') {
      sendResponse(commands.resolveTargetInfo(msg.params || {}));
      return true;
    }
    if (msg && msg.type === 'kbUndo') {
      sendResponse(commands.undoLast());
      return true;
    }
    if (msg && msg.type === 'kbPickStart') {
      picker.startPicker(
        (pickedList) => {
          try { chrome.runtime.sendMessage({ type: 'pick:result', pickedList }); } catch (e) {}
        },
        () => {
          try { chrome.runtime.sendMessage({ type: 'pick:cancel' }); } catch (e) {}
        }
      );
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'kbPickCancel') {
      picker.stopPicker();
      return false;
    }
    if (msg && msg.type === 'kbTypeText') {
      Promise.resolve(commands.typeText(msg.params || {})).then(sendResponse);
      return true;
    }
    if (msg && msg.type === 'kbPressKey') {
      Promise.resolve(commands.pressKey(msg.params || {})).then(sendResponse);
      return true;
    }
    if (msg && msg.type === 'kbSelectOption') {
      Promise.resolve(commands.selectOption(msg.params || {})).then(sendResponse);
      return true;
    }
    if (msg && msg.type === 'kbCheckBox') {
      Promise.resolve(commands.checkBox(msg.params || {})).then(sendResponse);
      return true;
    }
    if (msg && msg.type === 'kbWaitForElement') {
      commands.waitForElement(msg.params || {}).then(sendResponse);
      return true;
    }
    if (msg && msg.type === 'kbGetAttribute') {
      Promise.resolve(commands.getAttribute(msg.params || {})).then(sendResponse);
      return true;
    }
    if (msg && msg.type === 'kbRunJavaScript') {
      Promise.resolve(commands.runJs(msg.params || {})).then(sendResponse);
      return true;
    }
    if (msg && msg.type === 'kbPageCommand') {
      Promise.resolve(commands.executePageCommand(msg.command, msg.params || {})).then(sendResponse);
      return true;
    }
    return false;
  });

  // 助手 UI 只在顶层文档初始化；子框架（含跨域 iframe）只保留消息处理，
  // 供后台按 frameId 在对应框架内执行页面命令（跨域 iframe 打通的关键）。
  if (isTopFrame) {
    chat.initAssistant({
      runtime: createChromeRuntimeAdapter(),
      storage: createChromeStorageAdapter(chrome.storage.local, chrome),
      dom: createBrowserDocumentAdapter(),
    });
  }
}

// 打包产物是 iife，模块导出不会自动执行。这里用**副作用**把入口挂到一个约定变量上，
// 由构建脚本在产物末尾调用（见 scripts/build-content.mjs 的 footer）。
// 为什么不在源文件里直接调用：源文件是被 bundle 的模块，直接调用也能工作，
// 但那样"入口何时执行"就藏在模块求值顺序里；显式挂载 + 显式调用更容易排查。
window.__rfContentInit = initContentScript;
