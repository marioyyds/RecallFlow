#!/usr/bin/env node
// 宿主自检：**完全按 Chrome 的方式**启动 native host（管道 + 长度前缀帧），
// 走一遍 ping → status → ensure → stop，并核对 MCP server 真的起来/停掉了。
//
// 为什么要有它：native messaging 的失败模式几乎都是"静默"的——
//   · 帧格式写错：浏览器直接断开，不报错；
//   · manifest 的 allowed_origins 不匹配：onDisconnect 里只有一句 forbidden；
//   · 宿主进程起不来（path 不是可执行文件）：扩展只看到 "Native host has exited."
// 所以必须在**不依赖浏览器**的前提下先把协议和守护逻辑验证到位，
// 否则每次排查都要"重载扩展 + 开页面"来回猜。
//
// 用法：
//   node scripts/verify-native-host.mjs                      # 用已装好的 exe + host.config.json 的端口
//   node scripts/verify-native-host.mjs --exe <path.exe>
//   node scripts/verify-native-host.mjs --host <host.js>      # 跳过 exe，直接 node host.js
//   node scripts/verify-native-host.mjs --port 7811           # 在隔离端口上验证（会真的起一个 server 再停掉）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_JS = path.join(ROOT, 'integrations', 'native-host', 'host.js');
const DEFAULT_EXE = path.join(ROOT, 'integrations', 'native-host', 'bin', 'recallflow-native-host.exe');
const CONFIG = path.join(ROOT, 'integrations', 'native-host', 'host.config.json');

function parseArgs(argv) {
  const out = { exe: '', host: '', port: 0, timeoutMs: 40000 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(a + ' 缺少取值');
      return argv[i];
    };
    if (a === '--exe') out.exe = val();
    else if (a === '--host') out.host = val();
    else if (a === '--port') out.port = Number(val());
    else if (a === '--timeout') out.timeoutMs = Number(val());
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数：' + a);
  }
  return out;
}

function configPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (Number(cfg.port) > 0) return Number(cfg.port);
  } catch (e) {}
  return 7801;
}

async function health(port, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: ctrl.signal });
    return r.ok ? await r.json() : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('用法：node scripts/verify-native-host.mjs [--exe <exe>] [--host <host.js>] [--port N]\n');
    return 0;
  }
  const port = args.port || configPort();

  let cmd;
  let cmdArgs;
  let how;
  if (args.host) {
    cmd = process.execPath;
    cmdArgs = [path.resolve(args.host)];
    how = 'node ' + path.basename(args.host);
  } else {
    const exe = path.resolve(args.exe || DEFAULT_EXE);
    if (!fs.existsSync(exe)) {
      process.stderr.write('✖ 找不到宿主可执行文件：' + exe + '\n  先跑：node scripts/install-native-host.mjs\n');
      return 2;
    }
    cmd = exe;
    cmdArgs = ['chrome-extension://selfcheck/'];
    how = exe;
  }

  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    process.stdout.write((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  ' + detail : '') + '\n');
  };

  process.stdout.write('宿主自检：' + how + '（端口 ' + port + '）\n');
  const child = spawn(cmd, cmdArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { RECALLFLOW_MCP_PORT: String(port) }),
  });
  let exited = null;
  child.on('exit', (code) => {
    exited = code === null ? -1 : code;
  });
  let stderrBuf = '';
  child.stderr.on('data', (c) => {
    stderrBuf += c.toString('utf8');
  });

  // ---- 帧解码（与被测宿主同一套协议，独立实现以便互相印证）----
  const inbox = [];
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      try {
        inbox.push(JSON.parse(body.toString('utf8')));
      } catch (e) {
        inbox.push({ type: '__bad_json__', raw: body.toString('utf8').slice(0, 120) });
      }
    }
  });

  const send = (obj) => {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(json.length, 0);
    child.stdin.write(Buffer.concat([head, json]));
  };
  // fromIndex 默认从"当前已收到的条数"往后找：否则第二次 ensure 的断言会命中启动时那条自动上报的
  // 回复（两者都是 action=ensure），断言看起来通过、实际测的不是同一个东西。
  const waitFor = async (pred, timeoutMs, fromIndex) => {
    const start = Number.isInteger(fromIndex) ? fromIndex : inbox.length;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = inbox.slice(start).find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) return null;
      await sleep(120);
    }
  };

  try {
    // 1) 启动即应自动 ensure 并回一条 status（用户零操作的关键行为）
    const first = await waitFor((m) => m.type === 'status', 25000, 0);
    record('启动后自动上报状态（无需指令）', Boolean(first), first ? first.message || '' : '超时未收到 status');
    // "宿主是否拥有 server"由**启动时那条**回复决定：它才是本次真正执行的 ensure。
    const ownedByHost = Boolean(first && first.started === true);

    // 2) ping/pong
    let mark = inbox.length;
    send({ type: 'ping' });
    const pong = await waitFor((m) => m.type === 'pong', 5000, mark);
    record('ping → pong', Boolean(pong));

    // 3) status 里端口/进程信息齐全
    mark = inbox.length;
    send({ type: 'status' });
    const st = await waitFor((m) => m.type === 'status' && m.action === 'status', 8000, mark);
    record(
      'status 含端口与宿主 pid',
      Boolean(st && st.status && st.status.port === port && st.status.hostPid > 0),
      st && st.status ? 'port=' + st.status.port + ' hostPid=' + st.status.hostPid + ' serverRunning=' + st.status.serverRunning : ''
    );

    // 4) ensure：没在跑就该真起来，起来了 /health 必须能读到
    const already = await health(port);
    mark = inbox.length;
    send({ type: 'ensure' });
    const ens = await waitFor((m) => m.type === 'status' && m.action === 'ensure', 30000, mark);
    const after = await health(port);
    record(
      'ensure 之后 127.0.0.1:' + port + ' 可探活',
      Boolean(after && after.ok === true),
      (already ? '（此前已在运行）' : '（此前没在运行）') + ' → ' + (ens ? ens.message : '超时无回复')
    );

    // 5) 心跳：证明扩展 SW 能被续命（20s 一次，这里等到第一条即可）
    mark = inbox.length;
    const beat = await waitFor((m) => m.type === 'heartbeat', 25000, mark);
    record('定期心跳（MV3 service worker 续命用）', Boolean(beat));

    // 6) 只有"自己启动的"才允许 stop；复用时必须明确拒绝，避免误杀
    mark = inbox.length;
    send({ type: 'stop' });
    const stopped = await waitFor((m) => m.type === 'status' && m.action === 'stop', 20000, mark);
    if (ownedByHost) {
      const gone = await (async () => {
        for (let i = 0; i < 20; i += 1) {
          if (!(await health(port))) return true;
          await sleep(300);
        }
        return false;
      })();
      record('stop 停掉自己启动的 server（端口应释放）', gone, stopped ? stopped.message : '');
    } else {
      record('stop 对非自启实例明确拒绝（避免误杀）', Boolean(stopped && stopped.stopped === false), stopped ? stopped.message : '');
    }

    // 7) stdin 关闭 = 浏览器退出/扩展重载：宿主必须自己退出（不留孤儿进程）
    child.stdin.end();
    const exitedOk = await (async () => {
      for (let i = 0; i < 30; i += 1) {
        if (exited !== null) return exited;
        await sleep(200);
      }
      return null;
    })();
    record('stdin 关闭后宿主自行退出', exitedOk === 0, exitedOk === null ? '超时未退出（可能有孤儿进程）' : 'exitCode=' + exitedOk);
  } finally {
    if (exited === null) {
      try {
        child.kill();
      } catch (e) {}
    }
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write('\n' + (failed.length ? '✖ ' + failed.length + ' 项未通过' : '✔ 全部通过') + '\n');
  if (failed.length && stderrBuf.trim()) {
    process.stdout.write('\n宿主 stderr：\n' + stderrBuf.trim().slice(0, 2000) + '\n');
  }
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write('自检异常：' + String((e && e.stack) || e) + '\n');
    process.exit(1);
  });
