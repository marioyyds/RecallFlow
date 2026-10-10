// 桥接 WebSocket 鉴权的端到端验证（真实 server 进程 + 真实 WS 客户端）。
//
// 为什么需要这个脚本：桥接层「真实调用需要重载扩展 + 重启 server」，两者都会打断
// 正在使用的 MCP 会话，因此这一段既没有单测覆盖，也无法靠读代码确认 —— 必须真的连一次。
//
// 覆盖：
//   1. 正确 token → 注册为扩展（/health 报 ws:true）
//   2. 错误 token → 被拒绝关闭（/health 报 ws:false）
//   3. 不带 token → 被拒绝关闭
//
// 传输约定：WS 鉴权走 **URL 查询串**（浏览器 WebSocket API 无法设置请求头，
// 这是唯一可行的位置）；HTTP 通道走请求头，**不接受** ?token=。
import { spawn } from 'node:child_process';
// `ws` 只安装在被测包自己的 node_modules 里（根目录没有依赖），且是 CommonJS。
import wsPkg from '../integrations/opencode/recallflow-mcp/node_modules/ws/index.js';
const { WebSocket } = wsPkg;

const PORT = Number(process.env.VERIFY_WS_PORT || 7822);
const TOKEN = 'ws-verify-token-0123456789';
const BASE = 'http://127.0.0.1:' + PORT;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function health() {
  const r = await fetch(BASE + '/health', { cache: 'no-store' });
  return r.json();
}

async function waitServer(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await health();
      return true;
    } catch (e) {
      await sleep(150);
    }
  }
  return false;
}

// 用给定 token 连一次 WS，返回是否保持打开。token 为空则不拼查询串。
//
// 实现要点（踩过的坑）：**不能在超时回调里先 close 再让调用方读 /health**。
// close 会让服务端的 close handler 立刻把 extSocket 置空，于是「连接是好的」
// 却读到 ws:false —— 这是测量竞态，不是产品缺陷。
// 因此这里显式分成两段：先连上（accepted），持有 holdMs，再由调用方读 health，
// 最后才由 finally 关闭。
function openWs(token, holdMs = 400) {
  return new Promise((resolve) => {
    const url = 'ws://127.0.0.1:' + PORT + '/' + (token ? '?token=' + encodeURIComponent(token) : '');
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(Object.assign({ ws }, result));
    };
    const rejectTimer = setTimeout(() => {
      // 到点仍未被关闭 = 服务端接受了这条连接。再持有一小会儿，
      // 让调用方能在 socket 仍打开时读 /health。
      setTimeout(() => finish({ accepted: true }), holdMs);
    }, 700);
    ws.on('close', (code) => {
      clearTimeout(rejectTimer);
      finish({ accepted: false, closeCode: code });
    });
    ws.on('error', () => {});
  });
}

function closeWs(handle) {
  try { handle.ws.close(); } catch (e) {}
}

const proc = spawn(process.execPath, ['integrations/opencode/recallflow-mcp/index.js'], {
  env: Object.assign({}, process.env, {
    RECALLFLOW_MCP_PORT: String(PORT),
    RECALLFLOW_BRIDGE_TOKEN: TOKEN,
    RECALLFLOW_EVIDENCE_DIR: process.env.TEMP ? process.env.TEMP + '\\rf-ws-verify' : undefined,
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
proc.stderr.on('data', (d) => { serverLog += d.toString(); });

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
};

try {
  if (!(await waitServer())) throw new Error('server 未在预期时间内就绪');
  check('初始状态：无扩展连接', (await health()).ws === false);

  // 1) 错误 token → 应被关闭，且不注册为扩展
  const bad = await openWs('wrong-token');
  check('错误 token：连接被拒绝关闭', bad.accepted === false, 'code=' + bad.closeCode);
  await sleep(150);
  check('错误 token：未注册为扩展', (await health()).ws === false);

  // 2) 不带 token → 应被关闭
  const none = await openWs('');
  check('不带 token：连接被拒绝关闭', none.accepted === false);
  await sleep(150);
  check('不带 token：未注册为扩展', (await health()).ws === false);

  // 3) 正确 token → 保持打开并注册（在 socket 仍打开时读 health）
  const good = await openWs(TOKEN);
  check('正确 token：连接未被拒绝', good.accepted === true);
  const hGood = await health();
  check('正确 token：已注册为扩展（ws:true）', hGood.ws === true, JSON.stringify(hGood));
  closeWs(good);
} catch (e) {
  console.log('  ✘ 运行异常：' + (e && e.message));
  failures++;
} finally {
  try { proc.kill(); } catch (e) {}
}

console.log(failures ? '\n失败 ' + failures + ' 项' : '\n全部通过');
if (failures) console.log('--- server stderr ---\n' + serverLog);
process.exit(failures ? 1 : 0);
