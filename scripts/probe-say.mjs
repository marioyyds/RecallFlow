// 输入通道探针：把一句话经 POST /recallflow/say 送进 DSH 的这条会话。
// 写成文件而不是命令行，是为了彻底避开 shell 引号问题（那已经坑过我很多次）。
const text = process.argv[2] || '【自检】输入通道探针';
const base = process.argv[3] || 'http://127.0.0.1:3080';

const res = await fetch(base + '/recallflow/say', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text }),
});
console.log('  HTTP ' + res.status);
console.log('  ' + (await res.text()));
