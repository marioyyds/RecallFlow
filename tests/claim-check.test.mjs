// 完成前确定性断言层：只在「声称与实际不符」时可确定地判 fail。
//
// 安全不对称是本模块的核心契约：**永不返回 pass**。它只用来抓谎，
// 不用来认证为真 —— 否则就等于用一个廉价正则替掉了真正的证据校验。
import test from 'node:test';
import assert from 'node:assert/strict';

import { checkCompletionClaim, buildDeterministicReflection } from '../lib/assistant/claim-check.js';

const base = {
  ranTools: ['get_page_snapshot', 'set_element_style'],
  mutatingRanTools: ['set_element_style'],
  failedTools: [],
  evidenceText: '当前页面 DOM 快照：…',
};

test('声称隐藏广告但没有任何写类工具 → fail（本轮最核心的抓谎规则）', () => {
  const r = checkCompletionClaim({
    claim: '已隐藏页面上的全部广告。',
    ranTools: ['get_page_snapshot', 'read_current_page'],
    mutatingRanTools: [],
    failedTools: [],
    evidenceText: '快照…',
  });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasons[0].code, 'claim-without-mutation');
  assert.ok(r.reasons[0].message.includes('没有调用过任何页面修改类工具'), r.reasons[0].message);
});

test('声称修改但写类工具全失败 → fail', () => {
  const r = checkCompletionClaim({
    claim: '已把表头居中对齐。',
    ranTools: ['set_element_style'],
    mutatingRanTools: ['set_element_style'],
    failedTools: ['set_element_style'],
    evidenceText: '',
  });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.reasons[0].code, 'all-mutations-failed');
});

test('写类工具部分失败时不误判（可能另一部分成功了）', () => {
  const r = checkCompletionClaim({
    claim: '已隐藏广告。',
    ranTools: ['set_element_style', 'set_element_style'],
    mutatingRanTools: ['set_element_style', 'click_element'],
    failedTools: ['set_element_style'],
    evidenceText: '',
  });
  assert.equal(r.verdict, 'unknown', JSON.stringify(r.reasons));
});

test('声称「可见 0 次」但没有可见性核查证据 → fail', () => {
  const r = checkCompletionClaim({
    claim: '广告已清除干净，「广告」可见 0 次。',
    ranTools: ['set_element_style'],
    mutatingRanTools: ['set_element_style'],
    failedTools: [],
    evidenceText: '当前页面 DOM 快照：…（正文摘要）', // 只是快照，没有可见性维度
  });
  assert.equal(r.verdict, 'fail');
  assert.ok(
    r.reasons.some((x) => x.code === 'visibility-claim-without-evidence'),
    JSON.stringify(r.reasons)
  );
});

test('声称「可见 0 次」且证据里确有可见性核查 → 不再判 fail（交给 LLM）', () => {
  const r = checkCompletionClaim({
    claim: '「广告」可见 0 次 / DOM 4 次，均已不可见。',
    ...base,
    evidenceText: '【可见性核查】- 「广告」：可见 0 次 / DOM 4 次 —— 均不可见',
  });
  assert.equal(r.verdict, 'unknown');
});

test('证据里出现 getComputedStyle / display:none 也视为可见性核查', () => {
  for (const ev of ['逐元素检查 display:none', '用 getComputedStyle 过滤后可见文本为 0', 'offsetHeight = 0']) {
    const r = checkCompletionClaim({
      claim: '广告已不可见。',
      ...base,
      evidenceText: ev,
    });
    assert.equal(r.verdict, 'unknown', '应认可这种证据：' + ev);
  }
});

test('**永不返回 pass**：一切正常时是 unknown，把判断权留给校验器', () => {
  const r = checkCompletionClaim({ claim: '已隐藏 2 个广告位。', ...base });
  assert.equal(r.verdict, 'unknown');
  assert.deepEqual(r.reasons, []);
});

test('空总结 → unknown（不制造噪音）', () => {
  assert.equal(checkCompletionClaim({ claim: '', ...base }).verdict, 'unknown');
  assert.equal(checkCompletionClaim({ claim: '   ', ...base }).verdict, 'unknown');
  assert.equal(checkCompletionClaim({}).verdict, 'unknown');
  assert.equal(checkCompletionClaim().verdict, 'unknown');
});

test('只读任务声称纯读取结论时不误判', () => {
  const r = checkCompletionClaim({
    claim: '页面标题是「购物车」，共 3 个商品。',
    ranTools: ['read_current_page'],
    mutatingRanTools: [],
    failedTools: [],
    evidenceText: '页面标题：购物车',
  });
  assert.equal(r.verdict, 'unknown', JSON.stringify(r.reasons));
});

test('**精确性**：描述性措辞（含写动词但没声称自己做了）不得误判', () => {
  // 这些句子都含写操作动词，但都是在**描述**而非声称完成动作。
  // 误判的代价是一次白跑的校验 + 一次多余的反思，所以必须收紧。
  const descriptive = [
    '页面设置为深色主题，共 3 个商品。',
    '打开页面后可见 3 个商品卡片。',
    '选中文本后会弹出气泡。',
    '点击按钮会提交表单（这是页面的行为）。',
    '该区域显示广告位，未做修改。',
  ];
  for (const claim of descriptive) {
    const r = checkCompletionClaim({
      claim,
      ranTools: ['read_current_page'],
      mutatingRanTools: [],
      failedTools: [],
      evidenceText: '页面文本…',
    });
    assert.equal(r.verdict, 'unknown', '不应误判：' + claim + ' → ' + JSON.stringify(r.reasons));
  }
});

test('**精确性**：真正的完成态声称仍要抓到', () => {
  const assertions = ['已隐藏 2 个广告位。', '表头已经居中对齐了。', '已把广告全部清除了。', '隐藏了 2 个广告位。', '成功修改了标题样式。'];
  for (const claim of assertions) {
    const r = checkCompletionClaim({
      claim,
      ranTools: ['read_current_page'],
      mutatingRanTools: [],
      failedTools: [],
      evidenceText: '页面文本…',
    });
    assert.equal(r.verdict, 'fail', '应判 fail：' + claim);
    assert.equal(r.reasons[0].code, 'claim-without-mutation');
  }
});

test('规则 1 只在「调用过工具」时触发（没调工具由别处兜底）', () => {
  const r = checkCompletionClaim({
    claim: '已隐藏广告。',
    ranTools: [],
    mutatingRanTools: [],
    failedTools: [],
    evidenceText: '',
  });
  assert.equal(r.verdict, 'unknown');
});

test('多条规则可同时命中，原因按序累积', () => {
  const r = checkCompletionClaim({
    claim: '已隐藏广告，可见 0 次，已清除干净。',
    ranTools: ['get_page_snapshot'],
    mutatingRanTools: [],
    failedTools: [],
    evidenceText: '快照',
  });
  assert.equal(r.verdict, 'fail');
  const codes = r.reasons.map((x) => x.code);
  assert.ok(codes.includes('claim-without-mutation'), codes.join(','));
  assert.ok(codes.includes('visibility-claim-without-evidence'), codes.join(','));
  assert.ok(r.reason.length > 0);
});

test('脏数据安全：非数组字段不会抛错', () => {
  const r = checkCompletionClaim({
    claim: '已隐藏广告。',
    ranTools: 'not-an-array',
    mutatingRanTools: null,
    failedTools: undefined,
    evidenceText: 123,
  });
  assert.equal(typeof r.verdict, 'string');
});

test('buildDeterministicReflection: 含每条原因与下一步指引', () => {
  const text = buildDeterministicReflection({
    reasons: [{ code: 'x', message: '声称隐藏但没有写操作' }],
  });
  assert.ok(text.includes('声称隐藏但没有写操作'), text);
  assert.ok(text.includes('确定性规则'), text);
  assert.ok(text.includes('不要重复'), text);
  // 脏数据
  assert.equal(typeof buildDeterministicReflection(null), 'string');
  assert.ok(buildDeterministicReflection({}).length > 0);
});
