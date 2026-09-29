// 完成前「确定性断言」预检：在花一次 LLM 校验之前，用零成本规则先筛一遍。
//
// 设计上刻意**不对称**：只返回 'fail'（确定性抓谎）或 'unknown'（交给 LLM），
// **永不返回 'pass'**。这样确定性规则只在「本来就要重试」的情况下省下一次 LLM 调用，
// 绝不会因为规则放行而削弱护栏。确定性规则也不该假装能证明「真做成了」——
// 「页面确实变了」这类判断需要看证据，那仍是 LLM 校验器与 verify_change 的职责。
//
// 本模块为纯函数（无 chrome / DOM 依赖），可单测。

// 「写操作」动词：出现在完成总结里即表示模型声称做了修改。
const WRITE_VERBS = [
  '隐藏', '清除', '删掉', '删除', '移除', '去掉', '屏蔽', '拦截',
  '修改', '改为', '改成', '设置', '设成', '居中', '对齐', '加粗', '高亮', '描边', '换色', '改色', '放大', '缩小',
  '点击', '输入', '填写', '提交', '发送', '打开', '新建', '创建', '保存', '导出', '上传', '下载',
  '勾选', '选中', '取消勾选', '还原', '撤销', '回退',
];

/**
 * 判断总结是否在**声称自己做了写操作**。
 *
 * 不能只做「包含动词」匹配：「打开页面后可见 3 个商品」「页面设置为深色」这类**描述性**表述
 * 也会命中动词，造成误判（代价是一次白跑的校验 + 一次多余的反思）。
 * 因此要求完成态线索：动词前有「已/已经/成功/全部」，或动词后紧跟「了/完成/成功」。
 */
function claimsWriteAction(claim) {
  const verbs = WRITE_VERBS.join('|');
  const before = new RegExp('(?:已|已经|均已|都已|全部|成功|完成)[^。；;\\n]{0,14}(?:' + verbs + ')');
  const after = new RegExp('(?:' + verbs + ')[^。；;\\n]{0,4}(?:了|完成|成功)');
  return before.test(claim) || after.test(claim);
}

// 声称「可见性/残留」结论的措辞。
const VISIBILITY_CLAIM_RE =
  /可见\s*0|0\s*次可见|已不可见|全部不可见|均已不可见|可见次数\s*(?:为|是)?\s*0|零残留|清除干净|清干净|全清|彻底清除|不再出现|已无残留/;

// 证据里出现这些即视为「做过可见性核查」。
const VISIBILITY_EVIDENCE_RE =
  /可见性核查|可见\s*\d+\s*次|DOM\s*\d+\s*次|display\s*[:=]\s*none|checkVisibility|getComputedStyle|offsetHeight|offsetParent/i;

/**
 * @param {Object} input
 * @param {string} [input.claim] 完成总结（complete_task 的内容）
 * @param {string[]} [input.ranTools] 本次任务调用过的工具名
 * @param {string[]} [input.mutatingRanTools] 其中属于「页面修改类」（readOnly=false）的工具名
 * @param {string[]} [input.failedTools] 失败过的工具名
 * @param {string} [input.evidenceText] 最近的页面证据文本
 * @returns {{verdict:'fail'|'unknown', reasons:Array<{code:string,message:string}>, reason:string}}
 */
export function checkCompletionClaim(input = {}) {
  const claim = String(input.claim === undefined || input.claim === null ? '' : input.claim);
  const ran = Array.isArray(input.ranTools) ? input.ranTools.filter(Boolean) : [];
  const mutating = Array.isArray(input.mutatingRanTools) ? input.mutatingRanTools.filter(Boolean) : [];
  const failed = Array.isArray(input.failedTools) ? input.failedTools.filter(Boolean) : [];
  const evidence = String(input.evidenceText === undefined || input.evidenceText === null ? '' : input.evidenceText);

  const reasons = [];
  // 总结为空时无从判断，交给调用方（保持 unknown，不制造噪音）。
  if (!claim.trim()) return { verdict: 'unknown', reasons: [], reason: '' };

  const claimedVerb = WRITE_VERBS.find((v) => claim.includes(v));
  const claimsWrite = claimsWriteAction(claim);

  // 规则 1：声称做了写操作，但本次一个写类工具都没调用过。
  if (claimsWrite && mutating.length === 0 && ran.length > 0) {
    reasons.push({
      code: 'claim-without-mutation',
      message:
        '总结里声称完成了「' + (claimedVerb || '写') + '」类操作，但本次任务没有调用过任何页面修改类工具（只调用过：' +
        [...new Set(ran)].slice(0, 8).join('、') +
        '）。声称与实际动作不符。',
    });
  }

  // 规则 2：声称做了写操作，但所有写类工具都失败了。
  if (claimsWrite && mutating.length > 0 && mutating.every((t) => failed.includes(t))) {
    reasons.push({
      code: 'all-mutations-failed',
      message: '总结里声称完成了「' + (claimedVerb || '写') + '」类操作，但用到的写类工具全部失败：' + [...new Set(mutating)].join('、') + '。',
    });
  }

  // 规则 3：给出可见性/残留结论，却没有任何可见性核查证据。
  if (VISIBILITY_CLAIM_RE.test(claim) && !VISIBILITY_EVIDENCE_RE.test(evidence)) {
    reasons.push({
      code: 'visibility-claim-without-evidence',
      message:
        '总结里给出了「可见性 / 已无残留」这类结论，但证据中没有任何可见性核查数据。' +
        '请先用 read_current_page({ checkTexts: [...] }) 取得「可见 N 次 / DOM M 次」，再据此下结论。',
    });
  }

  if (!reasons.length) return { verdict: 'unknown', reasons: [], reason: '' };
  return { verdict: 'fail', reasons, reason: reasons.map((r) => r.message).join(' ') };
}

// 由确定性预检结果构造给 Agent 的反思消息（与 LLM 校验的反思同构，便于模型一致处理）。
export function buildDeterministicReflection(result) {
  const parts = ['（完成前检查未通过：确定性规则判定「声称与实际不符」）'];
  const reasons = (result && result.reasons) || [];
  for (const r of reasons) parts.push('- ' + (r.message || ''));
  parts.push('请据实核对页面状态后修正总结或补齐动作；不要重复刚才已失败的动作。');
  return parts.join('\n');
}
