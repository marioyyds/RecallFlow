// 视觉（多模态）消息装配 —— **纯函数**，全部经过 `VISION_ENABLED` 开关。
//
// ## 为什么要有这个模块
//
// 让面板内 Agent"看到"截图，卡在两件事上：
//   1. **工具消息只能放文本** ✗ ⇒ 图片不能塞进 tool message，必须走**追加的 user 消息**；
//   2. 图片很贵（实测约 **400 token/图**）⇒ 必须有**显式预算**，超出时**如实说明省了什么** ✓
//
// 本模块只做装配与预算，不碰 chrome / fetch / 状态 ⇒ 可以纯单测 ✓
//
// ## 为什么现在写它（而不等开关打开）
//
// `VISION_ENABLED` 仍是 `false` ⇒ `visionMessagesFor()` 一律返回空数组 ✓
// 也就是说**今天模型可见内容一字未变** ✓ ⇒ 按第 26 轮的纪律（见 docs/regression-red-flag.md）
// **不需要**跑真模型 eval ✓ —— 先把机制写好并钉住，打开开关是**一个常量 + 一次测量**的事 ✓
import { VISION_ENABLED } from '../shared/utils.js';

/** 单张图的 token 估算（实测值；粗估即可，用于预算裁剪）。 */
export const TOKENS_PER_IMAGE = 400;

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
  const { picked, note } = selectScreenshotsForVision(screenshots, options.budget);
  const msg = buildScreenshotMessage(picked, note);
  return msg ? [msg] : [];
}

/** 估算这批截图会占多少 token（供调用方打印/记账）。 */
export function estimateVisionTokens(count) {
  return Math.max(0, Number(count) || 0) * TOKENS_PER_IMAGE;
}
