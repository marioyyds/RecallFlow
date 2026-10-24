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
//   4. 体积红线：`site/index.html` ≤ 1MB，`site/` 下任一文件 ≤ 8MB。
//
// 退出码：全通过 0，任一失败 1。不用 skip、不用 try-catch 吞失败。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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

function walkSite(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSite(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function main() {
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

  // 第二遍：体积红线。整棵 site/ 都查，包括没被引用到的残留文件
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

main();
