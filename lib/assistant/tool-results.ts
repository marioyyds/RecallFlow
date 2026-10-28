// 工具结果的装配与摘要（从 tools.js 抽出的第四个模块）。
//
// 抽取动机：这几个函数决定**模型与调用方看到什么** —— 错误的 code、
// 失败原因的文案、以及页面快照被压缩成的那几行摘要。
// 它们此前夹在 chrome.* 调用之间，只能靠跑真实任务间接观察；
// 抽成纯模块后可以直接单测（其中 compactSnapshotSummary 此前**完全没有测试**，
// 而它恰恰是模型判断"页面长什么样"的依据）。
//
// 注意这里的取舍：这些函数不做 IO、不读运行上下文，只做"把已有数据整理成输出"。

// 页面文本（尤其数学/表情密集的页面）充满星形平面字符，按码元下标截断会切裂代理对，
// 进而让整个请求体在服务端解析阶段被拒（见 surrogates.js 的事故说明）。
import { sliceSafe } from '../shared/surrogates.ts';
import type { Caught } from './errors.ts';
import type { PageSnapshotLike, ToolResult } from './types.ts';

/**
 * 由 CDP 抛出的错误生成简短原因。
 *
 * 去掉开头的 `Xxx.：` 前缀（例如 `Page.captureScreenshot：...`）：
 * 那部分对使用者没有信息量，留着只会淹掉真正的原因。
 */
export function summarizeCdpError(e: Caught | null | undefined) {
  const msg = e && e.message ? e.message : String(e);
  return msg.replace(/^[A-Za-z.]+：/, '');
}

/**
 * 结构化工具错误：统一带 code，便于调用方（与 trace）按类型处理。
 *
 * `extra` 会被并入返回值（例如带上 selector、available 等诊断字段）——
 * 因此必须返回**新对象**，不能就地改 extra（调用方常复用同一字面量）。
 */
export function toolError(code: string, message: string, extra?: Record<string, unknown>): ToolResult {
  return Object.assign({ ok: false, code, result: message }, extra || {});
}

/**
 * 把 DOM 快照压缩成给模型看的短摘要：标题、URL、关键元素、正文开头。
 *
 * **正文那一段的措辞是有意的，不要简化掉**：它按 `textContent` 抽取，
 * 包含已隐藏节点的文字，因此**不能用于判断可见性**。若不说清，
 * 模型会据此断言"该元素可见/存在"，而真实页面上它可能是 `display:none` ——
 * 这类误判会直接变成错误结论（要判断可见性必须用元素快照的 visibility 字段）。
 */
export function compactSnapshotSummary(snapshot: PageSnapshotLike | null | undefined) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const title = String(snapshot.title || '');
  const url = String(snapshot.url || '');
  const elements = Array.isArray(snapshot.elements)
    ? snapshot.elements
        .slice(0, 8)
        .map((e) => {
          const label = e.label || e.placeholder || '';
          return e.ref + (label ? '：' + sliceSafe(String(label), 0, 24) : '');
        })
        .join('；')
    : '';
  const text = sliceSafe(String(snapshot.text || '').replace(/\s+/g, ' ').trim(), 0, 300);
  return ['页面标题：' + title, '页面URL：' + url, elements ? '关键元素：' + elements : '', text ? '正文摘要（按 textContent 抽取，含已隐藏节点文字，不能用于判断可见性）：' + text : '']
    .filter(Boolean)
    .join('\n');
}
