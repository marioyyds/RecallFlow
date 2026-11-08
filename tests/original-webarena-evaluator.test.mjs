import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOriginalInstruction,
  evaluateOriginalTask,
  normalizeOriginalTask,
} from '../integrations/webarena/original-evaluator.mjs';

const SITE_URLS = {
  SHOPPING: 'http://localhost:7770',
  SHOPPING_ADMIN: 'http://localhost:7780/admin',
  REDDIT: 'http://localhost:9999',
};

function pageAt(url, selected = '') {
  return {
    url: () => url,
    evaluate: async () => selected,
    goto: async () => {},
    waitForTimeout: async () => {},
    content: async () => '<html>full page</html>',
    isClosed: () => false,
  };
}

test('原始 WebArena 任务：映射开始页和 program_html URL', () => {
  const task = normalizeOriginalTask({
    task_id: 7,
    sites: ['shopping'],
    start_url: '__SHOPPING__',
    intent: 'Find a product',
    eval: {
      eval_types: ['program_html'],
      reference_answers: {},
      reference_url: '',
      program_html: [{
        url: '__SHOPPING__/checkout/cart',
        locator: '',
        required_contents: { must_include: ['cart'] },
      }],
    },
  }, SITE_URLS);

  assert.deepEqual(task.startUrls, ['http://localhost:7770']);
  assert.equal(task.eval.program_html[0].url, 'http://localhost:7770/checkout/cart');
  assert.match(buildOriginalInstruction(task), /实际.*网页/);
  assert.match(buildOriginalInstruction(task), /Find a product/);
});

test('原始 WebArena：string_match 保持 exact/must_include 语义', async () => {
  const task = normalizeOriginalTask({
    task_id: 8,
    sites: ['shopping'],
    start_url: '__SHOPPING__',
    intent: 'Return the product',
    eval: {
      eval_types: ['string_match'],
      reference_answers: { exact_match: 'Red Shirt' },
      reference_url: '',
      program_html: [],
    },
  }, SITE_URLS);
  const result = await evaluateOriginalTask({
    task,
    answer: '  "red shirt"  ',
    context: {},
    settings: {},
    siteUrls: SITE_URLS,
    page: pageAt('http://localhost:7770/'),
  });
  assert.equal(result.score, 1);
  assert.equal(result.checks[0].evaluator, 'string_match');
});

test('原始 WebArena：url_match 检查路径和查询参数', async () => {
  const task = normalizeOriginalTask({
    task_id: 9,
    sites: ['shopping'],
    start_url: '__SHOPPING__',
    intent: 'Open the filtered list',
    eval: {
      eval_types: ['url_match'],
      reference_answers: {},
      reference_url: '__SHOPPING__/catalogsearch/result/?q=shoe',
      url_note: 'GOLD in PRED',
      program_html: [],
    },
  }, SITE_URLS);
  const result = await evaluateOriginalTask({
    task,
    answer: '',
    context: {},
    settings: {},
    siteUrls: SITE_URLS,
    page: pageAt('http://localhost:7770/catalogsearch/result/?q=shoe&page=1'),
  });
  assert.equal(result.score, 1);
});

test('原始 WebArena：program_html 在 live page 执行原版 locator', async () => {
  const task = normalizeOriginalTask({
    task_id: 10,
    sites: ['reddit'],
    start_url: '__REDDIT__',
    intent: 'Check the vote state',
    eval: {
      eval_types: ['program_html'],
      reference_answers: {},
      reference_url: '',
      program_html: [{
        url: 'last',
        locator: 'document.querySelector("div.vote").getAttribute("class")',
        required_contents: { must_include: ['voted'] },
      }],
    },
  }, SITE_URLS);
  const result = await evaluateOriginalTask({
    task,
    answer: '',
    context: {},
    settings: {},
    siteUrls: SITE_URLS,
    page: pageAt('http://localhost:9999/f/test/1/', 'vote voted'),
  });
  assert.equal(result.score, 1);
  assert.equal(result.checks[0].evaluator, 'program_html');
});

test('原始 WebArena：GitLab member-role helper 读取页面成员角色', async () => {
  const task = normalizeOriginalTask({
    task_id: 11,
    sites: ['gitlab'],
    start_url: '__GITLAB__',
    intent: 'Check the member role',
    eval: {
      eval_types: ['program_html'],
      reference_answers: {},
      reference_url: '',
      program_html: [{
        url: 'last',
        locator: "func:gitlab_get_project_memeber_role('alice')",
        required_contents: { exact_match: 'Maintainer' },
      }],
    },
  }, { ...SITE_URLS, GITLAB: 'http://localhost:8023' });
  const page = pageAt('http://localhost:8023/group/project/-/project_members');
  page.evaluate = async (_fn, value) => (typeof value === 'string' ? 0 : 'Maintainer');
  const result = await evaluateOriginalTask({
    task,
    answer: '',
    context: {},
    settings: {},
    siteUrls: { ...SITE_URLS, GITLAB: 'http://localhost:8023' },
    page,
  });
  assert.equal(result.score, 1);
});
