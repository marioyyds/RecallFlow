// 临时脚本：用一个「假扩展」连到隔离实例（7802），验证 page_screenshot 的**成功路径** ——
// 即图片真的以 MCP image 内容块返回，并且落盘归档。
// 这样无需重载用户的扩展、也无需重启用户的 7801 实例。
const BASE = 'http://127.0.0.1:7802';
const TOKEN = 'recallflow-local-bridge-v1';
const AUTH = { 'X-RecallFlow-Token': TOKEN };

// 1x1 的合法 JPEG（足够验证透传与归档；服务端不做图像校验）
const FAKE_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let stopped = false;
const handled = [];
let pollCount = 0;

// 假扩展：长轮询取请求并回结果
async function fakeExtensionLoop() {
  while (!stopped) {
    try {
      const res = await fetch(BASE + '/poll', { cache: 'no-store', headers: AUTH });
      const data = await res.json();
      const requests = (data && data.requests) || [];
      for (const req of requests) {
        handled.push(req.method);
        let result;
        if (req.method === 'screenshot_capture') {
          result = {
            ok: true,
            image: {
              data: FAKE_JPEG_B64,
              mimeType: 'image/jpeg',
              width: 1280,
              height: 720,
              bytes: Math.round((FAKE_JPEG_B64.length * 3) / 4),
              format: 'jpeg',
              quality: 72,
              degraded: false,
            },
          };
        } else {
          result = { ok: true, note: '假扩展未实现 ' + req.method };
        }
        await fetch(BASE + '/result', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...AUTH },
          body: JSON.stringify({ id: req.id, result }),
        });
      }
      pollCount++;
    } catch (e) {
      if (!stopped) await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// ---- MCP 客户端 ----
const MCP = BASE + '/mcp';
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: 'Bearer ' + TOKEN,
  'X-RecallFlow-Token': TOKEN,
};
let sessionId = null;
async function rpc(method, params, notify) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!notify) body.id = Math.floor(Math.random() * 1e9);
  const headers = { ...MCP_HEADERS };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(MCP, { method: 'POST', headers, body: JSON.stringify(body) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (!text) return {};
  if (ct.includes('text/event-stream')) {
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    return datas.length ? JSON.parse(datas[datas.length - 1]) : {};
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

const loop = fakeExtensionLoop();
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake-ext-test', version: '1' } });
await rpc('notifications/initialized', {}, true);
await new Promise((r) => setTimeout(r, 300)); // 让假扩展先挂上长轮询

console.log('=== 成功路径：includeImage 默认 true ===');
const r1 = await rpc('tools/call', { name: 'page_screenshot', arguments: { label: '协议成功路径' } });
const res1 = (r1.body && r1.body.result) || r1.result || {};
const c1 = res1.content || [];
console.log('  内容块数: ' + c1.length);
console.log('  块类型: ' + c1.map((c) => c.type).join(', '));
const img = c1.find((c) => c.type === 'image');
console.log('  图片块 mimeType=' + (img && img.mimeType) + '，data 长度=' + (img && img.data ? img.data.length : 0));
console.log('  data 与假扩展返回一致: ' + (img && img.data === FAKE_JPEG_B64 ? '是' : '否'));
console.log('  文本块: ' + JSON.stringify(String((c1[0] || {}).text || '').replace(/\n/g, ' | ').slice(0, 200)));

console.log('\n=== includeImage:false 只取元数据 ===');
const r2 = await rpc('tools/call', { name: 'page_screenshot', arguments: { label: '纯文本模型', includeImage: false } });
const c2 = ((r2.body && r2.body.result) || r2.result || {}).content || [];
console.log('  内容块数: ' + c2.length + '，类型: ' + c2.map((c) => c.type).join(', '));

stopped = true;
await new Promise((r) => setTimeout(r, 300));

console.log('\n=== 归档落盘 ===');
const fs = await import('node:fs');
const path = await import('node:path');
const dir = process.env.RECALLFLOW_EVIDENCE_DIR;
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jpg') || f.endsWith('.json')) : [];
console.log('  证据目录: ' + dir);
console.log('  文件: ' + (files.length ? files.join(', ') : '（无）'));
const jsons = files.filter((f) => f.endsWith('.json'));
for (const j of jsons.slice(0, 2)) {
  const rec = JSON.parse(fs.readFileSync(path.join(dir, j), 'utf8'));
  console.log('  ' + j + ' → kind=' + rec.kind + ' label=' + rec.label + ' bytes=' + rec.bytes + ' mime=' + rec.mimeType);
}
const jpgs = files.filter((f) => f.endsWith('.jpg'));
if (jpgs.length) {
  const bytes = fs.readFileSync(path.join(dir, jpgs[0]));
  console.log('  ' + jpgs[0] + ' 实际字节数=' + bytes.length + '，与假图一致: ' + (bytes.toString('base64') === FAKE_JPEG_B64 ? '是' : '否'));
}

console.log('\n--- 结论 ---');
const ok =
  c1.length === 2 &&
  c1[0].type === 'text' &&
  c1[1].type === 'image' &&
  img.mimeType === 'image/jpeg' &&
  img.data === FAKE_JPEG_B64 &&
  c2.length === 1 &&
  c2[0].type === 'text' &&
  jpgs.length >= 1;
console.log(ok ? '成功路径验证通过：image 内容块、includeImage 开关、归档落盘均正常' : '存在未通过项，见上');
process.exit(ok ? 0 : 1);
