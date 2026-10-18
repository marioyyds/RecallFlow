// 登录 / 权限拦截识别。
//
// 为什么需要单独一层：真实站点不会统一用 401 告诉浏览器「该登录了」——
// 它们可能把用户带到 /login、弹出一层「请先登录后继续」、或者只回一句
// 「无权限 / 访问受限」。如果只让模型自己从正文里猜，典型失败是：
//   ① 把登录墙当成空白页，换关键词继续猜 URL；
//   ② 在登录页和业务页之间来回切换；
//   ③ 最后告诉用户「操作完成」。
//
// 这里只做纯判断，不碰 chrome.*，也不负责执行动作。输出同时给两边使用：
//   · 模型：在 tool 结果末尾追加「先让用户登录，不要继续试」；
//   · 用户：面板渲染成带真实登录链接的提示条。
//
// 判断刻意采用**组合证据**，避免把教程正文里的「请先登录」误报成登录墙。

const AUTH_PATH_RE = /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|passport|sso|auth)(?:\/|$)/i;
const LOGIN_COPY_RE =
  /(请先登录|需要登录|必须登录|未登录|尚未登录|登录后(?:继续|重试|查看|访问|使用)|登录以继续|去登录|立即登录|扫码登录|sign\s*in\s+to\s+continue|log\s*in\s+to\s+continue|please\s+(?:sign\s*in|log\s*in)|login\s+required|authentication\s+required)/i;
const DENY_COPY_RE =
  /(无权限|没有权限|权限不足|无权访问|访问受限|拒绝访问|禁止访问|permission\s+denied|access\s+denied|not\s+authori[sz]ed|forbidden|unauthorized|http\s*(?:401|403)|状态码\s*(?:401|403))/i;
const LOGIN_AFFORDANCE_RE = /(登录|登入|去登录|立即登录|登录后继续|sign\s*in|log\s*in)/i;
const NO_EFFECT_RE = /(未产生|没有产生|暂未观察|无变化|没有变化|unchanged|no\s+observable)/i;
const MUTATING_TOOLS = new Set([
  'open_tab',
  'switch_tab',
  'fetch_webpage',
  'click_element',
  'click_at',
  'type_text',
  'press_key',
  'select_option',
  'check_box',
  'hover_element',
  'drag_element',
  'upload_file',
  'scroll_page',
  'annotate',
  'run_javascript',
]);

function asHttpUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const base = baseUrl ? String(baseUrl) : undefined;
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    // 登录链接里不应该带凭据；即使站点给了，也不要把它写进提示或模型上下文。
    u.username = '';
    u.password = '';
    return u.href;
  } catch (e) {
    return '';
  }
}

function withoutHash(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch (e) {
    return String(url || '');
  }
}

export function isAuthUrl(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return AUTH_PATH_RE.test(decodeURIComponent(u.pathname || ''));
  } catch (e) {
    return false;
  }
}

function snapshotHaystack(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const elements = Array.isArray(s.elements) ? s.elements : [];
  const elementText = elements
    .slice(0, 120)
    .map((e) => [e && e.label, e && e.placeholder, e && e.name, e && e.href].filter(Boolean).join(' '))
    .join('\n');
  return [s.title, s.text, elementText].filter(Boolean).join('\n').slice(0, 16000);
}

/**
 * 从快照元素里找真实的登录入口。
 *
 * 只接受 http/https 的 href：`javascript:`、`data:` 和空锚点都不能作为给用户的登录链接。
 * 优先 href 本身像登录页的元素；只有文案像登录但 href 是站内相对地址时，也保留作为候选。
 */
export function findLoginLink(snapshot, baseUrl) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const elements = Array.isArray(s.elements) ? s.elements : [];
  let best = null;
  for (const e of elements) {
    if (!e || typeof e !== 'object' || !e.href) continue;
    const label = String(e.label || e.placeholder || e.name || '').trim();
    const hrefText = String(e.href || '').trim();
    if (!LOGIN_AFFORDANCE_RE.test(label) && !isAuthUrl(asHttpUrl(hrefText, baseUrl))) continue;
    const url = asHttpUrl(hrefText, baseUrl || s.url);
    if (!url) continue;
    let score = 0;
    if (LOGIN_AFFORDANCE_RE.test(label)) score += 4;
    if (isAuthUrl(url)) score += 6;
    if (String(e.tag || '').toLowerCase() === 'a' || String(e.role || '').toLowerCase() === 'link') score += 1;
    if (!best || score > best.score) {
      best = { url, label: label || '登录页', score };
    }
  }
  return best ? { url: best.url, label: best.label } : null;
}

function fallbackLoginUrl(currentUrl) {
  try {
    const u = new URL(currentUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin + '/login';
  } catch (e) {
    return '';
  }
}

/**
 * 识别一次工具结果是否被登录 / 权限拦截。
 *
 * @param {Object} input
 * @param {string} [input.beforeUrl] 动作前的页面 URL（用于识别“导航到了登录页”）
 * @param {string} [input.afterUrl] 动作后的 URL；没有时退回快照 URL
 * @param {Object} [input.snapshot] 页面快照 { url, title, text, elements }
 * @param {string} [input.result] 工具结果文本
 * @param {boolean} [input.ok] 工具是否成功；默认 true
 * @param {number} [input.statusCode] HTTP 状态码（fetch_webpage）
 * @param {string} [input.toolName]
 * @returns {null | {required:true,reason:string,summary:string,message:string,currentUrl:string,loginUrl:string,loginUrlSource:string,linkLabel:string}}
 */
export function detectAuthChallenge(input) {
  const data = input && typeof input === 'object' ? input : {};
  const snapshot = data.snapshot && typeof data.snapshot === 'object' ? data.snapshot : null;
  const beforeUrl = asHttpUrl(data.beforeUrl);
  const currentUrl =
    asHttpUrl(data.afterUrl) ||
    asHttpUrl(snapshot && snapshot.url) ||
    beforeUrl;
  const resultText = String(data.result || '').slice(0, 12000);
  const pageText = snapshotHaystack(snapshot);
  const haystack = [pageText, resultText].filter(Boolean).join('\n');
  const ok = data.ok !== false;
  const statusCode = Number(data.statusCode) || 0;
  const toolName = String(data.toolName || '');

  const authPath = isAuthUrl(currentUrl);
  const beforeAuthPath = isAuthUrl(beforeUrl);
  const navigatedToAuth =
    authPath &&
    (!beforeUrl || (!beforeAuthPath && withoutHash(beforeUrl) !== withoutHash(currentUrl)));
  const loginCopy = LOGIN_COPY_RE.test(haystack);
  const denyCopy = DENY_COPY_RE.test(haystack);
  const resultHasAuth = !ok && (LOGIN_COPY_RE.test(resultText) || DENY_COPY_RE.test(resultText));
  const statusHasAuth = statusCode === 401 || statusCode === 403;
  const link = findLoginLink(snapshot, currentUrl || beforeUrl);
  const pageTitleLooksLikeLogin = /(登录|登陆|登入|sign\s*in|log\s*in)/i.test(
    String((snapshot && snapshot.title) || '')
  );

  // 页面正文里出现「请先登录」本身远远不够：教程、博客、错误示例都会写这句话。
  // 只有和“动作失败 / 跳到登录路径 / 真实登录链接”组合起来才可信。
  const wallDetected =
    navigatedToAuth ||
    resultHasAuth ||
    statusHasAuth ||
    (!ok && (loginCopy || denyCopy)) ||
    (MUTATING_TOOLS.has(toolName) && loginCopy && Boolean(link)) ||
    (MUTATING_TOOLS.has(toolName) && pageTitleLooksLikeLogin && loginCopy && Boolean(link)) ||
    (loginCopy && Boolean(link) && NO_EFFECT_RE.test(resultText));

  if (!wallDetected) return null;

  const permissionDenied =
    denyCopy ||
    statusCode === 403 ||
    /(无权限|没有权限|权限不足|permission\s+denied|access\s+denied|forbidden)/i.test(resultText);
  const reason = permissionDenied ? 'permission-denied' : 'login-required';
  const summary = permissionDenied
    ? '操作被权限限制：当前登录状态或账号权限不足，需要登录 / 授权后重试。'
    : '操作被登录拦截：当前页面需要先登录后才能继续。';

  let loginUrl = '';
  let loginUrlSource = '';
  if (authPath) {
    loginUrl = currentUrl;
    loginUrlSource = 'current-page';
  } else if (link && link.url) {
    loginUrl = link.url;
    loginUrlSource = 'page-link';
  } else {
    loginUrl = fallbackLoginUrl(currentUrl || beforeUrl);
    loginUrlSource = loginUrl ? 'site-fallback' : '';
  }

  const message = loginUrl ? summary + ' 登录 / 授权入口：' + loginUrl : summary;
  return {
    required: true,
    reason,
    summary,
    message,
    currentUrl,
    loginUrl,
    loginUrlSource,
    linkLabel: (link && link.label) || (authPath ? '当前登录页' : '登录页'),
  };
}

/** 给模型看的追加说明：强调停下来等用户，而不是继续在页面上试。 */
export function authChallengeNotice(challenge) {
  if (!challenge || challenge.required !== true) return '';
  return (
    '\n\n⚠ ' + challenge.message +
    '\n请先把上面的登录 / 授权入口告诉用户，并等待用户完成登录。' +
    '在用户明确表示已登录前，不要反复点击、猜测其它地址，也不要在标签页之间来回切换。'
  );
}
