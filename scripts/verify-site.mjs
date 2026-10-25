// GitHub Pages 站点静态门禁（`node scripts/verify-site.mjs`，在仓库根运行）。
//
// 为什么要有这道闸：站点发布后最容易翻车的不是「代码写错」，而是
// 「本地双击能打开、推到 https://marioyyds.github.io/RecallFlow/ 就白屏 / 404」——
// 引用了一个没提交的资源、引用跑到了 `site/` 之外、图片直接指向第三方 CDN、
// 或者 GIF 大到 Pages 不肯收。这些在本地预览里全都「看起来没问题」，
// 只有部署完刷页面才暴露，而那时已经多花一轮 CI + 一轮人工确认。
// 所以把它做成一条命令：push 前本地跑一次，CI 里再跑一次。
//
// 零依赖（只用 Node 内置模块）：站点本体没有 npm 依赖，CI 里也就不装 npm 依赖，
// 这道闸必须能在 `actions/setup-node` 之后直接跑起来，不能反过来引入 devDependencies
// —— 否则就是 TITA-14/15 那个「门禁所需依赖没进 CI」的坑再来一遍。
//
// 检查项：
//   1. 前置：`site/index.html` 必须存在，否则退出码 1 并明确报错；
//   2. 引用：HTML 的 `src` / `href` / `srcset`、以及被引用到的**本地 CSS** 里的 `url(...)`：
//        · 文件必须在磁盘上存在（相对引用按所在文件目录解析）；
//        · 解析后必须落在 `site/` 内（`../` 越界即失败）；
//        · 不允许 `file://`、Windows 盘符路径、UNC 路径、根绝对路径 `/…`
//          （站点挂在 `/RecallFlow/` 子路径下，`/…` 会指向 github.io 根域）；
//   3. 外部引用白名单：只有 `<a href="https://...">` 这类**超链接**允许站外；
//      脚本 / 样式 / 字体 / 图片等**子资源**位置出现 `http(s)://` 或 `//cdn` 一律失败；
//   4. 体积红线：`site/index.html` ≤ 1MB，`site/` 下任一文件 ≤ 8MB；
//   5. 双语一致性（TITA-41/42）：静态默认必须是英文、字典两套文案键集合一致且非空、
//      HTML 用到的每个 key 都能在字典里取到、英文文案里不许残留汉字。
//
// 退出码：全通过 0，任一失败 1。不用 skip、不用 try-catch 吞失败。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const INDEX_REL = 'site/index.html';
const SITE_DIR = 'site';
const MAX_INDEX_BYTES = 1024 * 1024; // 1MB
const MAX_ASSET_BYTES = 8 * 1024 * 1024; // 8MB

const REPO_ROOT = process.cwd();
const SITE_ROOT = path.resolve(REPO_ROOT, SITE_DIR);
const INDEX_ABS = path.resolve(REPO_ROOT, INDEX_REL);

// 「超链接」位置：只有这两个标签的 href 允许指向站外（点了是跳转，加载失败不会白屏）。
const HYPERLINK_TAGS = new Set(['a', 'area']);
// 需要检查的 HTML 属性。URL 属性只认这三个 —— 站点是手写页面，不引入 data-* 懒加载那一套。
const URL_ATTRS = new Set(['src', 'href', 'srcset']);

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/g;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/g;

const failures = [];
let totalChecks = 0;
let failedChecks = 0;

function relFrom(root, abs) {
  const rel = path.relative(root, abs);
  return rel.split(path.sep).join('/');
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

// 把注释内容替换成空白（换行保留，行号才不会错位）。
// 不做这一步，注释掉的 `<script src="https://cdn...">` 会被当成真实引用 → 误报。
function maskComments(text, startToken, endToken) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(startToken, i)) {
      const end = text.indexOf(endToken, i + startToken.length);
      const stop = end === -1 ? text.length : end + endToken.length;
      for (let j = i; j < stop; j += 1) out += text[j] === '\n' ? '\n' : ' ';
      i = stop;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

// 引用的分类结果决定了后面怎么判：
//   skip     —— 锚点、data:/mailto:/tel:、空值，不参与检查；
//   external —— 站外 URL（超链接放行，子资源失败）；
//   relative —— 相对路径，解析后校验存在性与是否越界；
//   error    —— 无论出现在什么位置都直接失败（file://、盘符、UNC、`/…`）。
function classify(raw) {
  const value = raw.trim();
  if (!value || value.startsWith('#')) return { kind: 'skip' };
  // 盘符路径要先判：`C:/x.png` 也会被「单字母 scheme」的正则命中，
  // 不先拦下来就会被当成站外 URL，报的原因完全对不上。
  if (/^[a-zA-Z]:[\\/]/.test(value)) return { kind: 'error', reason: `盘符绝对路径（${value}）` };
  if (value.startsWith('\\\\')) return { kind: 'error', reason: 'UNC 网络路径' };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === 'file') {
      return { kind: 'error', reason: 'file:// 引用（Pages 上必然 404，本地也无法跨目录加载）' };
    }
    if (s === 'data' || s === 'mailto' || s === 'tel') return { kind: 'skip' };
    return { kind: 'external' };
  }
  if (value.startsWith('//')) return { kind: 'external' };
  if (value.startsWith('/')) {
    return {
      kind: 'error',
      reason: '根绝对路径 /…（站点挂在 /RecallFlow/ 子路径下，/… 会指到 github.io 根域）',
    };
  }
  return { kind: 'relative' };
}

function stripQueryAndHash(value) {
  const [withoutHash] = value.split('#', 1);
  const [withoutQuery] = withoutHash.split('?', 1);
  return withoutQuery;
}

function resolveRelative(ownerAbs, value) {
  const raw = stripQueryAndHash(value.trim());
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw; // 含非法 % 转义：按字面量解析，后面的「是否存在」会把它挡下来
  }
  return path.resolve(path.dirname(ownerAbs), decoded);
}

function recordFailure(where, reasons) {
  failedChecks += 1;
  for (const reason of reasons) failures.push(`✘ ${where}\n    ${reason}`);
}

// 单个引用在这里走完「协议 → 越界 → 存在性」三步。失败时把能一次报完的原因都报出来，
// 免得改一个再跑一次才发现下一个。
function checkReference({ ownerAbs, ownerRel, line, tag, attr, value, isHyperlink }) {
  totalChecks += 1;
  const where = `${ownerRel}:${line}  <${tag} ${attr}=>"${value.trim()}"`;
  const { kind, reason } = classify(value);
  if (kind === 'skip') return null;
  if (kind === 'error') {
    recordFailure(where, [reason]);
    return null;
  }
  if (kind === 'external') {
    if (isHyperlink) return null;
    recordFailure(where, [
      '外部子资源引用：只允许 `<a href="https://...">` 这类超链接指向站外，' +
        '脚本 / 样式 / 字体 / 图片必须自包含',
    ]);
    return null;
  }
  const resolved = resolveRelative(ownerAbs, value);
  const rel = path.relative(SITE_ROOT, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    recordFailure(where, [
      `引用越界：解析后落在 site/ 之外（site/${rel.split(path.sep).join('/')}）`,
    ]);
    return null;
  }
  if (!fs.existsSync(resolved)) {
    recordFailure(where, [`引用文件不存在：${relFrom(REPO_ROOT, resolved)}`]);
    return null;
  }
  if (!fs.statSync(resolved).isFile()) {
    recordFailure(where, [`引用路径不是文件：${relFrom(REPO_ROOT, resolved)}`]);
    return null;
  }
  return resolved;
}

function collectHtmlRefs(abs, rel) {
  const text = maskComments(fs.readFileSync(abs, 'utf8'), '<!--', '-->');
  const refs = [];
  TAG_RE.lastIndex = 0;
  let tagMatch;
  while ((tagMatch = TAG_RE.exec(text)) !== null) {
    const tag = tagMatch[1].toLowerCase();
    const attrs = tagMatch[2] || '';
    ATTR_RE.lastIndex = 0;
    let attrMatch;
    while ((attrMatch = ATTR_RE.exec(attrs)) !== null) {
      const attr = attrMatch[1].toLowerCase();
      if (!URL_ATTRS.has(attr)) continue;
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      // 属性在整份文件里的偏移 = 标签起点 + `<` + 标签名 + 属性在标签内的偏移（行号才准）。
      const line = lineOf(text, tagMatch.index + 1 + tagMatch[1].length + attrMatch.index);
      const isHyperlink = attr === 'href' && HYPERLINK_TAGS.has(tag);
      if (attr === 'srcset') {
        // srcset 是一组 `url 描述符` 候选，逗号分隔逐个查。
        for (const candidate of value.split(',')) {
          const url = candidate.trim().split(/\s+/)[0];
          if (!url) continue;
          refs.push({ line, tag, attr, value: url, isHyperlink: false });
        }
        continue;
      }
      refs.push({ line, tag, attr, value, isHyperlink });
    }
  }
  return refs.map((r) => ({ ...r, ownerAbs: abs, ownerRel: rel }));
}

function collectCssRefs(abs, rel) {
  const text = maskComments(fs.readFileSync(abs, 'utf8'), '/*', '*/');
  const refs = [];
  CSS_URL_RE.lastIndex = 0;
  let m;
  while ((m = CSS_URL_RE.exec(text)) !== null) {
    const value = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!value) continue;
    refs.push({
      ownerAbs: abs,
      ownerRel: rel,
      line: lineOf(text, m.index),
      tag: 'css',
      attr: 'url()',
      value,
      isHyperlink: false,
    });
  }
  return refs;
}

// ---------- 双语一致性 ----------
//
// 为什么要有这一组：`site/` 支持中英切换之后，最容易悄悄退化的是「文案」而不是「引用」——
//   · 有人把中文直接写回 index.html → 静态默认变成中文，SEO 抓取器（不执行 JS）拿到中文；
//   · 字典漏了某个 key → 切到中文仍显示英文，且没人看得出这块是漏的；
//   · 英文文案里混着没译干净的汉字 → 英文版里挂着中文。
// 这些只在部署后才看得出来，所以放在 push 前这道闸里。做法是真读字典对象、真读 HTML 属性，
// 不猜源码正则；节选-by-key 的断言都能被「删掉一条字典词条」这类操作打到红（见交付证据）。

const I18N_REL = 'site/i18n.js';
const I18N_KEY_ATTRS = new Set(['data-i18n', 'data-i18n-html', 'data-i18n-attr']);
// CJK 与全角标点：出现在英文文案里就是漏译，出现在静态 HTML 里就是静态默认不是英文。
const CJK_RE = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
// SEO 抓取器不执行 JS，这六处的静态值必须等于英文字典里对应的文案。
const SEO_STATIC_TARGETS = [
  { label: '<title>', kind: 'title', key: 'meta.title' },
  { label: 'meta[name="description"]', kind: 'meta', match: { attr: 'name', value: 'description' }, key: 'meta.description' },
  { label: 'meta[property="og:title"]', kind: 'meta', match: { attr: 'property', value: 'og:title' }, key: 'meta.title' },
  { label: 'meta[property="og:description"]', kind: 'meta', match: { attr: 'property', value: 'og:description' }, key: 'meta.socialDescription' },
  { label: 'meta[name="twitter:title"]', kind: 'meta', match: { attr: 'name', value: 'twitter:title' }, key: 'meta.title' },
  { label: 'meta[name="twitter:description"]', kind: 'meta', match: { attr: 'name', value: 'twitter:description' }, key: 'meta.socialDescription' },
];

function collectI18nKeys(text) {
  const keys = [];
  TAG_RE.lastIndex = 0;
  let tagMatch;
  while ((tagMatch = TAG_RE.exec(text)) !== null) {
    const attrs = tagMatch[2] || '';
    ATTR_RE.lastIndex = 0;
    let attrMatch;
    while ((attrMatch = ATTR_RE.exec(attrs)) !== null) {
      const attr = attrMatch[1].toLowerCase();
      if (!I18N_KEY_ATTRS.has(attr)) continue;
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      const line = lineOf(text, tagMatch.index + 1 + tagMatch[1].length + attrMatch.index);
      if (attr === 'data-i18n-attr') {
        for (const pair of value.trim().split(/\s+/)) {
          const colon = pair.indexOf(':');
          if (colon <= 0) continue;
          keys.push({ key: pair.slice(colon + 1), line });
        }
        continue;
      }
      keys.push({ key: value.trim(), line });
    }
  }
  return keys;
}

function findHtmlLangAttr(text) {
  TAG_RE.lastIndex = 0;
  let tagMatch;
  while ((tagMatch = TAG_RE.exec(text)) !== null) {
    if (tagMatch[1].toLowerCase() !== 'html') continue;
    const attrs = tagMatch[2] || '';
    ATTR_RE.lastIndex = 0;
    let attrMatch;
    while ((attrMatch = ATTR_RE.exec(attrs)) !== null) {
      if (attrMatch[1].toLowerCase() !== 'lang') continue;
      return attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
    }
  }
  return null;
}

function collectMetaContents(text) {
  const found = [];
  TAG_RE.lastIndex = 0;
  let tagMatch;
  while ((tagMatch = TAG_RE.exec(text)) !== null) {
    if (tagMatch[1].toLowerCase() !== 'meta') continue;
    const attrs = tagMatch[2] || '';
    const bag = new Map();
    ATTR_RE.lastIndex = 0;
    let attrMatch;
    while ((attrMatch = ATTR_RE.exec(attrs)) !== null) {
      bag.set(attrMatch[1].toLowerCase(), attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '');
    }
    found.push(bag);
  }
  return found;
}

function normalizeText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

// import 真实字典（i18n.js 不碰 document，可以在 Node 里安全加载）。
// 加载失败要变成**一条失败检查**，不能变成 ENOENT 崩溃让后面 9 条检查集体消失。
async function loadI18nApi() {
  totalChecks += 1;
  const abs = path.join(SITE_ROOT, 'i18n.js');
  if (!fs.existsSync(abs)) {
    recordFailure(`${I18N_REL}（双语字典）`, ['缺少双语字典：站点走 data-i18n 回填，文案必须集中在 site/i18n.js']);
    return null;
  }
  try {
    await import(pathToFileURL(abs).href);
  } catch (error) {
    recordFailure(`${I18N_REL}（双语字典）`, [`字典加载失败：${error && error.message ? error.message : String(error)}`]);
    return null;
  }
  const api = globalThis.RecallFlowI18n;
  const copy = api && api.COPY;
  if (!copy || typeof copy.en !== 'object' || typeof copy.zh !== 'object') {
    recordFailure(`${I18N_REL}（双语字典）`, ['字典未同时导出 en / zh 两套文案（COPY.en / COPY.zh）']);
    return null;
  }
  return api;
}

// 返回去重后的「HTML 用到的 key」列表；字典缺失时返回 []（不重复报错）。
function checkKeyCoverage(api, htmlText) {
  const used = collectI18nKeys(htmlText);
  const missing = [];
  for (const { key, line } of used) {
    if (typeof api.COPY.en[key] !== 'string' || typeof api.COPY.zh[key] !== 'string') {
      missing.push(`${INDEX_REL}:${line}  key="${key}"`);
    }
  }
  totalChecks += 1;
  if (missing.length) {
    recordFailure('双语 key 覆盖（index.html → 字典）', [
      `下列 data-i18n* 引用的 key 在 en/zh 字典里缺 ${
        missing.length
      } 处（切过去会留空白或漏译）：${missing.join('；')}`,
    ]);
  }
  return Array.from(new Set(used.map((u) => u.key)));
}

function checkDictionaryIntegrity(api) {
  const enKeys = Object.keys(api.COPY.en);
  const zhKeys = Object.keys(api.COPY.zh);

  totalChecks += 1;
  const onlyEn = enKeys.filter((k) => !zhKeys.includes(k));
  const onlyZh = zhKeys.filter((k) => !enKeys.includes(k));
  if (onlyEn.length || onlyZh.length) {
    const detail = [
      onlyEn.length ? `缺 zh：${onlyEn.join('、')}` : '',
      onlyZh.length ? `缺 en：${onlyZh.join('、')}` : '',
    ].filter(Boolean);
    recordFailure('双语字典：en / zh 键集合一致', [detail.join('；')]);
  }

  totalChecks += 1;
  const blank = [];
  for (const lang of ['en', 'zh']) {
    for (const key of Object.keys(api.COPY[lang])) {
      const value = api.COPY[lang][key];
      if (typeof value !== 'string' || value.trim() === '') blank.push(`${lang}.${key}`);
    }
  }
  if (blank.length) {
    recordFailure('双语字典：每种语言都不得有空白文案', [`空白/非字符串条目（${blank.length} 条）：${blank.join('、')}`]);
  }

  totalChecks += 1;
  // 豁免两种写法：
  //   · 两种语言完全相同的条目（语言名、品牌名、代码）本来就该原样出现；
  //   · 除此之外，英文条目里出现汉字 = 漏译。
  const chineseLeftover = enKeys.filter(
    (k) => api.COPY.en[k] !== api.COPY.zh[k] && CJK_RE.test(api.COPY.en[k] || ''),
  );
  if (chineseLeftover.length) {
    recordFailure('双语字典：英文文案里不得残留汉字（漏译检测）', [
      `英文条目含 CJK 字符（${chineseLeftover.length} 条）：${chineseLeftover.join('、')}`,
    ]);
  }
}

function checkStaticEnglishDefault(api, htmlText) {
  const masked = maskComments(htmlText, '<!--', '-->');

  totalChecks += 1;
  const langAttr = findHtmlLangAttr(masked);
  if (langAttr !== 'en') {
    recordFailure(`${INDEX_REL} 静态 <html lang>`, [
      `静态值必须是 "en"（没执行 JS 时也要是英文），实际为 ${JSON.stringify(langAttr)}`,
    ]);
  }

  totalChecks += 1;
  // 语言切换按钮上写的是语言自己的名字（EN / 中文）—— endonym 按设计不翻译，
  // 所以它是静态 HTML 里唯一允许出现的中文；其余任何中文都算「静态默认不是英文」。
  const exemptedDataLang = masked.replace(/<button\b[^>]*\bdata-lang\b[^>]*>[\s\S]*?<\/button>/gi, '');
  const hit = CJK_RE.exec(exemptedDataLang);
  if (hit) {
    recordFailure(`${INDEX_REL} 静态默认必须是英文`, [
      `静态 HTML（注释、语言切换按钮上的语言名除外）里出现了中文字符 "${hit[0]}"，位于第 ${lineOf(masked, hit.index)} 行：` +
        '静态默认一旦是中文，SEO 抓取器与禁用 JS 的浏览器拿到的就不是英文',
    ]);
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(masked);
  const metas = collectMetaContents(masked);
  for (const target of SEO_STATIC_TARGETS) {
    totalChecks += 1;
    let actual = null;
    if (target.kind === 'title') {
      actual = titleMatch ? titleMatch[1] : null;
    } else {
      const bag = metas.find((m) => m.get(target.match.attr) === target.match.value);
      actual = bag ? bag.get('content') : null;
    }
    const expected = api.COPY.en[target.key];
    if (typeof expected !== 'string' || normalizeText(actual) !== normalizeText(expected)) {
      recordFailure(`SEO 静态文案 ${target.label}`, [
        `静态值必须等于英文字典里的 "${target.key}"；实际=${JSON.stringify(normalizeText(actual))} 期望=${JSON.stringify(normalizeText(expected))}`,
      ]);
    }
  }
}

// 字典里有 HTML/脚本都没用到的 key = 死文案，迟早和页面写歪；宁可让它在这里红。
function checkNoDeadKeys(api, htmlText, usedKeys) {
  totalChecks += 1;
  const appRel = 'site/app.js';
  const appText = fs.existsSync(path.join(SITE_ROOT, 'app.js')) ? fs.readFileSync(path.join(SITE_ROOT, 'app.js'), 'utf8') : '';
  const dead = Object.keys(api.COPY.en).filter(
    (key) => !usedKeys.includes(key) && !htmlText.includes(key) && !appText.includes(key),
  );
  if (dead.length) {
    recordFailure('双语字典：不得有没人使用的词条', [
      `${dead.length} 条既没被 ${INDEX_REL} 引用、也没出现在 ${appRel} 里：${dead.join('、')}`,
    ]);
  }
}

async function checkBilingual() {
  const api = await loadI18nApi();
  const htmlText = fs.readFileSync(INDEX_ABS, 'utf8');
  if (!api) return;
  const usedKeys = checkKeyCoverage(api, htmlText);
  checkDictionaryIntegrity(api);
  checkStaticEnglishDefault(api, htmlText);
  checkNoDeadKeys(api, htmlText, usedKeys);
}

function walkSite(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSite(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

async function main() {
  console.log(`[verify-site] 仓库根：${REPO_ROOT}`);
  console.log(`[verify-site] 站点目录：${SITE_ROOT}`);

  if (!fs.existsSync(INDEX_ABS)) {
    console.error(`[verify-site] ✘ 前置失败：找不到 ${INDEX_REL}`);
    console.error(
      '[verify-site]   站点页面由 TITA-21-A 交付；若只是资源没生成，先跑 `node scripts/site-assets.mjs`。',
    );
    process.exit(1);
  }

  // 第一遍：引用检查。HTML 起步，遇到本地 CSS 就顺着扫它里面的 url()（BFS，去重防环）。
  const queue = [{ abs: INDEX_ABS, rel: INDEX_REL, type: 'html' }];
  const seen = new Set([path.resolve(INDEX_ABS)]);
  const discoveredCss = [];
  while (queue.length) {
    const file = queue.shift();
    const refs = file.type === 'html' ? collectHtmlRefs(file.abs, file.rel) : collectCssRefs(file.abs, file.rel);
    for (const ref of refs) {
      const resolved = checkReference(ref);
      if (!resolved) continue;
      const key = path.resolve(resolved);
      if (resolved.toLowerCase().endsWith('.css') && !seen.has(key)) {
        seen.add(key);
        discoveredCss.push(key);
        queue.push({ abs: resolved, rel: relFrom(REPO_ROOT, resolved), type: 'css' });
      }
    }
  }

  // 第三遍：双语一致性。默认语言是英文，所以静态 HTML 本身就是英文体制的一部分
  // （`html lang`、title / meta、以及注释之外再无中文），其余交给字典逐个回填。
  await checkBilingual();

  // 第四遍：体积红线。整棵 site/ 都查，包括没被引用到的残留文件
  // （它们同样会被 upload-pages-artifact 打进产物）。
  const siteFiles = fs.existsSync(SITE_ROOT) ? walkSite(SITE_ROOT) : [];
  for (const abs of siteFiles) {
    totalChecks += 1;
    const rel = relFrom(REPO_ROOT, abs);
    const size = fs.statSync(abs).size;
    const limit = path.resolve(abs) === path.resolve(INDEX_ABS) ? MAX_INDEX_BYTES : MAX_ASSET_BYTES;
    if (size > limit) {
      const limitText = limit === MAX_INDEX_BYTES ? '1MB' : '8MB';
      recordFailure(`${rel}（体积）`, [
        `体积 ${size} 字节 > 红线 ${limitText}（${limit} 字节）：压缩或替换为更轻的资源后再发布`,
      ]);
    }
  }

  const passed = totalChecks - failedChecks;
  console.log(`[verify-site] 检查项 ${totalChecks}，通过 ${passed}，失败 ${failedChecks}`);
  if (discoveredCss.length) {
    console.log(`[verify-site] 已扫描本地 CSS：${discoveredCss.map((p) => relFrom(REPO_ROOT, p)).join('、')}`);
  }
  if (failedChecks > 0) {
    for (const line of failures) console.error(line);
    console.error('[verify-site] 站点校验未通过');
    process.exit(1);
  }
  console.log('[verify-site] ✔ 站点校验通过');
}

await main();
