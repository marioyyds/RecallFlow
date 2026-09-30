// 观察插件经 WS 推的会话事件（新通道的第一手数据）。
// 用法：node scripts/watch-session-events.mjs [秒数]
// 说明：事件只在会话有活动时产生，因此运行期间在这条会话里说一句话就能看到帧。
const seconds = Number(process.argv[2] || 20);
const url = 'ws://127.0.0.1:3080/recallflow/ws';

const frames = [];
const kinds = new Map();

const ws = new WebSocket(url);
const done = () => {
  console.log('\n=== 汇总 ===');
  console.log('  收到帧 ' + frames.length + ' 条');
  for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('    ' + k + ' × ' + n);
  }
  const sample = frames.find((f) => f.kind === 'session-event' && f.event && f.event.text);
  if (sample) {
    console.log('\n=== 一条带文本的会话事件样本 ===');
    console.log('  ' + JSON.stringify(sample).slice(0, 300));
  } else {
    console.log('\n  （这段时间内没有带文本的会话事件 —— 期间会话没活动）');
  }
  try {
    ws.close();
  } catch {}
  // process.exitCode 而不是 process.exit()：Node 的 WebSocket 也是 undici 实现，
  // 同样可能在收尾时撞上 Windows 上的 libuv 断言（0xC0000409）。
  // 关掉 socket 之后事件循环会自然结束。
  process.exitCode = 0;
};

ws.addEventListener('open', () => console.log('已连上 ' + url + '，观察 ' + seconds + ' 秒…'));
ws.addEventListener('message', (ev) => {
  let m = null;
  try {
    m = JSON.parse(String(ev.data));
  } catch {}
  if (!m) return;
  frames.push(m);
  const key = m.kind + (m.event && m.event.type ? ' / ' + m.event.type : '');
  kinds.set(key, (kinds.get(key) || 0) + 1);
  console.log('  ← ' + key + (m.event && m.event.text ? '  ' + JSON.stringify(m.event.text).slice(0, 70) : ''));
});
ws.addEventListener('error', (e) => {
  console.log('WS 错误：' + ((e && e.message) || 'unknown'));
  process.exitCode = 1; // 同上的原因：不用 process.exit()
});
setTimeout(done, seconds * 1000);
