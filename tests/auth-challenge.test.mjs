import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectAuthChallenge,
  findLoginLink,
  authChallengeNotice,
  isAuthUrl,
} from '../lib/assistant/auth-challenge.js';

test('auth: 导航到登录路径时给出当前登录页链接', () => {
  const auth = detectAuthChallenge({
    beforeUrl: 'https://site.test/protected',
    afterUrl: 'https://site.test/login?return=%2Fprotected',
    snapshot: { title: '账号登录', text: '请先登录后继续', elements: [] },
    result: '点击已派发',
    ok: true,
    toolName: 'click_element',
  });
  assert.ok(auth);
  assert.equal(auth.reason, 'login-required');
  assert.equal(auth.loginUrl, 'https://site.test/login?return=%2Fprotected');
  assert.equal(auth.loginUrlSource, 'current-page');
  assert.match(authChallengeNotice(auth), /不要反复点击/);
});

test('auth: 登录墙上的真实相对链接优先于猜测地址', () => {
  const auth = detectAuthChallenge({
    beforeUrl: 'https://site.test/work',
    afterUrl: 'https://site.test/work',
    snapshot: {
      title: '工作台',
      text: '请先登录后继续使用',
      elements: [
        { tag: 'a', role: 'link', label: '立即登录', href: '/passport/signin?next=/work' },
      ],
    },
    result: '点击已派发，页面出现登录提示',
    ok: true,
    toolName: 'click_element',
  });
  assert.ok(auth);
  assert.equal(auth.loginUrl, 'https://site.test/passport/signin?next=/work');
  assert.equal(auth.loginUrlSource, 'page-link');
  assert.equal(auth.linkLabel, '立即登录');
});

test('auth: 权限墙识别为 permission-denied，并保留可登录入口', () => {
  const auth = detectAuthChallenge({
    beforeUrl: 'https://site.test/admin',
    afterUrl: 'https://site.test/admin',
    snapshot: { title: '403', text: '无权限访问此页面', elements: [] },
    result: '操作失败：权限不足',
    ok: false,
    statusCode: 403,
    toolName: 'click_element',
  });
  assert.ok(auth);
  assert.equal(auth.reason, 'permission-denied');
  assert.match(auth.summary, /权限/);
  assert.equal(auth.loginUrl, 'https://site.test/login');
});

test('auth: 阅读教程里提到“请先登录”且带登录链接时不误报', () => {
  const auth = detectAuthChallenge({
    beforeUrl: 'https://docs.test/guide',
    afterUrl: 'https://docs.test/guide',
    snapshot: {
      title: '如何设计登录流程',
      text: '教程示例：页面提示“请先登录后继续”，并提供一个登录链接。',
      elements: [{ tag: 'a', role: 'link', label: '登录', href: '/login' }],
    },
    result: '教程正文……',
    ok: true,
    toolName: 'read_current_page',
  });
  assert.equal(auth, null);
});

test('auth: 拒绝 javascript: 登录链接，回退到站点登录入口', () => {
  const link = findLoginLink(
    {
      elements: [{ tag: 'a', role: 'link', label: '登录', href: 'javascript:alert(1)' }],
    },
    'https://site.test/'
  );
  assert.equal(link, null);
  const auth = detectAuthChallenge({
    beforeUrl: 'https://site.test/a',
    afterUrl: 'https://site.test/a',
    snapshot: { title: '受限', text: '请先登录后继续', elements: [] },
    result: '点击失败',
    ok: false,
    toolName: 'click_element',
  });
  assert.ok(auth);
  assert.equal(auth.loginUrl, 'https://site.test/login');
  assert.equal(auth.loginUrlSource, 'site-fallback');
});

test('auth: 401/403 状态码直接视为登录或权限拦截', () => {
  const auth = detectAuthChallenge({
    beforeUrl: 'https://api.test/private',
    afterUrl: 'https://api.test/private',
    result: '抓取失败 (401)',
    ok: false,
    statusCode: 401,
    toolName: 'fetch_webpage',
  });
  assert.ok(auth);
  assert.equal(auth.reason, 'login-required');
  assert.equal(auth.loginUrl, 'https://api.test/login');
});

test('auth: 登录路径识别覆盖常见站点命名', () => {
  for (const url of [
    'https://a.test/login',
    'https://a.test/account/signin',
    'https://a.test/passport?next=/x',
    'https://a.test/sso/callback',
  ]) {
    assert.equal(isAuthUrl(url), true, url);
  }
  assert.equal(isAuthUrl('https://a.test/articles/login-design'), false);
});
