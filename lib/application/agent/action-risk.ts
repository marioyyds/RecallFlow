// 语义风险判定：**工具级的 risk 不足以代表一次点击**。
//
// click_element 的元数据恒为 low，但「发布 / 删除 / 支付」这类目标文字一旦命中，
// 这次点击就是不可逆的高风险动作。2026-11-12 的 CSDN 发布轨迹里，
// `click_element 「发布文章」` 被录制成了 r=low，而 edge 快路执行时 skipApproval——
// 于是“发布”理论上能绕过审批。这个文件把判定收成一份，录制、edge 提名、
// operation 路径共用同一个词表。

/** 命中即视为高风险目标（发布、删除、支付等不可逆/外向动作）。 */
export const RISKY_TARGET_LABEL =
  /(删除|移除|清空|退出|注销|取消|支付|购买|提交|发布|发送|关闭|卸载|重置)/i;

export function isRiskyTargetLabel(label: unknown): boolean {
  const text = String(label || '').trim();
  return Boolean(text) && RISKY_TARGET_LABEL.test(text);
}

/**
 * 把「工具元数据风险 + 目标语义」合成边缘风险。
 * - click_element 命中高风险目标词 → high（与 operation 路径的过滤同一口径）；
 * - 其他工具沿用录制时的工具风险（high / medium / low）。
 */
export function semanticEdgeRisk(
  tool: unknown,
  label: unknown,
  toolRisk: unknown
): 'high' | 'medium' | 'low' {
  const name = String(tool || '');
  const recorded = String(toolRisk || '');
  if (name === 'click_element' && isRiskyTargetLabel(label)) return 'high';
  if (recorded === 'high' || recorded === 'medium') return recorded;
  return 'low';
}