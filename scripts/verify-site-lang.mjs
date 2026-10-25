// 站点双语的行为门禁（`node scripts/verify-site-lang.mjs`，在仓库根运行；需要 devDependencies）。
//
// 为什么是「真浏览器」：`scripts/verify-site.mjs` 只能证明静态面（静态默认是英文、
// 字典覆盖到每个 key、英文里没有汉字），但「点一下切换器之后整页真的变成中文吗」
//「刷新之后还记得吗」「app.js 写出来的暂停按钮文案跟着变吗」这三件事只有 DOM 会说话 ——
// TITA-33 那一轮就是因为只改静态面、没有一条命令能复现真实渲染结果，导致样式白改一轮。
//
// 覆盖：
//   1. 首访（无 localStorage）= 英文：`<html lang="en">`、title / meta description 为英文文案；
//   2. 切换：点「中文」按钮 → `lang="zh-CN"`，title / meta / 可见文案 / aria-label / alt 全变中文；
//   3. 记忆：刷新后仍是中文；localStorage 里是真值而非空串；
//   4. 键盘可达：Tab 能走到语言按钮，Enter 能切回去（不是只有鼠标能点）；
//   5. 干净：英文状态下可见文本与可访问名里不许留中文；中文状态下不许留英文原文
//      （拿字典里的 en 文案逐条反查，不是挑几个词看着顺眼）；
//   6. 布局：两种语言在 1440 与 390 两个宽度下都不许横向溢出（英文通常更长）。
//
// 用法：
//   node scripts/verify-site-lang.mjs [--port 4184] [--out <截图目录>]
// 退出码：全通过 0，任一失败 1。不使用 skip，不用 try-catch 吞断言失败。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { prepareSiteAssets } from './site-assets.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ROOT = path.join(REPO_ROOT, 'site');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const failures = [];
let checks = 0;

// 交叉挑选一组「只可能整段出现在单一文本节点里」的 key：
// 既用来证明中文态下**没有**英文残留，也用来证明中文态下**有**中文（不是漏翻的空白）。
const SWITCH_KEYS = [
  'skip.toMain',
  'nav.quickstart',
  'nav.capabilities',
  'nav.demos',
  'nav.design',
  'nav.mcp',
  'nav.docs',
  'qs.title',
  'cap.title',
  'demo.title',
  'design.title',
  'mcp.title',
  'docs.title',
  'footer.repo',
  // `footer.license` 不在列表里：它的 en 值是 "License"，会被页脚那句两种语言同文的
  // "RecallFlow · MIT License" 命中 —— 那是假残留。页脚链接另有专门检查。
  'hero.ctaRepo',
  'hero.ctaQuickstart',
  'hero.eyebrow',
  'qs.step1.title',
  'qs.step2.title',
  'qs.step3.title',
  'qs.step4.title',
  'design.flow1.title',
  'design.flow5.title',
  'docs.capability.title',
  'docs.local.title',
];

function parseArgs(argv) {
  const args = { out: path.join(os.tmpdir(), 'tita-42-site-lang'), port: 4184 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[i + 1];
    else if (argv[i] === '--port') args.port = Number(argv[i + 1]);
    else if (argv[i].startsWith('--port=')) args.port = Number(argv[i].slice('--port='.length));
  }
  return args;
}

function check(name, ok, detail) {
  checks += 1;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` -> ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` -> ${detail}` : ''}`);
  return ok;
}

function serve(root, port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    const target = path.resolve(root, `.${urlPath}`);
    if (target !== root && !target.startsWith(root + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const file = fs.existsSync(target) && fs.statSync(target).isDirectory() ? path.join(target, 'index.html') : target;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// 在页面里跑：抓「可见文本」与「可访问名」，语言切换按钮（endonym：EN / 中文）除外 ——
// 它按设计在两种语言下都长一样，混进来会让「有无残留」的检查失真。
function collectText() {
  const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
  const nodes = [];
  const names = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.lang-switch')) continue;
    if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && node.nodeValue.trim()) nodes.push(node.nodeValue.trim());
    }
    for (const attr of ['aria-label', 'alt', 'title']) {
      const value = el.getAttribute(attr);
      if (value && value.trim()) names.push(value.trim());
    }
  }
  const visible = nodes.join('\n');
  const accessible = names.join('\n');
  // 「Agent 设计」那张示意图有两份（英文原图 / 中文版），`src` 跟着语言换。
  // `loaded` 比 `src` 更硬：路径写错、或 `scripts/site-assets.mjs` 没把图复制进
  // `site/assets`，字符串照样对得上，但 `naturalWidth` 会是 0。
  const diagramEl = document.querySelector('.diagram');
  return {
    visible,
    accessible,
    diagram: diagramEl
      ? { src: diagramEl.getAttribute('src'), loaded: Boolean(diagramEl.complete && diagramEl.naturalWidth > 0) }
      : { src: null, loaded: false },
    cjkInVisible: (visible.match(new RegExp(CJK.source, 'g')) || []).slice(0, 5),
    cjkInAccessible: (accessible.match(new RegExp(CJK.source, 'g')) || []).slice(0, 5),
    lang: document.documentElement.getAttribute('lang'),
    title: document.title,
    metaDescription: (document.querySelector('meta[name="description"]') || {}).content || null,
    stored: (() => {
      try {
        return window.localStorage.getItem('recallflow.site.lang');
      } catch (error) {
        return '<unavailable>';
      }
    })(),
    overflow: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth },
  };
}

async function focusLangButtonByKeyboard(page, lang) {
  // 从第 0 个 Tab 开始走，直到焦点落在目标语言按钮上；走不到就是键盘不可达。
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    const hit = await page.evaluate(
      (target) => {
        const el = document.activeElement;
        return Boolean(el && el.classList.contains('lang-btn') && el.getAttribute('data-lang') === target);
      },
      lang,
    );
    if (hit) return step + 1;
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  prepareSiteAssets(REPO_ROOT);
  fs.mkdirSync(args.out, { recursive: true });

  // 字典直接从 site/i18n.js 拉真数据：期望值不在脚本里二次手抄。
  const i18n = (await import(pathToFileURL(path.join(SITE_ROOT, 'i18n.js')).href)) && globalThis.RecallFlowI18n;
  if (!i18n || !i18n.COPY) {
    console.error('[verify-site-lang] ✘ 站点字典 site/i18n.js 未能加载');
    process.exit(1);
  }
  const en = i18n.COPY.en;
  const zh = i18n.COPY.zh;
  const url = `http://127.0.0.1:${args.port}/index.html`;

  const server = await serve(SITE_ROOT, args.port);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    // ---- 1. 首访：默认英文 ----
    await page.goto(url, { waitUntil: 'networkidle' });
    const first = await page.evaluate(collectText);
    check('首访 `<html lang>` 为 en', first.lang === 'en', first.lang);
    check('首访 localStorage 为空（没有语言记忆）', first.stored === null, JSON.stringify(first.stored));
    check('首访 title 为英文文案', first.title === en['meta.title'], first.title);
    check('首访 meta description 为英文文案', first.metaDescription === en['meta.description'], first.metaDescription);
    check('首访可见文本无中文残留', first.cjkInVisible.length === 0, JSON.stringify(first.cjkInVisible));
    check('首访可访问名（aria-label / alt）无中文残留', first.cjkInAccessible.length === 0, JSON.stringify(first.cjkInAccessible));
    check('首访示意图为英文版且真的加载出来了', first.diagram.src === en['design.diagramSrc'] && first.diagram.loaded, JSON.stringify(first.diagram));
    const enHeroOfEnglish = await page.locator('h1').innerText();
    check('首访 h1 为英文文案', enHeroOfEnglish.trim() === en['hero.title'], enHeroOfEnglish.trim());
    await checkNoOverflow(page, '英文 / 1440');

    // ---- 2. 切到中文 ----
    await page.locator('.lang-btn[data-lang="zh"]').click();
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'zh-CN');
    const chinese = await page.evaluate(collectText);
    check('切换到中文后 `<html lang>` 为 zh-CN', chinese.lang === 'zh-CN', chinese.lang);
    check('切换后 title 为中文文案', chinese.title === zh['meta.title'], chinese.title);
    check('切换后 meta description 为中文文案', chinese.metaDescription === zh['meta.description'], chinese.metaDescription);
    const missingZh = SWITCH_KEYS.filter((key) => !chinese.visible.includes(zh[key].replace(/<[^>]+>/g, '')));
    check(`切换后 ${SWITCH_KEYS.length} 条中文文案全部到位`, missingZh.length === 0, `缺 ${missingZh.length} 条：${missingZh.join('、')}`);
    const leftoverEn = SWITCH_KEYS.filter((key) => chinese.visible.includes(en[key].replace(/\s+/g, ' ')));
    check('切换后没有英文原文残留', leftoverEn.length === 0, `残留 ${leftoverEn.length} 条：${leftoverEn.join('、')}`);
    check('切换后 localStorage 记住 zh', chinese.stored === 'zh', JSON.stringify(chinese.stored));
    check(
      '切换器 aria-pressed 指向 zh',
      (await page.locator('.lang-btn[data-lang="zh"]').getAttribute('aria-pressed')) === 'true' &&
        (await page.locator('.lang-btn[data-lang="en"]').getAttribute('aria-pressed')) === 'false',
    );
    check(
      '切换后 aria-label 也是中文',
      (await page.locator('.lang-btn[data-lang="en"]').getAttribute('aria-label')) === zh['lang.switchToEn'],
      await page.locator('.lang-btn[data-lang="en"]').getAttribute('aria-label'),
    );
    const footer = await page.evaluate(() => Array.from(document.querySelectorAll('.footer-inner a')).map((a) => a.textContent.trim()));
    check(
      '切换后页脚两个链接都是中文（"License" 那句是 MIT 协议署名，两种语言同文）',
      footer.length === 2 && footer[0] === zh['footer.repo'] && footer[1] === zh['footer.license'],
      JSON.stringify(footer),
    );
    check(
      '切换到中文后示意图换为中文版且真的加载出来了',
      chinese.diagram.src === zh['design.diagramSrc'] && chinese.diagram.loaded,
      JSON.stringify(chinese.diagram),
    );
    const pauseButtonZh = await page.locator('.gif-toggle').first();
    check('暂停按钮文案为中文', (await pauseButtonZh.innerText()).trim() === zh['demo.pause'], (await pauseButtonZh.innerText()).trim());
    check(
      '暂停按钮 aria-label 含中文演示名',
      (await pauseButtonZh.getAttribute('aria-label')) === zh['demo.pauseLabel'].replace('{name}', zh['demo.xhs.title']),
      await pauseButtonZh.getAttribute('aria-label'),
    );
    await checkNoOverflow(page, '中文 / 1440');
    await checkNoOverflow(page, '中文 / 390', { width: 390, height: 844 });
    await page.screenshot({ path: path.join(args.out, 'zh-desktop.png'), fullPage: true });

    // ---- 3. 刷新后记忆保持 ----
    await page.reload({ waitUntil: 'networkidle' });
    const reloaded = await page.evaluate(collectText);
    check('刷新后仍是 zh-CN', reloaded.lang === 'zh-CN', reloaded.lang);
    check('刷新后 title 仍为中文', reloaded.title === zh['meta.title'], reloaded.title);
    check('刷新后可见文本无英文原文残留', SWITCH_KEYS.every((key) => !reloaded.visible.includes(en[key].replace(/\s+/g, ' '))));
    // 这条是「带存档语言首次加载即正确」：刷新后 localStorage 里已经是 zh，
    // 页面第一次跑 i18n.apply 就得落在中文图上，不能先闪一下英文图。
    check('刷新后（带存档语言）示意图仍是中文版', reloaded.diagram.src === zh['design.diagramSrc'] && reloaded.diagram.loaded, JSON.stringify(reloaded.diagram));

    // ---- 4. 键盘可达 + Enter 切回英文 ----
    const tabs = await focusLangButtonByKeyboard(page, 'en');
    check('Tab 能走到英文按钮（键盘可达）', typeof tabs === 'number', tabs === null ? '40 次 Tab 仍未命中' : `第 ${tabs} 次 Tab`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'en');
    const back = await page.evaluate(collectText);
    check('回车切回英文后 lang 为 en', back.lang === 'en', back.lang);
    check('回车切回英文后 localStorage 写回 en', back.stored === 'en', JSON.stringify(back.stored));
    const missingEn = SWITCH_KEYS.filter((key) => !back.visible.includes(en[key].replace(/\s+/g, ' ')));
    check(`切回英文后 ${SWITCH_KEYS.length} 条英文文案全部到位`, missingEn.length === 0, `缺 ${missingEn.length} 条：${missingEn.join('、')}`);
    check('切回英文后可见文本无中文残留', back.cjkInVisible.length === 0, JSON.stringify(back.cjkInVisible));
    check('切回英文后示意图换回英文版', back.diagram.src === en['design.diagramSrc'] && back.diagram.loaded, JSON.stringify(back.diagram));
    await checkNoOverflow(page, '英文 / 390', { width: 390, height: 844 });
    await page.screenshot({ path: path.join(args.out, 'en-desktop.png'), fullPage: true });

    // ---- 5. 冻结动画后再切语言：脚本写出来的文案也要跟着变 ----
    await page.locator('.gif-toggle').first().click();
    await page.waitForFunction(() => document.querySelector('.demo-media').classList.contains('is-frozen'));
    await page.locator('.lang-btn[data-lang="zh"]').click();
    await page.waitForFunction(() => document.documentElement.getAttribute('lang') === 'zh-CN');
    const frozen = await page.evaluate(() => {
      const button = document.querySelector('.gif-toggle');
      const still = document.querySelector('.demo-still');
      return { text: button.textContent.trim(), stillLabel: still ? still.getAttribute('aria-label') : null };
    });
    check('冻结态下切中文：按钮文案为中文播放态', frozen.text === zh['demo.play'], frozen.text);
    check('冻结态下切中文：停帧 canvas 的 aria-label 为中文', frozen.stillLabel === zh['demo.xhs.alt'], frozen.stillLabel);
    await page.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n[verify-site-lang] 检查项 ${checks}，失败 ${failures.length}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    process.exit(1);
  }
  console.log('[verify-site-lang] ✔ 双语行为门禁通过');
}

async function checkNoOverflow(page, label, viewport) {
  if (viewport) await page.setViewportSize(viewport);
  const data = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  const ok = data.scrollWidth <= data.innerWidth + 1;
  check(`${label}：无横向溢出`, ok, `${data.scrollWidth} vs ${data.innerWidth}`);
  if (viewport) await page.setViewportSize({ width: 1440, height: 900 });
}

main();
