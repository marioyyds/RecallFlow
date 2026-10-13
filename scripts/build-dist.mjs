#!/usr/bin/env node
// 发行包构建：产出「免 Node 的一键安装器」。
//
// 产物（dist/）：
//   payload/                      ← 安装器要塞进用户机器的全部文件
//     node.exe                    便携 Node（用户不需要自己装）
//     LICENSE-node.txt            Node 的许可证（MIT 要求随包分发）
//     recallflow-native-host.exe  启动器（本 exe 与机器无关，见 Launcher.cs）
//     host.js                     宿主
//     server.bundle.mjs           MCP server（esbuild 打成单文件，不需要 node_modules）
//     install-host.mjs            安装/卸载时写注册表用的脚本（也打成单文件）
//     install-host.cmd            开始菜单「修复宿主注册」用的入口
//     host.config.json
//     README.txt
//   RecallFlow-Setup-<ver>.exe    Inno Setup 装出来的安装器（需要 iscc；没有就跳过并提示）
//
// 用法：
//   node scripts/build-dist.mjs                        # 下载便携 Node（校验 SHA256）+ 编译安装器
//   node scripts/build-dist.mjs --from-local-node      # 用本机 node.exe（离线构建，速度最快）
//   node scripts/build-dist.mjs --no-installer         # 只产出 payload
//   node scripts/build-dist.mjs --node-version v22.14.0
//
// 为什么不用 Node SEA（单一 exe 更"好看"）：SEA 仍是实验特性、要 postject 注入、体积并不更小
// （node.exe 本身就 88MB），而 AV 对"自解压+拉起子进程"的误报概率更高。便携 node.exe 是同样效果、
// 零实验特性的做法。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PAYLOAD = path.join(DIST, 'payload');
const ESBUILD = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');
const LAUNCHER_CS = path.join(ROOT, 'integrations', 'native-host', 'launcher', 'Launcher.cs');
const HOST_JS = path.join(ROOT, 'integrations', 'native-host', 'host.js');
const SERVER_ENTRY = path.join(ROOT, 'integrations', 'opencode', 'recallflow-mcp', 'index.js');
const DIST_INSTALL = path.join(ROOT, 'packaging', 'dist-install.mjs');
const ISS = path.join(ROOT, 'packaging', 'recallflow.iss');

const say = (s) => process.stdout.write(s + '\n');
const step = (s) => process.stdout.write('\n=== ' + s + ' ===\n');
const warn = (s) => process.stderr.write('[build-dist] ' + s + '\n');

function parseArgs(argv) {
  const out = { fromLocalNode: false, nodeVersion: process.version, noInstaller: false, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(a + ' 缺少取值');
      return argv[i];
    };
    if (a === '--from-local-node') out.fromLocalNode = true;
    else if (a === '--node-version') out.nodeVersion = val();
    else if (a === '--no-installer') out.noInstaller = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数：' + a);
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function findCsc() {
  for (const c of [process.env.CSC, 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe']) {
    if (c && fs.existsSync(c)) return c;
  }
  return '';
}

/** 找 ISCC.exe：PATH / Inno 默认安装位置 / 用户级安装位置（本机就是这么装的）。 */
function findIscc() {
  if (process.env.ISCC && fs.existsSync(process.env.ISCC)) return process.env.ISCC;
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno', 'ISCC.exe'),
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files (x86)\\Inno Setup 7\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 7\\ISCC.exe',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  // 用户级安装目录名可能带版本号，扫一遍
  try {
    const base = path.join(process.env.LOCALAPPDATA || '', 'Programs');
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'ISCC.exe');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) {}
  return '';
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** 用仓库自带的 esbuild 打成单文件（实测 863KB、无需 node_modules）。 */
function bundle(entry, outfile) {
  const r = run(process.execPath, [
    ESBUILD,
    entry,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node20',
    // ws 的两个可选原生加速依赖：不打包，运行时缺失会自动降级（ws 内部有 try/catch）
    '--external:bufferutil',
    '--external:utf-8-validate',
    // ESM 产物里 CJS 依赖会用到 require()，需要一个 shim
    '--banner:js=import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
    '--outfile=' + outfile,
    '--log-level=warning',
  ]);
  if (r.code !== 0 || !fs.existsSync(outfile)) throw new Error('打包失败（' + entry + '）：\n' + r.out);
  return fs.statSync(outfile).size;
}

async function fetchNode(version, payloadDir) {
  const zipName = 'node-' + version + '-win-x64.zip';
  const base = 'https://nodejs.org/dist/' + version + '/';
  say('  下载 ' + base + zipName);
  const zipPath = path.join(os.tmpdir(), zipName);
  if (!fs.existsSync(zipPath)) {
    const r = await fetch(base + zipName);
    if (!r.ok) throw new Error('下载失败 HTTP ' + r.status + '（版本 ' + version + ' 是否存在？）');
    fs.writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
  }
  // 校验 SHA256：随包分发第三方二进制前必须核对官方清单，不能只看下载成功
  const sums = await (await fetch(base + 'SHASUMS256.txt')).text();
  const line = sums.split('\n').find((l) => l.trim().endsWith(zipName));
  if (!line) throw new Error('官方 SHASUMS256.txt 里没有 ' + zipName);
  const want = line.trim().split(/\s+/)[0].toLowerCase();
  const got = sha256(zipPath);
  if (want !== got) throw new Error('SHA256 不匹配：期望 ' + want + '，实际 ' + got);
  say('  SHA256 校验通过 ' + got.slice(0, 16) + '…');

  const extractDir = path.join(os.tmpdir(), 'rf-node-extract-' + version);
  fs.rmSync(extractDir, { recursive: true, force: true });
  ensureDir(extractDir);
  const inner = 'node-' + version + '-win-x64';
  // Windows 10+ 自带 bsdtar，能直接解 zip；失败再退回 PowerShell 的 Expand-Archive
  let r = run('tar', ['-xf', zipPath, '-C', extractDir]);
  if (r.code !== 0) {
    warn('tar 解压失败，改用 Expand-Archive：' + r.out.slice(0, 120));
    r = run('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' + extractDir + '" -Force']);
    if (r.code !== 0) throw new Error('解压 Node 包失败：' + r.out.slice(0, 300));
  }
  const from = path.join(extractDir, inner);
  fs.copyFileSync(path.join(from, 'node.exe'), path.join(payloadDir, 'node.exe'));
  if (fs.existsSync(path.join(from, 'LICENSE'))) {
    fs.copyFileSync(path.join(from, 'LICENSE'), path.join(payloadDir, 'LICENSE-node.txt'));
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
  return { source: '官方 zip ' + version, sha256: got };
}

async function localNode(payloadDir) {
  const nodeExe = process.execPath;
  fs.copyFileSync(nodeExe, path.join(payloadDir, 'node.exe'));
  const nodeDir = path.dirname(nodeExe);
  let license = '';
  for (const c of [path.join(nodeDir, 'LICENSE'), path.join(nodeDir, 'LICENSE.md')]) {
    if (fs.existsSync(c)) {
      license = fs.readFileSync(c, 'utf8');
      break;
    }
  }
  if (!license) {
    try {
      const r = await fetch('https://nodejs.org/dist/' + process.version + '/LICENSE');
      if (r.ok) license = await r.text();
    } catch (e) {}
  }
  fs.writeFileSync(
    path.join(payloadDir, 'LICENSE-node.txt'),
    license || 'Node.js is distributed under the MIT license. See https://nodejs.org/dist/' + process.version + '/LICENSE\n'
  );
  return { source: '本机 ' + nodeExe + '（' + process.version + '）', sha256: sha256(path.join(payloadDir, 'node.exe')) };
}

/** 冒烟测试：用**发行包自己的** node.exe / 启动器 / 单文件 server 走一遍真实协议。 */
function smokeTest(payloadDir) {
  const port = 7831 + Math.floor(Math.random() * 50);
  const r = run(process.execPath, [path.join(ROOT, 'scripts', 'verify-native-host.mjs'), '--exe', path.join(payloadDir, 'recallflow-native-host.exe'), '--port', String(port)], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { RECALLFLOW_MCP_PORT: String(port) }),
  });
  return { code: r.code, out: r.out, port };
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return 0;
  }
}

const MB = (n) => (n / 1048576).toFixed(1) + ' MB';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    say('用法：node scripts/build-dist.mjs [--from-local-node] [--node-version vX.Y.Z] [--no-installer]');
    return 0;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version || '0.0.1';
  const started = Date.now();

  step('0) 准备目录');
  const oldPayload = PAYLOAD;
  fs.rmSync(oldPayload, { recursive: true, force: true });
  if (!args.keep) fs.rmSync(DIST, { recursive: true, force: true });
  ensureDir(PAYLOAD);
  say('  ' + PAYLOAD);

  step('1) 打包 MCP server（esbuild 单文件）');
  const serverSize = bundle(SERVER_ENTRY, path.join(PAYLOAD, 'server.bundle.mjs'));
  say('  server.bundle.mjs  ' + MB(serverSize));

  step('2) 打包安装脚本（认扩展 ID / 写注册表）');
  const installSize = bundle(DIST_INSTALL, path.join(PAYLOAD, 'install-host.mjs'));
  say('  install-host.mjs   ' + MB(installSize));

  step('3) 复制宿主并编译启动器');
  fs.copyFileSync(HOST_JS, path.join(PAYLOAD, 'host.js'));
  const csc = findCsc();
  if (!csc) throw new Error('找不到 csc.exe（.NET Framework 4），无法编译启动器');
  const exeOut = path.join(PAYLOAD, 'recallflow-native-host.exe');
  const cs = run(csc, ['/nologo', '/target:exe', '/platform:anycpu', '/out:' + exeOut, LAUNCHER_CS]);
  if (cs.code !== 0 || !fs.existsSync(exeOut)) throw new Error('编译启动器失败：\n' + cs.out);
  say('  host.js / recallflow-native-host.exe  ' + MB(fileSize(exeOut)));

  step('4) 便携 Node（用户不需要自己装 Node）');
  const nodeInfo = args.fromLocalNode ? await localNode(PAYLOAD) : await fetchNode(args.nodeVersion, PAYLOAD);
  say('  来源：' + nodeInfo.source);
  say('  node.exe  ' + MB(fileSize(path.join(PAYLOAD, 'node.exe'))));

  step('5) 配置与辅助文件');
  fs.writeFileSync(path.join(PAYLOAD, 'host.config.json'), JSON.stringify({ port: 7801, mcpEntry: 'server.bundle.mjs' }, null, 2) + '\n', 'utf8');
  fs.copyFileSync(path.join(ROOT, 'packaging', 'install-host.cmd'), path.join(PAYLOAD, 'install-host.cmd'));
  fs.copyFileSync(path.join(ROOT, 'packaging', 'PAYLOAD-README.txt'), path.join(PAYLOAD, 'README.txt'));
  say('  host.config.json / install-host.cmd / README.txt');

  step('6) 冒烟测试（用发行包自己的启动器 + node.exe + 单文件 server）');
  const smoke = smokeTest(PAYLOAD);
  process.stdout.write(smoke.out.split('\n').map((l) => '  ' + l).join('\n') + '\n');
  if (smoke.code !== 0) throw new Error('冒烟测试未通过（见上方输出）');
  say('  ✔ 发行包可用（端口 ' + smoke.port + '）');

  step('7) 生成安装器');
  let installerPath = '';
  if (args.noInstaller) {
    say('  --no-installer：跳过');
  } else {
    const iscc = findIscc();
    if (!iscc) {
      warn('没找到 ISCC.exe（Inno Setup 编译器），跳过安装器生成。');
      warn('  装一个即可：winget install JRSoftware.InnoSetup（或 https://jrsoftware.org/isdl.php）');
      warn('  然后重跑：node scripts/build-dist.mjs --from-local-node');
    } else {
      // 中文向导：Inno 自带 ChineseSimplified.isl（社区翻译），有就用；没有就退回英文
      const langFile = path.join(path.dirname(iscc), 'Languages', 'ChineseSimplified.isl');
      const defines = ['/DAppVersion=' + version, '/DSourceDir=' + PAYLOAD, '/DOutDir=' + DIST];
      if (fs.existsSync(langFile)) defines.push('/DLangFile=' + langFile);
      const r = run(iscc, defines.concat([ISS]), { cwd: ROOT });
      process.stdout.write(r.out.split('\n').map((l) => '  ' + l).join('\n') + '\n');
      installerPath = path.join(DIST, 'RecallFlow-Setup-' + version + '.exe');
      if (r.code !== 0 || !fs.existsSync(installerPath)) throw new Error('ISCC 编译失败（退出码 ' + r.code + '）');
      say('  ✔ ' + installerPath + '  ' + MB(fileSize(installerPath)));
    }
  }

  step('8) 汇总');
  const files = fs.readdirSync(PAYLOAD).sort();
  let total = 0;
  for (const f of files) {
    const s = fileSize(path.join(PAYLOAD, f));
    total += s;
    say('  ' + f.padEnd(30) + MB(s).padStart(9) + (f === 'node.exe' ? '' : '  sha256 ' + sha256(path.join(PAYLOAD, f)).slice(0, 12)));
  }
  say('  ' + 'payload 合计'.padEnd(28) + MB(total).padStart(9));
  if (installerPath) say('  安装器'.padEnd(30) + MB(fileSize(installerPath)).padStart(9) + '  sha256 ' + sha256(installerPath));
  const report = [
    'RecallFlow 发行包',
    '构建时间：' + new Date().toISOString(),
    '版本：' + version,
    'Node：' + nodeInfo.source,
    'node.exe sha256：' + nodeInfo.sha256,
    installerPath ? '安装器：' + path.basename(installerPath) + '  sha256 ' + sha256(installerPath) : '（未生成安装器）',
    '耗时：' + ((Date.now() - started) / 1000).toFixed(1) + 's',
  ].join('\n');
  fs.writeFileSync(path.join(DIST, 'RELEASE.txt'), report + '\n', 'utf8');
  say('\n' + report);
  say('\n下一步：把' + (installerPath ? '安装器' : ' payload 目录') + '拷到目标机器，双击安装。');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    warn(String((e && e.stack) || e));
    process.exit(1);
  });
