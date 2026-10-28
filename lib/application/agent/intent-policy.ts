// Adaptive intent policy used when a chat run starts invoking research tools.
import { INTENTS, buildSystemPrompt, resolveIntent } from '../../assistant/intent-router.ts';
import { TOOL_REGISTRY } from '../../assistant/tools.ts';

// 运行时自纠：当普通对话（CHAT）任务实际调用到研究/网络类工具时，
// 把任务画像就地提升为「资料研究」——补齐全套浏览器/网络工具，并把系统提示规则
// 切换成 RESEARCH 的（含 complete_task 收尾），而不是只放宽预算。
// 导出以便单测：画像提升时必须保留追加的系统提示段，这一点很容易在重构中被破坏。
export function promoteToResearch(tools: any, messages: any, instruction: string, allSkills: any, promptExtras: any) {
  const researchInfo = resolveIntent(INTENTS.RESEARCH);
  // 缓存代价：往 tools 里追加会让请求前缀在追加点之后重新计算。
  // 这一步没法省 —— 研究类工具不在 CHAT 的 schema 里，模型根本调用不了它们。
  // 之所以可以接受：由 !promotedToResearch 守卫，整个 run 最多发生一次；
  // 另一条路（CHAT 起手就带上全部研究工具）会让每一轮都多背几 k token，更亏。
  for (const name of researchInfo.allowedTools) {
    if (tools.some((t: any) => t.function && t.function.name === name)) continue;
    const def = TOOL_REGISTRY.find((t) => t.name === name);
    if (def) tools.push(def.openai);
  }
  const names = tools.map((t: any) => t.function && t.function.name).filter(Boolean);
  const newPrompt = buildSystemPrompt(INTENTS.RESEARCH, instruction, names, allSkills);
  // 必须带上附加段（站点记忆 / 宏目录）：它们追加在基础系统提示之后，
  // 只按 buildSystemPrompt 重建会把它们静默丢掉 —— 而浏览器任务最需要它们。
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

