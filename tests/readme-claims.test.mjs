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

// 两份 README 都受同一组约束：README.md（英文，GitHub 默认渲染）与 README.zh-CN.md（中文）。
// 只校验英文那份的话，中文版会在无人看管下腐烂 —— 链接失效、措辞漂移都不会有人发现。
export const README_FILES = ['README.md', 'README.zh-CN.md'];

/** 精简后必须仍被 README 链接到的关键生成物 / 事实来源。 */
const MUST_LINK = [
  'docs/capability-inventory.md',
  'docs/skills-overview.md',
  'docs/integration-status.md',
];

/** 「失败软着陆」这条语义在每个语言版本里各自怎么锚定。 */
const SOFT_LANDING = {
  'README.md': {
    heading: /soft landing/i,
    ok: /does not remove|never removes|only injects/i,
    bad: /removes the offending tool|removes the problematic tool|removes the failing tool/i,
  },
  'README.zh-CN.md': {
    heading: /失败软着陆/,
    ok: /只注入反思|不摘除工具/,
    bad: /只摘除问题工具|摘除问题工具并/,
  },
};

// 两份都在文件顶部各读一次（`assertion-quality` 有一条 readFileSync 调用总数的棘轮，
// 在每个 test() 里重复读盘会把它顶红）；下面所有断言都复用这份快照。
//
// ⚠ 读盘必须是**容错**的：早先一版直接 `fs.readFileSync(f)`，删掉 README.zh-CN.md 后
// 模块在**加载期**就 ENOENT 崩溃 —— 退出码非 0，但 **0 条用例执行**，于是「少一份 README
// 要变红」这条门禁根本没有跑，看起来红了其实是崩了（评审退回的阻断项）。
// 这里让缺失落到 `null`，由 requireSrc() 在用例里给出**具名失败**。
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const SRC = Object.fromEntries(README_FILES.map((f) => [f, read(f)]));

/** 取某份 README 的内容；文件缺失时报成**用例失败**，而不是让模块加载崩溃。 */
function requireSrc(f) {
  assert.notEqual(SRC[f], null, 'README 缺失或不可读：' + f + '（这条必须是用例失败，不能是模块加载崩溃）');
  return SRC[f];
}

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

test('两份 README 都真实存在（少一份就红，而不是被静默跳过）', () => {
  const missing = README_FILES.filter((f) => !fs.existsSync(path.resolve(f)));
  assert.deepEqual(missing, [], 'README 缺失：\n  ' + missing.join('\n  '));
});

test('README 的每个相对链接都指向真实存在的文件', () => {
  const missing = [];
  for (const f of README_FILES) {
    const src = requireSrc(f);
    for (const p of localLinks(src)) {
      if (!fs.existsSync(path.resolve(p))) missing.push(f + ' → ' + p);
    }
  }
  assert.deepEqual(missing, [], 'README 里有失效链接（精简时最容易踩）：\n  ' + missing.join('\n  '));
});

test('README 仍链接到关键生成物 / 事实来源', () => {
  const missing = [];
  for (const f of README_FILES) {
    const src = requireSrc(f);
    for (const doc of MUST_LINK) {
      if (!src.includes(doc)) missing.push(f + ' → ' + doc);
    }
  }
  assert.deepEqual(missing, [], '精简不应把关键文档藏起来，README 缺少链接：\n  ' + missing.join('\n  '));
});

test('README 的「失败软着陆」描述必须与守卫的真实语义一致', async () => {
  // 起因：README 曾写「只**摘除问题工具**并注入反思继续」，而 tool-guard.js 的实际语义是
  // 「守卫绝不摘除工具、绝不终止任务」——两者相反，且没有任何一层能发现
  // （本文件原先只校验链接，不校验声明）。这是最容易误导读者的一种漂移：
  // 读者会以为"工具会被自动拿走"，从而误判失败恢复的行为。
  const { GUARD_CAN_DISABLE_TOOLS } = await import('../lib/application/agent/tool-guard.ts');
  for (const f of README_FILES) {
    const rule = SOFT_LANDING[f];
    const src = requireSrc(f);
    const bullet = src.split('\n').find((line) => rule.heading.test(line)) || '';
    assert.ok(bullet, f + ' 应保留「失败软着陆 / soft landing」这条说明');
    if (GUARD_CAN_DISABLE_TOOLS === false) {
      // 正向锚定而不是去猜否定词：文档必须**明确写出**真实语义。
      // （早先一版想用「出现摘除字样即违规」，结果把「不摘除工具」这句正确表述也判红了 ——
      //   检测否定在自然语言里不可靠，改成要求它把话说全。）
      // 每个语言版本各用一组锚点：英文版写 "removes the offending tool" 同样要红。
      assert.match(bullet, rule.ok, f + ' 的软着陆说明必须明确写出「只注入反思 / 不摘除工具」');
      assert.doesNotMatch(bullet, rule.bad, f + ' 不得宣称守卫会摘除工具');
    }
  }
});

test('这条 README 门禁本身有牙齿：把错误的「摘除」说法写回去必须变红（两种语言各一组）', () => {
  // 反证：上面的两条正则必须真的能区分正确与错误的措辞，否则它是一道假门禁。
  // 中文版沿用原来的样本；英文版用同源的错误措辞 —— 只加语言不换语义的话，
  // 英文版写「守卫会摘除工具」就没人拦了。
  const wrong = '失败软着陆：重复调用时，只摘除问题工具并注入反思继续；';
  const right = '失败软着陆：重复调用时，守卫只注入反思建议、不摘除工具；';
  assert.match(wrong, SOFT_LANDING['README.zh-CN.md'].bad, '错误措辞应被抓到');
  assert.match(right, SOFT_LANDING['README.zh-CN.md'].ok, '正确措辞应通过');
  assert.doesNotMatch(right, SOFT_LANDING['README.zh-CN.md'].bad);

  const wrongEn = '**Failure soft landing**: on repeated calls the guard removes the offending tool and injects reflection;';
  const rightEn = '**Failure soft landing**: on repeated calls the guard only injects reflection and does not remove tools;';
  assert.match(wrongEn, SOFT_LANDING['README.md'].bad, '英文错误措辞应被抓到');
  assert.match(rightEn, SOFT_LANDING['README.md'].ok, '英文正确措辞应通过');
  assert.doesNotMatch(rightEn, SOFT_LANDING['README.md'].bad);
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

test('语言切换行互相指向（两份 README 顶部各有一行，且都指向真实文件）', () => {
  for (const f of README_FILES) {
    const src = requireSrc(f);
    const links = localLinks(src);
    const other = README_FILES.filter((x) => x !== f);
    for (const o of other) {
      assert.ok(links.includes(o), f + ' 顶部应有指向 ' + o + ' 的语言切换链接');
    }
  }
});
