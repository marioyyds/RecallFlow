import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySensitiveField,
  containsLikelySecret,
  redactUrl,
  redactSensitiveText,
  redactSensitiveData,
  redactPageSnapshot,
} from '../lib/shared/sensitive-data.js';

test('敏感输入字段：密码/OTP/银行卡/API Key 都能识别', () => {
  const cases = [
    [{ inputType: 'password', name: 'password' }, 'credentials'],
    [{ autocomplete: 'one-time-code', label: '验证码' }, 'credentials'],
    [{ autocomplete: 'cc-number', label: '卡号' }, 'payment-card'],
    [{ name: 'api_key', label: 'API Key' }, 'secret'],
    [{ name: 'securityCode', label: 'CVV 安全码' }, 'payment-card'],
  ];
  for (const [field, category] of cases) {
    const r = classifySensitiveField(field);
    assert.equal(r.sensitive, true, JSON.stringify(field));
    assert.equal(r.category, category, JSON.stringify(field));
  }
  assert.equal(classifySensitiveField({ name: 'q', label: '搜索关键词' }).sensitive, false);
});

test('文本脱敏：密码、Bearer、Cookie、API Key、JWT 不原样输出', () => {
  const raw =
    'password=RF_SUPER_SECRET_42\n' +
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz\n' +
    'Cookie: sid=RF_COOKIE_SECRET\n' +
    'api_key=sk-test-RF_SECRET_12345\n' +
    'jwt=eyJabcdefghij.abcdefghij.abcdefghij';
  const out = redactSensitiveText(raw);
  for (const secret of [
    'RF_SUPER_SECRET_42',
    'abcdefghijklmnopqrstuvwxyz',
    'RF_COOKIE_SECRET',
    'sk-test-RF_SECRET_12345',
    'eyJabcdefghij.abcdefghij.abcdefghij',
  ]) {
    assert.ok(!out.includes(secret), '泄露：' + secret + '\n' + out);
  }
  assert.ok(out.includes('[已隐藏'));
});

test('文本脱敏：银行卡号按 Luhn 校验后才隐藏，保留末四位', () => {
  const out = redactSensitiveText('card=4111 1111 1111 1111；订单号=4111111111111112');
  assert.ok(!out.includes('4111 1111 1111 1111'));
  assert.ok(out.includes('**** **** **** 1111'));
  assert.ok(out.includes('4111111111111112'), '非银行卡数字不能被误伤');
});

test('URL 查询参数中的 token/session/code 值被隐藏，参数名保留', () => {
  const out = redactUrl('https://site.test/cb?token=RF_TOKEN&code=RF_CODE&x=1#session=RF_SESSION');
  for (const secret of ['RF_TOKEN', 'RF_CODE', 'RF_SESSION']) assert.ok(!out.includes(secret), out);
  assert.match(out, /\?token=\[已隐藏\]/);
  assert.match(out, /token=\[已隐藏\]/);
  assert.match(out, /code=\[已隐藏\]/);
  assert.match(out, /session=\[已隐藏\]/);
});

test('对象递归脱敏：secret 字段、快照正文和 href 都处理', () => {
  const data = {
    result: 'ok',
    password: 'RF_OBJECT_PASSWORD',
    nested: { access_token: 'RF_ACCESS_TOKEN', safe: 'hello' },
    pageSnapshot: {
      url: 'https://site.test/?token=RF_PAGE_TOKEN',
      title: '账号',
      text: '密码：RF_TEXT_PASSWORD',
      elements: [{ label: '卡号 4111 1111 1111 1111', href: '/x?session=RF_HREF_SESSION' }],
    },
  };
  const out = redactSensitiveData(data);
  const text = JSON.stringify(out);
  for (const secret of [
    'RF_OBJECT_PASSWORD',
    'RF_ACCESS_TOKEN',
    'RF_PAGE_TOKEN',
    'RF_TEXT_PASSWORD',
    'RF_HREF_SESSION',
    '4111 1111 1111 1111',
  ]) {
    assert.ok(!text.includes(secret), '泄露：' + secret + '\n' + text);
  }
  assert.equal(out.nested.safe, 'hello');
  assert.equal(redactPageSnapshot(data.pageSnapshot).title, '账号');
});

test('containsLikelySecret：明显令牌与卡号命中，普通文本不命中', () => {
  assert.equal(containsLikelySecret('sk-test-ABCDEFGH12345678'), true);
  assert.equal(containsLikelySecret('4111111111111111'), true);
  assert.equal(containsLikelySecret('这是一段普通页面正文'), false);
});
