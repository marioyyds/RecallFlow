import test from 'node:test';
import assert from 'node:assert/strict';

import { mdToSkill, serializeSkillMd, toRuntimeSkill } from '../lib/application/agent/skill-md.ts';
import { loadSkill } from '../lib/application/agent/skill-tools.ts';

const SKILL_MD = [
  '---',
  'name: publish-blog',
  'description: 发布博客',
  'x-recallflow-fast-actions:',
  '  - CLICK',
  '  - SCROLL_DOWN',
  'x-recallflow-slow-actions:',
  '  - type_text',
  'x-recallflow-tools:',
  '  - click_element',
  '---',
  '',
  '先打开编辑页，再逐个字段填写。',
].join('\n');

test('SKILL.md 可以声明快慢分工，并能在序列化后往返', () => {
  const skill = mdToSkill(SKILL_MD);
  assert.deepEqual(skill.x.fastActions, ['CLICK', 'SCROLL_DOWN']);
  assert.deepEqual(skill.x.slowActions, ['type_text']);

  const round = mdToSkill(serializeSkillMd(skill));
  assert.deepEqual(round.x.fastActions, ['CLICK', 'SCROLL_DOWN']);
  assert.deepEqual(round.x.slowActions, ['type_text']);

  const runtime = toRuntimeSkill(skill);
  assert.deepEqual(runtime.fastActions, ['CLICK', 'SCROLL_DOWN']);
  assert.deepEqual(runtime.slowActions, ['type_text']);
});

test('load_skill 把快慢分工明确告诉慢模型', async () => {
  const deps = {
    async getMergedSkills() {
      return [{
        name: 'publish-blog',
        title: '发布博客',
        content: '正文',
        fastActions: ['CLICK'],
        slowActions: ['type_text'],
      }];
    },
    validateSkillTools() {
      return [];
    },
  };
  const out = await loadSkill(deps, { name: 'publish-blog' });
  assert.equal(out.ok, undefined, 'load_skill 成功时沿用 result-only 形状');
  assert.match(out.result, /快慢分工/);
  assert.match(out.result, /CLICK/);
  assert.match(out.result, /type_text 必须由你/);
});