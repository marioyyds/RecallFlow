// native host（integrations/native-host/host.js）：native messaging 帧协议 + 守护 MCP server 的状态机。
//
// 为什么这些断言必须有：
//   · 帧格式写错时浏览器**静默断开**，不给任何错误 —— 只能靠协议层的往返断言兜住；
//   · 守护逻辑写错时用户看到的是"点了没反应"或"服务被误杀"，也必须脱开浏览器先钉死。
// 因此这里所有外部依赖（spawn / health / kill / 时钟）全部注入，测试不碰真实进程与端口。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeMessage, createDecoder, loadConfig, createHost, findRunningServer, createWatchdog } from '../integrations/native-host/host.js';

const THIS_FILE = fileURLToPath(import.meta.url);

function tmpConfig(obj) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rf-host-cfg-')), 'host.config.json');
  fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
  return p;
}

// ---------------- 帧协议 ----------------

test('encodeMessage: 4 字节小端长度 + UTF-8 JSON（Chrome 规定的格式）', () => {
  const frame = encodeMessage({ type: 'ping', n: 1 });
  assert.ok(Buffer.isBuffer(frame));
  const len = frame.readUInt32LE(0);
  assert.equal(len, frame.length - 4, '长度前缀必须正好等于正文长度');
  assert.deepEqual(JSON.parse(frame.subarray(4).toString('utf8')), { type: 'ping', n: 1 });
});

test('createDecoder: 一次收到半条帧也能正确拼出（stdin 不保证按消息切分）', () => {
  const got = [];
  const d = createDecoder({ onMessage: (m) => got.push(m) });
  const frame = encodeMessage({ type: 'status', ok: true });
  d.push(frame.subarray(0, 3));
  assert.equal(got.length, 0, '不足 4 字节时不能产出消息');
  d.push(frame.subarray(3, 9));
  assert.equal(got.length, 0, '正文不完整时不能产出消息');
  d.push(frame.subarray(9));
  assert.deepEqual(got, [{ type: 'status', ok: true }]);
});

test('createDecoder: 一次收到多条帧要全部产出（粘包）', () => {
  const got = [];
  const d = createDecoder({ onMessage: (m) => got.push(m) });
  d.push(Buffer.concat([encodeMessage({ i: 1 }), encodeMessage({ i: 2 }), encodeMessage({ i: 3 })]));
  assert.deepEqual(got, [{ i: 1 }, { i: 2 }, { i: 3 }]);
});

test('createDecoder: 超大帧报错且不产出（防止 OOM），坏 JSON 报错但不中断后续帧', () => {
  const errors = [];
  const got = [];
  const d = createDecoder({ maxBytes: 16, onMessage: (m) => got.push(m), onError: (e) => errors.push(e.message) });
  d.push(encodeMessage({ big: 'x'.repeat(64) }));
  assert.equal(got.length, 0);
  assert.match(errors.join('|'), /帧过大/);

  const bad = Buffer.alloc(4 + 3);
  bad.writeUInt32LE(3, 0);
  bad.write('{o}', 4, 'utf8');
  const d2 = createDecoder({ onMessage: (m) => got.push(m), onError: (e) => errors.push(e.message) });
  d2.push(Buffer.concat([bad, encodeMessage({ after: true })]));
  assert.match(errors.join('|'), /不是合法 JSON/);
  assert.deepEqual(got, [{ after: true }], '坏帧之后的消息仍应被解析');
});

test('createDecoder: 长度为 0 的帧按协议错误处理（不静默跳过）', () => {
  const errors = [];
  const zero = Buffer.alloc(4);
  zero.writeUInt32LE(0, 0);
  const d = createDecoder({ onMessage: () => {}, onError: (e) => errors.push(e.message) });
  d.push(zero);
  assert.match(errors.join('|'), /长度为 0/);
});

// ---------------- 配置 ----------------

test('loadConfig: 缺文件时回退默认（端口 7801），相对 mcpEntry 相对宿主目录解析', () => {
  const cfg = loadConfig(path.join(os.tmpdir(), 'rf-does-not-exist-' + Date.now() + '.json'));
  assert.equal(cfg.port, 7801);
  assert.equal(cfg.stopServerOnExit, false);
  assert.ok(path.isAbsolute(cfg.mcpEntry));
  assert.match(cfg.mcpEntry, /recallflow-mcp[\\/]index\.js$/);
});

test('loadConfig: 配置文件 + RECALLFLOW_MCP_PORT 环境变量（后者优先，便于隔离测试）', () => {
  const file = tmpConfig({ port: 7900, stopServerOnExit: true, heartbeatMs: 1234 });
  const cfg = loadConfig(file);
  assert.equal(cfg.port, 7900);
  assert.equal(cfg.stopServerOnExit, true);
  assert.equal(cfg.heartbeatMs, 1234);

  const prev = process.env.RECALLFLOW_MCP_PORT;
  process.env.RECALLFLOW_MCP_PORT = '7911';
  try {
    assert.equal(loadConfig(file).port, 7911, '环境变量应覆盖配置文件');
  } finally {
    if (prev === undefined) delete process.env.RECALLFLOW_MCP_PORT;
    else process.env.RECALLFLOW_MCP_PORT = prev;
  }
});

// ---------------- 守护状态机 ----------------

function makeHost(overrides = {}, deps = {}) {
  const cfg = Object.assign(
    {
      port: 7777,
      mcpEntry: THIS_FILE, // 只要"存在"即可，真正 spawn 被注入替换
      nodePath: process.execPath,
      heartbeatMs: 20000,
      startTimeoutMs: 1000,
      stopServerOnExit: false,
    },
    overrides
  );
  return createHost(
    cfg,
    Object.assign(
      {
        logger: () => {},
        sleep: async () => {},
        killPid: () => {},
        // 单测绝不能碰真实的 owned-server.json（跑一次就会污染本机状态，也会让线上判定失真）。
        ownedStore: { read: () => null, write: () => {}, clear: () => {} },
      },
      deps
    )
  );
}

test('ensure: 服务已在运行时复用，**不**重复启动', async () => {
  let spawned = 0;
  const host = makeHost(
    {},
    {
      healthCheck: async () => ({ ok: true, ws: true }),
      spawnServer: () => {
        spawned += 1;
        return { pid: 1 };
      },
    }
  );
  const r = await host.handle({ type: 'ensure' });
  assert.equal(r.started, false);
  assert.equal(spawned, 0, '已有实例时不该再 spawn 一个（会 EADDRINUSE）');
  assert.equal(r.status.reused, true);
  assert.equal(r.status.serverRunning, true);
});

test('ensure: 没在运行时真的启动，并等到健康检查通过才报成功', async () => {
  let up = false;
  const spawned = [];
  const host = makeHost(
    {},
    {
      healthCheck: async () => (up ? { ok: true } : null),
      spawnServer: () => {
        spawned.push(1);
        up = true;
        return { pid: 4242 };
      },
    }
  );
  const r = await host.handle({ type: 'ensure' });
  assert.equal(spawned.length, 1);
  assert.equal(r.started, true);
  assert.equal(r.status.serverPid, 4242);
  assert.equal(r.status.serverOwned, true);
  assert.equal(r.status.reused, false);
});

test('ensure: 启动后一直不健康 → 超时并给出可操作的错误（不假装成功）', async () => {
  let t = 0;
  const host = makeHost(
    { startTimeoutMs: 1000 },
    {
      healthCheck: async () => null,
      spawnServer: () => ({ pid: 9 }),
      now: () => t,
      sleep: async () => {
        t += 500;
      },
    }
  );
  const r = await host.handle({ type: 'ensure' });
  assert.equal(r.started, false);
  assert.match(r.message, /启动超时/);
  assert.match(r.message, /mcp-server\.log/);
});

test('ensure: 入口文件不存在时明确报错，而不是留一个空转的等待', async () => {
  const host = makeHost({ mcpEntry: path.join(os.tmpdir(), 'rf-nope-' + Date.now(), 'index.js') }, { healthCheck: async () => null });
  const r = await host.handle({ type: 'ensure' });
  assert.equal(r.started, false);
  assert.match(r.message, /找不到 MCP server 入口/);
});

test('stop: 只停"自己启动"的实例；别人启动的必须拒绝（防误杀用户手动起的服务）', async () => {
  // 自己启动的：杀掉，且端口最终不再健康
  let up = false;
  const killed = [];
  const owned = makeHost(
    {},
    {
      healthCheck: async () => (up ? { ok: true } : null),
      spawnServer: () => {
        up = true;
        return { pid: 555 };
      },
      killPid: (pid) => {
        killed.push(pid);
        up = false;
      },
    }
  );
  await owned.handle({ type: 'ensure' });
  const r1 = await owned.handle({ type: 'stop' });
  assert.deepEqual(killed, [555]);
  assert.equal(r1.stopped, true);
  assert.equal(r1.status.serverRunning, false);

  // 别人启动的（本宿主只探活，没有 pid）：拒绝停
  const foreign = makeHost({}, { healthCheck: async () => ({ ok: true }) });
  const r2 = await foreign.handle({ type: 'stop' });
  assert.equal(r2.stopped, false);
  assert.match(r2.message, /不是本宿主启动/);
});

test('onDisconnect: 默认不杀服务（浏览器关掉后 DSH 仍要能用 7801）；开启 stopServerOnExit 才杀', async () => {
  // 两个用例各自维护"服务是否在跑"，否则 ensure 会走复用分支、ownedPid 为 null，
  // 断言就变成空转（第一版正是这么假通过的）。
  const killKeep = [];
  let upKeep = false;
  const keep = makeHost(
    { stopServerOnExit: false },
    {
      healthCheck: async () => (upKeep ? { ok: true } : null),
      spawnServer: () => {
        upKeep = true;
        return { pid: 7 };
      },
      killPid: (p) => killKeep.push(p),
    }
  );
  await keep.handle({ type: 'ensure' });
  assert.equal(keep.ownedPid, 7, '前提：这次确实是宿主自己启动的服务');
  await keep.onDisconnect();
  assert.deepEqual(killKeep, [], '默认必须保留服务');

  const killStop = [];
  let upStop = false;
  const stop = makeHost(
    { stopServerOnExit: true },
    {
      healthCheck: async () => (upStop ? { ok: true } : null),
      spawnServer: () => {
        upStop = true;
        return { pid: 8 };
      },
      killPid: (p) => killStop.push(p),
    }
  );
  await stop.handle({ type: 'ensure' });
  assert.equal(stop.ownedPid, 8, '前提：这次确实是宿主自己启动的服务');
  await stop.onDisconnect();
  assert.deepEqual(killStop, [8]);
});

test('归属记录：宿主重启后仍认得自己启动的服务（否则「停止」按钮会永久失效）', async () => {
  // 场景：宿主进程换了一个（SW 回收 / 扩展重载 / 浏览器重启），而 server 还在跑。
  // 落盘记录里的 pid 与 /health 的 pid 一致 → 仍算我们拥有，stop 应该真的能停。
  const killed = [];
  let up = true;
  const host = makeHost(
    {},
    {
      healthCheck: async () => (up ? { ok: true, pid: 4242 } : null),
      killPid: (p) => {
        killed.push(p);
        up = false;
      },
      ownedStore: { read: () => ({ pid: 4242, port: 7777 }), write: () => {}, clear: () => {} },
    }
  );
  const r = await host.handle({ type: 'ensure' });
  assert.equal(r.started, false, '服务已在跑，不该再启动');
  assert.equal(host.ownedPid, 4242, '应认出这是本扩展此前启动的服务');
  const stopped = await host.handle({ type: 'stop' });
  assert.deepEqual(killed, [4242]);
  assert.equal(stopped.stopped, true);
});

test('归属记录：pid 与端口上的实际进程不一致时**不**认账（避免误杀复用来的实例）', async () => {
  const killed = [];
  const host = makeHost(
    {},
    {
      healthCheck: async () => ({ ok: true, pid: 9999 }), // 端口上是别人的进程
      killPid: (p) => killed.push(p),
      ownedStore: { read: () => ({ pid: 4242, port: 7777 }), write: () => {}, clear: () => {} },
    }
  );
  const r = await host.handle({ type: 'ensure' });
  assert.equal(host.ownedPid, null);
  assert.match(r.message, /复用现有实例/);
  const stopped = await host.handle({ type: 'stop' });
  assert.deepEqual(killed, []);
  assert.equal(stopped.stopped, false);
});

test('归属记录：自己启动时写入，stop 之后清掉', async () => {
  const events = [];
  let up = false;
  const host = makeHost(
    {},
    {
      healthCheck: async () => (up ? { ok: true } : null),
      spawnServer: () => {
        up = true;
        return { pid: 555 };
      },
      killPid: () => {
        up = false;
      },
      ownedStore: {
        read: () => null,
        write: (pid) => events.push(['write', pid]),
        clear: () => events.push(['clear']),
      },
    }
  );
  await host.handle({ type: 'ensure' });
  assert.deepEqual(events, [['write', 555]]);
  await host.handle({ type: 'stop' });
  assert.deepEqual(events, [
    ['write', 555],
    ['clear'],
  ]);
});

test('handle: ping → pong；未知指令明确报错', async () => {  const host = makeHost({}, { healthCheck: async () => null });
  const pong = await host.handle({ type: 'ping' });
  assert.equal(pong.type, 'pong');
  assert.ok(Number.isFinite(pong.at));

  const bad = await host.handle({ type: 'nonsense' });
  assert.equal(bad.type, 'error');
  assert.match(bad.error, /未知指令/);
});

test('status: 字段齐全（端口/宿主 pid/是否在跑/日志路径），供设置页直接展示', async () => {
  const host = makeHost({}, { healthCheck: async () => ({ ok: true, ws: false }) });
  const r = await host.handle({ type: 'status' });
  assert.equal(r.status.port, 7777);
  assert.ok(r.status.hostPid > 0);
  assert.equal(r.status.serverRunning, true);
  assert.match(r.status.hostLog, /native-host\.log$/);
  assert.match(r.status.serverLog, /mcp-server\.log$/);
});

test('findRunningServer: 只认 { ok: true } 的响应（探活失败一律当没运行）', async () => {
  const called = [];
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      called.push(String(url));
      return { ok: true, json: async () => ({ ok: true, ws: true }) };
    };
    const h = await findRunningServer(7801);
    assert.equal(h.ok, true);
    assert.match(called[0], /^http:\/\/127\.0\.0\.1:7801\/health$/);

    globalThis.fetch = async () => ({ ok: true, json: async () => ({ nope: 1 }) });
    assert.equal(await findRunningServer(7801), null);

    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    assert.equal(await findRunningServer(7801), null);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---------------- 看门狗 ----------------

test('看门狗：服务健康时什么都不做（不能每 20s 重启一次服务）', async () => {
  let ensured = 0;
  const wd = createWatchdog({ healthCheck: async () => ({ ok: true }), ensure: async () => (ensured += 1) });
  assert.equal(await wd.tick(), null);
  assert.equal(ensured, 0);
  assert.equal(wd.failures, 0);
});

test('看门狗：服务不在了就重新 ensure，并把结果回报给扩展', async () => {
  let up = false;
  const reported = [];
  const wd = createWatchdog({
    healthCheck: async () => (up ? { ok: true } : null),
    ensure: async () => {
      up = true;
      return { type: 'status', action: 'ensure', started: true };
    },
    onStatus: (r) => reported.push(r),
  });
  const r = await wd.tick();
  assert.equal(r.started, true);
  assert.deepEqual(reported, [r]);
  assert.equal(await wd.tick(), null, '恢复之后不该再反复 ensure');
});

test('看门狗：连续失败到上限就停手（否则会每轮生成一个新进程）', async () => {
  let ensured = 0;
  const logs = [];
  const wd = createWatchdog({
    healthCheck: async () => null,
    ensure: async () => {
      ensured += 1;
      return { type: 'status', started: false };
    },
    maxFailures: 2,
    logger: (m) => logs.push(m),
  });
  await wd.tick();
  await wd.tick();
  await wd.tick();
  assert.equal(ensured, 2, '达到上限后不得再启动');
  assert.equal(wd.stopped, true);
  assert.match(logs.join('|'), /停止尝试/);
});

test('看门狗：上一次 tick 还没跑完时不重入（异步探活期间可能又到点了）', async () => {
  let ensured = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const wd = createWatchdog({
    healthCheck: async () => {
      await gate;
      return null;
    },
    ensure: async () => {
      ensured += 1;
    },
  });
  const first = wd.tick();
  assert.equal(await wd.tick(), null, '重入的 tick 必须直接返回');
  release();
  await first;
  assert.equal(ensured, 1);
});
