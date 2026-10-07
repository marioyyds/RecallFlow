// 「7801 桥接已删除」的**反向钉住**：不许在代码里复活。
//
// 背景：用户 2026-10-08 明确说不再用 opencode，于是桥接那条链路（扩展侧的常量/连接/长轮询、
// 以及 `integrations/opencode/` 整包）都删掉了。删完之后最容易出的问题不是"没删干净"，
// 而是**日后有人照着旧文档又把某一段加回来** —— 所以这里把判据写成测试。
//
// 判据用的是**可执行形态**，而不是"出现过 7801 这几个字"：
//   - 文档、注释、测试里的历史叙述**应该**存在（否则后人不知道曾经有什么、为什么删）；
//     本文件自己就大量提到它们。
//   - 真正要禁止的是"这些东西还能被调用/连接" —— 地址、常量名、函数名、MCP 调用。
// 所以先把注释剥掉，再找那些形态。这样既不会误报散文，也不会漏掉真的复活。
//
// 这条测试的价值在提交 `aa55f5a` 之后才成立：在那之前它是红的（那时桥接还在）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 被跟踪的代码文件（不含文档与测试 —— 它们天然要提到历史）。 */
function codeFiles() {
  return execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => /\.(js|mjs)$/.test(f) && !/^tests\//.test(f) && !/^docs\//.test(f));
}

/** 去掉行注释与块注释 —— 只看"会被执行"的那部分。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const LIVE_PATTERNS = [
  [/127\.0\.0\.1:7801/, '连 7801 桥接的地址'],
  [/RELAY_(HOST|TOKEN|HTTP|WS|AUTH_HEADERS)/, '桥接常量（RELAY_*）'],
  [/\b(connectWs|httpLoop|handleWsMessage|scheduleReconnect|startMcpRelay)\b/, '桥接函数'],
  [/callExtension\(/, 'MCP 的 callExtension 调用'],
  [/integrations\/opencode/, '桥接包路径'],
];

test('代码里不得复活 7801 桥接（剥掉注释后按可执行形态判定）', () => {
  const files = codeFiles();
  assert.ok(files.length > 50, '扫描到的代码文件太少（' + files.length + '），git ls-files 可能没生效');

  const hits = [];
  for (const rel of files) {
    let src;
    try {
      src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    const stripped = stripComments(src);
    for (const [re, what] of LIVE_PATTERNS) {
      const m = stripped.match(re);
      if (m) hits.push(rel + ' 里还有「' + what + '」：' + m[0]);
    }
  }
  assert.deepEqual(
    hits,
    [],
    '桥接已随 opencode 一起删除（用户 2026-10-08），代码里不该再有可执行形态的引用：\n      ' + hits.join('\n      ')
  );
});

test('桥接那侧的产物与服务都不在了', () => {
  for (const rel of [
    'integrations/opencode/recallflow-mcp/index.js',
    'integrations/opencode/mcp-contract.md',
    'scripts/verify-mcp-shot.mjs',
    'scripts/verify-mcp-shot-success.mjs',
  ]) {
    assert.ok(!fs.existsSync(path.join(ROOT, rel)), rel + ' 应已删除');
  }
  // 但 DSH 那条通道的入口必须在（删东西最容易连坐）
  const relay = fs.readFileSync(path.join(ROOT, 'lib/bridge/relay.js'), 'utf8');
  assert.match(relay, /export function startRecallFlowRelay\(\)/, 'DSH 通道的启动函数必须在');
  assert.match(relay, /export async function sayToDsh\(/, 'sayToDsh 必须在');
});
