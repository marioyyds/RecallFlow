#!/usr/bin/env node
// RecallFlow native messaging host —— 让浏览器自己把本地 MCP server 拉起来。
//
// 为什么需要它（用户视角）：以前要打开终端敲 `node index.js --http`，非程序员根本走不到这一步。
// 现在由扩展在后台调 `chrome.runtime.connectNative()`，浏览器**按需启动本进程**，
// 本进程负责「确保 127.0.0.1:7801 上有 MCP server 在跑」。用户全程不需要知道有服务存在。
//
// 进程关系（关键，改代码前先读懂）：
//   Edge/Chrome ──(native messaging: stdin/stdout 长度前缀帧)──► recallflow-native-host.exe
//                                                                   └─(启动器)──► node host.js（本文件）
//   host.js ──(detached spawn)──► node index.js --http（7801）
//
// 为什么是「长度前缀帧」：这是 Chrome native messaging 的协议，**不能用行分隔 JSON**——
// 每条消息 = 4 字节小端长度 + UTF-8 JSON。写错一个字节浏览器就静默断开，且不给任何提示。
//
// 生命周期（**实测结论**，别再凭直觉推断）：
//   · 浏览器关闭 / 扩展重载 → 本进程 stdin 收到 EOF → 本进程退出；
//   · 服务**随之一起消失**：Chromium 把 native host 放进 job object，detached 子进程也在其中，
//     所以"服务比浏览器活得久"是不成立的（对照实验：宿主不由浏览器启动时，杀掉宿主服务仍存活，
//     说明回收来自 job object，而非我们没 detached）。
//   · 于是最终语义 = **浏览器开着，服务就在**；关掉浏览器服务停，重开浏览器自动恢复。
//     要让 7801 独立于浏览器常驻（DSH/opencode 长期跑），用 `bash scripts/dev-up.sh`。
//   · stopServerOnExit 只在"宿主被直接启动"（开发/自检）时才有意义：默认保留服务。
//
// 环境变量 / 配置文件：
//   host.config.json（与本文件同目录）字段见 DEFAULT_CONFIG：port / mcpEntry / nodePath /
//   heartbeatMs / startTimeoutMs / stopServerOnExit。安装器会用绝对路径写好它。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 协议上限：浏览器→宿主官方上限 64MB、宿主→浏览器 1MB。这里取更紧的值，
// 因为本项目的消息都是小状态包；收到超大帧说明对端有问题，宁可明确报错。
const MAX_INBOUND_BYTES = 8 * 1024 * 1024;
const PROTOCOL_VERSION = 1;

const DEFAULT_CONFIG = {
  port: 7801,
  // 默认按布局推导：仓储开发态在 ../opencode/recallflow-mcp/，发行包在 ./server.bundle.mjs。
  // 两者都要支持 —— 发行包是扁平目录（见 scripts/build-dist.mjs），不能假设仓库结构存在。
  mcpEntry: resolveDefaultMcpEntry(),
  nodePath: process.execPath,
  heartbeatMs: 20000,
  startTimeoutMs: 25000,
  // 注意：由浏览器启动时，服务无论如何都活不过浏览器（job object 回收，见文件头的生命周期说明）；
  // 这个开关只影响"宿主被直接启动"的场景（开发调试、自检脚本）。
  stopServerOnExit: false,
  // 看门狗：心跳时顺带探活，发现服务不在了就重新拉起。
  // 没有它，"浏览器一开服务就在"只对**首次**启动成立 —— 服务后来崩掉（OOM / 端口被抢）
  // 就再也没人管，用户看到的是"刚才还能用，现在不行了"。
  watchdog: true,
};

/**
 * 猜 MCP server 入口：返回第一个真实存在的候选，都不存在时返回仓储布局的默认路径
 * （留给错误信息用——报"找不到入口"时必须给出我们期望的完整路径，否则排障无从下手）。
 */
export function resolveDefaultMcpEntry() {
  const candidates = [
    path.resolve(HERE, 'server.bundle.mjs'), // 发行包：与 host.js 同目录
    path.resolve(HERE, '..', 'mcp', 'server.bundle.mjs'), // 发行包：分层布局
    path.resolve(HERE, '..', 'opencode', 'recallflow-mcp', 'index.js'), // 仓储开发态
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {}
  }
  return candidates[candidates.length - 1];
}

/** 日志目录：放在用户可见的位置，出问题时能让人直接找到文件。 */
export function logDir() {
  const base = process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || os.homedir();
  return path.join(base, 'RecallFlow', 'logs');
}

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    return true;
  } catch (e) {
    return false;
  }
}

/** 简易文件日志：native messaging 占用 stdout，stderr 会被浏览器吞掉，所以必须自己落盘。 */function createLogger(file) {
  let stream = null;
  try {
    ensureDir(path.dirname(file));
    stream = fs.createWriteStream(file, { flags: 'a' });
  } catch (e) {
    stream = null;
  }
  return (msg) => {
    const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
    if (stream) {
      try {
        stream.write(line);
      } catch (e) {}
    }
  };
}

/** 把一条消息编码成 native messaging 帧（4 字节小端长度 + UTF-8 JSON）。 */
export function encodeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32LE(json.length, 0);
  return Buffer.concat([head, json]);
}

/**
 * 增量解码器：stdin 的 data 事件**不保证**一条消息一次到达，
 * 所以必须缓存半条帧。这是 native messaging 最容易写错的地方。
 * @returns {{push: (buf: Buffer) => void}}
 */
export function createDecoder({ maxBytes = MAX_INBOUND_BYTES, onMessage, onError } = {}) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32LE(0);
        if (len === 0) {
          onError && onError(new Error('收到长度为 0 的帧（协议错误）'));
          buf = buf.subarray(4);
          continue;
        }
        if (len > maxBytes) {
          onError && onError(new Error('帧过大：' + len + ' 字节'));
          return; // 无法安全跳过，只能停止解析
        }
        if (buf.length < 4 + len) return;
        const body = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        let msg = null;
        try {
          msg = JSON.parse(body.toString('utf8'));
        } catch (e) {
          onError && onError(new Error('帧内容不是合法 JSON：' + String((e && e.message) || e)));
          continue;
        }
        onMessage && onMessage(msg);
      }
    },
  };
}

/** 读配置：host.config.json 与用户配置合并到默认值上；缺字段一律回退默认。 */
export function loadConfig(configPath) {
  const file = configPath || path.join(HERE, 'host.config.json');
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    raw = {};
  }
  const cfg = Object.assign({}, DEFAULT_CONFIG, raw && typeof raw === 'object' ? raw : {});
  cfg.port = Number(cfg.port) || DEFAULT_CONFIG.port;
  // 与 MCP server 同名的环境变量，便于测试与"临时换端口"时不用改配置文件。
  if (process.env.RECALLFLOW_MCP_PORT) {
    const p = Number(process.env.RECALLFLOW_MCP_PORT);
    if (Number.isFinite(p) && p > 0) cfg.port = p;
  }
  cfg.heartbeatMs = Number(cfg.heartbeatMs) || DEFAULT_CONFIG.heartbeatMs;
  cfg.startTimeoutMs = Number(cfg.startTimeoutMs) || DEFAULT_CONFIG.startTimeoutMs;
  cfg.stopServerOnExit = cfg.stopServerOnExit === true;
  cfg.watchdog = cfg.watchdog !== false;
  // 相对路径按本文件所在目录解析（安装器写绝对路径，手写配置时相对路径更好用）。
  cfg.mcpEntry = path.isAbsolute(cfg.mcpEntry) ? cfg.mcpEntry : path.resolve(HERE, cfg.mcpEntry);
  return cfg;
}

/** 探活：/health 无需鉴权（server 侧 OPEN_PATHS），返回解析后的 JSON 或 null。 */
export async function healthCheck(port, timeoutMs = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/health', { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------- 服务归属记录 ----------------
// 为什么需要落盘：宿主进程是短命的（SW 被回收、扩展重载、浏览器重启都会换一个），
// 而 server 是长命的。若不把"这个 pid 是我启动的"记下来，新宿主就会把自己上个实例启动的
// server 当成别人的 —— 表现为设置页的「停止」按钮永久失效（而且不会报错，只是拒绝）。
// 判定必须靠 /health 里的 pid 与记录**逐个比对**，绝不能只看记录存在就认账（否则会误杀复用来的实例）。
const OWNED_FILE = () => path.join(logDir(), 'owned-server.json');

export function readOwned(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file || OWNED_FILE(), 'utf8'));
    const pid = Number(j && j.pid);
    return Number.isInteger(pid) && pid > 0 ? { pid, port: Number(j.port) || null } : null;
  } catch (e) {
    return null;
  }
}

export function writeOwned(pid, port, file) {
  try {
    const f = file || OWNED_FILE();
    ensureDir(path.dirname(f));
    fs.writeFileSync(f, JSON.stringify({ pid, port, at: Date.now() }), 'utf8');
  } catch (e) {}
}

export function clearOwned(file) {
  try {
    fs.rmSync(file || OWNED_FILE(), { force: true });
  } catch (e) {}
}

/** 端口上是否已经有 MCP server 在服务（不论是谁启动的）。 */
export async function findRunningServer(port) {
  const h = await healthCheck(port);
  if (!h || h.ok !== true) return null;
  return h;
}

/**
 * 启动 MCP server（detached：宿主退出后它继续活着）。
 * stdio 指向日志文件——绝不能是 inherit，否则会把 native messaging 的 stdout 管道写脏。
 */
export function spawnServer(cfg, logger) {
  const logFile = path.join(logDir(), 'mcp-server.log');
  ensureDir(logDir());
  let out = 'ignore';
  try {
    out = fs.openSync(logFile, 'a');
  } catch (e) {
    out = 'ignore';
  }
  const child = spawn(cfg.nodePath, [cfg.mcpEntry, '--http'], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: Object.assign({}, process.env, { RECALLFLOW_MCP_PORT: String(cfg.port) }),
  });
  child.unref();
  logger('已启动 MCP server：pid=' + child.pid + ' entry=' + cfg.mcpEntry + ' port=' + cfg.port);
  return child;
}

/** 按 PID 结束进程（Windows 用 taskkill，其余用信号）。 */
export function killPid(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    } else {
      process.kill(pid, 'SIGTERM');
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 组装宿主的运行逻辑。依赖全部可注入（spawn/fetch 等），因此可以脱开浏览器做单测。
 * @returns {{handle: (msg:any)=>Promise<any>, onDisconnect: ()=>void, state: ()=>object}}
 */
export function createHost(cfg, deps = {}) {
  const doHealth = deps.healthCheck || ((p) => healthCheck(p));
  const doSpawn = deps.spawnServer || ((c, l) => spawnServer(c, l));
  const doSleep = deps.sleep || sleep;
  const now = deps.now || (() => Date.now());
  const logger = deps.logger || (() => {});
  // 杀进程也必须可注入：单测里绝不允许真的去 taskkill 一个 pid。
  const doKill = deps.killPid || killPid;
  // 归属记录的读写同样可注入，便于单测验证"跨宿主重启仍认得自己的服务"。
  const ownedStore = deps.ownedStore || {
    read: () => readOwned(),
    write: (pid) => writeOwned(pid, cfg.port),
    clear: () => clearOwned(),
  };

  let serverPid = null; // 只记录"我们自己启动"的 pid：复用别人启动的实例时不许杀
  let reused = false;
  let starting = null; // 并发 ensure 合流，避免同时拉起两个 server
  let lastError = '';
  let lastStartAt = 0;

  async function status() {
    const health = await doHealth(cfg.port);
    return {
      ok: true,
      protocol: PROTOCOL_VERSION,
      hostPid: process.pid,
      port: cfg.port,
      serverRunning: Boolean(health),
      serverOwned: Boolean(serverPid),
      serverPid: serverPid || null,
      reused,
      health: health || null,
      lastError: lastError || null,
      hostLog: path.join(logDir(), 'native-host.log'),
      serverLog: path.join(logDir(), 'mcp-server.log'),
    };
  }

  async function ensure() {
    const health = await doHealth(cfg.port);
    if (health) {
      // 端口上的进程可能是**上一个宿主实例**启动的（SW 回收 / 扩展重载 / 浏览器重启都会换宿主）。
      // 用 /health 里的 pid 与落盘记录比对：一致就仍然算我们拥有，这样「停止」按钮在
      // 宿主换过之后依然有效；不一致或没有记录就只探活、不接管。
      if (!serverPid) {
        const prev = ownedStore.read();
        if (prev && health.pid && Number(health.pid) === Number(prev.pid)) {
          serverPid = Number(health.pid);
          logger('认出端口上的服务是本扩展此前启动的：pid=' + serverPid);
        }
      }
      reused = !serverPid;
      return {
        type: 'status',
        action: 'ensure',
        started: false,
        message: serverPid ? '本地服务已在运行（由本扩展此前启动）' : '本地服务已在运行（复用现有实例）',
        status: await status(),
      };
    }
    if (starting) return starting;
    starting = (async () => {
      if (!fs.existsSync(cfg.mcpEntry)) {
        lastError = '找不到 MCP server 入口：' + cfg.mcpEntry;
        logger(lastError);
        return { type: 'status', action: 'ensure', started: false, message: lastError, status: await status() };
      }
      lastStartAt = now();
      let child = null;
      try {
        child = doSpawn(cfg, logger);
        serverPid = (child && child.pid) || null;
        if (serverPid) ownedStore.write(serverPid);
      } catch (e) {
        lastError = '启动失败：' + String((e && e.message) || e);
        logger(lastError);
        return { type: 'status', action: 'ensure', started: false, message: lastError, status: await status() };
      }
      const deadline = now() + cfg.startTimeoutMs;
      for (;;) {
        const h = await doHealth(cfg.port);
        if (h) {
          lastError = '';
          reused = false;
          return { type: 'status', action: 'ensure', started: true, message: '本地服务已启动', status: await status() };
        }
        if (now() >= deadline) {
          lastError = '启动超时（' + cfg.startTimeoutMs + 'ms）：日志见 ' + path.join(logDir(), 'mcp-server.log');
          logger(lastError);
          return { type: 'status', action: 'ensure', started: false, message: lastError, status: await status() };
        }
        await doSleep(300);
      }
    })();
    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  async function stop() {
    if (!serverPid) {
      const h = await doHealth(cfg.port);
      return {
        type: 'status',
        action: 'stop',
        stopped: false,
        message: h ? '这个实例不是本宿主启动的，未停止（避免误杀你手动起的服务）' : '本地服务本来就没在运行',
        status: await status(),
      };
    }
    const pid = serverPid;
    doKill(pid);
    for (let i = 0; i < 20; i += 1) {
      if (!(await doHealth(cfg.port))) break;
      await doSleep(250);
    }
    serverPid = null;
    ownedStore.clear();
    logger('已停止 MCP server：pid=' + pid);
    return { type: 'status', action: 'stop', stopped: true, message: '本地服务已停止', status: await status() };
  }

  return {
    async handle(msg) {
      const type = String((msg && msg.type) || '').trim();
      if (type === 'ping') return { type: 'pong', at: now() };
      if (type === 'ensure' || type === 'start') return await ensure();
      if (type === 'status') return { type: 'status', action: 'status', status: await status() };
      if (type === 'stop') return await stop();
      return { type: 'error', error: '未知指令：' + type };
    },
    async onDisconnect() {
      if (cfg.stopServerOnExit && serverPid) {
        doKill(serverPid);
        logger('stdin 关闭（浏览器退出/扩展重载），按配置停止 MCP server：pid=' + serverPid);
      }
    },
    status,
    get ownedPid() {
      return serverPid;
    },
    get lastStartAt() {
      return lastStartAt;
    },
  };
}

/**
 * 看门狗：周期性探活，服务不在了就重新 ensure。
 * 抽成独立函数是为了能单测（main 里的定时器没法测）：它有两个必须守住的性质 ——
 *   1. 服务健康时**不**做任何事（不能每 20s 就重启一次服务）；
 *   2. 连续失败到上限就停手（否则一个起不来的服务会每 20s 生成一个进程，越滚越多）。
 */
export function createWatchdog({ healthCheck: check, ensure, onStatus, maxFailures = 3, logger = () => {} }) {
  let failures = 0;
  let busy = false;
  let stopped = false;
  return {
    async tick() {
      if (busy || stopped) return null;
      busy = true;
      try {
        if (await check()) {
          failures = 0;
          return null;
        }
        if (failures >= maxFailures) {
          stopped = true;
          logger('看门狗：连续 ' + failures + ' 次未能恢复服务，停止尝试（避免不断生成进程）');
          return null;
        }
        failures += 1;
        logger('看门狗：服务不在，尝试重新拉起（第 ' + failures + ' 次）');
        const r = await ensure();
        if (onStatus) onStatus(r);
        return r;
      } catch (e) {
        logger('看门狗异常：' + String((e && e.message) || e));
        return null;
      } finally {
        busy = false;
      }
    },
    get failures() {
      return failures;
    },
    get stopped() {
      return stopped;
    },
  };
}

/** 进程入口：只有在被 node 直接执行时才跑（被 import 时保持纯函数可测）。 */
export async function main() {
  const cfg = loadConfig();
  const log = createLogger(path.join(logDir(), 'native-host.log'));
  log('宿主启动：pid=' + process.pid + ' node=' + process.execPath + ' config=' + JSON.stringify({
    port: cfg.port,
    mcpEntry: cfg.mcpEntry,
    heartbeatMs: cfg.heartbeatMs,
  }));

  const host = createHost(cfg, { logger: log });
  const send = (obj) => {
    try {
      process.stdout.write(encodeMessage(obj));
    } catch (e) {
      log('写 stdout 失败：' + String((e && e.message) || e));
    }
  };

  const decoder = createDecoder({
    onMessage: async (msg) => {
      let reply;
      try {
        reply = await host.handle(msg);
      } catch (e) {
        reply = { type: 'error', error: String((e && e.message) || e) };
      }
      send(reply);
    },
    onError: (e) => log('协议错误：' + String((e && e.message) || e)),
  });

  process.stdin.on('data', (c) => decoder.push(c));
  process.stdin.on('end', async () => {
    log('stdin 关闭，宿主退出');
    try {
      await host.onDisconnect();
    } catch (e) {}
    process.exit(0);
  });
  process.stdin.on('error', () => process.exit(0));
  // 保持 stdin 处于流动状态：某些平台不 resume 就收不到 data。
  process.stdin.resume();

  // 心跳 + 看门狗：心跳让 MV3 的 service worker 续命；看门狗保证服务崩了能自己回来。
  const watchdog = cfg.watchdog
    ? createWatchdog({
        healthCheck: () => healthCheck(cfg.port),
        ensure: () => host.handle({ type: 'ensure' }),
        onStatus: (r) => send(r),
        logger: log,
      })
    : null;
  const beat = setInterval(async () => {
    send({ type: 'heartbeat', at: Date.now(), port: cfg.port });
    if (watchdog) await watchdog.tick();
  }, cfg.heartbeatMs);
  beat.unref && beat.unref();

  // 扩展一连上就自动"确保服务在跑"，用户无需任何操作。
  const first = await host.handle({ type: 'ensure' });
  send(first);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    try {
      createLogger(path.join(logDir(), 'native-host.log'))('致命错误：' + String((e && e.stack) || e));
    } catch (e2) {}
    process.exit(1);
  });
}
