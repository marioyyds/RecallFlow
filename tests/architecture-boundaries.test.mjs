import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDependencyGraph,
  findDependencyCycles,
  findLayerViolations,
} from '../scripts/check-architecture.mjs';

function graphFrom(files, importer) {
  return buildDependencyGraph(files, (file) => importer[file] || '');
}

test('递归依赖必须被识别为循环', () => {
  const graph = graphFrom(
    ['lib/shared/a.ts', 'lib/assistant/b.ts', 'lib/page/c.ts'],
    {
      'lib/shared/a.ts': "import { b } from '../assistant/b.ts';",
      'lib/assistant/b.ts': "import { c } from '../page/c.ts';",
      'lib/page/c.ts': "import { a } from '../shared/a.ts';",
    }
  );
  assert.deepEqual(findDependencyCycles(graph), [
    ['lib/assistant/b.ts', 'lib/page/c.ts', 'lib/shared/a.ts'],
  ]);
});

test('shared 不得反向依赖 Assistant 或 Page', () => {
  const graph = graphFrom(
    ['lib/shared/a.ts', 'lib/assistant/b.ts'],
    { 'lib/shared/a.ts': "import { b } from '../assistant/b.ts';" }
  );
  assert.deepEqual(findLayerViolations(graph), [
    {
      code: 'layer-direction',
      from: 'lib/shared/a.ts',
      to: 'lib/assistant/b.ts',
      fromLayer: 'shared',
      toLayer: 'application',
    },
  ]);
});

test('允许方向保持通过，lib 也不得反向引用 entries', () => {
  const graph = graphFrom(
    ['entries/popup.ts', 'lib/page/a.ts', 'lib/assistant/b.ts', 'lib/shared/c.ts'],
    {
      'entries/popup.ts': "import '../lib/page/a.ts';",
      'lib/page/a.ts': "import '../assistant/b.ts';",
      'lib/assistant/b.ts': "import '../shared/c.ts';",
    }
  );
  assert.deepEqual(findLayerViolations(graph), []);

  const reverse = graphFrom(
    ['entries/popup.ts', 'lib/page/a.ts'],
    { 'lib/page/a.ts': "import '../../entries/popup.ts';" }
  );
  assert.equal(findLayerViolations(reverse)[0].code, 'entry-reverse-import');
});
