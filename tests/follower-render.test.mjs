import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sourcePath } from './source-path.mjs';

const chat = fs.readFileSync('lib/ui/page/chat.ts', 'utf8');
const hub = fs.readFileSync(sourcePath('lib/application/agent/run-hub.js'), 'utf8');

function bodyOf(src, marker, length = 1800) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, '找不到 ' + marker);
  return src.slice(at, at + length);
}

test('跟随页的每个 delta 不再整轮重绘：只调度 renderFollowedLive', () => {
  const body = bodyOf(chat, 'function renderFollowedRun()', 700);
  assert.match(body, /renderFollowedLive\(\)/, '应走增量 live 渲染');
  assert.doesNotMatch(body, /renderConversation\(\)/, '不得在每个 delta 重建整段对话');
});

test('跟随页的 live 消息有独立节点，历史对话只建一次', () => {
  const body = bodyOf(chat, 'function renderFollowedLive()', 2200);
  assert.match(chat, /follow-live-ai/, '应标记/替换 live assistant 节点');
  assert.match(body, /if \(!followedRun\.followedLiveReady\)/, '历史对话应只构建一次');
});

test('handleRunDelta 不在帧外重建 followedMessages', () => {
  const body = bodyOf(chat, 'function handleRunDelta(', 1100);
  assert.doesNotMatch(body, /rebuildFollowedMessages\(\)/, '数组重建应移出高频 delta 路径');
});

test('当前 narration 标记为 live，避免被当作已定稿而命中缓存', () => {
  assert.match(
    hub,
    /state\.narration\) parts\.push\(\{ type: 'narration', text: state\.narration, live: true \}\)/,
    '当前正文必须标记 live'
  );
});
