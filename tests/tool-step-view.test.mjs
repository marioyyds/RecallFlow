import test from 'node:test';
import assert from 'node:assert/strict';

import {
  laneBadgeHtml,
  toolStepHtml,
} from '../lib/ui/panel/tool-step-view.ts';

test('工具步骤视图为快思考和慢思考渲染可区分的标签与颜色类', () => {
  assert.match(laneBadgeHtml('fast'), /agent-lane lane-fast/);
  assert.match(laneBadgeHtml('fast'), /⚡ 快思考/);
  assert.match(laneBadgeHtml('slow'), /agent-lane lane-slow/);
  assert.match(laneBadgeHtml('slow'), /🧠 慢思考/);
  assert.equal(laneBadgeHtml('unknown'), '');

  assert.match(
    toolStepHtml('🔧 ', 'read_table', '参数', '参数', '{}', 'fast'),
    /class="agent-step lane-fast"/
  );
  assert.match(
    toolStepHtml('✓ 工具已完成：', 'inspect_element', '', '返回结果', '元素', 'slow'),
    /class="agent-step lane-slow"/
  );
});
