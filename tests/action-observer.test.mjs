import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BrowserActionObserver,
  buildCorrectionInstruction,
  isTargetSiteRequest,
} from '../integrations/webarena/action-observer.mjs';

function observer() {
  return new BrowserActionObserver(
    { on() {}, off() {} },
    { sites: ['shopping', 'shopping_admin', 'reddit'] }
  );
}

test('动作观察：只统计目标站点请求', () => {
  assert.equal(isTargetSiteRequest('http://localhost:7770/product.html', ['shopping']), true);
  assert.equal(isTargetSiteRequest('http://localhost:7780/admin/catalog/product/save', ['shopping_admin']), true);
  assert.equal(isTargetSiteRequest('https://api.typesafe.ai/v1/systemone', ['shopping']), false);
});

test('动作观察：mutation 没有写请求时要求补执行', () => {
  const o = observer();
  o.requests = [{ method: 'GET', url: 'http://localhost:7770/cart', status: 200, navigation: true, resourceType: 'document' }];
  const result = o.inspect('mutate', 'Disable a product');
  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /状态变更请求/);
  o.requests.push({ method: 'POST', url: 'http://localhost:7770/checkout/save', status: 302, navigation: false, resourceType: 'fetch' });
  assert.equal(o.inspect('mutate', 'Change the cart').ok, true);
});

test('动作观察：排序导航缺少排序参数时要求补执行', () => {
  const o = observer();
  o.requests = [{
    method: 'GET',
    url: 'http://localhost:7770/clothing/shoes.html',
    status: 200,
    navigation: true,
    resourceType: 'document',
  }];
  o.lastNavigationUrl = 'http://localhost:7770/clothing/shoes.html';
  const result = o.inspect('navigate', 'Go to shoes sorted by ascending price');
  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /排序条件/);
});

test('补执行指令只描述通用后置条件，不泄露 evaluator 请求契约', () => {
  const text = buildCorrectionInstruction('Original task', { issues: ['没有观察到目标站点的状态变更请求'] });
  assert.match(text, /Original task/);
  assert.match(text, /状态变更请求/);
  assert.doesNotMatch(text, /systemone|expected.*url|post_data/i);
});
