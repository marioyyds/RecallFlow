# 技能清单（自动生成，勿手改）

本文件由 `node scripts/gen-skills-overview.mjs` 从 `lib/assistant/skill-defs.js` 与
`tests/e2e/fixtures/playbooks.mjs` 推导得出，并由 `tests/skills-overview.test.mjs` 门禁
比对"产物变了而本文件没跟上"。**不要手写这份清单** —— 手写的必然腐烂。

## 总览

| 指标 | 值 |
| --- | --- |
| 技能总数 | **39** |
| 有剧本归属（真浏览器验收覆盖） | **30** |
| **孤儿技能**（无验收覆盖） | **9** |
| 能力剧本总数 | **30** |

## 运行时到底怎么"选技能"（2026-10 复核，与清单无关）

这一节是**手工维护的固定说明**（不是从源码数出来的），因为它讲的是运行时的真实行为，
而清单只能数出"有哪些技能、对应哪条剧本"。

1. **生产只给模型一行 `name：description`。** `buildSkillCatalog()`（`lib/assistant/skills.js`）
   把每个技能渲染成 `- name：用途`，随 system prompt 一起发出；**正文不预先注入**。
   模型判断当前任务适合某个技能时，才调用常驻工具 `load_skill(name)` 取回正文（`lib/assistant/skill-tools.js`）。
2. **运行时不做关键词匹配。** 曾经有一条"按 `x.keywords` 正则命中就注入正文"的路
   （`skills.js` 的 `detectSkill()`），它**在生产代码里没有任何调用方**，已于目标 ⑤ 删除。
   `x.keywords` / `x.intents` 仍保留，但只用于 **SkillHub 格式往返**（`skill-md.js`）与技能编辑页展示
   （`skills-page.js`）—— 与"选哪个技能"无关。
3. **因此"技能 ↔ 场景"在运行时比清单上松得多**（真模型实测，`docs/real-model-eval-log.md` 的
   「技能 ↔ 场景在运行时比清单上松得多」一节）；其中最要紧的两条：
   · **有 10 条场景一个技能都没加载，照样通过** —— 清单上的"有内置技能"是**资产层面**的对应，
     不等于"运行时模型会用它"✗；
   · 少数场景加载的是**不是自己那条**技能（如 `form-validation` 那次加载了 `checkout-form`），
     也照样通过；
   · **孤儿 ≠ 没被用**：`clip-to-knowledge` 没有自己的剧本，却被「知识库往返」与
     「知识库检索回退」两条剧本**实际加载过**。
4. **所以"孤儿技能"说的是验收覆盖，不是使用价值**：它意味着"没有夹具页 + 真浏览器判据"，
   意味着**改它的文案没法用现有 eval 测量**（这正是孤儿的代价）。
5. **文案的可执行性有一条静态门禁**（`tests/skill-content-structure.test.mjs`）：
   每个技能的正文要么有**连续编号、从 1 开始**的步骤清单，要么**显式声明**"本技能无步骤：<原因>"。
   依据是本仓库最贵的一课：**散文式的关键步骤会被模型跳过**（`readability-fix` 最早漏掉"改行宽"）。
   ⚠ 这道门禁**只**保证"结构上做得出来"，**不**保证"模型真的照做" —— 后者只有真模型 eval 能回答。

## 有剧本归属的技能（每一项都有夹具页 + E2E 判据）

| 技能 | 展示名 | 分类 | 对应剧本 |
| --- | --- | --- | --- |
| `canvas-coordinate-click` | canvas / 画布上的按钮（按坐标点击） | browser-automation | `canvas-coordinate-click` |
| `cascade-select` | 级联下拉框（选了父项，子项异步填充） | browser-automation | `cascade-select` |
| `cdp-drag-slider` | 拖拽（滑块 / 自定义排序等鼠标事件型控件） | browser-automation | `cdp-drag-slider` |
| `checkout-form` | 下单 / 多步表单（选商品 → 填写 → 勾选确认 → 提交） | browser | `checkout-form` |
| `cross-tab-handoff` | 跨标签页搬运（在 A 页读到的东西填进新开的 B 页） | browser-automation | `cross-tab-handoff` |
| `page-world-js` | 读页面 JS 状态 / 严格 CSP 页面（沙箱被拒会自动改用页面主世界） | browser-automation | `csp-page-world-js` |
| `date-picker-custom` | 自定义日期选择器：打字没用，要点日历 | browser-automation | `date-picker-custom` |
| `debug-console-error` | 排查「点了没反应」（先复现，再读运行期事实） | browser-automation | `debug-console-error` |
| `dismiss-overlay` | 被弹窗/遮罩挡住（先处理干扰，再干活） | browser | `dismiss-overlay` |
| `download-verify` | 下载文件：页面上不会变，凭据只能来自浏览器事件 | browser-automation | `download-verify` |
| `extract-merged-table` | 表格提取（含合并单元格，按列对齐） | browser | `extract-merged-table` |
| `form-validation` | 提交没反应：HTML5 原生校验静默拦住（页面上什么都不说） | browser-automation | `form-validation` |
| `infinite-scroll-hover-preview` | 无限滚动 + hover 预览（滚到底才加载，预览只在悬停后出现） | browser-automation | `infinite-scroll-hover-preview` |
| `knowledge-save-retrieve` | 知识库：存进去要能原样取回来（同一个网址会互相覆盖） | knowledge | `knowledge-save-retrieve` |
| `knowledge-search-fallback` | 知识库检索查不到时（查不到 ≠ 没有） | knowledge | `knowledge-search-fallback` |
| `macro-save-replay` | 宏：把已验证的多步操作存下来，之后零 token 回放 | browser-automation | `macro-save-replay` |
| `multi-candidate-convergence` | 多候选收敛（多家里挑一家：逐条核对约束 + 关键属性要重读） | browser-automation | `multi-candidate-convergence` |
| `new-tab-takeover` | 新标签页接管（点击后换页继续干活） | browser | `new-tab-takeover` |
| `operate-in-cross-origin-iframe` | 跨域 iframe 内操作（先读合并快照，再按复合 ref 路由） | browser | `operate-in-cross-origin-iframe` |
| `paginate-async` | 分页 + 异步加载（跨页找到目标，并等它真的渲染出来） | browser | `paginate-async` |
| `paywall-boundary` | 找免费可看的那一份：「能打开」不等于「能看」 | browser-automation | `paywall-preview-limit` |
| `pierce-shadow-dom` | 组件内操作（穿透 Shadow DOM） | browser | `pierce-shadow-dom` |
| `read-select-options` | 读下拉框选项（"选最便宜/最合适"之前先看有哪些） | browser-automation | `read-select-options` |
| `readability-fix` | 可读性美化（把难读的页面调成易读） | browser | `readability-fix` |
| `recover-from-rejection` | 被拒后自适应（读懂原因、补齐、再试） | browser | `recover-from-rejection` |
| `search-within-site` | 站内检索（搜索 + 结构化取回结果） | browser | `site-search` |
| `undo-last-action` | 撤销上一步（只回退最后一次可撤销动作） | browser-automation | `undo-last-action` |
| `upload-file` | 文件上传（工具只说"未观测"，必须读回） | browser-automation | `upload-file` |
| `video-playback-verify` | 视频播放器状态（「看起来在播」不等于真的在播） | browser-automation | `video-playback-verify` |
| `virtual-list-scroll` | 虚拟列表 / 长列表（DOM 里没有 ≠ 页面上没有） | browser-automation | `virtual-list-scroll` |

## 重复的通用纪律（抽「底座」的依据，数出来的不是感觉）

每个技能都要自带一遍"先快照、后操作、收尾 complete_task"这类纪律，
于是同一条纪律在多个技能里重复。下表统计**被至少 3 个技能声明**的工具 ——
数字越大，越说明它该被抽成公共底座（而不是在 36 份文案里各写一遍）。

| 工具 | 声明它的技能数 |
| --- | --- |
| `complete_task` | 36 |
| `get_page_snapshot` | 34 |
| `inspect_element` | 32 |
| `click_element` | 27 |
| `type_text` | 10 |
| `wait_for_element` | 10 |
| `select_option` | 8 |
| `read_current_page` | 6 |
| `scroll_page` | 4 |
| `add_entry` | 3 |
| `annotate` | 3 |
| `check_box` | 3 |
| `get_ax_snapshot` | 3 |
| `knowledge_read` | 3 |
| `read_diagnostics` | 3 |

（全部工具的出现次数见下方明细；`tools` 为空或未声明的技能不参与统计。）

<details><summary>全部工具的出现次数</summary>

| 工具 | 技能数 |
| --- | --- |
| `complete_task` | 36 |
| `get_page_snapshot` | 34 |
| `inspect_element` | 32 |
| `click_element` | 27 |
| `type_text` | 10 |
| `wait_for_element` | 10 |
| `select_option` | 8 |
| `read_current_page` | 6 |
| `scroll_page` | 4 |
| `add_entry` | 3 |
| `annotate` | 3 |
| `check_box` | 3 |
| `get_ax_snapshot` | 3 |
| `knowledge_read` | 3 |
| `read_diagnostics` | 3 |
| `fetch_webpage` | 2 |
| `run_javascript` | 2 |
| `click_at` | 1 |
| `drag_element` | 1 |
| `get_attribute` | 1 |
| `handle_dialog` | 1 |
| `hover_element` | 1 |
| `install_skill` | 1 |
| `install_userscript` | 1 |
| `list_frames` | 1 |
| `list_tabs` | 1 |
| `list_userscripts` | 1 |
| `load_skill` | 1 |
| `macro` | 1 |
| `open_tab` | 1 |
| `remove_entry` | 1 |
| `run_userscript` | 1 |
| `search_userscripts` | 1 |
| `switch_tab` | 1 |
| `take_screenshot` | 1 |
| `undo_last_action` | 1 |
| `upload_file` | 1 |

</details>

## 薄技能（文案偏短，可能讲不清"怎么做"）

口径：`content` 里**字符串字面量**的字符数累加（近似值，不含转义展开），
这里列出 **< 400 字符**的。目标 ⑤ 要求"薄技能充实或合并" —— 没有数字就只能凭印象挑 ✗

（当前没有 < 400 字符的技能）

## ⚠ 孤儿技能（**没有**真浏览器验收 —— 文案写了，但没人验过）

这些技能只在"模型读到文案"这一层有效，**没有**夹具页与 E2E 判据。
要么给它们补一个能力剧本，要么在技能定义里写一行 `// 无剧本：<原因>` 显式声明。

⚠ **孤儿 ≠ 没被用**（真模型实测）：`clip-to-knowledge` 就在这里，却被「知识库往返」与
「知识库检索回退」两条剧本实际加载过。孤儿状态说明的是**没有自己的验收覆盖**，
也就是**改它的文案没法用现有 eval 测量** —— 不是"这个技能没人会用"。
每条理由都由 `tests/skill-content-structure.test.mjs` 门禁核对：**必须是够用的理由**，
写"待补""暂无"这类空话会被判红。

| 技能 | 展示名 | 分类 | 为什么没有剧本 |
| --- | --- | --- | --- |
| `agent-browser` | Agent Browser（浏览器自动化） | browser-automation | 通用底座类技能（讲 agent-browser 的用法与边界），没有单一页面形态可造夹具；其纪律由各剧本间接覆盖。 |
| `clip-to-knowledge` | 剪藏到知识库 | knowledge | 覆盖的动作（`add_entry` / `knowledge_read`）本身已有剧本身演 ——「知识库往返」与「知识库检索回退」两条剧本验的就是这两个工具，真模型实测确认本技能会在这两条里被加载。本技能自己没有剧本，是因为它只是同一批动作的**另一种说法**（"剪藏"），页面侧没有独立不变量；单独再立一条只会把同一件事验两遍。若将来要立，缺的是"用户说剪藏、模型是否真去写库"这一类判据。 |
| `dialog-handling` | 浏览器对话框（confirm 阻塞 / prompt 要回填值） | browser-automation | **场景未收敛**：/dialog 夹具页已就绪，但 Playwright 的对话框管理与外部 attach 的 debugger 冲突（页面会直接死掉），需要换一套驱动方式。现状与已排除的原因见 docs/next-steps-handoff.md。 |
| `find-skill-skillhub` | Find Skill · SkillHub | ai-agent | 依赖第三方技能市场站点（外部服务），不适合做本地夹具；技能本身只是接口说明。 |
| `highlight-key-points` | 划重点 / 高亮关键信息 | reading | 能力由 annotate 系列工具承担，已有工具级单测；页面侧只是"高亮生效"的视觉结果，自动断言价值低。 |
| `humanizer` | Humanizer（去 AI 味） | content-creation | 纯文案改写：输入与产出都在回复文本里，不涉及页面操作，没有可断言的页面状态 —— 造一个夹具页也只能验"模型改得对不对"，那是主观判断，不是 E2E 判据。 |
| `remove-ads` | 去广告 / 屏蔽推广 | browser | 判据需要"隐藏得对不对"的人工确认（隐藏广告时不能连带藏掉正文）；已有的 mainContent 提醒是一条弱保障，但造不出可信的"广告与正文同构"夹具来自动断言。**最小可行验收**（未做，留给接手者）：夹具页放一个 `#ad-slot` 广告块 + 与它同容器的正文段落，判据 = 广告块不可见 **且** 正文可见。 |
| `summarize` | Summarize（总结） | reading | 纯文案处理（对已有内容做摘要），不涉及页面操作，没有可断言的页面状态。 |
| `userscript-task` | 用户脚本任务（下载/展开/签到/抢购） | browser | 覆盖多种任务形态（下载 / 展开 / 签到 / 抢购），尚未拆出最小可断言的一种；而且它依赖 GreasyFork 这类**外部站点**提供的脚本，夹具页给不出可信的等价物。拆出后应当补剧本并从本表移除。 |

