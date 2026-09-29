// 内容脚本入口（classic 脚本）：
// MV3 内容脚本不支持静态 ES module，这里用动态 import() 加载 lib/ 下的模块。
// 依赖的模块文件已在 manifest 的 web_accessible_resources 中声明。
if (window.__kbAiLoaded) {
} else {
  window.__kbAiLoaded = true;
  (async () => {
    const isTopFrame = window.top === window;
    // 所有框架都需要：正文/快照 + 页面命令（跨域 iframe 操作靠它）+ 元素拾取。
    const pageText = await import(chrome.runtime.getURL('lib/page/page-text.js'));
    const commands = await import(chrome.runtime.getURL('lib/page/commands.js'));
    const picker = await import(chrome.runtime.getURL('lib/page/picker.js'));
    // 调试捕获（console/network/元素源码）：所有框架都加载，以支持跨域 iframe 内的元素源码解析。
    const debugCapture = await import(chrome.runtime.getURL('lib/page/debug-capture.js'));

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
        if (!debugCapture) { sendResponse({ entries: [] }); return true; }
        debugCapture.getDebugBuffer('console').then((entries) => sendResponse({ entries: entries || [] }));
        return true;
      }
      if (msg && msg.type === 'kbGetNetwork') {
        if (!debugCapture) { sendResponse({ entries: [] }); return true; }
        debugCapture.getDebugBuffer('network').then((entries) => sendResponse({ entries: entries || [] }));
        return true;
      }
      if (msg && msg.type === 'kbGetElementSource') {
        const selector = commands.resolveElementSelector(msg.params || {});
        if (!selector || !debugCapture) {
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
      const chat = await import(chrome.runtime.getURL('lib/page/chat.js'));
      chat.initAssistant();
    }
  })();
}
