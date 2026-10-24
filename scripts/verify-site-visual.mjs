// 落地页视觉门禁（`node scripts/verify-site-visual.mjs`，在仓库根运行）。
//
// 为什么要有这道闸：`verify-site.mjs` 只能证明「引用没断」，证明不了「深色主题真的生效」。
// TITA-33 的上一轮就是把样式注入浏览器、仓库里一行没改，却报告「已完成」——
// 没有一条命令能复现「页面实际长什么样」，评审就只能靠截图和信任。
//
// 这道闸用真实 Chromium 打开本地站点，量计算样式、对比度、浅色漏光和窄屏横向溢出，
// 并输出截图。所有断言都是可复现的数字，不读源码正则。
//
// 用法：
//   node scripts/verify-site-visual.mjs [--out <截图目录>] [--port 4183]
// 退出码：全通过 0，任一失败 1。不使用 skip，不用 try-catch 吞断言失败。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
  '.woff2': 'font/woff2',
};

const failures = [];
let checks = 0;

function parseArgs(argv) {
  const args = { out: path.join(os.tmpdir(), 'tita-33-site-visual'), port: 4183 };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--out') args.out = argv[i + 1];
    else if (argv[i] === '--port') args.port = Number(argv[i + 1]);
  }
  return args;
}

function check(name, ok, detail) {
  checks += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` -> ${detail}` : ''}`);
  if (!ok) failures.push(`${name}${detail ? ` -> ${detail}` : ''}`);
}

function serve(root, port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    let target = path.resolve(root, `.${urlPath}`);
    if (!target.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// 在页面里执行：量计算样式、对比度、浅色漏光、窄屏溢出。
function collectInPage() {
  const parseColor = (value) => {
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const srgb = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = ({ r, g, b }) => 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const effectiveBg = (el) => {
    let node = el;
    let acc = null;
    while (node && node !== document.documentElement.parentNode) {
      const c = parseColor(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) acc = acc === null ? c : over(acc, c);
      if (acc && acc.a >= 0.999) return acc;
      node = node.parentElement;
    }
    return acc || parseColor(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  };
  const ratio = (el) => {
    const fgRaw = parseColor(getComputedStyle(el).color);
    const bg = effectiveBg(el);
    const fg = fgRaw.a < 1 ? over(fgRaw, bg) : fgRaw;
    const l1 = luminance(fg);
    const l2 = luminance(bg);
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const fontPx = (el) => parseFloat(getComputedStyle(el).fontSize);
  const contrast = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const px = fontPx(el);
    const weight = Number(getComputedStyle(el).fontWeight);
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    return { selector, ratio: ratio(el), required: large ? 3 : 4.5, px, weight };
  };

  const css = (sel, prop) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el)[prop] : null;
  };

  // 浅色漏光：面积够大、背景接近不透明的亮色块。
  const lightLeaks = [];
  for (const el of document.querySelectorAll('body *')) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const bg = parseColor(style.backgroundColor);
    if (!bg || bg.a < 0.5) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width * rect.height < 4000) continue;
    if (luminance(bg) > 0.5) {
      const name = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
      lightLeaks.push({ element: name, background: style.backgroundColor, area: Math.round(rect.width * rect.height) });
    }
  }

  const steps = document.querySelector('.steps');
  return {
    htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    bodyColor: getComputedStyle(document.body).color,
    bodyFontSize: getComputedStyle(document.body).fontSize,
    bodyLineHeight: getComputedStyle(document.body).lineHeight,
    h1: {
      fontSize: css('h1', 'fontSize'),
      fontWeight: css('h1', 'fontWeight'),
      letterSpacing: css('h1', 'letterSpacing'),
      lineHeight: css('h1', 'lineHeight'),
      textAlign: css('h1', 'textAlign'),
    },
    h2FontSize: css('h2', 'fontSize'),
    navLink: {
      color: css('.site-nav a', 'color'),
      fontSize: css('.site-nav a', 'fontSize'),
      fontWeight: css('.site-nav a', 'fontWeight'),
      paddingTop: css('.site-nav a', 'paddingTop'),
      paddingRight: css('.site-nav a', 'paddingRight'),
      borderRadius: css('.site-nav a', 'borderRadius'),
    },
    card: {
      borderRadius: css('.card', 'borderRadius'),
      background: css('.card', 'backgroundColor'),
      transitionProperty: css('.card', 'transitionProperty'),
      transitionDuration: css('.card', 'transitionDuration'),
    },
    containerWidth: Math.round(document.querySelector('.container').getBoundingClientRect().width),
    heroTextAlign: css('.hero-inner', 'textAlign'),
    stepsColumns: steps ? getComputedStyle(steps).gridTemplateColumns.split(' ').filter(Boolean).length : null,
    heroLogoFilter: css('.hero-logo', 'filter'),
    diagramFilter: css('.diagram', 'filter'),
    diagramBackground: css('.diagram', 'backgroundColor'),
    contrasts: [
      contrast('.lead'),
      contrast('.hero-note'),
      contrast('.section-lead'),
      contrast('.card p'),
      contrast('.steps p'),
      contrast('.doc-list span'),
      contrast('.demo figcaption p'),
      contrast('.site-nav a'),
      contrast('.footer-inner'),
    ].filter(Boolean),
    lightLeaks,
    overflow: {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

async function measure(page, label) {
  const data = await page.evaluate(collectInPage);
  const desktop = label === 'desktop';
  console.log(`\n[${label}] ${data.viewport.width}x${data.viewport.height}`);
  console.log(JSON.stringify(data, null, 2));

  check(`${label}: html 底色为 #0F0F0F`, data.htmlBg === 'rgb(15, 15, 15)', data.htmlBg);
  check(`${label}: body 文字为 #EEEEEE`, data.bodyColor === 'rgb(238, 238, 238)', data.bodyColor);
  check(`${label}: h1 ${desktop ? '>= 56px' : '>= 32px'} 且 600`, parseFloat(data.h1.fontSize) >= (desktop ? 56 : 32) && data.h1.fontWeight === '600', `${data.h1.fontSize} / ${data.h1.fontWeight}`);
  check(`${label}: h1 居中`, data.h1.textAlign === 'center', data.h1.textAlign);
  check(`${label}: h1 letter-spacing <= ${desktop ? '-1px' : '-0.5px'}`, parseFloat(data.h1.letterSpacing) <= (desktop ? -1 : -0.5), data.h1.letterSpacing);
  check(`${label}: h1 line-height <= 1.1`, parseFloat(data.h1.lineHeight) / parseFloat(data.h1.fontSize) <= 1.1, data.h1.lineHeight);
  check(`${label}: h2 ${desktop ? '为 36px' : '>= 27px'}`, desktop ? data.h2FontSize === '36px' : parseFloat(data.h2FontSize) >= 27, data.h2FontSize);
  check(`${label}: 导航文字 #BCBCBC / 16px / 500`, data.navLink.color === 'rgb(188, 188, 188)' && data.navLink.fontSize === '16px' && data.navLink.fontWeight === '500', `${data.navLink.color} / ${data.navLink.fontSize} / ${data.navLink.fontWeight}`);
  check(`${label}: 导航 padding 8px 12px`, data.navLink.paddingTop === '8px' && data.navLink.paddingRight === '12px', `${data.navLink.paddingTop} ${data.navLink.paddingRight}`);
  check(`${label}: 卡片圆角 12px`, data.card.borderRadius === '12px', data.card.borderRadius);
  check(`${label}: 卡片 hover 过渡含 background-color/box-shadow 0.15s`, data.card.transitionProperty.includes('background-color') && data.card.transitionProperty.includes('box-shadow') && data.card.transitionDuration.split(', ').every((d) => d === '0.15s'), `${data.card.transitionProperty} / ${data.card.transitionDuration}`);
  check(`${label}: 无浅色底漏光`, data.lightLeaks.length === 0, JSON.stringify(data.lightLeaks));
  check(`${label}: 无横向溢出`, data.overflow.scrollWidth <= data.overflow.innerWidth + 1, `${data.overflow.scrollWidth} vs ${data.overflow.innerWidth}`);

  for (const c of data.contrasts) {
    check(`${label}: 对比度 ${c.selector} >= ${c.required}:1`, c.ratio >= c.required, `${c.ratio}:1`);
  }

  if (desktop) {
    check('desktop: 内容栏 >= 1120px', data.containerWidth >= 1120, `${data.containerWidth}px`);
    check('desktop: steps 为 2 列', data.stepsColumns === 2, `${data.stepsColumns} 列`);
    check('desktop: hero 居中', data.heroTextAlign === 'center', data.heroTextAlign);
    check('desktop: 深色 logo 已反色', data.heroLogoFilter !== 'none', data.heroLogoFilter);
    check('desktop: 示意图已做深色适配（反色）', data.diagramFilter !== 'none', data.diagramFilter);
  } else {
    check('mobile: steps 为 1 列', data.stepsColumns === 1, `${data.stepsColumns} 列`);
  }
  return data;
}

async function checkInteractions(page) {
  const anchors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.site-nav a')).map((a) => {
      const href = a.getAttribute('href') || '';
      return { href, target: href.startsWith('#') ? !!document.querySelector(href) : false };
    }),
  );
  const expected = ['#quickstart', '#capabilities', '#demos', '#design', '#mcp', '#docs'];
  const missing = anchors.filter((a) => !a.target).map((a) => a.href);
  const got = anchors.map((a) => a.href);
  check('导航锚点全部指向存在的区块', missing.length === 0 && expected.every((id) => got.includes(id)) && anchors.length === expected.length, JSON.stringify(got));

  check('演示区存在 2 个暂停按钮', (await page.locator('.gif-toggle').count()) === 2);

  await page.locator('#demos').scrollIntoViewIfNeeded();
  await page.waitForFunction(
    () => {
      const img = document.querySelector('.demo-gif');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    },
    null,
    { timeout: 20000 },
  );
  const firstToggle = page.locator('.gif-toggle').first();
  check('暂停按钮已显示', !(await firstToggle.getAttribute('hidden')));
  await firstToggle.click();
  const frozen = await page.evaluate(() => {
    const media = document.querySelector('.demo-media');
    const button = media.querySelector('.gif-toggle');
    return {
      frozen: media.classList.contains('is-frozen'),
      hasStill: Boolean(media.querySelector('.demo-still')),
      pressed: button.getAttribute('aria-pressed'),
      text: button.textContent.trim(),
    };
  });
  check('点击后停帧（is-frozen + canvas + aria-pressed）', frozen.frozen && frozen.hasStill && frozen.pressed === 'true' && frozen.text === '播放动画', JSON.stringify(frozen));
  await firstToggle.click();
  const resumed = await page.evaluate(() => {
    const media = document.querySelector('.demo-media');
    return {
      frozen: media.classList.contains('is-frozen'),
      hasStill: Boolean(media.querySelector('.demo-still')),
      pressed: media.querySelector('.gif-toggle').getAttribute('aria-pressed'),
    };
  });
  check('再次点击恢复动画', !resumed.frozen && !resumed.hasStill && resumed.pressed === 'false', JSON.stringify(resumed));
}

async function main() {
  const args = parseArgs(process.argv);
  prepareSiteAssets(REPO_ROOT);
  fs.mkdirSync(args.out, { recursive: true });

  const server = await serve(SITE_ROOT, args.port);
  const browser = await chromium.launch();
  try {
    const results = {};
    for (const [label, viewport] of [
      ['desktop', { width: 1440, height: 900 }],
      ['mobile', { width: 390, height: 844 }],
    ]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${args.port}/index.html`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      results[label] = await measure(page, label);
      if (label === 'desktop') await checkInteractions(page);
      await page.screenshot({ path: path.join(args.out, `${label}-full.png`), fullPage: true });
      await page.screenshot({ path: path.join(args.out, `${label}-hero.png`) });
      await page.close();
    }
    fs.writeFileSync(path.join(args.out, 'measurements.json'), JSON.stringify(results, null, 2), 'utf8');
    console.log(`\n[verify-site-visual] 截图与测量：${args.out}`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n[verify-site-visual] 检查项 ${checks}，失败 ${failures.length}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[FAIL] ${failure}`);
    process.exit(1);
  }
  console.log('[verify-site-visual] 视觉门禁通过');
}

main();
