// 视觉（多模态）消息装配 —— **纯函数**，全部经过 `VISION_ENABLED` 开关。
//
// ## 为什么要有这个模块
//
// 让面板内 Agent"看到"截图，卡在两件事上：
//   1. **工具消息只能放文本** ✗ ⇒ 图片不能塞进 tool message，必须走**追加的 user 消息**；
//   2. 图片很贵（**实测** 1280×720 JPEG q40 ≈ **578 token/图**，随尺寸变化；上界取 600）
//      ⇒ 必须有**显式预算**，超出时**如实说明省了什么** ✓
//
// 本模块只做装配与预算，不碰 chrome / fetch / 状态 ⇒ 可以纯单测 ✓
//
// ## 开关的状态（第 6 步已打开）
//
// `VISION_ENABLED = true` ⇒ 截图结果之后**会**追加一条带 `image_url` 的 user 消息 ✓
// 也就是说**模型可见内容变了** ⇒ 按第 26 轮的纪律（见 docs/regression-red-flag.md）**必须**测量 ✓
// 本轮做的是**定向**测量（真 key 探针 + 开关前后 token 增量），不是 30 条全量扫描，
// 且已如实记录"哪些部分**没有被**验证"（见 docs/real-model-eval-log.md 最新一轮）。
// 关闭侧的行为继续由 `tests/vision-messages.test.mjs` 的 `visionEnabled` override 两臂钉住 ✓
import { VISION_ENABLED } from '../shared/utils.ts';

/**
 * 单张图的 token 估算（**实测值**，用于预算裁剪）。
 *
 * 实测方法与读数（第 8 步，2026-10；`deepseek-flash`，同一段文本发两次读 `usage.prompt_tokens` 差值）：
 *
 * | 图宽（同比例 16:9） | JPEG q40 体积 | 差值 prompt_tokens |
 * | --- | --- | --- |
 * | 320px | 1.4KB | **192** |
 * | 640px | 3.2KB | **192** |
 * | 960px | 6.4KB | **314** |
 * | 1280px（本仓库默认视口） | 11.5KB | **578** |
 *
 * ⇒ 每图成本**不是**固定的：它大致按 28px 一格的补丁数走（约 `ceil(w/28)*ceil(h/28)` 量级）。
 * 取 **600** 而不是旧的 400：默认 1280×720 截图实测 578，400 是**低估**——
 * 低估会让"预算里还能再塞一张"这种判断偏乐观（正是本仓库最忌讳的**无声失准**）。
 *
 * ⚠ 这里刻意仍用"每图一个常数"的**保守上界**，不引入按面积的公式：
 * ① `estimateVisionTokens(count)` 的调用方只关心量级；② 多一个随宽高变化的估算函数，
 * 就多一处"估算与实测漂移"的地方。要更准就得在调用点传宽高（`screenshot.width/height` 现成可得）。
 */
export const TOKENS_PER_IMAGE = 600;

/**
 * **任务级**成本上界：一次任务里最多**真送**几张图。
 *
 * 为什么需要它：视觉打开后每张图约 600 token 进上下文，而 `take_screenshot` 是模型可以**反复**调用的
 * 工具 ⇒ 没有上界的话，一次任务能把上下文塞满图 ✗（成本与"前面内容被挤掉"两个风险叠在一起）。
 *
 * `ctx.visionBudget`（按 token 的预算）**至今没有任何地方赋值**（`agent.js` 只有一处读它）⇒
 * 真正兜住成本的只有这个**按张数**的上界。到上界时**不静默丢**：改推一条**纯文字说明**
 * （说清"从第几张起不再送图"）—— 与本仓库"每处截断/丢弃都要留痕"的纪律一致 ✓
 */
export const MAX_IMAGES_PER_TASK = 3;

/** 已经送过 `sentCount` 张图时，这一张还该不该**真送**？ */
export function shouldSendImage(sentCount: any, cap = MAX_IMAGES_PER_TASK) {
  return (Number(sentCount) || 0) < (Number(cap) || 0);
}

/** 达到上界时的**纯文字**说明（不假装送过图，也不说"看不到图"这种与开关状态矛盾的话 ✗）。 */
export function imageCapNote(sentCount: any, label: string, cap = MAX_IMAGES_PER_TASK) {
  const n = Number(sentCount) || 0;
  const c = Number(cap) || 0;
  const what = label ? `（${label}）` : '';
  return (
    `本次任务已送出 ${n} 张截图，达到上限 ${c} 张${what} —— 这一张**不再送出图像**，` +
    `下面只有文字说明；若要看图，请说清要看哪一块，我会在下次任务里优先看它。`
  );
}

/**
 * 默认预算：最多几张图、单张 base64 上限（约 1.5MB 原始字节）。
 *
 * ## 依据（第 6 步打开开关时复核过）
 *
 * · **每图 token**：实测 578（1280×720 JPEG q40）⇒ `TOKENS_PER_IMAGE = 600` 是上界；
 *   ⚠ 但**不要**据此说"每轮最多约 1200 token" —— `maxImages: 2` 在真实接线里**不生效**
 *   （`agent.js` 每张截图各调用一次，见 `visionMessagesFor` 的说明）⇒
 *   实际每轮多付的是 **578 × 本次任务截了几张**，**没有张数上界** ✗
 * · **单张体积**：实测 1280×705 JPEG q40 ≈ 63KB ⇒ base64 ≈ 84KB 字符；
 *   另一张内容更密的 1280×720 q40 实测 20.1KB / 27,432 字符。
 *   `maxBase64Chars: 2_000_000` 相当于允许约 **1.5MB 原始字节**的单图
 *   ⇒ 它是"**防呆上限**"而不是"典型值"，典型图永远碰不到它；超过它的那张会被省略**并说明** ✓
 *
 * ## ⚠ 真实限制：**不可配置**
 *
 * `ctx.visionBudget` 至今**没有任何地方赋值**（`agent.js` 只有一处读）⇒ 恒为 `undefined`
 * ⇒ 生产实际生效的**只有本常量**。**不要**对外宣称"预算可调/可在设置里改"。
 * 要让它真正可配，需要：① 设置项 → ② 赋值到 `ctx.visionBudget` → ③ 一条门禁断言设置真的生效。
 */
export const DEFAULT_VISION_BUDGET: Record<string, any> = Object.freeze({
  maxImages: 2,
  maxBase64Chars: 2_000_000,
});

/**
 * 按预算挑选要送进模型的截图（**从最近往回想**：越新的截图越相关）。
 *
 * @returns {{picked: Array, skippedCount: number, note: string}}
 */
export function selectScreenshotsForVision(screenshots: any, budget: Record<string, any> = {}) {
  const maxImages = Number.isFinite(budget.maxImages) ? budget.maxImages : DEFAULT_VISION_BUDGET.maxImages;
  const maxBase64Chars = Number.isFinite(budget.maxBase64Chars) ? budget.maxBase64Chars : DEFAULT_VISION_BUDGET.maxBase64Chars;
  const list = Array.isArray(screenshots) ? screenshots.filter((s) => s && s.dataUrl) : [];
  const picked = [];
  let skipped = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const b64 = String(s.dataUrl).split(',')[1] || '';
    if (picked.length >= maxImages || b64.length > maxBase64Chars) { skipped += 1; continue; }
    picked.push(s);
  }
  picked.reverse();
  // 丢东西必须说明（与本仓库其它截断处同一纪律：handoff 的 trailOmitted、快照的 omittedBySize）
  const note = skipped > 0
    ? '（为控制体积，另有 ' + skipped + ' 张截图**未送入模型**；需要时可用 take_screenshot 重新截取目标区域。）'
    : '';
  return { picked, skippedCount: skipped, note };
}

/**
 * 把选中的截图装配成**追加的 user 消息**（OpenAI 兼容的多模态形态）。
 *
 * 为什么是 user 消息而不是 tool 消息：工具消息只能是文本 ✗
 * 而图片必须作为内容部件出现 ⇒ 追加一条 user 消息是唯一干净的落点 ✓
 */
export function buildScreenshotMessage(screenshots: any, note = '') {
  const list = Array.isArray(screenshots) ? screenshots.filter((s) => s && s.dataUrl) : [];
  if (!list.length) return null;
  const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
    {
      type: 'text',
      text:
        '以下是刚在页面上截取的 ' + list.length + ' 张截图（供你观察页面外观）。' +
        (note ? '\n' + note : ''),
    },
  ];
  for (const s of list) {
    content.push({ type: 'image_url', image_url: { url: String(s.dataUrl) } });
  }
  return { role: 'user', content };
}

/**
 * 对外入口：**开关关闭时一律返回空数组**（今天的行为与引入之前完全一致）。
 *
 * ## ⚠ 张数上限（`maxImages`）在**真实接线里不生效** —— 如实记下来，别当成"已封顶"
 *
 * `agent.js` 是**每张截图各调用一次**本函数（`visionMessagesFor([res.screenshot])`，
 * 数组里永远只有 1 张）⇒ 每次调用都只看得到 1 张，`maxImages: 2` 永远不是约束。
 * 实测（复现脚本见 docs/real-model-eval-log.md 第六轮 · 发现 17）：
 * "5 次各传 1 张" ⇒ 进上下文的图 = **5 张**、"省略说明"出现 **0 次** ✗
 * ⇒ 所以 `VISION_ENABLED_*_COPY` 里**不再承诺**"只送预算内的最近几张"（第 6 步已改成如实说法）✓
 * ⇒ 要真正封顶，需要把上限做成**任务级**（在 agent.js 累计已送张数）—— 那是行为改动 + 需要测量，
 *   **本轮没有做**，列入 docs/remaining-work.md 的待决项。
 *
 * @returns {Array} 要追加到 messages 末尾的消息（可能为空）
 */
export function visionMessagesFor(screenshots: any, options: Record<string, any> = {}) {
  const enabled = typeof options.visionEnabled === 'boolean' ? options.visionEnabled : VISION_ENABLED;
  if (!enabled) return [];
  // ⚠ `options.budget` 为 undefined 时 `selectScreenshotsForVision` 会自行套默认值，
  // 但这里显式写出来：开启侧的文案向模型承诺了"单张过大会省略并说明"，
  // 而那笔预算必须是**真实存在**的（`ctx.visionBudget` 目前没有任何地方设置 ⇒ 恒为 undefined）。
  const { picked, note } = selectScreenshotsForVision(screenshots, options.budget || DEFAULT_VISION_BUDGET);
  if (!picked.length) {
    // **丢东西必须说明**（本仓库的硬纪律，同 handoff 的 trailOmitted / 快照的 omittedBySize）：
    // 原先这里直接走 `buildScreenshotMessage([]) === null` ⇒ 连那句"未送入模型"也一起丢掉，
    // 于是"截图静默地没进上下文" ✗ —— 模型会以为没截图，而它其实截了。
    // 现在至少产出一条**纯文本**说明消息（没有图可送时不应产出图片消息）。
    return note ? [{ role: 'user', content: [{ type: 'text', text: '（本次截图没有送入你的上下文）' + note }] }] : [];
  }
  const msg = buildScreenshotMessage(picked, note);
  return msg ? [msg] : [];
}

/** 估算这批截图会占多少 token（供调用方打印/记账）。 */
export function estimateVisionTokens(count: any) {
  return Math.max(0, Number(count) || 0) * TOKENS_PER_IMAGE;
}
