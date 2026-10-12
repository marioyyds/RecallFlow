# 剩余工作（可执行清单）

> 写于第 28/30 轮，上下文即将耗尽。这份清单的存在意义：**下一次接手不必重新调研**。
> 每条都写清"改哪里、判据是什么、怎么验证"。

## 一、纪律（先读这一节，它来自本会话的教训）

1. **改动模型能看到的内容（提示 / 技能 / 工具描述）⇒ 必须测量** ✗
   方法见 `docs/regression-red-flag.md`（含可直接粘贴的循环命令）。
   第 23 轮我"抽了个漂亮的底座"、没测量就标完成，第 26 轮实测**通过率 3/7 vs 5/5** ✓ 已回退。
2. **证据便宜时先取证据，不要先建理论** ✓
   「已订满」那条我连续建了 4 个假设、全被否证 ✗ 而一次消息转储（第 15 轮）
   和一次动作探针（第 17 轮）各自一次调用就把范围缩到底 ✓
3. **改完立刻跑相关门禁** ✓ 我有两次是"改完指令没同步触发词"「用 PowerShell 改写源文件把 UTF-8 写坏」✗
   前者门禁本来能抓到（我没跑），后者是本会话开头就记录过的陷阱 ✗
4. **不要用 PowerShell 改写源文件**（`Get-Content`/`Set-Content` 破坏 UTF-8）✗ 用 `edit` 工具 ✓
5. **夹具模板字符串里不能有反引号** ✗（会终止模板字符串）✓

## 二、① 多模态：让面板内 Agent 能"看到"截图（**已完成：开关已打开**）

**第 6 步（打开开关）已做完** ⇒ 从这一步起**模型可见内容真的变了** ⇒ 已按纪律做**定向**测量
（不是全量 30 条扫描，理由见本节的「第 6 步怎么做的」）。

| # | 事项 | 状态 | 位置 |
| --- | --- | --- | --- |
| 1 | 数组 content 的历史不再被**静默丢弃**（归一化为文本 + 说明图片有没有传下去）| ✅ | `lib/assistant/context.js` 的 `flattenHistoryContent` |
| 2 | **开关**（单一事实来源）+ 文案函数 | ✅ **已打开** | `lib/shared/utils.js` 的 `VISION_ENABLED` / `visionLimitationNote` |
| 3 | 多模态消息装配 + 预算（张数 / 单片体积 / **丢弃必说明**）| ✅ | `lib/assistant/vision.js` |
| 4 | **接线**：截图在 tool 消息之后作为**追加的 user 消息**进入上下文 | ✅ | `lib/assistant/agent.js`（`messages.push({role:'tool'…})` 之后）|
| 5 | "你看不到图像"文案条件化（**四处**，整句二选一）| ✅ 关闭侧与 HEAD 逐字节相同（脚本可证）| `tool-schemas.js` / `skill-defs.js` / `utils.js` / `context.js` |
| 6 | **打开开关**（`VISION_ENABLED = true`）| ✅ **本轮完成** | 见下「第 6 步怎么做的」|
| 7 | 对照门禁：关闭时请求里**不得**有 `image_url`；开启时**应当**有 | ✅ | `tests/e2e/vision-switch.spec.mjs`（按常量实际值选臂）|
| 8 | 预算复核：token/图、`maxImages`/`maxBase64Chars` 取几合适 | ✅ 已复核（结论：**保留 2 / 2e6**）| 见下「预算复核」|

对应门禁：`tests/history-array-content.test.mjs`(8)、`tests/vision-switch.test.mjs`(9)、
`tests/vision-messages.test.mjs`(13)、`tests/vision-wiring.test.mjs`(4)、
`tests/vision-text-conditional.test.mjs`(13)、`tests/e2e/vision-switch.spec.mjs`（真浏览器两臂）

### 第 6 步怎么做的（可复核）

0. **人读开启侧文案时又抓到一处"假话"，一并修了**（这条最能说明"打开开关必须逐句读"）：
   开启侧原稿写「只送**预算内**的最近几张，超出的会省略并说明」，但接线**没有**做这件事 ——
   `agent.js` 是**每张截图各调用一次** `visionMessagesFor([res.screenshot])`
   ⇒ 每次调用只看到 1 张，`maxImages: 2` **永远不是约束**。
   实测（可复现）：`selectScreenshotsForVision` 一次传 5 张 ⇒ 选中 2 张；
   而复刻 agent 的调用形状（5 次各传 1 张）⇒ **5 张全部进上下文、"省略说明"出现 0 次** ✗
   ⇒ 两点处理：
   ① **文案改成如实的**（本次任务里截的每张都会送；单张过大的会省略并说明），
      并加 `doesNotMatch(/预算内/)` 让它**不能被改回去**；
   ② **"单张过大"这条路原先还是静默的**：全部被跳过时 `buildScreenshotMessage([])` 返回 `null`
      ⇒ 连那句"未送入模型"也一起丢掉 ✗ ⇒ 已在 `vision.js` 的 `visionMessagesFor` 修成
      "仍产出一条纯文本说明消息"，并补了单测（`tests/vision-messages.test.mjs`）。
   ⚠ **未做**：把上限做成**任务级**（在 `agent.js` 累计本次任务已送的张数）。那是行为改动 + 需要测量，
   本轮**没有**做 ⇒ 所以文案里也**不承诺**它（见「待决项」）。

1. **先修"打开就会变成假话"的模型可见文本**，不许只改顺手看到的那一处。做法是脚本穷举：
   - 两臂（`VISION_ENABLED` false/true，用 data: URL 改写源码载入）把**全部模型可见文本面**渲染出来逐块比对
     ⇒ 差异块**恰好 4 处**（`take_screenshot` 说明、readability-fix 技能、`formatScreenshotSummary`、
     `visionLimitationNote` 默认整句），前三处 + 这一处**都已经条件化** ⇒ 没有第五处 ✓
   - 再扫源码里的**字符串字面量**（同时命中「图像」与「可见性主张」）：命中 8 条，逐条判"是否模型可见 / 是否随开关换档"
     ⇒ 找出**第 4 处接线点**：`lib/assistant/context.js` 的 `flattenHistoryContent`
     （历史回放把图片降级为 `[图片]` 后补一句"当前**未把图片传给模型**"）。
     ⚠ 这一处**不会**随开关翻转而改变输出（它原先根本没读开关）⇒ 只有"逐条读模型可见文本"才发现它 ✗
   - 判定为"不是假话、不需改"的两条（也写下来，免得下一个人重查）：
     `panel-css.js` 里那句是**样式表注释**（不面向模型，用例 ⑤ 钉着它只是注释）；
     `skill-defs.js` 的「截图里能看到但 DOM 里读不到」讲的是**对话框不在 DOM 里**，不是模型能力主张 ✓
2. **第 4 处的措辞要求（精确，不能笼统）**：历史回放**不重传**图片（只留文字占位），
   而**本次新增**的截图会随请求进上下文 ⇒ 开启侧写成
   「该消息含 N 张图片；历史回放**不会重传**这些图片，此处只保留文字占位 —— 只有**本次新增**的截图才会随请求送进你的上下文。」
   ⚠ 笼统写成"图片已传给模型"同样是假话（这些历史图恰恰没传）—— 用例里专门有一条断言拦它。
3. **关闭侧逐字节相同的证据**（可复现）：
   - 从 HEAD 解出旧树（`git archive HEAD | tar -x -C <临时目录>`），把两棵树的模型可见文本面各渲染一份
     ⇒ 除 `flattenHistoryContent` 外的 **92 个块逐字节相同**（开启侧也相同，说明启用分支没被顺手改动）；
   - `flattenHistoryContent` 单独比对：HEAD 版输出 vs 新版关闭臂输出，**5 组夹具全部逐字节相同**（含 `normalizeHistory` 端到端）✓
4. **打开开关**：`lib/shared/utils.js` 的 `VISION_ENABLED = false` → `true`。
   副作用（有意、已留痕）：工具注册表指纹 `fb63cc85d45590b1` → **`58a68187a828f71f`**，
   差异条目**恰好 1 条**（`take_screenshot：description 变了`，44 → 44 个工具、权限元数据全等）——
   原因与证据写在 `tests/registry-fingerprint.test.mjs` 的指纹变更历史里 ✓
5. **测试怎么改的（不是删断言）**：原来把"关闭"当默认钉住的断言，全部改成**按开关实际值选臂**：
   - 行为断言用**显式 override**（`formatScreenshotSummary(meta, false/true)`、
     `flattenHistoryContent(c, false/true)`、`visionMessagesFor(shots, {visionEnabled})`）⇒ 两臂都还在跑；
   - 默认入口额外断言"必须落在 `VISION_ENABLED` **实际取值**那一臂"⇒ 常量无论翻到哪边这条都有牙齿；
   - E2E 继续用 `test.skip(VISION_ENABLED !== false / !== true)`：开关打开后**关闭臂被 skip**，
     关闭侧的传输行为改由 `tests/vision-messages.test.mjs`(13) 的 override 钉住 ✓
   - 原来的"改 true 就该红"那条牙齿用例重写成：**开启侧文案没接上（仍写"看不到图"）必须被判为不合格** ✓
6. **E2E 开启臂真的跑了**（真 Chromium + 真扩展 + 真 CDP 截图）：视觉阶段
   `1 skipped`（关闭臂，按常量 skip）+ `2 passed`（开启臂 + 牙齿）；全量三阶段
   黄金任务 40 / 断线恢复 1 / 视觉两臂 2 passed + 1 skipped，`run-e2e` 退出码 **0** ✓
   开启臂断言：图出现在 `take_screenshot` 结果**之后追加的 user 消息**里、`tool` 消息仍是纯字符串、
   `image_url` 是 `data:image/…` 形态 ✓

### 预算复核（第 8 步的"张数/体积仍是拍的"这一条，本轮给出结论）

| 项 | 结论 | 依据 |
| --- | --- | --- |
| `TOKENS_PER_IMAGE` | **600**（不变） | 每图实测 578（1280×720 JPEG q40）⇒ 600 是保守上界 |
| `maxImages` | **保留 2**，但 ⚠ **要知道它在真实接线里不生效** | `agent.js` 每张截图各调用一次 ⇒ 每次只看到 1 张，2 张的上限永远不是约束（实测 5 次各传 1 张 ⇒ 5 张全进上下文）✗ 所以每轮多付的是 **578 × 本次截了几张**，**没有张数上界**；开启侧文案已据此改成如实说法 |
| `maxBase64Chars` | **保留 2_000_000** | 实测 1280×705 JPEG q40 ≈ 63KB ⇒ base64 ≈ 84KB 字符；另一张内容更密的 1280×720 q40 实测 20.1KB / 27,432 字符。2e6 是**防呆上限**，典型图永远碰不到；超过它的那张会被省略**并说明**（说明这条路本轮修过，见上）✓ |

⚠ **如实标注（不许假装可配置）**：`ctx.visionBudget` **至今没有任何地方赋值**（`agent.js` 只有一处读，
恒为 `undefined`）⇒ 生产实际生效的**只有 `DEFAULT_VISION_BUDGET`**，**不可配置**。
这一点写在 `lib/assistant/vision.js` 的常量注释里，并有门禁用例钉住
（若哪天 `agent.js` 里出现 `ctx.visionBudget = …`，那条用例会红，逼人同步文档）✓

### ⬜ 待决项（本轮**刻意没做**，单列出来）

1. **把图片上限做成任务级**（真正兑现"只送最近 N 张"）：需要在 `agent.js` 累计本次任务已送张数，
   并在超出时**如实说明**省了几张。⚠ 注意它天然会碰"请求前缀稳定性"（`scripts/check-prefix-stability.mjs`）：
   只能是**追加**说明，不能回头改写已发出的消息 ✓
2. **让 `ctx.visionBudget` 可配置**：① 设置项 → ② 赋值 → ③ 一条门禁断言设置真的生效（三步缺一不可）。
3. **给一条 eval 场景加"截一张图并说出你看到的细节"**：见下面的"没有验证的部分"第 2 条。

### ⬜ 本轮**没有**验证的部分（不要当成已验过）

1. **真模型上"图真的进了上下文、而且模型真的看得见"没有被验证** ✗
   本轮环境里 `E2E_LLM_REAL_KEY` / `RECALLFLOW_EVAL_API_KEY` **都没有设置**（`env` 里也不存在，
   工作区里也没有任何 `sk-` 形态凭据）⇒ 真实 API 探针**未能执行**。
   探针脚本与命令见 `docs/real-model-eval-log.md` 最新一轮（写好待跑，不含任何密钥）。
2. **"视觉能力对任务有没有用"在真模型下无法被评估** ✗ —— 因为**没有任何 eval 场景会调 `take_screenshot`**：
   30 条剧本的 `PLAYBOOKS[*]` 里 `take_screenshot` 的出现次数为 **0**，`tests/e2e-eval/real-model.eval.mjs`
   与 `scripts/eval-real-model.mjs` 里也是 **0**。唯一会截图的路径是 E2E 的视觉门禁（脚本化夹具 + 模拟 LLM），
   它验的是**传输管道**，不是"模型看图后判断更准"。
   最小可行方案（本轮**不**新造场景，只记下来）：给某条现有剧本的指令加一句
   "顺便截一张图并说出你在图里看到的一个具体细节"，把它登记进 eval 的 `E2E_LLM_VISION_SHOT` 那一臂即可。
3. **"打开后没退化"只有很弱的对照**：只跑了脚本化 E2E（模拟 LLM），**没有**跑真模型 eval 场景
   （同样卡在密钥）⇒ 通过率数字**无法给出**。

### ⚠ 本轮工作区里的 3 项**既有**失败（与视觉开关无关，可复现）

`node scripts/run-all-checks.mjs` 的单元测试步骤会红 3 条，**都不是本次改动引起的**：

| 失败 | 根因 | 证据 |
| --- | --- | --- |
| `能力清单必须与产物一致` | 工作区里 `docs/capability-inventory.md` 有一处**未提交的他人改动**（把 `form-validation` 回执判据 4→0、`video-playback-verify` 页面判据 8→11；合计 101/64→104/65），而产物推导出的仍是 101/64 | 只读渲染该清单并与磁盘文件逐行比对 ⇒ 不同行 = **3 行**，全部是上面那两行 + 合计行；`git status` 显示该文件的修改**不是**本轮产生的（本轮未碰 docs 下任何未跟踪/已改文件）|
| `清单必须与产物一致（改了技能或剧本…）` + 它的牙齿用例 | `scripts/gen-skills-overview.mjs` 解析 `ORPHAN_SKILL_REASONS` 的正则要求 `',\n`，而本工作副本 `lib/assistant/skill-defs.js` 是 **CRLF**（`core.autocrlf=true`）⇒ 9 条原因解析出 **0** 条 ⇒ 文档里那份原因表被判"与产物不一致" | 同一脚本在 **HEAD 解出的旧树上跑，得到完全相同的 9 行差异**；LF 化后解析 9 条 ✓。`git status` 显示 `skill-defs.js` / `playbooks.mjs` / 该生成脚本本轮**一行未改** ⇒ 与本轮无关 |

⇒ 这两处若要修，是**独立的一轮**（修生成器的行尾健壮性 / 让同事的清单改动与产物对齐），
**本轮刻意不碰**（纪律：不顺手重构无关代码）。本轮自己的用例（含视觉 47 条）**全绿** ✓


### 第 7 步怎么做的（可复核）

- **真截图**走通了：`tests/e2e/vision-switch.spec.mjs` 用真 Chromium + 真扩展 + `cdpEnabled: true`，
  夹具脚本调 `take_screenshot`（CDP `Page.captureScreenshot`）拿到真 base64
  （实测 1280×705 JPEG q40 ≈ 63KB），**不是**在 mock 层塞假图 ✓
- **两臂都由开关的实际值决定**：`test.skip(VISION_ENABLED !== false / !== true)` ——
  开关一打开，**同一份门禁自动变成开启臂**，不会出现"开了但没人管" ✓
- **关闭臂**：所有捕获请求里图像部件数 = 0，同时断言截图**文本**结果确实发出去过
  （否则"没有图"可能只是"没截图"，证不出东西）✓
  ⚠ 第 6 步打开开关后这条**会被 skip**（真实扩展读的就是那个常量）——关闭侧的传输行为改由
  `tests/vision-messages.test.mjs` 的 `visionEnabled:false` override 钉住，不是没人管 ✓
- **开启臂（第 6 步起真的在跑）**：图像必须出现在 `take_screenshot` 的 tool 消息**之后**、作为**追加的 user 消息**，
  且 tool 消息本身仍是纯文本（`checkScreenshotImageShape` 逐条验形态）✓
- **门禁有牙齿**（三条证据）：① spec 内的纯函数判定逻辑用构造的坏数据验了一遍（把图塞进 tool 消息、
  少掉带图消息、role 不对、非 data: URL 全都要被判不合格）；② 故意往捕获请求里注入一个假图 ⇒
  关闭臂真的红了（错误信息里给出请求形态、不打印 base64）；③ 第 6 步之前把开关**临时**改成 `true` 跑过一次，
  开启臂真的**绿**了；第 6 步之后它是**默认跑**的（本轮实跑：视觉阶段 2 passed + 1 skipped）✓
- **已知未覆盖**：关闭臂在开关打开后被 skip ⇒ E2E 层面不再覆盖关闭侧的传输行为
  （由单测 override 覆盖）；若有人删掉开启臂，只有 `tests/vision-messages.test.mjs`
  的源码级接线门禁会红 ⚠

### 第 8 步实测（真实 API）

方法：同一段文本发两次（`deepseek-flash`，`stream:false`，`max_tokens:4`），读 `usage.prompt_tokens` 差值。

| 图宽（16:9，JPEG q40） | 体积 | 差值 prompt_tokens |
| --- | --- | --- |
| 320px | 1.4KB | 192 |
| 640px | 3.2KB | 192 |
| 960px | 6.4KB | 314 |
| **1280px（本仓库默认视口）** | 11.5KB | **578**（连测 3 次都是 578，纯文本基线恒为 44） |

⇒ 旧的 `TOKENS_PER_IMAGE = 400` 是**低估**（默认视口实测 578）⇒ 改成 **600**（保守上界）✓
⇒ 张数与单张体积上限的复核结论见上面「预算复核」一节（第 6 步做的）✓

### 关键技巧：第 5 步怎么做到"零风险"（第 7 步已升级为**整句**二选一）

⚠ 下面是第 5 步当时用的"只包一个从句"的做法。第 7 步审校发现**只条件化从句会拼出坏话**
（`：，` 坏标点、"只展示给用户" ⊕ "送进你的上下文"自相矛盾）⇒ 现在**四处**都是**整句**二选一
（`lib/shared/utils.js` 的 `VISION_ENABLED_TOOL_COPY` / `VISION_ENABLED_SKILL_COPY` /
`VISION_ENABLED_SUMMARY_COPY`，以及 `context.js` 里历史回放那句 —— 第 4 处是第 6 步补上的）。
**关闭侧仍然是逐字节原文** ✓ 原理不变：

不要**改写**那些文案 ✗（措辞一变就是模型可见变化 ⇒ 立刻要测量）。
而是**把现有文案原样包起来** ✓：

```js
// 例：lib/assistant/tool-schemas.js 的截图工具说明
VISION_ENABLED ? '' : '<这里原样保留当时那段"你看不到图像"的文本>'
```

这样 `VISION_ENABLED` 仍是 `false` 时，**输出与当时逐字节相同** ✓
⇒ 属于**纯重构**（模型可见内容零变化）⇒ 按纪律**不需要**跑 eval ✓
⇒ 而开关一旦打开，那段文案**自动消失** ✓ 不会留下"嘴上说看不到、上下文里却有图"的矛盾 ✓

判据（无需浏览器）：
- 单测：开关关闭时，四处产出的文本与**改动前**的字符串**完全相等**
  （把当时的原文当基准写进用例，并用 data: URL 改写源码拿**关闭臂**——第 6 步之后常量是 true）✓；
- 单测：开关打开时，四处都不再包含"看不到图像 / 未把图片传给模型" ✓；
- 源码级门禁：**四处**都必须**引用**开关，不许各自硬编码判断 ✓（防止有人只改一处）。
  ⚠ 这条门禁管不住"完全不随开关变化、但打开后会变成假话"的文本 ——
  第 4 处正是这种（它原先没读开关）⇒ 必须**额外**扫一遍模型可见文本，见「第 6 步怎么做的」第 1 条。

⚠ 原来这里写着"只有**第 6 步（打开开关）**才真正改变模型输入 ⇒ 到那时才做对照测量"。
**第 6 步已经做了**（见上文）——那一轮做的是**定向**测量（真 key 探针 + E2E 开启臂），
**没有**做"开/关各 4–6 次"的对照扫描；原因（环境无密钥）与未验证清单都写在上面，
**不要**把它当成"已完成全量测量" ✗

⚠ "改了模型能看到的内容必须测量"是本仓库最贵的一条教训（第 23→26 轮：没测量就标完成，
实测通过率 3/7 vs 5/5 后回退 ✗）—— 本条纪律**仍然有效**，只是第 6 步的测量被环境卡住了。

## 三、④ 场景泛化：还剩 5 个

已交付：付费墙/试看边界 ㉕、下载校验 ㉖、自定义日期选择器 ㉗
有证据待续：浏览器对话框（`/dialog` 夹具页**已写好并验证过自身行为**，
但 Playwright 的对话框管理与外部 attach 的 debugger 冲突 —— 页面会直接死掉 ✗
需要换一套驱动方式；细节在 `docs/next-steps-handoff.md` 与 `docs/regression-red-flag.md`）

未做：多候选站收敛、`<video>` 播放器状态、无限滚动 / hover 预览、富文本、HTML5 拖放

每个新场景按既有五件套做（**照 ㉕㉖㉗ 的样子抄**最省事）：
夹具页（造真难点）+ 剧本（`tools` 作契约锚点 + `pageChecks` + `mustSeeInToolResults`）
+ E2E（双层判据 + `autoApprove`）+ 技能 + 门禁（`node scripts/gen-capability-inventory.mjs` 后跑 `run-all-checks`）
+ 真模型 eval 实跑 ✓

**已知坑**（都踩过）：
- 触发词**必须**出现在剧本自己的指令里，且 E2E 指令要**逐字一致** ✓（有门禁，但改完要**立刻跑** ✓）
- 需要 `run_javascript` 的剧本要 `cdp: true` ✓（沙箱在 MV3 下**任何页面都跑不起来** ✓）
- 脚本化路径**没有思考延迟** ⇒ 异步渲染必须显式 `wait_for_element` ✓
- 判据**不要预设实现**：我犯过 7 次（如用我自己脚本里的键名 `lastFree` 当判据 ✗）
  ⇒ 判据要来自**页面自身的文本/数据** ✓

## 四、⑤ 技能归纳：还剩 2 项

已完成：清单生成 + 门禁（第 19 轮）、重复量化（第 20 轮）、9 个孤儿声明（第 21 轮）、薄技能量化（第 22 轮）
已证伪并回退：抽"通用操作纪律"底座（第 23 轮做、第 26 轮实测证伪 ✗）

1. **删各技能正文里的重复段落**
   —— ⚠ **删重复 ≠ 加底座**：删掉能省 token 且**不**稀释正文 ✓ 但仍**必须先测基线** ✓
   数据在 `docs/skills-overview.md`（`complete_task`×33、`get_page_snapshot`×31、`inspect_element`×28）
2. **薄技能充实或合并**：`remove-ads`(246) / `clip-to-knowledge`(292) / `userscript-task`(357)
   —— 注意这**三个同时是孤儿技能** ⇒ 它们是最弱的一环；要么补剧本、要么明确承认只是文案层 ✓

## 五、② 已收口；③（A3/A4/A5）本轮**逐条复核**后的结论

> **本节是重写的。** 原文只有三行结论（"已收口 + 禁毒缓存 + 单一来源 ✓"），
> 没有 file:line、没有测试名、没有命令输出 —— 属于"结论先行、证据缺失"，而且**已经过期**：
> 逐行核对时发现 A3 还有一条 CDP 调用没有超时、桥接侧的截图阶梯**根本没修**、
> A4 的标记形态在**两个渲染器**里只修了一个、A5 有一条**完全静默**的截断路径。
> 以下每条都给：判据 → 现状（file:line）→ 测试 → 实跑命令 → **没做到的部分**。

### 5.1 A3：CDP 每条命令都要自己超时 —— **部分收口 → 本轮补齐后 = 已收口（仍有一处未复现）**

复核方法：`git grep -n "chrome\.debugger"` 找出**全部**入口，再逐个看调用链；
`git grep -n "cdp\."` 找出所有调用方，确认没有任何一处绕过 `command/attach/sendRaw`。

| 判据 | 现状（file:line） | 结论 |
| --- | --- | --- |
| 每条命令有超时 | `lib/backend/cdp.js:138` `command()` → `sendRaw()`（`:97`，`withTimeout` 包裹 `chrome.debugger.sendCommand`）；`attach()` `:25` 同样超时；`Page.enable` 走 `sendRaw` 默认超时（`:52` 那段） | ✓ |
| 默认超时存在且 <15s | `lib/backend/cdp.js:118` `DEFAULT_CDP_TIMEOUT_MS = 8000` | ✓ |
| attach 缓存的是**带超时**的 promise | `lib/backend/cdp.js:48` 缓存 `task`（= `withTimeout(...)`），注释在 `:45-47` 写明"缓存原始 promise 会让这个标签页再也用不了 CDP" | ✓ |
| 失败清缓存（无毒化） | `lib/backend/cdp.js:54-58`（`catch` 里 `attached.delete(id)`）；`onDetach` 也清（`:19-23`） | ✓ |
| **✗ 漏网的一条：`detach`** | 原 `detach()` 把 `chrome.debugger.detach` 的回调直接包进 `new Promise`，回调不触发 ⇒ **永不 settle** | **本轮补**：`lib/backend/cdp.js:72` 现在走 `withTimeout(...).catch(()=>{})`（解绑是尽力而为，超时吞掉但不许挂住） |
| 截图阶梯受**总预算**约束 | 面板侧：`lib/assistant/screenshot-tool.js:69` `captureWithLadder`（预算 → 剩余预算下传 `timeoutMs`），默认 `:28` `DEFAULT_SCREENSHOT_BUDGET_MS = 12000`，`takeScreenshot` 的预算入口 `:124`；`Page.getLayoutMetrics` 共用同一份 deadline（`:148`） | ✓（12s < 15s） |
| **✗ 桥接侧完全没有预算** | `lib/bridge/relay.js:234` `screenshotCapture` **自己抄了一份阶梯**：无 deadline、每档默认 8s（最坏 24s+），失败一律报"无法附加" | **本轮补**：`:263` 改用共享的 `captureWithLadder`，失败按 `:276` 的 `shot.timedOut` 分两种措辞 |
| 超时 vs 附加失败**分开报** | 面板侧 `screenshot-tool.js` 的成功/失败分支；桥接侧同上 | ✓（两处都有门禁） |

**实跑**：
```
node --test tests/cdp-timeout.test.mjs
ℹ tests 12   ℹ pass 12   ℹ fail 0      （复核前是 8 条）
```
新增 4 条：⑨ detach 有界（含"朴素实现必挂"的牙齿断言）、⑨b detach 源码必须在 `withTimeout` 里 +
其它文件不得直连 `chrome.debugger`、⑩ `captureWithLadder` 预算/超时标记（含"朴素循环会走满三档"的牙齿）、
⑩b relay 必须走共享阶梯（源码级）。

**⚠ 没有做到的部分（如实写）**：
1. **"15s 挂起"的原始复现从未做到过** —— 本环境里没有可复现该现象的页面/会话
   （当时的症状来自用户会话：`take_screenshot` 与 `list_frames` 各挂满 15 秒）。
   本轮能证明的只是"**症状已由超时梯子兜住**"：Chrome 永不回调时，命令在
   `DEFAULT_CDP_TIMEOUT_MS=8000` 内拒绝、阶梯在 12s 预算内收口、错误能指出卡在哪一步。
   **原始复现未完成** ⇒ 不要写成"根因已在真实页面复现"。
2. 桥接侧的预算**只有静态 + 单测证据**（`tests/cdp-timeout.test.mjs` ⑩），
   **没有**在真实浏览器里对 `screenshotCapture` 跑过超时场景（E2E 不覆盖桥接截图）。

### 5.2 A4：省略标记不能与数据同形 —— **本轮从"部分"补到"已收口"**

复核方法：`git grep -n "共 N 项\|省略\|⟨…省略"`，逐个判断"这处产物**进不进模型上下文**"。

**两条链路必须分清（这是本轮才写清的事）**：

| 产物 | 谁生成 | 谁读 | file:line |
| --- | --- | --- | --- |
| **进模型上下文**：控制台/网络数据的省略标记 | 页面主世界的裸脚本 | `page_health` / `read_console` 的工具结果 → 模型消息 | `lib/page/debug-hook.js:92`（数组元素）、`:103`（对象键）；取数链：`lib/page/debug-capture.js` → `lib/page/chat.js:1014-1021` → `content.js:5356-5384` → `lib/bridge/relay.js:187` → MCP `page_health` |
| **渲染器产物**（人看 / 导出 / 粘贴给别人） | 导出与面板渲染器 | 导出记录、面板持久化 —— **不进本次模型的请求** | `lib/page/transcript.js:247` `previewArgsJson`、`:133` `clipPart`、`:279` `toolLine`；调用方 `lib/page/chat.js:922/937` |

| 判据 | 现状 | 结论 |
| --- | --- | --- |
| 省略标记用可辨形态（不是 `…共 N 项`） | `lib/page/transcript.js:226` `OMIT_MARK_START = '⟨…省略 '` / `formatOmittedItems`；debug-hook 用同一字面量（`:92`） | ✓ |
| 数组元素形态不与数据同形 | 上面两处 | ✓ |
| **✗ 键名仍与数据同形**：`clipPart` 与 `previewArgsJson` 的退化分支原先写 `{ '…': … }`（键名与真实字段名同形） | 旧形态在 `lib/page/transcript.js` 的 `clipPart`（现在 `:156`）与 `previewArgsJson` 退化分支（现在 `:271`）—— 改动前两处都是 `'…'` 键 | **本轮补**：新增 `:239` `OMIT_ARGS_KEY = '⟨…省略参数⟩'`，两处都改用它；`debug-hook.js:103` 早已是 `⟨…省略字段⟩` |
| 门禁是否**两边都扫** | 旧 `tests/omit-mark.test.mjs` ⑤ **只正则扫 debug-hook.js** ⇒ transcript.js 那个坑一直没被管 | **本轮补**：⑤ 现在同时扫两个文件；新增 ⑥（行为面：键名必须是 `OMIT_ARGS_KEY`、要说"取不回"）、⑦（正常参数逐字节不变） |

**实跑**：
```
node --test tests/omit-mark.test.mjs
ℹ tests 7   ℹ pass 7   ℹ fail 0        （复核前 5 条）
```

**没有做到的部分**：`transcript.js:143-158` 的 `resultTruncated` / `textTruncated` 只是**布尔标记**，
导出文本里读不出"截掉了多少"（`clipInline` 有"共 N 字符，已截断"，但 `clipPart` 只置位）。
本轮**没有**改它 —— 它不改变"元信息 vs 内容"的形态判定（没有与数据同形），
属于可读性问题；要改的话得连导出测试一起动，列在这里而不是假装已经修了。

### 5.3 A5：每条截断路径都要"给可恢复 id"或"明说取不回" —— **本轮从"部分"补到"已收口"**

复核方法：`git grep -n "formatTruncationNotice|collapseOldToolResults|MAX_TOOL_TRAIL|MAX_TRAIL_RESULT_CHARS|omittedBySize|noticeOnTruncation|truncateEvidenceText"`，
逐个看调用点是否**既能说明又给得出下一步**。

| 截断路径 | 现状（file:line） | 判据 |
| --- | --- | --- |
| 工具结果 > 6000 字符 | `lib/assistant/agent.js:1734` 用 `formatTruncationNotice(res.result.length, rid)`（格式单一来源 `:327`），全文进 `ctx.resultStore` | ✓ 有 id=res-N + 用法 |
| 历史折叠（`collapseOldToolResults`） | `lib/assistant/context.js:261` `buildCollapsed`：认得出整条通知就**保住 id**（`id=…，可用 expand_result(id=…) 分段取回`），认不出就明说"**中段内容已省略且取不回原文**，请重新调用产生它的工具" | ✓ 两条分歧都有措辞 |
| handoff 轨迹上限（`MAX_TOOL_TRAIL=60` / `MAX_TRAIL_RESULT_CHARS=600`） | `lib/shared/handoff.js:30/:32`；`buildHandoffRecord` 写 `trailTotal/trailStored/trailOmitted`（`:330-332`），全量另存一个 key（`:170` `MAX_TRAIL_FULL=200`），MCP 侧把三个数的语义写给调用方（`integrations/opencode/recallflow-mcp/index.js:930`、`:1085-1086`） | ✓ 可恢复的步数 vs 取不回的步数分开 |
| 快照体积预算（`omittedBySize`） | 生产 `lib/page/page-text.js:606-617`；提示语 `lib/assistant/page-read-tools.js:168-182`（"另有 N 个…，需要它们时先 scroll_page…"） | ✓ |
| 单图超预算（视觉） | `lib/assistant/vision.js:138-143`：全部被跳过时仍产出一条说明消息 | ✓ |
| **✗ 历史单条超长（`normalizeHistory`）** | `lib/assistant/context.js:219` 原来是 `content.slice(0, maxChars)`——**一个字节的说明都没有** | **本轮补**：`:223` 追加 `formatHistoryTruncationNotice`（共 N 字符 / 只送入前 M / **被截掉的部分取不回原文**） |
| **✗ 上一轮执行摘要超长** | 同一处 `toolSummary.slice(0, 400)` 静默 | **本轮补**：`:225-233` 追加 `⟨…摘要已截断，共 N 字符⟩`（上限改由 `:99` `HISTORY_SUMMARY_MAX_CHARS` 单一来源） |
| **✗ 更早历史被丢弃（两种上限）** | `noticeOnTruncation` 这个开关**生产从未打开**（`git grep noticeOnTruncation` 旧结果只有测试），且"条数上限"那条路连置位点都没有（循环条件里退出） | **本轮补**：`lib/assistant/context.js:205`+`:211` 两种上限都置 `dropped`；`lib/assistant/agent.js:210` 与 `lib/shared/rag.js:213` 显式传 `noticeOnTruncation: true` |
| **✗ 指令去重判据的字面量耦合** | `agent.js` 原判据 `last.length === 3000`：一旦历史被截断（长度变了）就静默失效 ⇒ 当前指令在请求里出现两次 | **本轮补**：抽成 `lib/assistant/context.js:160` `isDuplicateInstruction`（先剥通知再比，`:97` `HISTORY_MAX_CHARS` 单一来源），`lib/assistant/agent.js:220` 调用它 |
| **✗ 桥接 `browser_read` 的截断** | `lib/bridge/relay.js:396` `truncateEvidenceText` 只说"已截断" | **本轮补**：说明改成"**被截掉的部分无法用 id 取回**，需要时请用更大的 maxChars 重新调用 browser_read" |
| **✗ 落盘快照单条超长（`compactSessionMessages`）** | `lib/assistant/agent.js:168` 原为 `message.content.slice(-12000)`——静默留尾 | **本轮补**：`:186-193` 前置 `formatTailKeptTruncationNotice`（`lib/assistant/context.js` 新增），说明"共 N 字符 / 只保留末尾 / 前半段取不回"；上限改由 `:165` `SESSION_MESSAGE_MAX_CHARS` 单一来源 |
| **✗ 落盘快照丢整条消息** | 同一函数 `source.filter(…).slice(-39)`：超出 39 条的历史**静默消失** | **本轮补**：`:175-182` 补一条"更早的 N 条消息未随快照保存，取不回原文"的说明消息 |

> ⚠ 为什么落盘快照也算 A5：它在"继续上一次运行"时被**原样恢复成发给模型的 messages**
>（`lib/assistant/agent.js:1279-1283`）。快照里的静默截断 = 模型看到一段没有开头的文本，
> 却以为那就是全部对话 —— 与 `normalizeHistory` 那条是同一个错，只是发生在恢复路径上。

**实跑**：
```
node --test tests/expand-result.test.mjs
ℹ tests 7   ℹ pass 7   ℹ fail 0

node --test tests/context.test.mjs tests/agent-prompt.test.mjs tests/silent-failure-regressions.test.mjs
ℹ tests 100   ℹ pass 100   ℹ fail 0
```
（`tests/context.test.mjs` 15 → 21 条；`tests/agent-prompt.test.mjs` 的 `compactSessionMessages` 两条
**被改写过** —— 旧断言把"静默 slice"与"静默丢弃 11 条"当契约钉住了。现在断言更严：
既要截断/丢弃，也要**说明**，并且"没超限时逐字节不变"。两处都属于**收紧**而非放宽。）

**没有做到的部分（如实写）**：
1. **模型可见文本被改动，但没有做真模型测量** ✗
   本轮动的模型可见文本有三类：① 截断说明（**只在真的发生截断时才出现**：单条历史 >3000 字符、
   历史条数/token 超限、上一轮摘要 >400 字符、落盘快照单条 >12000 字符或超过 39 条）；
   ② 桥接的错误/截断措辞；③ 恢复时新增的"更早的 N 条未保存"提示。
   本环境里 `E2E_LLM_REAL_KEY` / `RECALLFLOW_EVAL_API_KEY` **都没有设置** ⇒
   `docs/regression-red-flag.md` 要求的"改模型可见内容必须测量"**未能执行**。
   能给的确定性证据只有：正常路径（未截断）**逐字节不变**（有断言：`tests/context.test.mjs`
   的"未超长时一个字都不多"、`tests/agent-prompt.test.mjs` 的"正好等于上限时一个字都不许多"、
   `tests/omit-mark.test.mjs` ⑦），以及 `scripts/check-prefix-stability.mjs` 全绿。
   ⚠ **不要把它当成"已测量"** ✗
2. **`noticeOnTruncation` 打开后的前缀缓存影响没有实测**：那条提示会作为**第一条**历史消息出现，
   首次出现时整段前缀失效一次（与本仓库已知的折叠行为同类）。没有测过它的成本。
3. **`sanitizeToolPairing` 仍会静默剔除"配对不全"的消息**（`lib/assistant/agent.js:147-159`）：
   这是协议硬要求（悬空的 tool 结果会让请求非法），但它剔掉的**内容**没有留痕。
   本轮**没有**动它（要动得先想清"合法请求"与"留痕"如何兼得）。
4. 历史截断的说明里写的是"请让用户重新说明 / 改用工具重新读取页面"——
   **没有**做"自动把原文存进 `resultStore` 并给 id"（那需要把前端会话历史也接入暂存，是行为改动）。

### 5.4 本轮的牙齿证据（构造坏输入 ⇒ 必红）

在**仓库副本**（`%TEMP%` 下，未改动本工作树）里做了 **11 组**定向变异，逐条确认对应门禁变红：

| 变异（改回旧实现） | 变红的门禁 | 退出码 |
| --- | --- | --- |
| `detach` 去掉 `withTimeout` | `cdp-timeout` ⑨（12s test-timeout 兜底）+ ⑨b | 1 |
| `captureWithLadder` 忽略总预算 | `cdp-timeout` ⑥ + ⑩ | 1 |
| relay 换回自己的阶梯 | `cdp-timeout` ⑩b | 1 |
| `clipPart` 键名改回 `'…'` | `omit-mark` ⑤ + ⑥ | 1 |
| 历史截断改回静默 `slice` | `context.test` 截断说明 + `isDuplicateInstruction` | 1 |
| 条数上限不置 `dropped` | `context.test` 条数上限提示 | 1 |
| agent.js 不传 `noticeOnTruncation` | `context.test` 生产调用方源码门禁 | 1 |
| `truncateEvidenceText` 去掉"取不回" | `silent-failure-regressions` 截断标注 | 1 |
| `isDuplicateInstruction` 不剥通知 | `context.test` 截断副本去重 | 1 |
| `compactSessionMessages` 单条改回静默 `slice(-12000)` | `agent-prompt.test` 留尾+说明 | 1 |
| `compactSessionMessages` 丢整条消息不补说明 | `agent-prompt.test` "丢了多少必须写明" | 1 |

### 5.5 一句话状态

- **② 会话容量：已收口**（原文结论，本轮未复核这一条 —— 别把它当成刚验过）。
- **③ A3：已收口**（"每一条 CDP 调用都有界"现在成立）；
  ⚠ 但**"15s 挂起的原始复现"未完成**，桥接侧预算只有单测证据。
- **③ A4：已收口**（两个渲染器的省略标记形态统一 + 门禁两边都扫）。
- **③ A5：已收口**（逐条截断路径都有 id 或明说取不回）；
  ⚠ 但**新增的模型可见文本没有真模型测量**（无密钥），这一条如实标注为未测量。

---

## ④ 富文本 / HTML5 拖放：**未做，但已切成可执行的小步**（本轮因"委托迟迟不落盘"而停在这里）

### 为什么会停在这里（如实）
本会话对这两个新场景派了 4 次单，**其中 3 次在 3 轮内 0 落盘**（最后一次是"只造一个夹具页"这种极小任务也没落盘 ✗）。
规律很清楚：**只要派单里出现"先读几千行、再一次性写五件套"，agent 就会把预算花在读代码上** ✗
⇒ **下一轮的做法：一步只做一件事，并要求"落盘后再做别的"**（本会话里成功落地的块都是这样落盘的）。

### 富文本（"看起来改上了 ≠ 真的改上了"）—— 5 个难点（照原设计，可直接用）
1. **`contenteditable` 只认可信的输入**：纯合成事件/直接赋值 `textContent` ⇒ 页面状态与隐藏字段**不更新**
   （页面记 `__rt.syntheticIgnored++`）✗ ⇒ 必须走 CDP 可信输入（或页面可接受的输入路径）
2. **必须保住结构**：页面记 `__rt.strong` / `__rt.list` / `__rt.links` ⇒ 只改纯文本不算完成
3. **工具栏按钮作用于选区**：没有选区就点「加粗」⇒ **什么都不发生**（`__rt.noopClicks++`）✗
4. **隐藏字段只在 `blur` 时同步**：不失焦就读回 = **旧值**（`__rt.syncs++`）✗
5. **迷惑项**：装饰性「B」图标（`#rt-fake-bold`）点了只动它自己（`__rt.fakeBold++`）✗

**判据（双层）**：页面状态 = 结构数量真的对 + 隐藏字段与编辑器一致 + `noopClicks > 0` 而结构**确实变了**；
模型回执 = **结构性证据**（读回的 HTML 片段 / 结构摘要）真的到了模型手上 ✓
**阴性对照**：初始内容里没有目标结构；点装饰键后结构一位不变 ✓
**捷径必败**：只点按钮不选文字 / 只用合成事件打字 / 只读 `innerText` / 不失焦就读回 ✓

### HTML5 拖放（原生 `dragstart/dragover/drop`）
难点方向：原生拖放**不走鼠标事件**（合成 `mousedown/mousemove` 无效）⇒ 必须派发**真的 DragEvent** 或用
`DataTransfer` 构造；且 `drop` 的**默认行为**会阻止/吞掉事件（要 `preventDefault` 的时机对）；
判据同样两层：页面状态（落点容器真的收到数据、`__dd.dropCount++`）+ 模型回执（拖放结果文本到手）✓

### 这两个场景的验收清单（照本仓库既有纪律）
夹具 → 剧本（`tools` 序列 + `pageChecks` + `mustSeeInToolResults`）→ 脚本化 E2E（双层判据 + 阴性对照）→
技能（**编号步骤**，`x.tools ⊇ 剧本 tools`）→ 生成脚本重跑 → **注入必红 ×2** → 连跑两次 → 全量 E2E →
**真模型 eval ×3**（`--grep` **必须取自剧本 `title`**，跑前 `--list` 确认 `Total: 1`）→ 数字同步 → 提交 ✓

### ④ 的**当前真实状态**（第 62 轮定格；下一会话从这里继续）

**已落地并提交（都真起服务验证过）**：
- `/rich` —— `richTextPage()`：`window.__rt = { syntheticIgnored, noopClicks, syncs, fakeBold, inputs, strong, list, links }`，
  元素 `#rt-editor` / `#rt-hidden` / `#rt-bold` / `#rt-list` / `#rt-link` / `#rt-fake-bold` / `#rt-status`
  （HTTP 200 / 2819 字节 / 12 项全命中 ✓）
- `/h5drag` —— `html5DragPage()`：`window.__dd = { dragStarts, dragOverAccepted, drops, acceptedDrops, wrongZone, emptyDrops, fakeDrags, lastPayload, lastZone }`，
  元素 `#dd-card` / `#dd-fake` / `#dd-left` / `#dd-right` / `#dd-result` / `#dd-status`
  （HTTP 200 / 2434 字节 / 全部命中 ✓）

**每个场景还剩 3 个小步**（**原子单元**：少任何一个契约门禁都会红 ✗ —— "剧本要有技能""技能 tools ⊇ 剧本 tools""清单要看到 E2E 引用"）：
1. mock LLM 分派块（**计数器推进**，不要用"回执里有没有某串"推进 ✗）+ 剧本（`pageChecks` 必须是**真状态**）+ 技能（**编号步骤**）+ 一条 E2E 用例（**基线 + 双层判据 + 至少一处"走捷径就达不到"**）+ 生成脚本重跑；
2. **注入必红**（例如"让合成事件也能更新状态"/"让隐藏字段实时同步"/"让 drop 不需要 preventDefault"）+ 连跑两次 + 全量 E2E；
3. **真模型 eval ×3**（`--grep` 必须取自剧本 `title`，跑前 `--list` 确认 `Total: 1`）→ 数字同步 → 提交。

**为什么停在这里（如实）**：这一步对**委托**连试 5 次、其中 4 次在 2–3 轮内 0 落盘（含"只造一个夹具页"这种极小任务 ✗）；
规律是"先读几千行再写"会把预算烧光 ⇒ 有效做法是**每轮只做一小步且必须落盘**（夹具页两步就是这么落地的 ✓）。
会话上下文也已耗尽 ⇒ 剩下的"读形状再写 100+ 行"留给下一会话，按上面 3 个小步走 ✓

### 两个夹具页的难点机制**已实测验证**（不是"能取到页面"，而是机制真的生效）✓

用一次性 Playwright 探针跑出来的原始读数（探针不入库，读数记在这里供下一步用）：

| 检查 | 读数 | 结论 |
| --- | --- | --- |
| 合成编辑（直接改 DOM + 合成 `input` 事件）| `inputs=0`、**`syntheticIgnored=1`** | **陷阱生效**：看起来有字、状态不更新 ✗ |
| 可信键入（Playwright 真键盘）| `inputs=4` | 可信输入才被承认 ✓ |
| 无选区点「加粗」| **`noopClicks=1`、`strong=0`** | 空操作被记下且结构一位不变 ✗ |
| 合成 `DragEvent` + `DataTransfer` 落到右区 | `drops=1`、**`acceptedDrops=1`** | drop 真的收到 payload ✓ |
| 同上，结果文案 | `已收下 RF-7391（落点：dd-right）` | 状态与文案一致 ✓ |

**对写 mock 剧本的两条直接约束**（少走弯路）：
1. **拖放**：页面**不查 `isTrusted`** ⇒ mock 剧本可以用**合成 `DragEvent` + `DataTransfer`** 驱动（不必走 CDP）✓
2. **富文本打字**：页面**只认可信 / 带 `inputType` 的输入** ⇒ mock 剧本**必须用可信键入（CDP）**，纯合成会被拒 ✗

### ④ 剩下两步的**可照抄骨架**（把"要先读几千行"这件事提前做掉，避免下一会话再停滞 ✗）

> 目标：下一会话**不必先勘察**，照下面的骨架填即可。所有字段名/工具名都已核对过真实存在。

#### A. 富文本（`/rich`）—— 剧本 + E2E 用例（技能已落地 `rich-text-structure` ✓）

**mock LLM 分派块**（`tests/e2e/fixtures/server.mjs`，放在既有的剧本分派区，**用计数器 `done = toolResults.length` 推进** ✗不要用文案匹配）：
1. `get_page_snapshot({maxElements:40})` —— 看清 `#rt-editor` 与工具栏
2. `click_element({selector:'#rt-editor'})` + **可信输入**（CDP 键入，如 `type_text` 走可信事件；⚠ 合成会被页面拒 ✗）
3. **选中一段文字**（`run_javascript({engine:'page'})` 里 `getSelection()` 选 Range，或键盘 Shift+Home —— 二选一，后者更"可信"）
4. `click_element({selector:'#rt-bold'})` —— 结构应出现 `<strong>`（`__rt.strong >= 1`）
5. `click_element({selector:'#rt-list'})` —— 列表（`__rt.list >= 1`）
6. `click_element({selector:'#rt-bold'})` **不选**任何文字 —— 页面记 `__rt.noopClicks += 1`，结构**不变** ✓
7. `click_element({selector:'#rt-fake-bold'})` —— 装饰键：`__rt.fakeBold += 1`，结构**不变** ✓
8. `click_element({selector:'h1'})` —— **让编辑区失焦** ⇒ `__rt.syncs += 1` 且 `#rt-hidden` 被写入 ✓
9. `inspect_element({op:'text', text:'结构'})`（读 `#rt-status`）—— 把结构计数读回（**回执判据**靠它）
10. `complete_task(...)`

**playbook 条目**（`tests/e2e/fixtures/playbooks.mjs`）：
- `id: 'rich-text-structure'`、`trigger: '富文本'`（⚠ 必须**逐字**出现在 `instruction` 里）
- `tools: ['get_page_snapshot','click_element','type_text','press_key','inspect_element','complete_task']`（技能 `x.tools` 已 ⊇ 它 ✓）
- `eval.url: '/rich'`；`pageChecks`（**全是真状态**）：
  `window.__rt.strong >= 1`、`window.__rt.list >= 1`、`window.__rt.noopClicks >= 1`、
  `window.__rt.syncs >= 1`、`window.__rt.fakeBold >= 1`、
  `document.getElementById('rt-hidden').value.indexOf('strong') >= 0`
- `mustSeeInToolResults: ['strong', 'ul']`（或状态串里的结构计数 —— **只可能来自读回**）

**E2E 用例**（`tests/e2e/golden.spec.mjs`）：先跑**基线**（`__rt.strong/list/links` 全 0、`#rt-hidden` 为空、
点一次 `#rt-fake-bold` 后结构**一位不变**）→ `page.reload()` 复位 → `sendInstruction(...)` → 双层判据
（页面状态见上 + `toolResultsText()` 里出现结构证据）✓

#### B. HTML5 拖放（`/h5drag`）—— 技能 + 剧本 + 用例

- **技能** `html5-drag-drop`（照 `rich-text-structure` 的形态写：编号步骤 —— 先看清卡片与两个落点 →
  用**真 DragEvent / DataTransfer**（⚠ 合成鼠标事件无效 ✗）→ 落点必须 `dragover` 里 `preventDefault()` 过 →
  payload 在 **`drop` 里**读 → 读回 `#dd-result` 与 `window.__dd` 计数 → 结论只用读回的数据；`x.tools ⊇ 剧本 tools`）
- **mock 剧本的捷径**：探针已证明**页面不查 `isTrusted`** ⇒ 可用 `run_javascript({engine:'page'})` 里
  `new DataTransfer()` + `dispatchEvent(new DragEvent('dragover'|'drop', {dataTransfer}))` 驱动（**不必走 CDP** ✓）
- `pageChecks`：`__dd.acceptedDrops >= 1`、`__dd.drags`…（`dragStarts >= 1`）、**`__dd.wrongZone === 0`**、
  `__dd.emptyDrops === 0`、`#dd-result` 文本含 `RF-7391`；`mustSeeInToolResults: ['RF-7391', '收下']`（或 `#dd-result` 原文）
- **阴性对照**：初始 `#dd-result` 为"尚未收到任何工单"；`#dd-fake` 卡片拖它 ⇒ `fakeDrags++` 而 `drops` 不变 ✗

**两步之后**：`gen-*` 重跑 → 注入必红 ×2 → 连跑两次 → 全量 E2E → **真模型 ×3**（`--grep` 取自 `title`，先 `--list` 确认 `Total: 1`）→ 数字同步 → 提交 ✓

### 富文本脚本化用例：**根因已定性**（第 74 轮）—— 两条待决修法 + 一个新发现

**新发现（本轮，很关键）**：`run_javascript` 的 schema 里写明 **"每次执行都需用户批准"** ✗
⇒ 脚本化 E2E 里若没有自动批准，这一步**拿不到工具结果、整轮就停在那里**
（观测：mock 用计数器推进，但结果数**卡在 3 条**、`#rt-bold` 的事件序列为 `[]` ✓ 完全吻合）
⇒ **任何依赖 `run_javascript` 的脚本化剧本，都必须先确认"批准"这条链路**（否则会静默停在那里 ✗），
这条对 `<video>`（`inspect_element` 读状态那条不走 JS）与 CSP 场景也有参考价值 ✓

**根因（一条）**：夹具难点①要求 **`isTrusted` 输入**，而产品的 `type_text` **只发合成事件**
（实测：`cdpEnabled:true` 下仍然 `syntheticIgnored:1`、`inputs:0`；`click_element` 也发合成事件
`mousedown/mouseup/click` 全是 `isTrusted=false`、`detail=0`）⇒ **这个难点落在产品能力之外** ✗
（`cdpEnabled:true` 的写法经核对是对的 ✓；`type_text` 的两个真错误已修：必填参数是 **`value`**、
且**必须给定位符** ✓）

**两条修法（二选一，都已评估）**：
1. **改夹具判据（小、推荐）**：把"必须 `isTrusted`"改成"必须带 **`inputType` 的 `beforeinput`/`input`**"✓
   陷阱仍然成立（**直接改 DOM / 纯赋值根本没有 `beforeinput`** ⇒ 仍然被拒 ✓），而产品的打字能通过 ✓
   ⚠ 配套：还需一条**选区**路径（`press_key({key:'Control+a'})` 在这次实测里没造出选区 ✗ ——
   怀疑是编辑区当时**没有焦点**；下一步先加一次 `click_element('#rt-editor')` 再按 Ctrl+A，
   或确认 `run_javascript` 的批准链路后用它设 Range ✓）
2. **改产品**：让 `type_text` 走 CDP **可信输入** ✗（影响面大：所有输入类场景都要重测 ✓）

## (b) 思考"流式置底"的真浏览器断言：**本轮未做成，已回退，根因待查** ✗（如实记，不假装 ✓）

**为什么回退**：断言在实测中**稳定读到同一个偏差 265px** ✗（`scrollHeight - scrollTop - clientHeight = 265`），
我据此排除的两个假设都被**证伪**：
1. ❌ "折叠态下推理正文不计入高度 ⇒ 断言恒真" —— 折叠确实是事实 ✓（面板只有 ~171px 高、内容 ~220px），
   但**展开后**再断言，读数仍恒为 **265** ✗
2. ❌ "Playwright `locator.click()` 自动把元素滚进视野 ⇒ `observerAutoScroll` 被置 false" ——
   改成 `evaluate(el => el.click())`（不触发自动滚动 ✓）后，读数**仍然**是 **265** ✗

**已确认的事实（对下一步有用）**：
- `.p-body` 是滚动容器 ✓（溢出守卫 `h > c + 60` 能通过 ✓）
- 夹具 `sseThinkStream`：头两片思维链 → **4 秒 hold** → 第二段 + 正文 ✓（"思考进行中"窗口确定存在 ✓）
- 面板在该视口下只有 **~171px** 高 ⇒ 推理文本要很长才溢出（我已把夹具头两片加长到 `repeat(40)` 试过 ✓）

**下一步该量什么（先量再改，别再猜 ✗）**：
- 在 `chat.js` 临时插一个探针：`window.__probe = { pins: 0, lastPinAt: 0 }`，
  在**每一处** `scrollTop = scrollHeight` 的守卫分支里 `pins += 1` ⇒ 直接看"置底到底有没有被调用过"✓
- 同时读 `observerAutoScroll` 的真值（探针里一并暴露 ✓）与"谁在滚动"（`.p-body` 还是别的祖先 ✓）
- 266/265 这种**恒定值**提示：读数可能来自"布局里另有一段固定高度"（例如 .fab / 输入区 / 提示条 ✓），
  也可能 `clientHeight` 不是可视区高度 ⇒ **先把这三个量各自打出来**再谈断言 ✓

**纪律**：不许为了让这条变绿去**放宽**断言（例如把 40px 阈值改成 300px ✗）；
本轮结束时的状态是**回退到 HEAD**（思考用例 `1 passed 6.8s` ✓、全量 E2E 绿 ✓），
(b) 作为**未完成项**留在队列里 ✓

## (b) 第二轮测量：**找到了真缺陷** —— 第二个思考块挂载时面板被**重置到顶部** ✗

**测量方法**（临时在思考用例里打时间序列，每 200ms 记 `h/t/c/偏差`；**不改产品代码** ✓）：
```
i=0..17  h=247 t=48 c=171 dist=28    ← 置底**确实生效**：偏差 28 < 40，视图贴着底 ✓
i=18..24 h=366 t=0  c=199 dist=167   ← 第二块挂载后：scrollTop **被重置成 0** ✗（跳到顶部）
```
（这一段覆盖了夹具的 4 秒 hold 与 hold 之后的增量 ✓；`clientHeight` 从 171 变 199 ✓ 说明布局也变了 ✓）

**结论（可复现）**：
1. **流式增量置底是好的** ✓（上一轮我改的那两处**有效**：i=0..17 一直 dist=28 ✓）
   ⇒ 之前那次读到"稳定 265/167"的偏差，是**被后面的重置覆盖了** ✗，不是我的修法没生效 ✓
2. **真正的缺陷**：第二块思考挂载 / 正文到达时，面板 `scrollTop` 变成 **0** ✗ ⇒
   用户正在看的内容**被顶走**（"思考时视图不跟手"的用户反馈，根因很可能是这一条 ✓ 而不只是"没置底" ✓）

**下一步（先定位"谁把它置成 0"再改，别猜 ✗）**：
- 在 `chat.js` 里给 `panelBody.scrollTop` 的**每一处赋值**加临时探针（记 `pins` 与**最后一次赋的值** ✓），
  跑同一条用例 ⇒ 直接看出是"置底之后又被谁写成 0"还是"整块 DOM 被重建（重建本身会把 scrollTop 归零 ✓）"✓
- 重点怀疑：`resetReasoning` / `mountThinkSegment` 挂新块时是否有 `innerHTML` 级重建 ✓，
  以及"新一轮开始时清掉上一轮指针"那条路径 ✓（`tests/thinking-record.test.mjs` 里已有相关用例 ✓）
- 定位后按纪律：**改实现 + 加门禁**（门禁要能咬住"挂块后 scrollTop 必须仍在底部"✓）；
  ⚠ 仍然**不许**放宽阈值凑绿 ✗

**本轮结束状态**：临时测量代码**已回退** ✓；思考用例 `1 passed` ✓；全量 E2E 绿 ✓；(b) 仍未完成，
但**根因已从"置底没生效"修正为"挂第二块时被重置到顶部"** ✓ —— 这是一次有价值的修正 ✓

### (b) 追查"谁把 scrollTop 归零"：**已缩小到两处候选**（第 91 轮）

**重要的排除**：全文件**没有任何一处**把 `scrollTop` 写成 **0** ✗（14 处全是**受守卫的置底**
`if (observerAutoScroll && panelBody) panelBody.scrollTop = panelBody.scrollHeight;` ✓），
`mountThinkSegment`（`chat.js:604`）也只是**新建块 + 追加**（没有重建 ✗）⇒
**嫌疑指向"整块 DOM 被重建"** ✓（重建本身就会把 scrollTop 归零 ✓）

**两处候选（按嫌疑排序）**：
1. **`chat.js:1882`** —— `flowEl = document.createElement('div'); flowEl.className = 'agent-flow';` +
   `aiMsg.appendChild(flowEl)` ⇒ **每次调用都会造一个新的流容器** ✗
   ⇒ 要确认它是不是在**一轮之内**也会被调用（若"正文开始 / 收到 chunk"时调用了它，就会把流容器换新 ✓
   而新容器插入会把滚动位置归零 ✓ ⇒ 与观测到的 i=18 时刻（第二块挂载 + 正文到达 ✓）**高度吻合** ✓）
2. **`chat.js:1645`** —— `flowEl = null;`（某个重置路径 ✓）⇒ 之后第一次 append 会走别的分支 ✓

**插桩方案（下一轮照做，一次定位）**：在 `chat.js` 里临时给这两处 + 每一处置底加 `window.__probe`
（`pins` / `newFlow` / `nullFlow` / `lastScrollWrite` ✓），跑同一条思考用例读序列 ✓
⇒ 若 `newFlow` 恰好在 i=18 出现 ⇒ 根因确定 ✓；之后**改实现 + 加门禁**（"挂块/开新流后必须仍在底部" ✓），
⚠ 仍**不许**放宽阈值凑绿 ✗

### (c) 付费墙：**判据与夹具都已正确，失败是模型行为** —— 修正原计划（第 93 轮，有代码证据）

**原计划**（我几轮前写的）："把'免费状态 / 试看剩余时长'做成**必须读回的字段**" ⇒ 复核后发现**不必** ✓：
- 判据本来就是**页面状态**（`window.__currentEp <= window.__lastFreeEp`、`__player.isPreview === false`、
  `__reachedEnd === true`、`__player.duration === __fullSeconds`）✓
- 回执侧**已经**要求 `mustSeeInToolResults: ['试看', '180']` ✓（即"必须把试看/试看时长读回来"✓）
- 夹具**自洽** ✓：`server.mjs:2616` `var preview = st === 'vip'` ⇒ 会员集 = 试看 180 秒、
  免费集 = 完整 1140 秒 ✓ ⇒ **不可能**出现"停在会员集却走完整时长"的读数 ✓

**实测失败的真实含义**（我之前把判据标签读反了 ✗）：那条标签写的是**期望值**
（"走的是完整时长（1140 秒），不是试看的 180 秒" ✓）⇒ 它红 = 实际是**试看 180 秒** ✓
⇒ 合起来就是：**模型停在会员集的试看里、没去看选集列表里每集的状态** ✗ —— 这是**能力/行为**问题 ✓，
不是夹具或判据的缺陷 ✓（页面**是**公平的：选集列表里每集都标了 免费/会员 ✓）

**结论与下一步（口径写清，避免以后重复怀疑夹具 ✗）**：
- **不改夹具、不改判据**（它们都对 ✓）；**也不假装**这次改动能提高通过率 ✗
- 若要真的改善：唯一杠杆是**技能提示**（模型可见 ⇒ 必须复测 ✓）——
  例如在 `paywall-boundary` 的技能里加一句"**别只试一集：逐集读状态**，找出最后一集免费的"✓
  并如实记录复测结果（可能没变化 ✓，也可能变好 ✓，都要如实写 ✓）
- 该场景历史 flaky（43%–100%）⇒ **单次 1/3 不构成任何结论** ✓

### (d) `<video>` 的边界**决定**（第 94 轮）：**选"改夹具让状态可达"，不减覆盖** ✓

**现状**（`tests/e2e/fixtures/playbooks.mjs:867` 起，5 条页面判据）：
| # | 判据 | 性质 |
| --- | --- | --- |
| 1 | `__decoded > 0` | **状态** ✓（稳定可过 ✓）|
| 2 | `__seeked >= 1` | ⚠ **动作计数**（模型必须点「跳到末尾」✗）|
| 3 | `__midWaits > 0` | **状态** ✓，但**只有**那次 seek 才会产生 ✗（依赖 #2）|
| 4 | `__pauses >= 1` | ⚠ **动作计数**（模型必须按暂停 ✗）|
| 5 | `__events` 含 `ended` | **状态** ✓，但要模型**播到片尾**才出现 ✗ |

**决定：走"改夹具"这条路 ✓**（另一条"把 2/4/5 降为情报"= **减少覆盖** ✗，不做）

**理由（与本仓库既有口径一致 ✓）**：动作计数是**路径断言** ✗ —— 这正是我在富文本场景里
把 `noopClicks` / `fakeBold` 从**真模型判据**移走、只留在**脚本化基线**里的同一条口径 ✓

**具体改法（施工单，下一轮一次做完 ✓）**：
1. **夹具**（`server.mjs` 的 video 页）：
   - 让**主播放器**在被按播放后，**自然走到片尾并 fire `ended`**（素材就几秒 ✓，不需要模型再做任何动作 ✓）
   - 让**播放中途的 `waiting`** 由页面**自己**产生一次（例如按播放后 ~0.6s 处脚本化地 stall 一下 ✓），
     而不是只能靠「跳到末尾」✗ ⇒ `__midWaits` 变成"**按一次播放就能产生**"的状态 ✓
2. **判据**：保留 #1 #3 #5（**状态** ✓）；把 #2 #4 两条**动作计数**从 `pageChecks` 移到
   **脚本化用例的基线**里（那里用**真点击**证明页面确实记了 seek / pause ✓）
3. **重新测量**：`--grep 视频播放器状态 --repeat-each=3` ✓，把**逐次结果**记进 `docs/real-model-eval-log.md` ✓
   ⚠ 如实：改进/无变化/仍红都要写 ✓；若"按一次播放"就能满足 #3 #5 而模型仍红 ⇒ 那说明
   **它连播放键都没按对**（那才是真能力问题 ✓ 也正是这条场景要测的东西 ✓）
