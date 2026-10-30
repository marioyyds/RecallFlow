// 桥接驱动扩展内 agent（agent_task）的**风险预算**判定 —— 纯逻辑，便于直测。
//
// 本模块存在的理由（这是整个 agent_task 设计的承重墙）：
//
// 扩展内置 agent 的逐次审批走的是 `port.postMessage({type:'tool-approval'})` → **面板 UI** 应答
// （agent.js 的 waitForToolApproval）。桥接场景下**没有面板**，于是只剩两条路：
//   1. 等 —— 一直挂到超时，任务必然失败，且失败原因（无人点同意）在结果里看不出来；
//   2. 绕过 —— 直接放行。这正是 lib/shared/bridge-write-policy.js 存在的理由：
//      桥接是**独立入口**，绕过审批就等于"模型能在你的真实浏览器上点删除、填提交、跑任意 JS"。
//
// 两条都不可接受。因此需要的不是"接上审批"，而是**没有 UI 时依然成立的授权形态**：
// 由调用方在**开工前一次性声明**本次允许的风险类别（allowRisk），
// 执行前对**每一次**工具调用逐个判定，不在声明内的直接拒绝并给出可操作原因。
//
// 三条不可协商的规则：
//   · `high`（任意代码执行 / 第三方用户脚本）**任何 allowRisk 都换不到**，只能面板逐次批准；
//   · `read` 是观察，永远允许，不需要声明（否则清单会退化成"必须把所有只读工具列一遍"）；
//   · 未知风险等级、未知工具一律**拒绝**（默认拒绝，不是默认放行）。
//
// ⚠ 必须承认的漏洞：allowRisk 由**调用方**声明，所以它约束的是「模型能做什么」，
// 而不是「调用方能做什么」——任何持有桥接 token 的本机进程都能自己声明 allowRisk 然后发指令。
// 因此本模块的安全强度**完全等于桥接 token 的强度**，
// 而默认 token 是写在仓库里的公开常量 → 换 token 是 agent_task 的**上线前置条件**。
//
// 本文件必须保持零依赖（扩展侧与 node 测试都要能直接载入）。

/** 允许被 allowRisk 声明的风险类别。刻意不含 high。 */
export const AGENT_BUDGET_RISKS = Object.freeze(['page', 'browser', 'network', 'write', 'destructive', 'external']);

/** 永不开放的高风险等级（alwaysRequireApproval 类工具）。 */
export const AGENT_NEVER_RISK = 'high';

/**
 * risk → toolApprovalPolicy 类别。与 agent.js 的 toolNeedsApproval **保持一致**，
 * 但刻意复制而不是 import：本模块必须零依赖（扩展与 node 测试都要能直接载入），
 * 而 agent.js 会拖进整条工具链。一致性由测试钉住
 * （见 tests/bridge-agent-policy.test.mjs 的「与 agent.js 的映射不得漂移」）。
 */
export const RISK_TO_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  page: 'commands',
  browser: 'browser',
  network: 'browser',
  write: 'edit',
  destructive: 'edit',
  external: 'mcp',
});

/**
 * 把调用方给的 allowRisk 归一化成集合。
 *
 * 宽容之处：`read` 会自动并入（它永远允许，调用方写不写都行）。
 * 严格之处：非数组、含非字符串、含未知类别的值**一律返回错误**，
 * 而不是"过滤掉不认识的就当没写" —— 静默丢弃一个安全声明比报错危险得多。
 *
 * @param {*} raw 调用方传入的 allowRisk
 * @returns {{ok:true,set:Set<string>}|{ok:false,error:string}}
 */
export function normalizeAllowRisk(
  raw: unknown
): { ok: true; set: Set<string> } | { ok: false; error: string } {
  const list = raw === undefined || raw === null ? [] : raw;
  if (!Array.isArray(list)) {
    return { ok: false, error: 'allowRisk 必须是数组（允许的风险类别清单），收到：' + typeof list };
  }
  const set = new Set(['read']);
  for (const item of list) {
    const v = String(item === undefined || item === null ? '' : item).trim().toLowerCase();
    if (!v) continue;
    // read 是唯一"允许但不必声明"的类别。显式写它不算错 ——
    // 把它判成未知类别会让一个完全合理的调用失败，而这类失败看起来像"清单不全"。
    if (v === 'read') continue;
    if (v === AGENT_NEVER_RISK) {
      return {
        ok: false,
        error:
          'allowRisk 不接受 "' + AGENT_NEVER_RISK + '"：任意代码执行 / 第三方用户脚本' +
          '（run_javascript、run_userscript、install_userscript）**任何声明都换不到**，' +
          '只能在浏览器面板里由用户当次批准。',
      };
    }
    if (!AGENT_BUDGET_RISKS.includes(v)) {
      return {
        ok: false,
        error:
          'allowRisk 里有未知的风险类别 "' + v + '"。可用类别：' + AGENT_BUDGET_RISKS.join('、') +
          '（read 不需要声明，永远允许）。',
      };
    }
    set.add(v);
  }
  return { ok: true, set };
}

/**
 * 判定一次工具调用是否落在声明好的风险预算内。
 *
 * @param {string} toolName 工具名（含 mcp__ 前缀的 MCP 工具也走这里）
 * @param {Set<string>|Array<string>} allowSet 归一化后的允许集合
 * @param {object} deps 注入的元数据查询（便于纯测）
 * @param {(name:string)=>{risk?:string, readOnly?:boolean, alwaysRequireApproval?:boolean, requiresApproval?:boolean}} deps.getMetadata
 * @returns {{allowed:true,risk:string,readOnly:boolean}|{allowed:false,risk:string,reason:string,hint:string}}
 */
type ToolMetadata = {
  risk?: string;
  readOnly?: boolean;
  alwaysRequireApproval?: boolean;
  requiresApproval?: boolean;
};

type PolicyDeps = {
  getMetadata?: (name: string) => ToolMetadata;
};

export function checkAgentToolBudget(
  toolName: unknown,
  allowSet: Set<string> | string[] | unknown,
  deps: PolicyDeps = {}
) {
  const name = String(toolName || '');
  const getMetadata = deps.getMetadata || (() => ({}));
  const meta: ToolMetadata = getMetadata(name) || {};
  const risk = String(meta.risk || '');
  const set: Set<string> =
    allowSet instanceof Set ? allowSet : new Set(Array.isArray(allowSet) ? allowSet : []);

  // 未知风险等级 / 未登记工具：默认拒绝。默认放行一个我们不了解的东西，
  // 等于让"新增工具时忘了标 risk"变成一条静默的提权路径。
  if (!risk || risk === 'unknown') {
    return {
      allowed: false,
      risk: risk || 'unknown',
      reason: '工具「' + name + '」没有可用的风险等级，无法判断是否在你的 allowRisk 内。',
      hint: '这通常是工具未登记元数据。请改用面板执行，或换一个已登记的工具。',
    };
  }

  // 高风险：任何 allowRisk 都换不到（见文件头第 1 条规则）。
  if (risk === AGENT_NEVER_RISK || meta.alwaysRequireApproval === true) {
    return {
      allowed: false,
      risk,
      reason:
        '工具「' + name + '」属高风险（' + (risk === AGENT_NEVER_RISK ? '任意代码执行 / 第三方脚本' : '被标记为逐次审批') +
        '），**不能**经 agent_task 执行。',
      hint: '这类操作只能在浏览器面板里由用户当次批准，请让用户直接在面板里执行这一步。',
    };
  }

  // 只读观察：永远允许。
  if (risk === 'read') return { allowed: true, risk, readOnly: true };

  // 其余按类别判定。
  const category = RISK_TO_CATEGORY[risk];
  if (!category) {
    return {
      allowed: false,
      risk,
      reason: '工具「' + name + '」的风险等级 "' + risk + '" 没有对应的审批类别，无法判定。',
      hint: '请改用面板执行，或补上该风险等级的类别映射。',
    };
  }
  if (set.has(risk)) return { allowed: true, risk, readOnly: false };

  // 拒绝时必须给出可操作路径（与 docs/tool-design.md §7 一致）：
  // 告诉调用方缺哪个类别、补上之后就能跑，而不是干巴巴报"不允许"。
  return {
    allowed: false,
    risk,
    reason:
      '工具「' + name + '」属风险类别 "' + risk + '"（审批类别 ' + category + '），' +
      '但不在本次 allowRisk 声明内。已声明：' + [...set].sort().join('、') + '。',
    hint:
      '若这次任务确实需要它，请重新调用 agent_task 并在 allowRisk 里加上 "' + risk + '"' +
      '（当前已允许的类别会随本次任务结束而失效，不会累积到下一次）。',
  };
}

/**
 * 算出本次任务可以**免逐次审批**的工具名清单。
 *
 * 为什么需要它（这是一个实测出来的坑，不是可选的优化）：
 * agent 循环里的审批是 `waitForToolApproval(port, ...)` —— 它等的是 **port 上的审批应答**
 * （面板 UI 点「同意」）。而 `readLiveApprovalSettings` 会**重新读 storage**，
 * 也就是说无论桥接传什么 settings 快照，只要用户存储里 `toolApproval` 是开的、
 * 某个工具的类别没被自动批准，agent 就会进入等待 —— 而桥接场景没有面板，
 * 于是这个任务会**一直挂到超时**，且失败原因（无人点同意）在结果里看不出来。
 *
 * 解法是复用 agent 循环**已有**的会话级放行机制（`sessionApprovedTools`），
 * 而不是去改审批逻辑：把"本任务已授权"的工具名预先填进去，
 * 循环里的 `!sessionApprovedTools.has(tc.name)` 自然就跳过了那次等待。
 * agent.js 一行不用改，面板路径完全不受影响。
 *
 * ⚠ 这只是**让流程不被卡住**；真正的授权判定在 checkAgentToolBudget（执行前逐个判定）。
 * 两者是配合关系：这里负责"别卡在没人能回答的问题上"，那里负责"不许做没授权的事"。
 * 因此高风险工具**绝不出现在这个清单里**（它们的 risk 不在可声明集合内）。
 *
 * @param {Set<string>|Array<string>} allowSet 归一化后的允许集合
 * @param {Array<string>} toolNames 候选工具名（通常来自工具注册表）
 * @param {object} deps { getMetadata }
 * @returns {Array<string>} 可免审的工具名（已排序，便于测试与稳定输出）
 */
export function preApprovedToolNames(
  allowSet: Set<string> | string[] | unknown,
  toolNames: unknown,
  deps: PolicyDeps = {}
): string[] {
  const set: Set<string> =
    allowSet instanceof Set ? allowSet : new Set(Array.isArray(allowSet) ? allowSet : []);
  const getMetadata = deps.getMetadata || (() => ({}));
  const out = [];
  for (const raw of Array.isArray(toolNames) ? toolNames : []) {
    const name = String(raw || '');
    if (!name) continue;
    const meta: ToolMetadata = getMetadata(name) || {};
    const risk = String(meta.risk || '');
    // 只读不需要审批；高风险永远不给会话级放行。
    if (risk === 'read' || !risk || risk === 'unknown') continue;
    if (risk === AGENT_NEVER_RISK || meta.alwaysRequireApproval === true) continue;
    // 必须"本身会走审批"才值得填：requiresApproval 未置位的工具本来就不弹。
    if (meta.requiresApproval !== true) continue;
    if (!set.has(risk)) continue;
    out.push(name);
  }
  return out.sort();
}
