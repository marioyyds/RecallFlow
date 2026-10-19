import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifySensitiveAction,
  isSensitivePage,
} from '../lib/assistant/sensitive-action-policy.js';

function classify(toolName, args, pageUrl, target) {
  return classifySensitiveAction({ toolName, args, pageUrl, target });
}

test('支付确认、购买、转账等动作必须阻止自动执行', () => {
  for (const label of ['确认支付', '立即购买', '提交订单', '确认转账', '立即提现', 'Pay now', 'Place order']) {
    const r = classify('click_element', { role: 'button', name: label }, 'https://shop.test/goods', {
      label,
      role: 'button',
      tag: 'button',
    });
    assert.equal(r.blocked, true, label);
    assert.match(r.category, /payment/);
  }
});

test('密码、验证码、CVV 等敏感输入在写入前拦截', () => {
  const r1 = classify('type_text', { value: 'secret-password' }, 'https://site.test/login', {
    inputType: 'password',
    name: 'password',
    label: '密码',
  });
  assert.equal(r1.blocked, true);
  assert.equal(r1.category, 'account-credentials');

  const r2 = classify('type_text', { value: '123' }, 'https://shop.test/pay', {
    autocomplete: 'cc-csc',
    label: 'CVV',
  });
  assert.equal(r2.blocked, true);
  assert.equal(r2.category, 'payment-instrument');

  const r3 = classify('press_key', { key: 'Enter' }, 'https://site.test/login', {
    inputType: 'password',
    name: 'password',
    label: '密码',
  });
  assert.equal(r3.blocked, true, '无 selector 的 press_key 也必须看当前焦点字段');
});

test('账号安全动作：登录、改密码、注销、API Key 授权默认阻止', () => {
  for (const label of ['登录', '修改密码', '注销账号', '创建 API Key', '授权应用']) {
    const r = classify('click_element', { role: 'button', name: label }, 'https://site.test/settings', {
      label,
      role: 'button',
      tag: 'button',
    });
    assert.equal(r.blocked, true, label);
  }
});

test('只读页面操作不受影响，文章里的“支付说明”不会被当成支付按钮', () => {
  assert.equal(classify('read_current_page', {}, 'https://docs.test/payment-guide').blocked, false);
  assert.equal(classify('get_page_snapshot', {}, 'https://bank.test/pay').blocked, false);
  assert.equal(
    classify('click_element', { role: 'link', name: '支付说明' }, 'https://docs.test/guide', {
      label: '支付说明',
      role: 'link',
      tag: 'a',
    }).blocked,
    false
  );
  assert.equal(
    classify('click_element', { role: 'link', name: '购买记录' }, 'https://shop.test/account', {
      label: '购买记录',
      role: 'link',
      tag: 'a',
    }).blocked,
    false
  );
});

test('明确支付/账号安全页面上的写操作一律交给用户；只读与导航仍允许', () => {
  assert.equal(isSensitivePage('https://site.test/checkout'), true);
  assert.equal(isSensitivePage('https://site.test/login'), true);
  assert.equal(isSensitivePage('https://site.test/account/security'), true);
  assert.equal(isSensitivePage('https://site.test/products'), false);
  assert.equal(classify('type_text', { selector: '#coupon', value: 'X' }, 'https://site.test/checkout').blocked, false);
  assert.equal(classify('click_element', { selector: '#submit' }, 'https://site.test/checkout').blocked, true);
  assert.equal(classify('scroll_page', { y: 300 }, 'https://site.test/checkout').blocked, false);
  assert.equal(classify('open_tab', { url: 'https://site.test/checkout' }, 'https://site.test/checkout').blocked, false);
});

test('代码执行和宏在敏感页面或代码出现敏感语义时必须阻止', () => {
  assert.equal(
    classify('run_javascript', { code: 'document.querySelector("#pay").click()' }, 'https://site.test/pay').blocked,
    true
  );
  assert.equal(
    classify('run_javascript', { code: 'document.querySelector("button").click()' }, 'https://shop.test/pay').blocked,
    true
  );
  assert.equal(
    classify('macro', { op: 'run', name: 'checkout' }, 'https://shop.test/pay').blocked,
    true
  );
});

test('普通搜索/填写/点击不被误拦截', () => {
  assert.equal(
    classify('type_text', { value: '咖啡' }, 'https://shop.test/search', {
      inputType: 'search',
      placeholder: '搜索商品',
    }).blocked,
    false
  );
  assert.equal(
    classify('click_element', { role: 'button', name: '搜索' }, 'https://shop.test/search', {
      label: '搜索',
      role: 'button',
    }).blocked,
    false
  );
});
