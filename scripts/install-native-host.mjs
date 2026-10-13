#!/usr/bin/env node
// native messaging 宿主安装器：把「浏览器能自动拉起本地服务」这件事一次性装好。
//
// 它做四件事（每一件都对应一个已知的失败模式）：
//   1. 探测扩展 ID：Chrome 的 allowed_origins 必须与扩展 ID 完全一致，差一个字符就是
//      "Access to the specified native messaging host is forbidden"，而且浏览器不会告诉你原因。
//      解压目录扩展的 ID 由**绝对路径**推导，所以可以直接从浏览器 Profile 里按路径反查。
//   2. 生成宿主配置与 manifest：path 必须指向**可执行文件**（见 launcher/Launcher.cs.template 的说明）。
//   3. 编译启动器 exe：用系统自带的 csc.exe（.NET Framework 4），不引入任何新依赖。
//   4. 写注册表：HKCU 下按浏览器分别登记，**不需要管理员权限**。
//
// 用法：
//   node scripts/install-native-host.mjs                    # 自动探测扩展 ID 并安装
//   node scripts/install-native-host.mjs --list-ids         # 只列出探测到的扩展 ID
//   node scripts/install-native-host.mjs --extension-id XX  # 手动指定（可重复）
//   node scripts/install-native-host.mjs --uninstall        # 卸载（删注册表 + 构建产物）
//   node scripts/install-native-host.mjs --dry-run          # 只打印将要执行的写操作
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectExtensionIdsByPath } from '../integrations/native-host/detect-extension.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_DIR = path.join(ROOT, 'integrations', 'native-host');
const BIN_DIR = path.join(HOST_DIR, 'bin');
// 启动器源码现在是**路径无关**的（运行时自己解析 node/host.js），所以不再需要占位符替换与
// 每次安装重新生成 .cs —— 编译产物可以跨机器复用，见 integrations/native-host/launcher/Launcher.cs。
const LAUNCHER_CS = path.join(HOST_DIR, 'launcher', 'Launcher.cs');
const EXE = path.join(BIN_DIR, 'recallflow-native-host.exe');
const LAUNCHER_CONFIG = path.join(BIN_DIR, 'launcher.config');
const HOST_JS = path.join(HOST_DIR, 'host.js');
const HOST_CONFIG = path.join(HOST_DIR, 'host.config.json');
const MANIFEST = path.join(BIN_DIR, 'com.recallflow.bridge.json');
const HOST_NAME = 'com.recallflow.bridge';
const MCP_ENTRY = path.join(ROOT, 'integrations', 'opencode', 'recallflow-mcp', 'index.js');

const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const BROWSERS = [
  {
    id: 'edge',
    name: 'Edge',
    regKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + HOST_NAME,
    userData: path.join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
  },
  {
    id: 'chrome',
    name: 'Chrome',
    regKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST_NAME,
    userData: path.join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
  },
];

function parseArgs(argv) {
  const out = { extensionIds: [], uninstall: false, dryRun: false, listIds: false, noVerify: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--extension-id' || a === '--id') {
      i += 1;
      if (!argv[i]) throw new Error('--extension-id 缺少取值');
      out.extensionIds.push(String(argv[i]).trim());
    } else if (a === '--uninstall') out.uninstall = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--list-ids') out.listIds = true;
    else if (a === '--no-verify') out.noVerify = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数：' + a);
  }
  return out;
}

const say = (s) => process.stdout.write(s + '\n');
const warn = (s) => process.stderr.write('[install-native-host] ' + s + '\n');

// 扩展 ID 探测已抽到共享模块：发行包里的安装脚本也要用同一份逻辑（且发行态只能按名称识别，
// 因为那时我们不知道用户把扩展加载到了哪个目录）。见 integrations/native-host/detect-extension.mjs。
const detectExtensionIds = (userDataDir) => detectExtensionIdsByPath(userDataDir, ROOT);
export { detectExtensionIds };

function findCsc() {
  const cands = [
    process.env.CSC || '',
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  ].filter(Boolean);
  for (const c of cands) {
    if (fs.existsSync(c)) return c;
  }
  return '';
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function reg(args, dryRun) {
  const printable = 'reg ' + args.map((a) => (a.includes(' ') ? '"' + a + '"' : a)).join(' ');
  if (dryRun) {
    say('  [dry-run] ' + printable);
    return { code: 0, out: '' };
  }
  const r = run('reg', args);
  if (r.code !== 0) warn('注册表命令失败：' + printable + '\n' + r.out.trim());
  return r;
}

function buildLauncher() {
  const csc = findCsc();
  if (!csc) {
    // 没有编译器不算致命：只要已有编译产物就能继续用（开发机上通常都编译过了）。
    if (fs.existsSync(EXE)) return { csc: '(未找到 csc，复用已有 exe)', out: '', reused: true };
    throw new Error('找不到 csc.exe（.NET Framework 4）且没有已编译的启动器 exe。Windows 10/11 默认自带 csc；否则先在有编译器的机器上跑一次构建。');
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  // 先编到临时名再落位：**正在运行的 exe 无法被覆盖**（Windows 会锁住，实测报
  // "being used by another process"），但可以改名让开位置 —— 运行中的老进程继续用改名后的文件，
  // 浏览器下次拉起就会用新文件。这样升级不需要先杀宿主（杀了会连带把服务一起带走）。
  const tmpExe = EXE + '.new';
  try {
    fs.rmSync(tmpExe, { force: true });
  } catch (e) {}
  const r = run(csc, ['/nologo', '/target:exe', '/platform:anycpu', '/out:' + tmpExe, LAUNCHER_CS]);
  if (r.code !== 0 || !fs.existsSync(tmpExe)) {
    throw new Error('编译启动器失败（csc 退出码 ' + r.code + '）：\n' + r.out.trim());
  }
  const oldExe = EXE + '.old';
  try {
    fs.rmSync(oldExe, { force: true });
  } catch (e) {
    /* 上一次改名留下的 .old 仍在运行：删不掉是正常的，忽略 */
  }
  if (fs.existsSync(EXE)) {
    try {
      fs.renameSync(EXE, oldExe);
    } catch (e) {
      /* 没被占用时也能直接覆盖，这里失败就交给下面的 rename 报错 */
    }
  }
  fs.renameSync(tmpExe, EXE);
  try {
    fs.rmSync(oldExe, { force: true });
  } catch (e) {
    /* 运行中的旧 exe：留给下次安装清理 */
  }
  return { csc, out: r.out.trim(), reused: false };
}

function writeConfigs(extensionIds, port) {
  const cfg = {
    port,
    mcpEntry: MCP_ENTRY,
    nodePath: process.execPath,
    heartbeatMs: 20000,
    startTimeoutMs: 25000,
    stopServerOnExit: false,
  };
  fs.writeFileSync(HOST_CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  // 启动器运行时按 launcher.config 解析 node 与 host.js（纯文本：前两行有效内容）。
  // 开发态路径是任意的（仓库在哪、node 装在哪都不一定），所以必须显式写这两个路径；
  // 发行包走扁平布局，不写这个文件也能自己找到同目录的 node.exe / host.js。
  fs.writeFileSync(LAUNCHER_CONFIG, process.execPath + '\n' + HOST_JS + '\n', 'utf8');

  const existing = (() => {
    try {
      return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    } catch (e) {
      return null;
    }
  })();
  const origins = new Set((existing && existing.allowed_origins) || []);
  for (const id of extensionIds) origins.add('chrome-extension://' + id + '/');

  const manifest = {
    name: HOST_NAME,
    description: 'RecallFlow 本地服务宿主：浏览器按需拉起 127.0.0.1:7801 的 MCP server',
    path: EXE,
    type: 'stdio',
    allowed_origins: Array.from(origins).sort(),
  };
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { cfg, manifest };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    warn(String(e.message));
    return 2;
  }
  if (args.help) {
    say('用法：node scripts/install-native-host.mjs [--extension-id XX] [--uninstall] [--dry-run] [--list-ids] [--no-verify]');
    return 0;
  }
  const port = Number(process.env.RECALLFLOW_MCP_PORT) || 7801;

  // ---- 探测扩展 ID ----
  const detected = new Map(); // browserName -> ids
  for (const b of BROWSERS) {
    const ids = fs.existsSync(b.userData) ? detectExtensionIds(b.userData) : [];
    if (fs.existsSync(b.userData)) detected.set(b.name, ids);
  }
  const allIds = new Set(args.extensionIds);
  for (const ids of detected.values()) ids.forEach((id) => allIds.add(id));

  if (args.listIds) {
    say('仓库目录：' + ROOT);
    for (const [name, ids] of detected) {
      say('  ' + name + '：' + (ids.length ? ids.join(', ') : '（没找到指向本目录的扩展）'));
    }
    if (args.extensionIds.length) say('  命令行指定：' + args.extensionIds.join(', '));
    if (!detected.size) say('  （没发现任何浏览器 Profile 目录）');
    return 0;
  }

  if (args.uninstall) {
    say('卸载 native messaging 宿主…');
    let ok = true;
    for (const b of BROWSERS) {
      const r = reg(['delete', b.regKey, '/f'], args.dryRun);
      if (!args.dryRun) say('  ' + b.name + ' 注册表：' + (r.code === 0 ? '已删除' : '本来就没有（忽略）'));
    }
    if (!args.dryRun) {
      for (const f of [EXE, LAUNCHER_CONFIG, MANIFEST]) {
        try {
          fs.rmSync(f, { force: true });
        } catch (e) {}
      }
      say('  构建产物已删除（宿主配置 host.config.json 保留）');
    }
    say(ok ? '完成。扩展会退回"手动启动 MCP server"的模式（见 scripts/dev-up.sh）。' : '完成（有警告）。');
    return 0;
  }

  // ---- 装 ----
  say('RecallFlow native messaging 宿主安装');
  say('  仓库目录：' + ROOT);
  say('  node：' + process.execPath);
  if (!allIds.size) {
    warn('没有找到扩展 ID，无法生成 allowed_origins。');
    warn('请打开 edge://extensions（或 chrome://extensions），启用开发人员模式后复制本扩展的 ID，再执行：');
    warn('  node scripts/install-native-host.mjs --extension-id <那个ID>');
    warn('（若扩展还没加载过，先"加载解压缩的扩展"指向：' + ROOT + '）');
    return 3;
  }
  for (const [name, ids] of detected) {
    say('  ' + name + '：' + (ids.length ? ids.join(', ') : '未发现本目录的扩展'));
  }
  if (args.extensionIds.length) say('  额外指定：' + args.extensionIds.join(', '));

  if (args.dryRun) {
    say('\n[dry-run] 将执行：');
    say('  1) 编译 ' + LAUNCHER_CS + ' → ' + EXE);
    say('  2) 写 ' + HOST_CONFIG + ' 与 ' + LAUNCHER_CONFIG + '（node 与 host.js 的绝对路径）');
    say('  3) 写 ' + MANIFEST);
    for (const b of BROWSERS) {
      if (fs.existsSync(b.userData)) reg(['add', b.regKey, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f'], true);
    }
    return 0;
  }

  let built;
  try {
    built = buildLauncher();
  } catch (e) {
    warn(String(e.message));
    return 4;
  }
  say('\n1) 启动器：' + EXE + (built.reused ? '（复用已有产物，' + built.csc + '）' : '（已编译）'));
  if (built.out) say('   csc：' + built.out.split('\n')[0].slice(0, 160));

  const { cfg, manifest } = writeConfigs(Array.from(allIds), port);
  say('2) 宿主配置：' + HOST_CONFIG + '（端口 ' + cfg.port + '）');
  say('3) 宿主 manifest：' + MANIFEST);
  for (const o of manifest.allowed_origins) say('   允许来源：' + o);

  say('4) 注册表：');
  for (const b of BROWSERS) {
    if (!fs.existsSync(b.userData)) {
      say('  ' + b.name + '：未安装/未使用过，跳过');
      continue;
    }
    const r = reg(['add', b.regKey, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f'], false);
    say('  ' + b.name + '：' + (r.code === 0 ? '已登记 → ' + b.regKey : '失败（见上方错误）'));
  }

  if (!args.noVerify) {
    say('\n5) 宿主自检（不依赖浏览器，走真实管道 + 协议帧）：');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-native-host.mjs'), '--exe', EXE], {
      stdio: 'inherit',
      env: process.env,
    });
    if (r.status !== 0) {
      warn('自检未通过（见上方输出）。宿主已装好，但请先修好再重载扩展。');
      return 5;
    }
  }

  say('\n完成。还差一步（必须手动做一次）：');
  say('  在 edge://extensions（或 chrome://extensions）点本扩展的「重新加载」——');
  say('  因为这次给 manifest.json 新增了 nativeMessaging 权限，不重载不会生效。');
  say('  重载后打开扩展设置页，会看到「本地服务」状态；以后浏览器一开，服务自动就绪。');
  return 0;
}

// 只有直接执行时才跑 main（便于测试 import detectExtensionIds）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
