#!/usr/bin/env node
// 发行包里的"宿主注册"脚本：由安装器在文件落盘后调用（用随包的 node.exe 运行）。
//
// 为什么不让 Inno 自己写注册表：allowed_origins 必须等于用户机器上那个扩展的 ID，
// 而这个 ID 只有在**用户机器上**才取得出来（发行包不知道用户把扩展加载到了哪个目录）。
// 所以注册这一步必须跑一段能读浏览器 Profile 的代码 —— 就是这里。
//
// 用法（安装器调用，不面向用户直接使用）：
//   node install-host.mjs --install --dir "<app>"      注册（认扩展 ID → 写 manifest → 写注册表）
//   node install-host.mjs --uninstall                  反注册（删注册表项与 manifest）
//   node install-host.mjs --stop [--port 7801]         升级前停掉正在运行的宿主与服务
//   node install-host.mjs --list-ids                   诊断：打印本机认出的扩展 ID
//
// 退出码：0 成功；3 = 还没在浏览器里加载扩展（安装器据此给出"先加载扩展"的提示）；其它非 0 = 真错误。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  detectExtensionIdsByPath,
  detectExtensionIdsByStorageMarker,
  detectExtensionIdsByDirName,
  browserTargets,
} from '../integrations/native-host/detect-extension.mjs';

const HOST_NAME = 'com.recallflow.bridge';
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const EXIT_NO_EXTENSION = 3;
const ID_RE = /^[a-p]{32}$/;
// 打包后本文件就躺在安装目录里，所以默认取自身所在目录（安装器也会显式传 --dir）。
const APP_DIR_DEFAULT = path.dirname(fileURLToPath(import.meta.url));

const say = (s) => process.stdout.write(s + '\n');
const warn = (s) => process.stderr.write('[install-host] ' + s + '\n');

function parseArgs(argv) {
  const out = { mode: '', dir: '', port: 7801, browsers: [], listIds: false, help: false, extensionIds: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const val = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(a + ' 缺少取值');
      return argv[i];
    };
    if (a === '--install') out.mode = 'install';
    else if (a === '--uninstall') out.mode = 'uninstall';
    else if (a === '--stop') out.mode = 'stop';
    else if (a === '--list-ids') out.listIds = true;
    else if (a === '--dir') out.dir = val();
    else if (a === '--port') out.port = Number(val());
    else if (a === '--browser') out.browsers = String(val()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--extension-id') out.extensionIds.push(String(val()).trim());
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error('未知参数：' + a);
  }
  return out;
}

function reg(args) {
  const r = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function targets(filter) {
  const all = browserTargets(LOCALAPPDATA);
  if (!filter.length) return all;
  return all.filter((b) => filter.includes(b.id) || filter.includes(b.name.toLowerCase()));
}

/**
 * 认扩展 ID，按可靠性排序，并返回"是怎么认出来的"用于诊断。
 *
 * 顺序的由来（每条都是实测/踩坑的结果）：
 *   1. 命令行指定 —— 静默部署/企业分发用；
 *   2. 扩展目录 = 安装目录 —— 万一有人把扩展解压进 app 目录；
 *   3. **本地存储记录** —— Preferences 里只有 path、没有 manifest/name（实测），
 *      但 `Local Extension Settings\<扩展ID>\` 的目录名就是 ID，内容含我们写的 recallflow.* 键；
 *   4. 扩展目录名白名单 —— 上面的目录只有在扩展跑过一次之后才存在，这是兜底；
 *   5. 都没有 → 退出码 3，让安装器提示用户"先在浏览器里加载扩展"。
 */
export function detectIds(userData, appDir, explicit) {  if (explicit && explicit.length) return { ids: explicit, how: '命令行指定' };
  const byPath = appDir ? detectExtensionIdsByPath(userData, appDir) : [];
  if (byPath.length) return { ids: byPath, how: '扩展目录 = 安装目录' };
  const byMarker = detectExtensionIdsByStorageMarker(userData);
  if (byMarker.length) return { ids: byMarker, how: '本扩展的本地存储记录' };
  const byDirName = detectExtensionIdsByDirName(userData);
  if (byDirName.length) return { ids: byDirName, how: '扩展目录名匹配' };
  return { ids: [], how: '' };
}

/** 都认不出来时，交互式让用户粘贴（只有真的在终端里跑才提示；静默安装不阻塞）。 */
function promptForId() {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('请粘贴 RecallFlow 的扩展 ID（edge://extensions / chrome://extensions 里那串小写字母）后回车：', (answer) => {
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

function writeManifest(appDir, ids) {
  const manifestPath = path.join(appDir, HOST_NAME + '.json');
  let origins = [];
  try {
    const prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    origins = (prev && prev.allowed_origins) || [];
  } catch (e) {
    origins = [];
  }
  const set = new Set(origins);
  for (const id of ids) set.add('chrome-extension://' + id + '/');
  const manifest = {
    name: HOST_NAME,
    description: 'RecallFlow 本地服务宿主：浏览器按需拉起 127.0.0.1 上的 MCP server',
    path: path.join(appDir, 'recallflow-native-host.exe'),
    type: 'stdio',
    allowed_origins: Array.from(set).sort(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifestPath, manifest };
}

function stopRunning(port, appDir) {
  // 1) 启动器：杀掉所有 recallflow-native-host.exe（浏览器拉起的那个壳）
  const t = spawnSync('taskkill', ['/IM', 'recallflow-native-host.exe', '/F'], { encoding: 'utf8', windowsHide: true });
  const killedHost = t.status === 0;
  // 2) 宿主本体：它也是 node.exe（跑 host.js），**同样锁着 {app}\node.exe**。
  //    只按镜像名杀会漏掉它 —— 实测残留就是它造成的（卸载后 node.exe / 宿主 exe 删不掉）。
  let killedNode = 0;
  if (appDir) {
    const safe = String(appDir).replace(/'/g, "''");
    const q = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*" + safe + "*' } | ForEach-Object { $_.ProcessId }",
      ],
      { encoding: 'utf8', windowsHide: true }
    );
    for (const line of String(q.stdout || '').split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (spawnSync('taskkill', ['/PID', String(pid), '/F'], { encoding: 'utf8', windowsHide: true }).status === 0) killedNode += 1;
    }
  }
  // 3) 服务：按端口找监听进程（它也是 {app}\node.exe）
  let killedServer = false;
  const ns = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  for (const line of String(ns.stdout || '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (!m || Number(m[1]) !== Number(port)) continue;
    spawnSync('taskkill', ['/PID', m[2], '/F'], { encoding: 'utf8', windowsHide: true });
    killedServer = true;
  }
  return { killedHost, killedNode, killedServer };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    warn(String(e.message));
    return 2;
  }
  if (args.help) {
    say('用法：install-host.mjs --install --dir <app> | --uninstall | --stop [--port N] | --list-ids');
    return 0;
  }
  const appDir = args.dir ? path.resolve(args.dir) : APP_DIR_DEFAULT;

  if (args.listIds) {
    say('安装目录：' + appDir);
    if (args.extensionIds.length) say('  命令行指定：' + args.extensionIds.join(', '));
    for (const b of targets(args.browsers)) {
      if (!fs.existsSync(b.userData)) {
        say('  ' + b.name + '：未安装/未使用过');
        continue;
      }
      const r = detectIds(b.userData, appDir, args.extensionIds);
      say('  ' + b.name + '：' + (r.ids.length ? r.ids.join(', ') + '（识别方式：' + r.how + '）' : '没找到 RecallFlow 扩展'));
    }
    return 0;
  }

  if (args.mode === 'stop') {
    const r = stopRunning(args.port || 7801, appDir);
    say(
      '停止运行中的宿主/服务：启动器=' + (r.killedHost ? '已停' : '未运行') +
        '，宿主本体=' + r.killedNode + ' 个' +
        '，服务=' + (r.killedServer ? '已停' : '未运行')
    );
    return 0;
  }

  if (args.mode === 'uninstall') {
    let removed = 0;
    for (const b of targets(args.browsers)) {
      const key = 'HKCU\\Software\\' + b.regSuffix + '\\NativeMessagingHosts\\' + HOST_NAME;
      const r = reg(['delete', key, '/f']);
      say('  ' + b.name + '：注册表' + (r.code === 0 ? '已删除' : '本来就没有'));
      if (r.code === 0) removed += 1;
    }
    try {
      fs.rmSync(path.join(appDir, HOST_NAME + '.json'), { force: true });
    } catch (e) {}
    say('宿主注册已移除（' + removed + ' 个浏览器）。用户数据与日志保留。');
    return 0;
  }

  if (args.mode !== 'install') {
    warn('必须指定 --install / --uninstall / --stop / --list-ids');
    return 2;
  }

  // ---- 安装：认扩展 ID → 写 manifest → 写注册表 ----
  const found = new Map(); // browser → { ids, how }
  for (const b of targets(args.browsers)) {
    if (!fs.existsSync(b.userData)) continue;
    found.set(b.name, detectIds(b.userData, appDir, args.extensionIds));
  }
  const allIds = new Set();
  for (const r of found.values()) r.ids.forEach((id) => allIds.add(id));

  if (!allIds.size) {
    // 自动识别失败：交互式问一次（Install 的"修复宿主注册"入口就是这么用的）
    say('');
    say('没能自动认出 RecallFlow 扩展的 ID。');
    say('  请在 Edge/Chrome 打开扩展页，找到 RecallFlow，复制它下面那串 32 位小写字母 ID。');
    const typed = await promptForId();
    if (ID_RE.test(typed)) {
      allIds.add(typed);
      say('  已接受手动输入的 ID：' + typed);
    } else {
      if (typed) warn('输入的不是合法扩展 ID（应为 32 位 a-p 字母）：' + typed);
      warn('没有在浏览器里找到 RecallFlow 扩展。');
      warn('请先在 Edge/Chrome 的扩展页启用「开发人员模式」→「加载解压缩的扩展」→ 指向扩展目录，');
      warn('然后运行开始菜单里的「RecallFlow 修复宿主注册」（或重跑安装器）。');
      return EXIT_NO_EXTENSION;
    }
  }
  for (const [browserName, r] of found) {
    if (r.ids.length) say('  ' + browserName + '：' + r.ids.join(', ') + '（识别方式：' + r.how + '）');
  }

  const { manifestPath, manifest } = writeManifest(appDir, Array.from(allIds));
  say('宿主 manifest：' + manifestPath);
  for (const o of manifest.allowed_origins) say('  允许来源：' + o);
  for (const b of targets(args.browsers)) {
    if (!fs.existsSync(b.userData)) {
      say('  ' + b.name + '：未安装/未使用过，跳过注册');
      continue;
    }
    const key = 'HKCU\\Software\\' + b.regSuffix + '\\NativeMessagingHosts\\' + HOST_NAME;
    const r = reg(['add', key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f']);
    say('  ' + b.name + '：' + (r.code === 0 ? '已注册' : '注册失败：' + r.out));
    if (r.code !== 0) return 4;
  }
  // 兼容：也写一份到 app 目录的 host.config.json（宿主找不到时用默认值，写了更明确）
  try {
    const cfgPath = path.join(appDir, 'host.config.json');
    if (!fs.existsSync(cfgPath)) {
      fs.writeFileSync(cfgPath, JSON.stringify({ port: args.port || 7801, mcpEntry: 'server.bundle.mjs' }, null, 2) + '\n', 'utf8');
    }
  } catch (e) {}
  say('完成：浏览器下次启动或扩展重载时会自动拉起本地服务。');
  return 0;
}

// 只有被直接执行时才跑 main（便于单测 import 其中的纯函数）。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) process.exit(await main());

