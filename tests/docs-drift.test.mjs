// 文档漂移门禁：核对几件**具体的、可证伪的**事。
//
// 起因是一个真实事故：`docs/recallflow-dsh-keypoints.md` 声称「7801 桥接链路整体删除、
// integrations/opencode/ 整包移除」，而 `background.js` 至今仍在 `startMcpRelay()`、
// 目录与 850+ 行 server 也都在。一份文档就这样与工作树相反，而**没有任何一层能发现**：
// 静态门禁只看代码，测试只测行为，没有东西核对"文档里的断言是否仍然成立"。
//
// 这里只钉几件最容易腐烂、且影响读者判断的事，不做全文校验（那会变成负担）：
//   1. 关键文件的存在性 —— 文档说"已删除"的东西，代码里到底还在不在；
//   2. 不能出现**无更正的**"已删除"断言；
//   3. 集成方向的唯一事实来源文档必须存在（否则读者又会回到三份互相矛盾的说法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const exists = (rel) => existsSync(new URL(rel, ROOT));

test('集成事实文档存在（它是"该信哪一份"的唯一答案）', () => {
  assert.ok(exists('docs/integration-status.md'), '缺少 docs/integration-status.md');
  const doc = read('docs/integration-status.md');
  // 必须明确点名当前可用路径，否则读者仍无法判断。
  assert.match(doc, /relay\.js/, '应点名扩展侧桥接实现');
  assert.match(doc, /recallflow-mcp\/index\.js/, '应点名 MCP server 实现');
});

test('声称"桥接链路已删除"的文档必须带有更正说明', () => {
  // 这些文档确实描述过一次删除；它们是历史记录，但必须让读者一眼看到它与工作树不符。
  for (const rel of ['docs/recallflow-dsh-keypoints.md', 'docs/recallflow-project-analysis.md']) {
    const doc = read(rel);
    assert.match(doc, /状态更正|与工作树不符|本地.*还在/, rel + ' 描述了"删除"但缺少更正说明');
  }
  // 更正必须点出代码仍在，而不是含糊其辞。
  const keypoints = read('docs/recallflow-dsh-keypoints.md');
  assert.match(keypoints, /relay\.js/, '更正块应指出 relay.js 仍存在');
  // 并且必须把读者指向唯一事实来源，否则他又要自己判断该信哪一份。
  assert.match(read('docs/recallflow-project-analysis.md'), /integration-status\.md/, '应指向唯一事实来源');
});

test('文档说"已删除"的文件，代码里必须真的不在（否则就是漂移）', () => {
  // 反向核对：这两个文件曾被文档声称删除。若它们仍在，则**不允许**出现无更正的删除断言。
  const relayExists = exists('lib/bridge/relay.js');
  const mcpExists = exists('integrations/opencode/recallflow-mcp/index.js');
  assert.ok(relayExists, 'lib/bridge/relay.js 应存在（若真被删除，请同步更新集成事实文档）');
  assert.ok(mcpExists, 'recallflow-mcp/index.js 应存在（若真被删除，请同步更新集成事实文档）');

  // 既然两者都在，任何"整包/整体删除"的断言都必须伴随更正措辞。
  for (const rel of ['docs/recallflow-dsh-keypoints.md']) {
    const text = read(rel);
    const claimsDeletion = /整体删除|整包/.test(text);
    if (claimsDeletion) {
      assert.match(text, /状态更正/, rel + ' 声称删除但缺少更正块（代码里它们仍在）');
    }
  }
});

test('background.js 仍挂载桥接时，文档不得说该链路已移除', () => {
  const bg = read('background.js');
  const mountsRelay = /startMcpRelay\s*\(/.test(bg);
  assert.ok(mountsRelay, 'background.js 应仍在启动桥接（若已移除，请同步更新文档与 relay.js）');
  const status = read('docs/integration-status.md');
  assert.match(status, /startMcpRelay/, '集成事实文档应说明扩展启动时会挂载桥接');
});
