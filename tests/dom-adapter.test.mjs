import test from 'node:test';
import assert from 'node:assert/strict';

import { BrowserDocumentAdapter } from '../lib/adapters/dom/document.ts';

test('BrowserDocumentAdapter：创建、挂载、查询和焦点状态都通过注入的 document', () => {
  const calls = [];
  const appended = [];
  const documentApi = {
    activeElement: { id: 'active' },
    visibilityState: 'visible',
    createElement(tag) {
      calls.push(['create', tag]);
      return { tag };
    },
    getElementById(id) {
      calls.push(['get', id]);
      return { id };
    },
    querySelector(selector) {
      calls.push(['query', selector]);
      return { selector };
    },
  };
  const adapter = new BrowserDocumentAdapter(documentApi);
  const parent = { appendChild: (child) => appended.push(child) };
  const child = adapter.createElement('button');
  adapter.append(parent, child);

  assert.deepEqual(child, { tag: 'button' });
  assert.deepEqual(appended, [child]);
  assert.deepEqual(adapter.getElementById('root'), { id: 'root' });
  assert.deepEqual(adapter.querySelector('.x'), { selector: '.x' });
  assert.deepEqual(adapter.getActiveElement(), { id: 'active' });
  assert.equal(adapter.getVisibilityState(), 'visible');
});
