// README「能力概览」的**声明 ↔ 代码锚点**门禁。
//
// ## 为什么需要它
//
// 这个仓库对"文档数字"早就有门禁（测试数必须等于快照、表格列数要一致），
// 但**没有任何东西盯着"声明本身有没有实现"** ——
// 一处声明写着一个并不存在的能力（或曾经存在、后来被删掉），
// 读者与用户都无从察觉，而这类谎最难被其它门禁抓到：
// 它既不是数字漂移，也不是语法问题，只是**话说过头了**。
//
// 本文件把每条声明的**代码锚点**显式写下来并断言它存在。它不是"自动理解 README"，
// 而是把一次**人工审计**固化成回归：审计过的事实不会悄悄失效。
//
// 本轮（第 19 轮）逐条审计的结论：README 这几条声明**都属实**，
// 其中三处（权限预览 / 技能中心 / 知识库导入导出）此前从未被任何场景或测试覆盖过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const readme = fs.readFileSync('README.md', 'utf8');

/**
 * 每条：`claim` 是 README 里应出现的**声明关键词**（用来钉住那一行还在），
 * `anchors` 是 [文件, 必须出现的内容] —— 声明背后的实现。
 */
const CLAIMS = [
  {
    claim: '权限预览',
    anchors: [
      ['userscripts.js', '申请的 GM API'],
      ['lib/userscript/manager.js', 'export async function previewScript'],
      ['lib/userscript/manager.js', 'export async function previewCode'],
    ],
  },
  {
    claim: '技能中心增删改查与导入导出',
    anchors: [
      ['skills-page.js', 'updateUserSkill'],
      ['lib/assistant/skill-store.js', 'export async function updateUserSkill'],
      ['lib/assistant/skill-store.js', 'export async function addUserSkill'],
      ['lib/assistant/skill-md.js', 'export function serializeSkillMd'],
    ],
  },
  {
    claim: '四类知识库',
    anchors: [
      ['lib/shared/constants.js', 'STORAGE_KEY'],
      ['manager.js', 'export-btn'],
      ['manager.js', 'import-btn'],
    ],
  },
  {
    claim: '站点记忆复用已验证的选择器',
    anchors: [
      ['lib/assistant/site-memory.js', 'export async function rememberElement'],
      ['lib/assistant/site-memory.js', 'export async function getSiteHints'],
      ['lib/assistant/agent.js', '本站点记忆'],
    ],
  },
  {
    claim: '撤销可回退输入 / 勾选 / 选择 / 样式 / 滚动',
    anchors: [
      ['lib/page/commands.js', 'function pushUndo'],
      ['lib/page/commands.js', 'export function undoLast'],
    ],
  },
  {
    claim: '穿透 iframe 与 Shadow DOM',
    anchors: [
      ['lib/page/commands.js', 'function queryAllInFrames'],
      ['lib/assistant/tool-schemas.js', '穿透开放 shadow root'],
    ],
  },
  {
    // ⚠ 这一条是本轮审计**改过措辞**的：原文写「MCP 服务器」，读起来像"插件**是**一个 MCP 服务器"，
    // 而实现是 **MCP 客户端**（连远程 MCP 服务器、把工具并进 Agent）。本 checkout 里也没有
    // recallflow-mcp/ 那类服务端包。措辞已改准，锚点也跟着钉在客户端实现上。
    claim: 'MCP 客户端',
    anchors: [
      // 顺带纠正一处我自己的锚点误写：第一版写在 intent-router.js 里 grep 'mcp' ——
      // 那只是路由里提到过 MCP，实现其实在 mcp.js。门禁逼你把"声明背后是哪个实现"写准。
      ['lib/assistant/mcp.js', 'MCP_PROTOCOL_VERSION'],
      ['lib/assistant/mcp.js', 'MCP Client'],
    ],
  },
];

test('README 的每条能力声明都必须还在，且背后有真实实现（声明 ↔ 代码锚点）', () => {
  const problems = [];
  for (const { claim, anchors } of CLAIMS) {
    if (!readme.includes(claim)) {
      problems.push('README 里找不到声明「' + claim + '」—— 若已删掉该能力，请同步删掉本文件里的这条');
      continue;
    }
    for (const [file, needle] of anchors) {
      let src = '';
      try {
        src = fs.readFileSync(file, 'utf8');
      } catch (e) {
        problems.push('声明「' + claim + '」的锚点文件不存在：' + file);
        continue;
      }
      if (!src.includes(needle)) {
        problems.push('声明「' + claim + '」在 ' + file + ' 里找不到锚点：' + needle);
      }
    }
  }
  assert.deepEqual(problems, [], '声明与实现对不上（README 说过头了，或实现被删了）：\n  ' + problems.join('\n  '));
});

test('这条门禁本身有牙齿：删掉实现、或写一条只有声明没有实现的条目，都必须判为不合格', () => {
  const check = (claims, files) => {
    const out = [];
    for (const { claim, anchors } of claims) {
      if (!readme.includes(claim)) {
        out.push('no-claim:' + claim);
        continue;
      }
      for (const [file, needle] of anchors) {
        const src = files[file];
        if (src === undefined) out.push('no-file:' + file);
        else if (!src.includes(needle)) out.push('no-anchor:' + file + '|' + needle);
      }
    }
    return out;
  };
  // 声明不在 README 里 → 必须被发现
  assert.deepEqual(check([{ claim: '这个能力不存在于README', anchors: [] }], {}), ['no-claim:这个能力不存在于README']);
  // 声明在、但实现被删了 → 必须被发现
  assert.deepEqual(
    check([{ claim: '权限预览', anchors: [['x.js', 'previewScript']] }], { 'x.js': '// 什么都没剩' }),
    ['no-anchor:x.js|previewScript']
  );
  // 声明在、锚点也在 → 通过
  assert.deepEqual(
    check([{ claim: '权限预览', anchors: [['x.js', 'previewScript']] }], { 'x.js': 'export function previewScript() {}' }),
    []
  );
});
