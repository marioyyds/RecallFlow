// userscript-tools.js + skill-tools.js：能力管理两族（C-1 拆出的第 9、10 族）。
//
// 抽取的收益：这两族都涉及**安全边界**（谁能装脚本、技能依赖是否可用），
// 以前埋在巨型 switch 里只能靠读代码确认。现在把边界直接断言下来。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  listUserscriptsTool,
  searchUserscripts,
  installUserscript,
  runUserscript,
  USERSCRIPT_TOOLS,
  handleUserscriptTool,
} from '../lib/assistant/userscript-tools.js';
import { loadSkill, installSkill, saveSkill, normalizeSkillName, SKILL_TOOLS, handleSkillTool, MIN_SKILL_CONTENT } from '../lib/assistant/skill-tools.js';

// ---------------------------------------------------------------- 用户脚本族

function mkUsDeps(overrides = {}) {
  const deps = {
    ctx: { tabId: 7 },
    listUserscripts: async () => [],
    searchScripts: async () => [],
    installFromUrl: async () => ({ script: { name: 'S', version: '1.0.0', matches: ['*://a.test/*'] } }),
    runUserscriptOnTab: async () => ({ ok: true, result: '已执行' }),
    getUserscriptSettings: async () => ({ agentCanInstall: true }),
    ...overrides,
  };
  return deps;
}

test('USERSCRIPT_TOOLS 覆盖四个工具名', () => {
  assert.deepEqual([...USERSCRIPT_TOOLS].sort(),
    ['install_userscript', 'list_userscripts', 'run_userscript', 'search_userscripts']);
});

test('handleUserscriptTool：不属于本族返回 null', async () => {
  assert.equal(await handleUserscriptTool('load_skill', {}, mkUsDeps()), null);
});

test('list_userscripts：无脚本时给出可读文案（不是空字符串）', async () => {
  const r = await listUserscriptsTool(mkUsDeps());
  assert.equal(r.ok, true);
  assert.match(r.result, /尚未安装任何用户脚本/);
});

test('list_userscripts：列出名称/版本/id/匹配/描述，并标出已停用', async () => {
  const r = await listUserscriptsTool(mkUsDeps({
    listUserscripts: async () => [
      { id: 'u1', name: 'A', version: '2.0', enabled: true, matches: ['*://a.test/*'], description: '做 A' },
      { id: 'u2', name: 'B', version: '1.0', enabled: false, matches: [], description: '' },
    ],
  }));
  assert.match(r.result, /\[1\] A v2\.0\n/);
  assert.match(r.result, /id：u1/);
  assert.match(r.result, /匹配：\*:\/\/a\.test\/\*/);
  assert.match(r.result, /\[2\] B v1\.0（已停用）/, '停用的脚本必须标出来');
  assert.match(r.result, /描述：无/);
});

test('search_userscripts：无结果时明确说"未找到"（不是成功空结果）', async () => {
  const r = await searchUserscripts(mkUsDeps(), { query: 'q' });
  assert.equal(r.ok, true);
  assert.match(r.result, /未找到相关脚本/);
});

test('search_userscripts：列出名称、安装量、描述与 code_url（安装要用它）', async () => {
  const r = await searchUserscripts(mkUsDeps({
    searchScripts: async () => [{ name: 'X', installs: 123, description: 'd', codeUrl: 'https://gf/x.user.js' }],
  }), { query: 'x' });
  assert.match(r.result, /\[1\] X（安装 123）/);
  assert.match(r.result, /code_url：https:\/\/gf\/x\.user\.js/);
});

test('**安全边界**：用户关闭"允许 Agent 安装脚本"后，install 必须拒绝', async () => {
  let called = false;
  const r = await installUserscript(mkUsDeps({
    getUserscriptSettings: async () => ({ agentCanInstall: false }),
    installFromUrl: async () => { called = true; return {}; },
  }), { url: 'https://gf/x.user.js' });
  assert.equal(r.ok, false);
  assert.match(r.result, /用户已在设置中关闭/, '要说明是用户自己的设置，而不是含糊的"安装失败"');
  assert.match(r.result, /打开设置页/, '要给出可执行的下一步');
  assert.equal(called, false, '被拒绝时绝不能真的去装');
});

test('install_userscript：允许时返回名称/版本/匹配，并带出警告', async () => {
  const r = await installUserscript(mkUsDeps({
    installFromUrl: async () => ({ script: { name: 'S', version: '1.2', matches: ['*://a/*'], warnings: ['含 @require'] } }),
  }), { url: 'https://gf/x.user.js' });
  assert.equal(r.ok, true);
  assert.match(r.result, /已安装用户脚本：S v1\.2/);
  assert.match(r.result, /匹配：\*:\/\/a\/\*/);
  assert.match(r.result, /警告：含 @require/, '警告必须带出来（可能含远程依赖）');
});

test('run_userscript：成功用 r.result，失败用 r.error（不能把原因吞掉）', async () => {
  const ok = await runUserscript(mkUsDeps({ runUserscriptOnTab: async () => ({ ok: true, result: '已执行 3 步' }) }), { scriptId: 'u1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.result, '已执行 3 步');

  const fail = await runUserscript(mkUsDeps({ runUserscriptOnTab: async () => ({ ok: false, error: 'URL 不匹配任何规则' }) }), { scriptId: 'u1' });
  assert.equal(fail.ok, false);
  assert.match(fail.result, /URL 不匹配任何规则/);
});

test('run_userscript：把 ctx.tabId 传给执行器（在当前页执行）', async () => {
  let seen = null;
  await runUserscript(mkUsDeps({ ctx: { tabId: 42 }, runUserscriptOnTab: async (tabId) => { seen = tabId; return { ok: true, result: '' }; } }), { scriptId: 'x' });
  assert.equal(seen, 42);
});

// ---------------------------------------------------------------- 技能族

function mkSkillDeps(overrides = {}) {
  return {
    getMergedSkills: async () => [],
    getDefaultSkills: () => [],
    getUserSkills: async () => [],
    addUserSkill: async (skill) => skill,
    updateUserSkill: async (name, patch) => Object.assign({}, patch, { name }),
    validateSkillTools: () => [],
    installSkillFromSkillHub: async () => ({ ok: true, result: '已安装' }),
    ...overrides,
  };
}

test('SKILL_TOOLS 覆盖三个工具名（读 / 装 / 写）', () => {
  assert.deepEqual([...SKILL_TOOLS].sort(), ['install_skill', 'load_skill', 'save_skill']);
});

test('handleSkillTool：不属于本族返回 null', async () => {
  assert.equal(await handleSkillTool('run_userscript', {}, mkSkillDeps()), null);
});

test('load_skill：缺 name 时失败', async () => {
  const r = await loadSkill(mkSkillDeps(), {});
  assert.equal(r.ok, false);
  assert.match(r.result, /缺少技能 name 参数/);
});

test('load_skill：找不到技能时指向系统提示里的目录（否则模型会反复换名字试）', async () => {
  const r = await loadSkill(mkSkillDeps(), { name: '不存在' });
  assert.equal(r.ok, false);
  assert.match(r.result, /未找到名为「不存在」的技能/);
  assert.match(r.result, /技能目录/, '必须告诉它去哪看可用技能');
});

test('load_skill：按 name / title / id 三种键都能命中', async () => {
  const skills = [{ id: 'sid', name: 'sname', title: '标题', content: '正文' }];
  for (const key of ['sid', 'sname', '标题']) {
    const r = await loadSkill(mkSkillDeps({ getMergedSkills: async () => skills }), { name: key });
    assert.match(r.result, /正文/, '用 ' + key + ' 应能命中');
  }
});

test('load_skill：返回完整说明（含用途/标签/正文），而不是摘要', async () => {
  const r = await loadSkill(mkSkillDeps({
    getMergedSkills: async () => [{ name: 's', title: 'T', description: '用途说明', tags: ['a', 'b'], content: '完整正文' }],
  }), { name: 's' });
  assert.match(r.result, /# 技能：T/);
  assert.match(r.result, /用途：用途说明/);
  assert.match(r.result, /标签：a、b/);
  assert.match(r.result, /完整正文/);
});

test('load_skill：技能声明的依赖工具不可用时，要明确指向技能页（而不是让模型反复失败）', async () => {
  const r = await loadSkill(mkSkillDeps({
    getMergedSkills: async () => [{ name: 's', title: 'T', content: 'c' }],
    validateSkillTools: () => ['boost 不存在', 'nope 不存在'],
  }), { name: 's' });
  assert.match(r.result, /依赖工具存在问题/);
  assert.match(r.result, /- boost 不存在/);
  assert.match(r.result, /请到技能页更新依赖工具列表/);
});

test('install_skill：缺 identifier 时失败；identifier 与 url 等价', async () => {
  const missing = await installSkill(mkSkillDeps(), {});
  assert.equal(missing.ok, false);
  assert.match(missing.result, /缺少技能 identifier 参数/);

  let seen = null;
  const viaUrl = await installSkill(mkSkillDeps({ installSkillFromSkillHub: async (id) => { seen = id; return { ok: true, result: 'ok' }; } }), { url: '@ns/slug' });
  assert.equal(viaUrl.ok, true);
  assert.equal(seen, '@ns/slug', 'url 应作为 identifier 的别名');
});

// ---------------------------------------------------------------- save_skill
//
// 这条能力来自会话 RF-FY6PUP 的真实缺口：用户说「沉淀为技能」，而技能族当时只有
// load_skill（读）与 install_skill（从 SkillHub 装）—— 没有任何工具能**写**一份技能，
// 模型只能拿 macro(op=save) 去顶，最后两头落空（用户看到「不能保存 skill 和宏」）。

const LONG_CONTENT = '适用于「发表图文笔记」这类流程。\n\n1. 先切到图文标签；\n2. 填标题与正文；\n3. 回读确认后提交。\n';

test('normalizeSkillName：空格/下划线/大写/非法字符都归一化成 kebab-case', () => {
  assert.equal(normalizeSkillName('Publish XHS Note'), 'publish-xhs-note');
  assert.equal(normalizeSkillName('  publish__xhs  '), 'publish-xhs');
  assert.equal(normalizeSkillName('发布笔记'), '', '纯中文无法归一化 ⇒ 空串（由调用方拒绝并给出可读原因）');
  assert.equal(normalizeSkillName('a---b'), 'a-b');
  assert.equal(normalizeSkillName(null), '');
});

test('save_skill：缺 name / name 无法归一化时失败，并说明要什么形状', async () => {
  const missing = await saveSkill(mkSkillDeps(), { content: LONG_CONTENT });
  assert.equal(missing.ok, false);
  assert.match(missing.result, /kebab-case/);

  const chinese = await saveSkill(mkSkillDeps(), { name: '发布笔记', content: LONG_CONTENT });
  assert.equal(chinese.ok, false);
  assert.match(chinese.result, /kebab-case/);
});

test('save_skill：正文过短/过长都拒绝（短到写不清做法，长到稀释上下文）', async () => {
  const short = await saveSkill(mkSkillDeps(), { name: 'x-skill', content: '很短' });
  assert.equal(short.ok, false);
  assert.match(short.result, new RegExp('至少 ' + MIN_SKILL_CONTENT));
  assert.match(short.result, /以后怎么做/, '要告诉模型正文该写什么，而不是只说"太短"');

  const long = await saveSkill(mkSkillDeps(), { name: 'x-skill', content: 'x'.repeat(20001) });
  assert.equal(long.ok, false);
  assert.match(long.result, /过长/);
});

test('save_skill：与**内置技能**重名必须拒绝（内置优先会静默盖掉它）', async () => {
  // 这是最坏的一种失败：保存返回成功，但技能永远不生效（getMergedSkills 里内置优先）。
  const r = await saveSkill(
    mkSkillDeps({ getDefaultSkills: () => [{ name: 'readability-fix' }] }),
    { name: 'readability-fix', content: LONG_CONTENT }
  );
  assert.equal(r.ok, false);
  assert.match(r.result, /与\*\*内置技能\*\*重名/);
  assert.match(r.result, /readability-fix-custom/, '要给一个可用的替代名');
});

test('save_skill：新建走 addUserSkill，同名已存在时走 updateUserSkill', async () => {
  const calls = [];
  const deps = mkSkillDeps({
    getUserSkills: async () => [{ name: 'existing-skill' }],
    addUserSkill: async (s) => { calls.push('add:' + s.name); return s; },
    updateUserSkill: async (name, patch) => { calls.push('update:' + name); return Object.assign({}, patch, { name }); },
  });
  await saveSkill(deps, { name: 'brand-new', content: LONG_CONTENT });
  await saveSkill(deps, { name: 'existing-skill', content: LONG_CONTENT });
  assert.deepEqual(calls, ['add:brand-new', 'update:existing-skill']);
});

test('save_skill：依赖工具写错要当场报出来（运行时会被忽略）', async () => {
  const r = await saveSkill(
    mkSkillDeps({ validateSkillTools: () => ['「boost」不是可用工具'] }),
    { name: 'x-skill', tags: 'a, b', intents: ['browser_task', '不存在的意图'], tools: ['click_element', 'boost'], content: LONG_CONTENT }
  );
  assert.match(r.result, /boost/, '依赖工具的警告必须出现在保存结果里');
  assert.match(r.result, /技能.*页核对/, '要告诉用户去哪核对（正文会进入今后的系统提示）');
});

test('save_skill：归一化后的字段形状与技能页写入的完全一致（同一份 toStorageShape）', async () => {
  let saved = null;
  await saveSkill(mkSkillDeps({ addUserSkill: async (s) => { saved = s; return s; } }), {
    name: 'Publish XHS Note',
    displayName: '发布小红书图文笔记',
    description: '用户要发图文笔记时用',
    tags: '小红书, 图文',
    intents: ['browser_task'],
    keywords: ['发笔记|发布'],
    tools: ['type_text'],
    content: LONG_CONTENT,
  });
  assert.equal(saved.name, 'publish-xhs-note');
  assert.deepEqual(saved.tags, ['小红书', '图文']);
  assert.equal(saved.skill_type, 'prompt-template', '没给 skill_type 时取默认值');
  assert.deepEqual(saved.x.intents, ['browser_task']);
  assert.deepEqual(saved.x.tools, ['type_text']);
  assert.ok(saved.content.includes('发表图文笔记'));
});

test('save_skill：存储抛错时如实报错，不得假报成功', async () => {
  const r = await saveSkill(
    mkSkillDeps({ addUserSkill: async () => { throw new Error('QUOTA_BYTES exceeded'); } }),
    { name: 'x-skill', content: LONG_CONTENT }
  );
  assert.equal(r.ok, false);
  assert.match(r.result, /QUOTA_BYTES/);
});

test('handleSkillTool：save_skill 已接入本族分派', async () => {
  const r = await handleSkillTool('save_skill', { name: 'nope', content: '' }, mkSkillDeps());
  assert.equal(r.ok, false, '空正文应被本族处理并给出可读原因，而不是返回 null');
});
