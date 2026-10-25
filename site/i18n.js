// 站点双语字典与语言切换运行时（`site/i18n.js`）。
//
// 为什么单独一个文件：`site/` 是零依赖静态站点（`docs/github-pages.md` 的硬约定），
// 这里也不能例外 —— 只用浏览器内置 API，不引入 CDN、不引入 npm 包，引用全走相对路径。
//
// 三条约定：
//   1. **字典是文案的唯一来源**。页面里用户可见的文案全部挂在 `data-i18n*` 属性上，
//      运行时按当前语言回填；`<title>` / meta 同样回填，保证分享卡片与页头一致。
//   2. **静态默认必须是英文**。`index.html` 里所有静态文本（含 `<title>`、meta 描述、
//      OG / twitter）本身就是英文`：SEO 抓取器不执行 JS`，拿到什么就是什么。
//      静态 HTML 里出现中文会被 `scripts/verify-site.mjs` 判失败（这条约定因此不可能悄悄退化）。
//   3. **默认英文，且不做浏览器语言嗅探**。语言只来自 localStorage；
//      存过就用存过的，没存过就是英文。
//
// 用法（浏览器）：`<script src="i18n.js" defer></script>` 必须在 `app.js` 之前，
// 两者都是 defer，因此执行顺序是「先字典后页面脚本」。
// `scripts/verify-site.mjs` 也会以 ESM 方式 import 本文件（挂到 `globalThis`），
// 所以这里不能在顶层碰 `document` —— DOM 操作一律发生在 `apply()` 调用之后。
(function (root) {
  'use strict';

  var STORAGE_KEY = 'recallflow.site.lang';
  var DEFAULT_LANG = 'en';
  var LANGS = ['en', 'zh'];
  var HTML_LANG = { en: 'en', zh: 'zh-CN' };

  // 逐条对照 site/index.html 的可见文案。`zh` 一列与原文逐字一致；
  // `en` 一列来自 TITA-43 交付的译稿 `RecallFlow-site-en-translation-table.md`
  // （术语与 README.md 的英文版对齐：capability inventory / tool guard /
  // failure soft landing / real execution ...）。命令与路径（`chrome://extensions/`、
  // `edge://extensions/`）、浏览器名（Chrome / Edge）、品牌名 RecallFlow 不译。
  // 例外（译稿与门禁冲突时保留自译）：`demo.play` / `demo.playLabel` —— 译稿是
  // “Play animation”，但 scripts/verify-site-visual.mjs 对停帧后的按钮文案断言
  // “Resume animation”，改动字典会让该门禁变红，故保留（详见 TITA-44 交付评论）。
  var COPY = {
    en: {
      'meta.title': 'RecallFlow · Your Browser Office Assistant',
      'meta.description':
        'RecallFlow is an office-assistant extension that runs inside your real browser: read, click, fill, drag, upload, paginate, carry data across pages — hand the repetitive web work over to the Agent.',
      'meta.socialDescription':
        'It acts inside your real browser: read, click, fill, drag, upload, paginate, carry data across pages — hand the repetitive web work over to the Agent.',

      'skip.toMain': 'Skip to main content',
      'brand.home': 'RecallFlow home',
      'nav.label': 'Main navigation',
      'nav.quickstart': 'Quick start',
      'nav.capabilities': 'Core capabilities',
      'nav.demos': 'Real execution',
      'nav.design': 'Agent design',
      'nav.mcp': 'MCP integration',
      'nav.docs': 'Docs',

      'lang.group': 'Language',
      // 语言切换按钮上写的是语言自己的名字（EN / 中文），两种语言下都不翻译，
      // 所以它俩是 index.html 里的静态文本、不进字典；按钮给屏幕阅读器读的
      // aria-label 才走下面的 switchTo* 两条。
      'lang.switchToEn': 'Switch to English',
      'lang.switchToZh': 'Switch to Chinese',

      'hero.logoAlt': 'RecallFlow logo',
      'hero.eyebrow': 'Chrome and Edge extension · Manifest V3 · all data stays local',
      'hero.title': 'Hand the repetitive web work to an Agent that acts inside your real browser',
      'hero.lead':
        'Your browser office assistant — read, click, fill, drag, upload, paginate, carry data across pages',
      'hero.ctaRepo': 'View source on GitHub',
      'hero.ctaQuickstart': 'Quick start in four steps',
      'hero.note':
        'It does not shove HTML at a model — it acts inside your real browser: logged-in sessions, SPAs and intranet pages are all readable and operable; when synthesized events fall short, it dispatches trusted events over CDP.',

      'qs.title': 'Quick start',
      'qs.lead': 'From download to running: just four steps.',
      'qs.step1.title': 'Load the unpacked extension',
      'qs.step1.body':
        'Open <code>chrome://extensions/</code> in Chrome, or <code>edge://extensions/</code> in Edge, enable “Developer mode”, choose “Load unpacked” and point it at the project directory.',
      'qs.step2.title': 'Configure your DeepSeek API Key',
      'qs.step2.body':
        'Click the extension icon to open Settings and fill in your own DeepSeek API Key. Without it, the knowledge base still works.',
      'qs.step3.title': 'Use the bubble on the right of the page',
      'qs.step3.body':
        'Open any web page, click the “RecallFlow” bubble on the right, type an instruction, or pick a quick phrase.',
      'qs.step4.title': 'Optional: allow access to file URLs',
      'qs.step4.body':
        'To operate local HTML you opened by double-clicking, turn on “Allow access to file URLs” in the extension details; after that, local pages behave like any web page.',

      'cap.title': 'Core capabilities',
      'cap.lead':
        'The target is every element on a web page: cross-origin iframes, Shadow DOM, canvas, virtual lists, upload / drag-and-drop / cascading selects, pagination and infinite scroll.',
      'cap.card1.title': 'Across iframes / Shadow DOM / canvas',
      'cap.card1.body':
        'Locate and operate inside the real structure of the real page, without guessing at the DOM.',
      'cap.card2.title': 'Upload, drag-and-drop and cascading selects',
      'cap.card2.body':
        'Covers custom date pickers, file uploads, drag-to-sort and cascading selects; when synthesized events fall short, trusted events are dispatched over CDP.',
      'cap.card3.title': 'Pagination and infinite scroll',
      'cap.card3.body':
        'Keeps operating after paging or scroll-loading; targets inside virtual lists are hit too.',
      'cap.card4.title': 'Carry data across pages',
      'cap.card4.body':
        'Move information from one page to another — read, click, fill and drag can be chained into one flow.',
      'cap.card5.title': 'Remembers and reuses',
      'cap.card5.body':
        'Site memory, skills and macros make repeated flows reusable; all data is stored locally.',
      'cap.card6.title': 'Failure soft landing and observability',
      'cap.card6.body':
        'On repeated calls or consecutive failures it only injects reflection suggestions and does not remove tools; tools, timings and the run trace are recorded round by round.',
      'cap.link':
        'For what guarantees each capability (fixture pages / scripts / E2E / skills / criteria), see <a href="https://github.com/marioyyds/RecallFlow/blob/master/docs/capability-inventory.md">Capability inventory</a>.',

      'demo.title': 'Real execution demos',
      'demo.lead':
        'Inside the extension panel, the Agent works on real pages; the right column is the tool log growing step by step. All recordings below are <strong>speeded-up replays</strong>; third-party sites require login, so these are real-world demos.',
      'demo.xhs.alt':
        'Auto-publishing to Xiaohongshu demo: open the composer, fill title and body, insert images, add topics, click publish',
      'demo.xhs.title': 'Auto-publishing to Xiaohongshu',
      'demo.xhs.desc':
        'Open the composer, fill title and body, insert images, add topics, click publish — the whole flow, no step skipped.',
      'demo.pageops.alt': 'Page operations demo: click, type and submit on a real page',
      'demo.pageops.title': 'Page operations',
      'demo.pageops.desc':
        'Click / type / submit on a real page, with every step kept in the tool log.',
      'demo.find.alt':
        'Search on the current page demo: find a target in the page and jump to the result',
      'demo.find.title': 'Search on the current page',
      'demo.find.desc':
        'Find a target in the page and jump to the result — good for long documents and information-dense admin pages.',
      'demo.highlight.alt':
        'Mark up what matters demo: highlight / annotate key information on the page',
      'demo.highlight.title': 'Mark up what matters',
      'demo.highlight.desc':
        'Highlight / annotate key information on the page, so what was read is obvious at a glance.',
      'demo.pause': 'Pause animation',
      // 译稿给的是 “Play animation”，但这会让 scripts/verify-site-visual.mjs
      // 停帧按钮文案那条断言变红（门禁本轮不改），故保留自译 “Resume animation”。
      'demo.play': 'Resume animation',
      'demo.pauseLabel': 'Pause animation: {name}',
      'demo.playLabel': 'Resume animation: {name}',
      'demo.fallbackName': 'demo',
      'demo.note':
        'Demo files are large and lazy-loaded; click “Pause animation” to freeze the current frame and read.',

      'design.title': 'Agent design',
      'design.lead':
        'After receiving an instruction it assembles context; model output goes through the tool guard and graded approval; execution results flow back to the model; before the final answer there is one more completion check.',
      'design.diagramAlt': 'RecallFlow value loop: read → operate → remember',
      // 示意图有两份（英文原图 + TITA-47 拆出来的中文版），靠 `src` 走 `data-i18n-attr`
      // 跟着语言换 —— 只切 alt 会让中文页面继续显示英文图。两份字典**都必须**有这条 key：
      // `applyAttrPairs` 取不到文案时会保留静态默认值（英文图），漏一条就退化成不换图。
      'design.diagramSrc': 'assets/read-operate-remember.svg',
      'design.flow1.title': 'Receive instruction',
      'design.flow1.body': 'Assemble context: intent routing, system prompt, history and budget.',
      'design.flow2.title': 'Model output',
      'design.flow2.body':
        'Tool calls go to the tool guard; the final answer goes to the completion check.',
      'design.flow3.title': 'Graded approval',
      'design.flow3.body': 'Graded by risk and site trust; tools execute once approved.',
      'design.flow4.title': 'Execute and feed back',
      'design.flow4.body':
        'Execution results go back to the model for the next round; when there is no progress, only reflection suggestions are injected.',
      'design.flow5.title': 'Completion check',
      'design.flow5.body':
        'If it is not met, inject reflection and continue; once met, deliver the answer.',
      'design.note1':
        '<strong>Failure soft landing</strong>: on repeated calls, consecutive failures or no progress, it only injects reflection suggestions and does not decide for the model; it wraps up only when there is sustained no-progress across tools or the budget is exhausted.',
      'design.note2':
        "<strong>Unified registry</strong>: the model's tool list, permission policy and parameter validation share a single definition.",
      'design.note3':
        '<strong>Reliability and observability</strong>: sessions shared across the browser, run lock, stall detection and before-and-after action snapshot verification, with per-round cache hit rate and latency breakdown.',
      'design.link':
        'For the full flowchart, see <a href="https://github.com/marioyyds/RecallFlow/blob/master/docs/assets/recallflow-page-ops-e2e.svg">Page operations E2E flowchart</a>.',

      'mcp.title': 'Integrating with external AI (MCP)',
      'mcp.body':
        'SPAs, logged-in pages or intranet pages that <code>webfetch</code> cannot read are handed to RecallFlow, which reads them over a real browser session and returns evidence with timestamps and hashes; external agents can also touch the page through the single write channel <code>page_action</code>, forming a “read → change → verify” front-end debugging loop.',
      'mcp.refs':
        'The single source of truth for the integration roadmap is <a href="https://github.com/marioyyds/RecallFlow/blob/master/docs/integration-status.md">docs/integration-status.md</a>; installation and configuration are in <a href="https://github.com/marioyyds/RecallFlow/blob/master/integrations/opencode/recallflow-mcp/README.md">recallflow-mcp/README.md</a>.',

      'docs.title': 'Documentation map',
      'docs.lead':
        'From capability boundaries to integration details, it is all in the repository’s docs/ directory.',
      'docs.capability.title': 'Capability inventory',
      'docs.capability.desc':
        'What guarantees each capability: fixture pages, scripts, E2E, skills and criteria.',
      'docs.skills.title': 'Skill inventory',
      'docs.skills.desc': 'Skills, script ownership, orphan and thin skills.',
      'docs.integration.title': 'Integration roadmap',
      'docs.integration.desc':
        'What the external-AI integration actually delivered — the single source of truth.',
      'docs.panel.title': 'Panel sessions',
      'docs.panel.desc':
        'How sessions are shared, switched, run-locked, and followed across tabs.',
      'docs.e2e.title': 'Real-browser E2E guide',
      'docs.e2e.desc':
        'How to write and run E2E, and the golden-task conventions.',
      'docs.local.title': 'Local page support',
      'docs.local.desc':
        'How far file:// page support goes, and why exports leave no trace.',

      'footer.tagline': 'RecallFlow · MIT License',
      'footer.repo': 'GitHub repository',
      'footer.license': 'License',
    },
    zh: {
      'meta.title': 'RecallFlow · 你的浏览器办公助手',
      'meta.description':
        'RecallFlow 是运行在真实浏览器里的办公助手扩展：读、点、填、拖、上传、翻页、跨页搬运，把重复的网页工作交给 Agent。',
      'meta.socialDescription':
        '在你的真实浏览器里动手：读、点、填、拖、上传、翻页、跨页搬运，把重复的网页工作交给 Agent。',

      'skip.toMain': '跳到主要内容',
      'brand.home': 'RecallFlow 首页',
      'nav.label': '主导航',
      'nav.quickstart': '快速上手',
      'nav.capabilities': '核心能力',
      'nav.demos': '真实执行',
      'nav.design': 'Agent 设计',
      'nav.mcp': 'MCP 集成',
      'nav.docs': '文档',

      'lang.group': '语言切换',
      'lang.switchToEn': '切换到英文',
      'lang.switchToZh': '切换到中文',

      'hero.logoAlt': 'RecallFlow 标志',
      'hero.eyebrow': 'Chrome 与 Edge 扩展 · Manifest V3 · 数据保存在本地',
      'hero.title': '把重复的网页工作，交给在真实浏览器里动手的 Agent',
      'hero.lead': '你的浏览器办公助手 —— 读、点、填、拖、上传、翻页、跨页搬运',
      'hero.ctaRepo': '在 GitHub 查看源码',
      'hero.ctaQuickstart': '四步快速上手',
      'hero.note':
        '不是把 HTML 塞给模型，而是在你的真实浏览器里动手：登录态、SPA、内网页面都能读能操作；合成事件失效时经 CDP 派发可信事件。',

      'qs.title': '快速上手',
      'qs.lead': '从下载到跑起来，只需要四步。',
      'qs.step1.title': '加载解压缩的扩展',
      'qs.step1.body':
        '在 Chrome 打开 <code>chrome://extensions/</code>，或在 Edge 打开 <code>edge://extensions/</code>，启用「开发人员模式」，选择「加载解压缩的扩展」并指向项目目录。',
      'qs.step2.title': '配置 DeepSeek API Key',
      'qs.step2.body':
        '点击扩展图标进入设置，填入自配的 DeepSeek API Key。未配置时，知识库仍可正常使用。',
      'qs.step3.title': '在页面右侧气泡使用',
      'qs.step3.body': '打开任意网页，点右侧「RecallFlow」气泡，输入指令，或直接选用快捷语句。',
      'qs.step4.title': '可选：允许访问文件网址',
      'qs.step4.body':
        '要操作双击打开的本地 HTML，需在扩展详情里打开「允许访问文件网址」；开启后本地页与普通网页一致。',

      'cap.title': '核心能力',
      'cap.lead':
        '目标是网页上的一切元素：跨域 iframe、Shadow DOM、canvas、虚拟列表、上传 / 拖拽 / 级联下拉、分页与无限滚动。',
      'cap.card1.title': '跨 iframe / Shadow DOM / canvas',
      'cap.card1.body': '在真实页面的真实结构里定位与操作，不靠对 DOM 结构的猜测。',
      'cap.card2.title': '上传、拖拽与级联下拉',
      'cap.card2.body':
        '覆盖自定义日期选择器、文件上传、拖拽排序与级联选择；合成事件失效时经 CDP 派发可信事件。',
      'cap.card3.title': '分页与无限滚动',
      'cap.card3.body': '翻页、滚动加载之后继续操作，虚拟列表里的目标同样能命中。',
      'cap.card4.title': '跨页搬运',
      'cap.card4.body': '把信息从一个页面搬到另一个页面，读、点、填、拖可以串成一条流程。',
      'cap.card5.title': '会记、会复用',
      'cap.card5.body': '站点记忆、技能与宏让重复流程可以复用；数据全部保存在本地。',
      'cap.card6.title': '失败软着陆与可观测',
      'cap.card6.body':
        '重复调用或连续失败时只注入反思建议、不摘除工具；逐轮记录工具、耗时与运行轨迹。',
      'cap.link':
        '每条能力的保证方式（夹具页 / 剧本 / E2E / 技能 / 判据）见<a href="https://github.com/marioyyds/RecallFlow/blob/master/docs/capability-inventory.md">能力清单</a>。',

      'demo.title': '真实执行演示',
      'demo.lead':
        '在扩展面板里让 Agent 在真实页面上干活，右栏是逐步长出的工具记录。以下录制均为<strong>加速回放</strong>；第三方站点需登录，属真实场景展示。',
      'demo.xhs.alt': '自动发布小红书演示：打开创作页、填标题与正文、插入图片、添加话题、点击发布',
      'demo.xhs.title': '自动发布小红书',
      'demo.xhs.desc': '打开创作页、填标题与正文、插入图片、添加话题、点击发布，全流程一步不落。',
      'demo.pageops.alt': '页面操作演示：在真实页面上完成点击、输入与提交',
      'demo.pageops.title': '页面操作',
      'demo.pageops.desc': '在真实页面上完成点击 / 输入 / 提交，每一步都留在工具记录里。',
      'demo.find.alt': '当前页面搜索演示：在页面内检索目标并定位到结果',
      'demo.find.title': '当前页面搜索',
      'demo.find.desc':
        '在页面内检索目标并定位到结果，适合长文档与信息密集的后台页面。',
      'demo.highlight.alt': '画出页面重点演示：高亮、标注页面上的关键信息',
      'demo.highlight.title': '画出页面重点',
      'demo.highlight.desc': '高亮 / 标注页面上的关键信息，读到的内容一眼可辨。',
      'demo.pause': '暂停动画',
      'demo.play': '播放动画',
      'demo.pauseLabel': '暂停动画：{name}',
      'demo.playLabel': '播放动画：{name}',
      'demo.fallbackName': '演示',
      'demo.note': '演示文件较大，已启用懒加载；点击「暂停动画」可以停在当前帧阅读。',

      'design.title': 'Agent 设计',
      'design.lead':
        '收到指令后组装上下文，模型输出经工具守卫判定与分级审批，执行结果回到模型；最终答复前还会做一次完成校验。',
      'design.diagramAlt': 'RecallFlow 价值闭环：读 → 操作 → 记忆',
      // 与 en 的 `design.diagramSrc` 成对，删掉任意一条都会静默回退成英文图（见上方注释）。
      'design.diagramSrc': 'assets/read-operate-remember.zh-CN.svg',
      'design.flow1.title': '收到指令',
      'design.flow1.body': '组装上下文：意图路由、系统提示、历史与预算。',
      'design.flow2.title': '模型输出',
      'design.flow2.body': '工具调用进入工具守卫；最终答复进入完成校验。',
      'design.flow3.title': '分级审批',
      'design.flow3.body': '按风险与站点信任分级，通过后执行工具。',
      'design.flow4.title': '执行并回流',
      'design.flow4.body': '执行结果回到模型，继续下一轮；无进展时只注入反思建议。',
      'design.flow5.title': '完成校验',
      'design.flow5.body': '未达成则注入反思继续，达成后交付回答。',
      'design.note1':
        '<strong>失败软着陆</strong>：重复调用、连续失败或无进展时只注入反思建议，不替模型做决定；仅在跨工具持续无进展或预算触顶时收尾。',
      'design.note2': '<strong>统一注册表</strong>：模型工具列表、权限策略与参数校验共用一份定义。',
      'design.note3':
        '<strong>可靠性与可观测</strong>：共享会话、运行锁、卡死检测与动作前后快照校验，逐轮记录缓存命中率与耗时分段。',
      'design.link':
        '完整流程图见<a href="https://github.com/marioyyds/RecallFlow/blob/master/docs/assets/recallflow-page-ops-e2e.svg">页面操作 E2E 流程图</a>。',

      'mcp.title': '与外部 AI 集成（MCP）',
      'mcp.body':
        '<code>webfetch</code> 读不到的 SPA、登录态或内网页面，交由 RecallFlow 以真实浏览器会话读取，返回带时间戳与哈希的证据；外部 agent 还能经唯一写通道 <code>page_action</code> 碰页面，形成「读 → 改 → 验」的前端调试闭环。',
      'mcp.refs':
        '集成路线的唯一事实来源是<a href="https://github.com/marioyyds/RecallFlow/blob/master/docs/integration-status.md">docs/integration-status.md</a>，安装与配置见<a href="https://github.com/marioyyds/RecallFlow/blob/master/integrations/opencode/recallflow-mcp/README.md">recallflow-mcp/README.md</a>。',

      'docs.title': '文档导航',
      'docs.lead': '从能力边界到集成细节，都在仓库的 docs/ 目录里。',
      'docs.capability.title': '能力清单',
      'docs.capability.desc': '每条能力由什么保证：夹具页、剧本、E2E、技能与判据。',
      'docs.skills.title': '技能清单',
      'docs.skills.desc': '技能、剧本归属、孤儿技能与薄技能。',
      'docs.integration.title': '集成路线',
      'docs.integration.desc': '与外部 AI 集成到底实现了哪些，唯一事实来源。',
      'docs.panel.title': '面板会话',
      'docs.panel.desc': '会话如何共享、切换，以及运行锁与跨标签页跟随。',
      'docs.e2e.title': '真浏览器 E2E 指南',
      'docs.e2e.desc': 'E2E 怎么写、怎么跑，以及黄金任务的约定。',
      'docs.local.title': '本地网页支持',
      'docs.local.desc': 'file:// 页面支持到哪一步，为什么导出不留痕。',

      'footer.tagline': 'RecallFlow · MIT License',
      'footer.repo': 'GitHub 仓库',
      'footer.license': '许可协议',
    },
  };

  function normalize(lang) {
    return LANGS.indexOf(lang) === -1 ? DEFAULT_LANG : lang;
  }

  function htmlLang(lang) {
    return HTML_LANG[normalize(lang)];
  }

  // 语言只来自 localStorage：默认英文就是英文，不看 navigator.language。
  function detect() {
    try {
      return normalize(root.localStorage.getItem(STORAGE_KEY) || '');
    } catch (error) {
      return DEFAULT_LANG;
    }
  }

  function save(lang) {
    try {
      root.localStorage.setItem(STORAGE_KEY, normalize(lang));
    } catch (error) {
      /* 隐私模式下写不进去也要能切换，只是下次回到英文 */
    }
  }

  function format(value, params) {
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, function (all, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : all;
    });
  }

  function text(lang, key, params) {
    var dict = COPY[normalize(lang)] || {};
    var value = dict[key];
    return typeof value === 'string' ? format(value, params) : '';
  }

  function applyAttrPairs(element, spec, lang) {
    var pairs = (spec || '').trim().split(/\s+/);
    for (var i = 0; i < pairs.length; i += 1) {
      var pair = pairs[i];
      var colon = pair.indexOf(':');
      if (colon <= 0) continue;
      var attr = pair.slice(0, colon);
      var key = pair.slice(colon + 1);
      var value = text(lang, key);
      // 取不到文案就保持静态默认值，不要写空串：空的 alt / aria-label 比英文原文更糟。
      if (value) element.setAttribute(attr, value);
    }
  }

  // 一次遍历回填全部带标记的 DOM。幂等：重复调用结果相同。
  function apply(lang) {
    var resolved = normalize(lang);
    var doc = root.document;
    if (!doc) return resolved;

    doc.documentElement.setAttribute('lang', htmlLang(resolved));

    var plain = doc.querySelectorAll('[data-i18n]');
    for (var i = 0; i < plain.length; i += 1) {
      var value = text(resolved, plain[i].getAttribute('data-i18n'));
      if (value) plain[i].textContent = value;
    }

    var rich = doc.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < rich.length; j += 1) {
      var html = text(resolved, rich[j].getAttribute('data-i18n-html'));
      if (html) rich[j].innerHTML = html;
    }

    var attrs = doc.querySelectorAll('[data-i18n-attr]');
    for (var k = 0; k < attrs.length; k += 1) {
      applyAttrPairs(attrs[k], attrs[k].getAttribute('data-i18n-attr'), resolved);
    }

    var buttons = doc.querySelectorAll('[data-lang]');
    for (var m = 0; m < buttons.length; m += 1) {
      buttons[m].setAttribute('aria-pressed', buttons[m].getAttribute('data-lang') === resolved ? 'true' : 'false');
    }

    return resolved;
  }

  function switchTo(lang) {
    var resolved = apply(lang);
    save(resolved);
    return resolved;
  }

  root.RecallFlowI18n = {
    COPY: COPY,
    LANGS: LANGS,
    DEFAULT_LANG: DEFAULT_LANG,
    STORAGE_KEY: STORAGE_KEY,
    normalize: normalize,
    htmlLang: htmlLang,
    detect: detect,
    save: save,
    text: text,
    format: format,
    apply: apply,
    switchTo: switchTo,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
