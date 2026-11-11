function snapshot(overrides = {}) {
  return {
    version: 2,
    url: 'https://example.test/',
    title: 'JEV calibration',
    text: '',
    fingerprint: 'fp-jevs',
    scroll: { y: 0, height: 800, viewport: 800 },
    elements: [],
    capabilities: {},
    ...overrides,
  };
}

/**
 * 真实 TypeSafe 校准用例。每个场景同时声明：
 * - 期望的 operation；
 * - 若 operation 有 target head，期望的 target 文案；
 * - 是否应因歧义/风险而拒绝自动执行。
 */
export const JEV_CALIBRATION_SCENARIOS = Object.freeze([
  {
    id: 'click-obvious',
    instruction: '点击“继续”进入下一步',
    snapshot: snapshot({
      url: 'https://example.test/form',
      title: '步骤 1',
      text: '当前步骤：基本信息\n下一步：联系方式',
      elements: [
        { ref: 'rf-1', tag: 'button', role: 'button', label: '上一步', inViewport: true },
        { ref: 'rf-2', tag: 'button', role: 'button', label: '继续', inViewport: true },
      ],
    }),
    expect: { operation: 'CLICK', targetLabel: '继续' },
  },
  {
    id: 'click-ambiguous',
    instruction: '处理一下当前表单',
    snapshot: snapshot({
      url: 'https://example.test/ambiguous',
      title: '编辑内容',
      text: '请选择下一步操作',
      elements: [
        { ref: 'rf-1', tag: 'button', role: 'button', label: '保存草稿', inViewport: true },
        { ref: 'rf-2', tag: 'button', role: 'button', label: '发送审核', inViewport: true },
      ],
    }),
    expect: { operation: 'BLOCKED' },
  },
  {
    id: 'type-title',
    instruction:
      '把文章标题填成“BallonsTranslator 深度研究”，正文暂时不要动。',
    snapshot: snapshot({
      url: 'https://example.test/editor',
      title: '写文章',
      text: '文章标题 正文 还未填写',
      elements: [
        {
          ref: 'rf-title',
          tag: 'input',
          role: 'textbox',
          type: 'text',
          label: '文章标题',
          placeholder: '请输入文章标题',
          valuePresent: false,
          inViewport: true,
        },
        {
          ref: 'rf-body',
          tag: 'textarea',
          role: 'textbox',
          label: '正文',
          valuePresent: false,
          inViewport: true,
        },
      ],
    }),
    // 快路径不再提供输入能力：TYPE_TEXT 已移出 operation 空间，字段值由慢思考回合
    // 写入。这两条场景不再给 operation 打分（expect.operation = null）——它们现在
    // 只用来证明「纯输入页仍然构造出请求、且 offered 里没有 TYPE_TEXT」。
    expect: { operation: null },
  },
  {
    id: 'type-body-title-filled',
    instruction: '标题已经完成，继续填写正文第一段。',
    snapshot: snapshot({
      url: 'https://example.test/editor',
      title: '写文章',
      text: '文章标题 已填写 正文 还未填写',
      elements: [
        {
          ref: 'rf-title-new',
          tag: 'input',
          role: 'textbox',
          type: 'text',
          label: '文章标题',
          selector: 'input.article-title',
          valuePresent: true,
          inViewport: true,
        },
        {
          ref: 'rf-body',
          tag: 'pre',
          role: '',
          label: '',
          selector: 'pre.editor__inner',
          inViewport: true,
        },
      ],
      capabilities: {
        editables: {
          count: 1,
          samples: [{ selector: 'pre.editor__inner', kind: 'contenteditable' }],
        },
      },
    }),
    // 同上：contenteditable 也不再是快路径目标，正文由慢思考回合写入，不打分。
    expect: { operation: null },
  },
  {
    id: 'wait-loading',
    instruction: '编辑器还没有出现，等待它加载完成。',
    snapshot: snapshot({
      url: 'https://example.test/loading',
      title: '加载中',
      text: '正在加载编辑器，请稍候',
      elements: [],
    }),
    expect: { operation: 'WAIT' },
  },
  {
    id: 'read-page',
    instruction: '先读取页面完整正文，再根据正文分析。',
    snapshot: snapshot({
      url: 'https://example.test/article',
      title: '长文章',
      text: '正文摘要只显示了一小段。',
      elements: [],
    }),
    expect: { operation: 'READ_PAGE' },
  },
  {
    id: 'read-table',
    instruction: '读取表格中的全部型号和价格。',
    snapshot: snapshot({
      url: 'https://example.test/products',
      title: '商品表格',
      text: '商品型号 价格 表格 共 12 行',
      elements: [],
    }),
    expect: { operation: 'READ_TABLE' },
  },
  {
    id: 'risky-publish-only',
    instruction: '把当前内容发布出去。',
    snapshot: snapshot({
      url: 'https://example.test/editor',
      title: '文章编辑',
      text: '正文已填写，可以发布',
      elements: [
        { ref: 'rf-publish', tag: 'button', role: 'button', label: '发布', inViewport: true },
      ],
    }),
    expect: { operation: 'BLOCKED' },
  },
]);
