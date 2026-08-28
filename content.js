// 内容脚本入口（classic 脚本）：
// MV3 内容脚本不支持静态 ES module，这里用动态 import() 加载 lib/ 下的模块。
// 依赖的模块文件已在 manifest 的 web_accessible_resources 中声明。
if (window.__kbAiLoaded) {
} else {
  window.__kbAiLoaded = true;
  (async () => {
    const chat = await import(chrome.runtime.getURL('lib/page/chat.js'));
    const pageText = await import(chrome.runtime.getURL('lib/page/page-text.js'));
    const commands = await import(chrome.runtime.getURL('lib/page/commands.js'));

    // 响应后台的即时页面正文读取请求（Agent 工具 read_current_page）
    // 与页面命令请求（Agent 工具 page_command / 用户路径 API）
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'kbGetPageText') {
        sendResponse({ text: pageText.extractPageText() });
        return true;
      }
      if (msg && msg.type === 'kbGetPageSnapshot') {
        sendResponse(pageText.extractPageSnapshot(msg.options || {}));
        return true;
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

    chat.initAssistant();
  })();
}
