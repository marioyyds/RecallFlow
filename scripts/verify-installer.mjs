#!/usr/bin/env node
// 安装器验收（M2 回归）：静默安装 → 校验落位/注册表/卸载项 → 跑通服务 → 静默卸载 → 校验清理。
//
// 为什么必须有：
//   · 安装器会**真的往本机装东西**（写 HKCU、往 %LOCALAPPDATA% 落 89MB 文件），手点一遍无法复现；
//   · "卸载有没有清干净"是最容易漏的一条，而它恰恰是用户唯一会用来判断"装坏了没"的动作。
// 脚本会先保存当前（开发态）注册项，测完自动恢复，所以跑完机器仍回到可用状态。
//
// 用法：
//   node scripts/verify-installer.mjs                     # 自动找 dist/RecallFlow-Setup-*.exe
//   node scripts/verify-installer.mjs --setup <path.exe>
//   node scripts/verify-installer.mjs --keep              # 装完不卸载（人工看看界面）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectExtensionIdsByStorageMarker, browserTargets } from '../integrations/native-host/detect-extension.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const APP = path.join(LOCALAPPDATA, 'Programs', 'RecallFlow');
const START_MENU = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
const HOST_NAME = 'com.recallflow.bridge';
const KEYS = browserTargets(LOCALAPPDATA).map((b) => [b.name, 'HKCU\\Software\\' + b.regSuffix + '\\NativeMessagingHosts\\' + HOST_NAME]);
const EXPECTED_FILES = ['node.exe', 'recallflow-native-host.exe', 'host.js', 'server.bundle.mjs', 'install-host.mjs', 'host.config.json', 'install-host.cmd', 'README.txt', 'LICENSE-node.txt'];

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  ' + detail : ''));
};
const say = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { setup: '', keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--setup') out.setup = argv[++i] || '';
    else if (argv[i] === '--keep') out.keep = true;
  }
  return out;
}

function findSetup() {
  const dir = path.join(ROOT, 'dist');
  if (!fs.existsSync(dir)) return '';
  const f = fs.readdirSync(dir).find((x) => /^RecallFlow-Setup-.*\.exe$/i.test(x));
  return f ? path.join(dir, f) : '';
}

function regQuery(key) {
  const r = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
  const m = /REG_SZ\s+(.+)\s*$/.exec(String(r.stdout || '').trim());
  return m ? m[1].trim() : '';
}
const regExists = (key) => spawnSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true }).status === 0;

/** Inno 用 AppId 派生卸载键名，不能猜 —— 扫一遍按内容找（注意查全部值，默认值是空的）。 */
function findUninstallKey() {
  const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
  const r = spawnSync('reg', ['query', base], { encoding: 'utf8', windowsHide: true });
  for (const line of String(r.stdout || '').split(/\r?\n/).map((l) => l.trim())) {
    if (!/^HKEY_/i.test(line)) continue;
    const hkcu = line.replace(/^HKEY_CURRENT_USER/i, 'HKCU');
    const r2 = spawnSync('reg', ['query', hkcu], { encoding: 'utf8', windowsHide: true });
    if (String(r2.stdout || '').includes('RecallFlow')) return hkcu;
  }
  return '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const setup = path.resolve(args.setup || findSetup());
  if (!setup || !fs.existsSync(setup)) {
    console.error('找不到安装器。先构建：node scripts/build-dist.mjs --from-local-node');
    return 2;
  }
  say('安装器：' + setup + '（' + (fs.statSync(setup).size / 1048576).toFixed(1) + ' MB）');

  // 期望的扩展 ID：用与安装脚本相同的识别逻辑算出来，避免测试里硬编码（硬编码会掩盖识别退化）
  const expectedIds = new Set();
  for (const b of browserTargets(LOCALAPPDATA)) {
    if (!fs.existsSync(b.userData)) continue;
    for (const id of detectExtensionIdsByStorageMarker(b.userData)) expectedIds.add(id);
  }
  say('本机识别到扩展 ID：' + (Array.from(expectedIds).join(', ') || '（无）'));

  const backup = {};
  for (const [name, key] of KEYS) backup[key] = regQuery(key);
  say('已保存当前注册项（测完恢复）：' + JSON.stringify(backup));

  say('\n1) 静默安装');
  const log = path.join(os.tmpdir(), 'rf-setup-install.log');
  const install = spawnSync(setup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + log], { encoding: 'utf8', windowsHide: true });
  record('安装器退出码 0', install.status === 0, 'status=' + install.status);
  await sleep(1000);

  say('\n2) 安装目录');
  const missing = EXPECTED_FILES.filter((f) => !fs.existsSync(path.join(APP, f)));
  record('全部载荷文件都在', missing.length === 0, missing.length ? '缺少：' + missing.join(',') : EXPECTED_FILES.length + ' 个文件');

  say('\n3) 宿主 manifest');
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(APP, HOST_NAME + '.json'), 'utf8'));
  } catch (e) {}
  record('manifest 可解析且 name 正确', Boolean(manifest && manifest.name === HOST_NAME));
  record('path 指向安装目录里的 exe', Boolean(manifest && path.resolve(manifest.path) === path.resolve(path.join(APP, 'recallflow-native-host.exe'))), manifest ? manifest.path : '');
  const origins = (manifest && manifest.allowed_origins) || [];
  record(
    'allowed_origins 认出本机扩展 ID',
    expectedIds.size > 0 && Array.from(expectedIds).every((id) => origins.includes('chrome-extension://' + id + '/')),
    JSON.stringify(origins)
  );

  say('\n4) HKCU 注册表');
  for (const [name, key] of KEYS) {
    const v = regQuery(key);
    record(name + ' 指向已安装的 manifest', v === path.join(APP, HOST_NAME + '.json'), v || '（空）');
  }

  say('\n5) 卸载项与开始菜单');
  const unins = fs.existsSync(APP) ? fs.readdirSync(APP).find((f) => /^unins\d+\.exe$/i.test(f)) : '';
  record('存在卸载程序', Boolean(unins), unins || '（无）');
  const uninstallKey = findUninstallKey();
  record('"应用和功能"里有卸载项', Boolean(uninstallKey), uninstallKey || '（没找到）');
  const shortcuts = fs.existsSync(START_MENU) ? fs.readdirSync(START_MENU).filter((f) => f.includes('RecallFlow')) : [];
  record('开始菜单有 RecallFlow 快捷方式', shortcuts.length >= 2, shortcuts.join(' / '));

  say('\n6) 用已安装的宿主跑协议自检（隔离端口，不碰 7801）');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verify-native-host.mjs'), '--exe', path.join(APP, 'recallflow-native-host.exe'), '--port', '7841'], { encoding: 'utf8', cwd: ROOT });
  record('已安装的宿主自检通过', r.status === 0, (r.stdout || '').trim().split('\n').slice(-2).join(' | ').slice(0, 160));

  if (!args.keep) {
    say('\n7) 静默卸载');
    const un = spawnSync(path.join(APP, unins || 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { encoding: 'utf8', windowsHide: true });
    await sleep(2500);
    record('卸载器退出码 0', un.status === 0, 'status=' + un.status);
    const left = fs.existsSync(APP) ? fs.readdirSync(APP) : [];
    record('载荷文件全部删除', left.length === 0, left.join(',') || '（目录已删）');
    for (const [name, key] of KEYS) record(name + ' 注册项已移除', !regExists(key));
    record('"应用和功能"卸载项已移除', uninstallKey ? !regExists(uninstallKey) : false);
    const after = fs.existsSync(START_MENU) ? fs.readdirSync(START_MENU).filter((f) => f.includes('RecallFlow')) : [];
    record('开始菜单快捷方式已移除', after.length === 0, after.join(' / ') || '（无）');
  }

  say('\n8) 恢复开发态注册');
  const restore = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'install-native-host.mjs'), '--no-verify'], { encoding: 'utf8', cwd: ROOT });
  record('开发态安装脚本执行成功', restore.status === 0);
  for (const [name, key] of KEYS) {
    const v = regQuery(key);
    if (backup[key]) record(name + ' 注册项已恢复', v === backup[key], v);
  }

  const failed = results.filter((x) => !x.ok);
  say('\n' + (failed.length ? '✖ ' + failed.length + ' 项未通过：' + failed.map((f) => f.name).join('；') : '✔ 全部通过（' + results.length + ' 项）'));
  say('安装日志：' + log);
  return failed.length ? 1 : 0;
}

process.exit(await main());
