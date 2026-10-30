// Adaptive intent policy used when a chat run starts invoking research tools.
import { INTENTS, buildTaskPolicyPrompt } from './intent-router.ts';

// 运行时自纠：当普通对话（CHAT）任务实际调用到研究/网络类工具时，
// 把任务画像就地提升为「资料研究」——只追加 RESEARCH 的执行策略，不改工具 schema。
// 工具 surface 在所有意图间共享，因此这次画像切换不会破坏请求前缀缓存。
// 导出以便单测：画像提升时必须保留追加的系统提示段，这一点很容易在重构中被破坏。
export function promoteToResearch(messages: any, instruction: string, promptExtras: any) {
  const newPrompt = buildTaskPolicyPrompt(INTENTS.RESEARCH, instruction);
  // 必须带上附加段（站点记忆 / 宏目录）：它们追加在基础系统提示之后，
  // 只重建任务策略会把它们静默丢掉 —— 而资料研究任务最需要它们。
  const content = promptExtras ? newPrompt + promptExtras : newPrompt;
  // 追加到末尾，**不覆写 messages[0]**。
  // messages[0] 是整段请求前缀的起点，改写它会让此前累积的全部前缀缓存失效、
  // 整段历史都要重新 prefill。追加是 append-only 的，只影响新增部分。
  // DeepSeek 的 Chat Completion 接口明确支持在对话中间插入 system 消息；
  // 位置更靠近当前轮，对模型行为的约束力也不弱于放在开头。
  // 调用方须保证此时 messages 末尾没有待配对的 tool_calls（否则 tool 结果会被隔开、请求非法）。
  messages.push({ role: 'system', content });
  return content;
}

