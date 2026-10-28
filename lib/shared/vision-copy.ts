// Vision capability, screenshot degradation, and the model-facing copy they control.
// Vision capability and screenshot-facing copy remain one cohesive policy block.
/**
 * 「内容脚本连不上」这一类失败的识别。
 *
 * 判定规则与用户脚本运行时的注入兜底是**同一套**（见 lib/userscript/manager.js 里
 * 「Receiving end does not exist → 先注入 runner.js 再重试」那一段）。这里收成一处，
 * 免得出现第三、第四份拷贝 —— 而拷贝之间一旦漂移，就会出现"某条路认得、另一条不认得"。
 */
/**
 * **视觉能力开关**（单一事实来源）。
 *
 * ## 为什么要有它
 *
 * 界面上有好几处文案在说"你看不到图像"（截图工具说明、相关技能等）。
 * 在支持视觉之前，这些话是**对的**；一旦把截图真的传给模型，它们就变成**错的** ✗
 * 分散在多处的硬编码文案，改一处忘一处 —— 于是模型会收到**自相矛盾**的指导
 *（"你看不到图" + 一张图就在上下文里）。
 *
 * 现在能力由这一个常量决定：文案与传输都**必须**问它，不许各自硬编码 ✓
 *
 * ## 当前状态：**打开**（`true`，第 6 步已于本轮打开）
 *
 * 也就是说：**模型可见内容变了** ✗ ⇒ 按第 26 轮的纪律（见 docs/regression-red-flag.md）
 * 必须做对照测量。本轮做了**定向**测量而不是全量 30 条扫描（见 docs/real-model-eval-log.md 的最新一轮）。
 *
 * ## 打开它需要同时做完（见 docs/remaining-work.md）—— 已全部完成
 *
 * 1. 把截图作为**追加的 user 消息**送进请求（工具消息只能放文本）—— 已完成（`lib/assistant/vision.ts`）；
 * 2. "你看不到图像"的文案条件化 —— 已完成，做法是**整句二选一**：
 *    `tool-schemas.js` 的 `take_screenshot` 说明、`skill-defs.js` 的 readability-fix 技能、
 *    本文件的 `formatScreenshotSummary`、`context.js` 的历史回放占位说明 ✓
 *    ⇒ 关闭时输出与改动前**逐字节相同**（纯重构 ⇒ 不需要测量 ✓），
 *      打开时换成如实且不矛盾的启用分支 ✓
 *    （门禁：`tests/vision-text-conditional.test.mjs` 把改动前的原文当基准钉住，
 *      并断言启用分支里不再有"看不到图像 / 只展示给用户 / 不进入你的上下文"这类反话；
 *      该文件另有一条**源码级**门禁，四处接线点都必须引用开关，不许各自硬编码 ——
 *      第 4 处即 `context.js` 的 `flattenHistoryContent`，它在第 6 步打开开关前
 *      是"开关翻转不会改到、但会变成假话"的那一处 ✗，靠那条扫描找出来的。
 *      ⚠ `visionLimitationNote` 的默认整句**不算**受控文案 ——
 *      它只在 `formatScreenshotSummary` 的关闭分支里被调用 ✓）
 * 3. 预算：每图 **实测 578 token**（1280×720 JPEG q40；随尺寸变化，`TOKENS_PER_IMAGE` 取上界 600）
 *    ⇒ 需要"最多几张 / 多大"的显式上限，超出时**如实说明省略了什么**；
 *    ⚠ **已知限制**：`ctx.visionBudget` 至今**没有任何地方赋值**（只有 `agent.js` 一处读）
 *    ⇒ 生产实际用的是 `vision.js` 的 `DEFAULT_VISION_BUDGET`（`{maxImages:2, maxBase64Chars:2e6}`），
 *    **不可配置** —— 不要对外宣称"可调预算"（见 docs/remaining-work.md 的如实标注）。
 * 4. 门禁：开关关闭时请求里**不得**出现任何 `image_url`（对照组）——
 *    已加（`tests/e2e/vision-switch.spec.mjs` 按本常量的实际值选择断言臂）。
 *    ⚠ 开关打开后**关闭臂那条 E2E 会被 skip**（真实扩展里读的就是这个常量）⇒
 *    关闭侧的传输行为由 `tests/vision-messages.test.mjs` 的 override 两臂钉住，不是没人管。
 */
export const VISION_ENABLED = true;

/** "看不到图像"那半句（默认整句说明的**单一来源**；`prefix` 形态由调用方自带措辞）。 */
export const VISION_CLAUSE = '**看不到图像**（截图只给用户看，不会进入你的输入）';

/**
 * 当前视觉能力的**如实说明**（供各处文案使用）。
 *
 * 开关关闭时返回"看不到图像"的说明；开启时返回空串 ——
 * 调用方据此条件化文案，避免"嘴上说看不到、上下文里却有图"的自相矛盾 ✗
 *
 * 传 `prefix` 时，`prefix` 就是调用方**自己那一段**禁用文案，关闭时**原样**返回：
 * 各处的措辞本来就不同（如 `formatScreenshotSummary` 用「你看不到图像内容」）——
 * 若在这里再拼一次默认从句，关闭时的输出就不再与改动前逐字节相同 ✗
 *（"纯重构"的前提被破坏，按纪律就得跑 eval ✗）
 *
 * @param {boolean} [visionEnabled] 覆盖开关（测试用；生产不传）
 * @param {string} [prefix] 调用方自己的那段禁用文案（关闭时原样返回，见 `formatScreenshotSummary`）
 * @returns {string} 需要追加的说明（未启用视觉时非空）
 */
export function visionLimitationNote(visionEnabled: unknown, prefix?: unknown) {
  const enabled = typeof visionEnabled === 'boolean' ? visionEnabled : VISION_ENABLED;
  if (enabled) return '';
  if (typeof prefix === 'string') return prefix;
  return '注意：当前' + VISION_CLAUSE + '，请依据 DOM / 可访问性树等文本信息判断。';
}

/**
 * 截图工具说明里那句「你看不到图像内容」的**原文**（条件化的禁用分支）。
 *
 * 单一来源就在这里 —— `lib/assistant/tool-schemas.ts` 直接 import 它，
 * 而不是自己再抄一份字面量（抄一份 = 开关打开后两处文案漂移 ✗）。
 */
export const VISION_UNAVAILABLE_TOOL_COPY =
  '不进入你的上下文 —— 当前模型是纯文本的，**你看不到图像内容**，不要据「已截图」描述页面外观或声称视觉上已修好。';

/**
 * `skill-defs.js` 里 readability-fix 技能那句「你看不到图像内容」的**原文**（条件化的禁用分支）。
 */
export const VISION_UNAVAILABLE_SKILL_COPY =
  '但**你看不到图像内容**，\n  不要据"已截图"声称视觉上已经改好。';

/**
 * 三处文案的**启用分支**（开关打开后替换掉上面三份禁用分支的整句）。
 *
 * ## 为什么整句替换，而不是只替换"你看不到图像"那半句
 *
 * 第 5 步只把一个从句条件化，于是开启侧拼出过两句坏话 ✗（第 7 步审校时实测复现）：
 *   · `formatScreenshotSummary`：`…不进入你的上下文：` + `''` + `，不要据它描述页面外观。`
 *     ⇒ 既拼出 `：，` 这种坏标点，又**与事实相反**（开启后图确实进了上下文）；
 *   · `take_screenshot` 说明：`图片**只展示给用户与留档**` + `同时也会送进你的上下文…`
 *     ⇒ 自相矛盾（"只"与"同时也会"）。
 * 所以现在**每条受开关影响的句子都以整句为单位二选一** ✓ —— 关闭侧仍是逐字节原文。
 *
 * ## 启用分支的措辞要满足三条
 *
 * 1. **如实**：图会随请求送进模型上下文。措辞**必须**与接线实际做的事一致 ——
 *    第 6 步打开开关时逐句人读 + 脚本核对，发现原稿承诺了一件接线**没有做**的事 ✗：
 *    原稿写「只送**预算内**的最近几张，超出的会省略并说明」，
 *    但 `agent.js` 是**每张截图各调用一次** `visionMessagesFor([res.screenshot])`
 *    ⇒ 每次调用只看到 1 张，`DEFAULT_VISION_BUDGET.maxImages`（2）**永远不是约束**：
 *    实测「5 次各传 1 张」⇒ 进上下文的图 = **5 张**、"省略说明"出现 **0 次**（复现脚本见
 *    docs/real-model-eval-log.md 第六轮 · 发现 17）。
 *    所以现在改成**没有按张数封顶**的如实说法：本次任务里截的每张都会送；
 *    **单张过大**（超过 `maxBase64Chars`）的那张会被省略**并说明**（这句是真的，见下）。
 * 2. **有指导**：像素证据**不能替代**文本证据（尺寸/颜色/对比度这类判断仍要读 DOM 计算值）；
 * 3. **不动**与开关无关的那条：`截图不能作为 complete_task 的 evidence` 两档共用 ✓
 *
 * ⚠ 与"单张过大"配套的**接线修复**：原先全部被跳过时 `buildScreenshotMessage` 返回 `null`
 * ⇒ 连那句"未送入模型"的说明也一起丢掉 = **静默**丢图 ✗（正是本仓库最忌讳的形态）。
 * 现在 `visionMessagesFor` 在这种情况下**仍产出一条纯文本说明消息** ✓
 * ⚠ **未做**（建议独立一轮）：把张数上限做成**任务级**（在 `agent.js` 里累计本次任务已送的张数）。
 * 那是行为改动 + 需要真模型测量，本轮**没有**做 —— 所以文案里也**不承诺**它。
 */

/** 截图工具说明的**启用分支**（`take_screenshot`）。 */
export const VISION_ENABLED_TOOL_COPY =
  '图片也会随请求送进你的上下文（本次任务里截的每张都会送；单张过大的会省略并说明）—— 你可以据此观察页面外观。';

/** readability-fix 技能那句的**启用分支**（承接 `- 需要给用户可视证据时用 take_screenshot，`）。 */
export const VISION_ENABLED_SKILL_COPY =
  '图片会随请求送进你的上下文（本次任务里截的每张都会送；单张过大的会省略并说明），\n  所以你可以据此观察改动的视觉效果；但**外观判断仍要读计算值**（像素证据替代不了 `inspect_element({op:"styles"})` 的读数）。';

/** 截图结果摘要里那句的**启用分支**（`formatScreenshotSummary`）。 */
export const VISION_ENABLED_SUMMARY_COPY =
  '图片会随请求送进你的上下文（本次任务里截的每张都会送；单张过大的会省略并说明），据此可以观察页面外观。';

/**
 * 截图的降质阶梯（纯函数）。
 *
 * CDP 的 Page.captureScreenshot 不能指定缩放，因此体积只能靠 format/quality 控制：
 * 先按请求的参数拍，超限就逐级降质重拍。把阶梯做成纯函数，便于验证「不会无限重试」
 * 与「png 请求在超限时也会退到 jpeg」。
 * @param {'jpeg'|'png'} format
 * @param {number} quality 1-100（仅 jpeg 有效）
 * @returns {Array<{format:string, quality?:number}>}
 */
export function screenshotAttempts(format: unknown, quality: unknown) {
  const q = Math.min(100, Math.max(20, Math.round(Number(quality) || 72)));
  if (format === 'png') {
    // png 无损但可能极大：先 png，超限退 jpeg 并逐级降质。
    return [{ format: 'png' }, { format: 'jpeg', quality: 60 }, { format: 'jpeg', quality: 35 }];
  }
  const ladder = [{ format: 'jpeg', quality: q }];
  const mid = Math.max(30, q - 25);
  // 只在「确实更低」时追加，避免出现 [35, 30, 30] 这种重复档位（白拍一次）。
  if (mid < q) ladder.push({ format: 'jpeg', quality: mid });
  if (ladder[ladder.length - 1].quality > 30) ladder.push({ format: 'jpeg', quality: 30 });
  return ladder;
}

/**
 * 截图结果的元数据文案（纯函数）。
 *
 * 关键：必须**明确告诉模型它看不到图像内容**（未启用视觉时）。
 * 当前管线是纯文本的，若不明说，模型很容易基于「已截图」编造对页面外观的描述。
 * 反过来，一旦 `VISION_ENABLED` 打开，那句话就变成**错的**（图真的进了上下文）✗
 * ⇒ 改成条件化：开关关闭时与**改动前逐字节相同**（纯重构 ⇒ 不需要测量 ✓），
 *   开关打开时换成 `VISION_ENABLED_SUMMARY_COPY` ✓
 *
 * ⚠ **整句**二选一，不是只换"你看不到图像"那半句：
 * 只换半句会拼出「…不进入你的上下文：，不要据它描述页面外观。」——
 * 既是坏标点，又**与事实相反**（开启后图确实进了上下文）✗
 * 门禁：`tests/vision-text-conditional.test.mjs` ⑥⑦ 两臂都钉住 ✓
 * @param {{width:number, height:number, format:string, quality?:number, bytes:number, label?:string, degraded?:boolean}} meta
 * @param {boolean} [visionEnabled] 覆盖开关（测试用；生产不传）
 */
export function formatScreenshotSummary(meta: any, visionEnabled: unknown) {
  const m = meta || {};
  const w = Math.max(0, Math.round(Number(m.width) || 0));
  const h = Math.max(0, Math.round(Number(m.height) || 0));
  const kb = Math.max(0, Math.round((Number(m.bytes) || 0) / 1024));
  const fmt = String(m.format || 'jpeg').toUpperCase();
  const sizeText = w && h ? w + '×' + h + ' CSS px' : '尺寸未知';
  const parts = ['已截图 ' + sizeText + '（' + fmt + (m.quality ? ' q' + m.quality : '') + '，' + kb + 'KB）'];
  if (m.label) parts.push('标注：' + String(m.label).slice(0, 60));
  if (m.degraded) parts.push('（为控制体积已自动降质）');
  const enabled = typeof visionEnabled === 'boolean' ? visionEnabled : VISION_ENABLED;
  return (
    parts.join('·') +
    '\n' +
    (enabled
      ? VISION_ENABLED_SUMMARY_COPY
      : '图片只展示给用户、不进入你的上下文：' +
        visionLimitationNote(visionEnabled, '**你看不到图像内容**') +
        '，不要据它描述页面外观。') +
    '若需要可判断的文本证据，请用 get_page_snapshot / read_diagnostics / inspect_element。' +
    '\n**截图不能作为 complete_task 的 evidence**：完成前校验只读文本证据。' +
    '截图是给用户留档的，不要为了「取证」反复截图。'
  );
}
