import { esc } from '../../shared/dom/html.ts';

export function clipDetail(text: any, max: any): string {
  const value = String(text === undefined || text === null ? '' : text);
  if (!value) return '';
  return value.length > max ? value.slice(0, max) + '\n…（共 ' + value.length + ' 字符，已截断）' : value;
}

export function toolStepHtml(lead: any, name: any, hint: any, detailLabel: any, detail: any): string {
  const head =
    '<span class="agent-tool">' + esc(lead) + esc(name) + '</span>' +
    (hint ? '<span class="agent-tool-arg">：' + esc(hint) + '</span>' : '');
  if (!detail) return '<div class="agent-step">' + head + '</div>';
  return (
    '<details class="agent-step"><summary>' + head + '</summary>' +
    '<div class="agent-step-detail">' +
    (detailLabel ? '<div class="agent-step-label">' + esc(detailLabel) + '</div>' : '') +
    '<pre class="agent-step-pre">' + esc(detail) + '</pre>' +
    '</div></details>'
  );
}

export function toolStepElement(lead: any, name: any, hint: any, detailLabel: any, detail: any): Element | null {
  const wrap = document.createElement('div');
  wrap.innerHTML = toolStepHtml(lead, name, hint, detailLabel, detail);
  return wrap.firstElementChild;
}

export function safeAuthLink(value: any): string {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.username = '';
    url.password = '';
    return url.href;
  } catch (error) {
    return '';
  }
}

export function authChallengeHtml(auth: any): string {
  if (!auth || auth.required !== true) return '';
  const loginUrl = safeAuthLink(auth.loginUrl);
  const summary = String(auth.summary || auth.message || '操作被登录 / 权限拦截，请登录后重试。');
  const reason =
    auth.reason === 'permission-denied' ? '权限限制' : auth.reason === 'mcp-token-required' ? '服务端点拒绝（凭据）' : '登录拦截';
  return (
    '<div class="auth-challenge" role="alert" data-auth-reason="' + esc(auth.reason || 'login-required') + '">' +
      '<div class="auth-challenge-title">⚠ 操作被' + esc(reason) + '</div>' +
      '<div class="auth-challenge-summary">' + esc(summary) + '</div>' +
      (loginUrl
        ? '<a class="auth-challenge-link" href="' + esc(loginUrl) + '" target="_blank" rel="noopener noreferrer">打开登录页</a>'
        : '') +
    '</div>'
  );
}

export function authChallengeElement(auth: any): Element | null {
  const html = authChallengeHtml(auth);
  if (!html) return null;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  return wrap.firstElementChild;
}
