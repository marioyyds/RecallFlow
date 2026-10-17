// 知识库从 chrome.storage.local 迁移到 IndexedDB 的真实浏览器验证。
import { test, expect } from '@playwright/test';
import { launchExtension, closeExtension, resetKnowledgeBase, readKnowledgeBase } from './helpers.mjs';

let context;

test.beforeAll(async () => {
  context = await launchExtension();
});

test.afterAll(async () => {
  await closeExtension(context);
});

test('旧 knowledgeBase 自动迁入 IndexedDB，并保留迁移前备份', async () => {
  await resetKnowledgeBase(context);
  const [sw] = context.serviceWorkers();
  const legacyId = 'https://legacy.test/doc';
  await sw.evaluate(async ({ id }) => {
    await chrome.storage.local.set({
      knowledgeBase: {
        [id]: {
          id,
          type: 'article',
          title: '旧版 Markdown 文档',
          url: id,
          status: 2,
          note: '# 迁移成功\n\n正文内容',
          tags: ['迁移'],
          createdAt: 10,
          updatedAt: 20,
        },
      },
      knowledgeBaseDataVersion: 2,
    });
  }, { id: legacyId });

  const extId = new URL(sw.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/manager.html`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.item .item-title')).toHaveText('旧版 Markdown 文档');

  const book = await readKnowledgeBase(context);
  expect(book[legacyId].note).toContain('# 迁移成功');
  expect(book[legacyId].tags).toEqual(['迁移']);

  const stored = await sw.evaluate(async () => chrome.storage.local.get(null));
  expect(stored.knowledgeBase).toBeUndefined();
  expect(stored.knowledgeBasePreIndexedDB[legacyId].note).toContain('# 迁移成功');

  await page.reload();
  await expect(page.locator('.item .item-title')).toHaveText('旧版 Markdown 文档');
  expect(Object.keys(await readKnowledgeBase(context))).toHaveLength(1);
  await page.close();
});
