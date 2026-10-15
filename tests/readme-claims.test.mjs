// README 的**链接完整性**门禁。
//
// ## 为什么改（原来的「声明 ↔ 代码锚点」为什么不再合适）
//
// README 原先逐条复述能力声明，于是这里用一张 `CLAIMS` 表把每条声明的代码锚点钉住 ——
// 防止"话说过头了"。README 精简后改为「定位 + 链接自动生成文档」的形态：
// 细粒度能力声明交给 `docs/capability-inventory.md`（自动生成）+ 真浏览器 E2E 覆盖，
// 公告板本身只负责**把话说准、把链接指对**。
//
// 于是这个文件盯的不再是「声明背后有没有实现」，而是两件在精简形态下才会出错的事：
//   · 每个**相对链接**必须指向真实存在的文件（否则读者点到 404 —— 精简最容易踩的坑）；
//   · 若干**关键生成物**必须仍被链接到（否则精简会把它们悄悄藏起来）。
//
// ⚠ 本文件**不**替代能力验收：那种"模型在真浏览器里到底做不做得成"由 E2E 回答，
// 而不是任何静态门禁。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const readme = fs.readFileSync('README.md', 'utf8');

/** 精简后必须仍被 README 链接到的关键生成物 / 事实来源。 */
const MUST_LINK = [
  'docs/capability-inventory.md',
  'docs/skills-overview.md',
  'docs/integration-status.md',
];

/** 抓 markdown 里的本地链接目标（[..](x) 与 ![..](x)），去掉锚点与查询串。 */
export function localLinks(md) {
  const out = [];
  for (const m of md.matchAll(/\]\(([^)]+)\)/g)) {
    let t = m[1].trim();
    if (!t) continue;
    if (/^(https?:)?\/\//i.test(t) || t.startsWith('#')) continue; // 外链 / 纯锚点
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) continue; // mailto: 等其它协议
    t = t.split('#')[0].split('?')[0];
    if (t) out.push(t);
  }
  return out;
}

test('README 的每个相对链接都指向真实存在的文件', () => {
  const missing = localLinks(readme).filter((p) => !fs.existsSync(path.resolve(p)));
  assert.deepEqual(missing, [], 'README 里有失效链接（精简时最容易踩）：\n  ' + missing.join('\n  '));
});

test('README 仍链接到关键生成物 / 事实来源', () => {
  const missing = MUST_LINK.filter((doc) => !readme.includes(doc));
  assert.deepEqual(missing, [], '精简不应把关键文档藏起来，README 缺少链接：\n  ' + missing.join('\n  '));
});

test('这条门禁本身有牙齿：失效链接必须被抓，外链 / 锚点不受影响', () => {
  assert.deepEqual(localLinks('![x](docs/nope.md)'), ['docs/nope.md']);
  assert.deepEqual(localLinks('[x](https://example.com/a)'), []);
  assert.deepEqual(localLinks('[x](#anchor)'), []);
  assert.deepEqual(localLinks('[x](mailto:a@b.c)'), []);
  assert.deepEqual(localLinks('[x](docs/ok.md#sec)'), ['docs/ok.md'], '锚点应被剥掉');
  // 用一个真实存在的门禁自身文件反证：存在的路径不应出现在 missing 里
  assert.ok(fs.existsSync(path.resolve('README.md')), '前提：README.md 存在');
});
