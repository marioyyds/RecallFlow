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
import { loadSkill, installSkill, SKILL_TOOLS, handleSkillTool } from '../lib/assistant/skill-tools.js';

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
    validateSkillTools: () => [],
    installSkillFromSkillHub: async () => ({ ok: true, result: '已安装' }),
    ...overrides,
  };
}

test('SKILL_TOOLS 覆盖两个工具名', () => {
  assert.deepEqual([...SKILL_TOOLS].sort(), ['install_skill', 'load_skill']);
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
