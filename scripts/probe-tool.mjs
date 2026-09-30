// 工具往返探针：经插件的 POST /recallflow/probe-tool 走一次完整的
// DSH 插件 → WS → 扩展 → 页面 → 回执 链路。
// 为什么用脚本而不是 curl：Windows 上把 JSON 交给 curl 会被 shell 重引用（这个坑踩过多次）。
// 用法：node scripts/probe-tool.mjs [method] [port]
const method = process.argv[2] || 'page_health';
const port = process.argv[3] || '3080';

const res = await fetch('http://127.0.0.1:' + port + '/recallflow/probe-tool', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ method, params: {} }),
});
console.log('  HTTP ' + res.status);
const body = await res.json().catch(async () => ({ raw: await res.text().catch(() => '') }));
if (body && body.ok) {
  console.log('  ✓ 往返成功，方法=' + body.method);
  const v = body.value;
  console.log('  返回数据摘要：' + JSON.stringify(v).slice(0, 260));
} else {
  console.log('  ✗ ' + JSON.stringify(body).slice(0, 260));
}
process.exit(body && body.ok ? 0 : 1);
