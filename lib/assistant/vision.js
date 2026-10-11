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
// ## 为什么现在写它（而不等开关打开）
//
// `VISION_ENABLED` 仍是 `false` ⇒ `visionMessagesFor()` 一律返回空数组 ✓
// 也就是说**今天模型可见内容一字未变** ✓ ⇒ 按第 26 轮的纪律（见 docs/regression-red-flag.md）
// **不需要**跑真模型 eval ✓ —— 先把机制写好并钉住，打开开关是**一个常量 + 一次测量**的事 ✓
import { VISION_ENABLED } from '../shared/utils.js';

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

/** 默认预算：最多几张图、单张 base64 上限（约 1.5MB 原始字节）。 */
export const DEFAULT_VISION_BUDGET = Object.freeze({
  maxImages: 2,
  maxBase64Chars: 2_000_000,
});

/**
 * 按预算挑选要送进模型的截图（**从最近往回想**：越新的截图越相关）。
 *
 * @returns {{picked: Array, skippedCount: number, note: string}}
 */
export function selectScreenshotsForVision(screenshots, budget = {}) {
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
export function buildScreenshotMessage(screenshots, note = '') {
  const list = Array.isArray(screenshots) ? screenshots.filter((s) => s && s.dataUrl) : [];
  if (!list.length) return null;
  const content = [
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
 * @returns {Array} 要追加到 messages 末尾的消息（可能为空）
 */
export function visionMessagesFor(screenshots, options = {}) {
  const enabled = typeof options.visionEnabled === 'boolean' ? options.visionEnabled : VISION_ENABLED;
  if (!enabled) return [];
  // ⚠ `options.budget` 为 undefined 时 `selectScreenshotsForVision` 会自行套默认值，
  // 但这里显式写出来：开启侧的文案向模型承诺了「只送预算内的最近几张」，
  // 而那笔预算必须是**真实存在**的（`ctx.visionBudget` 目前没有任何地方设置 ⇒ 恒为 undefined）。
  const { picked, note } = selectScreenshotsForVision(screenshots, options.budget || DEFAULT_VISION_BUDGET);
  const msg = buildScreenshotMessage(picked, note);
  return msg ? [msg] : [];
}

/** 估算这批截图会占多少 token（供调用方打印/记账）。 */
export function estimateVisionTokens(count) {
  return Math.max(0, Number(count) || 0) * TOKENS_PER_IMAGE;
}
