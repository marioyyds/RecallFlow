#!/usr/bin/env node
// 安装器**升级路径**验收：已装且正在运行时再装一次。
//
// 为什么单独一条：Windows 不允许覆盖正在运行的 exe，而"只杀进程"不够 ——
// 扩展会立刻按注册表把宿主拉回来（实测 1 秒），文件重新被锁住，安装器会以退出码 5 失败。
// 正确顺序是「先反注册（让扩展拉不起来）→ 再停宿主与服务 → 再替换文件 → 装完注册回去」。
// 这条路径不做，升级就会变成"失败但没人知道"。
//
// 用法：
//   node scripts/verify-installer-upgrade.mjs [--setup <path.exe>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserTargets } from '../integrations/native-host/detect-extension.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const APP = path.join(LOCALAPPDATA, 'Programs', 'RecallFlow');
const HOST_EXE = path.join(APP, 'recallflow-native-host.exe');
const HOST_NAME = 'com.recallflow.bridge';
const KEYS = browserTargets(LOCALAPPDATA).map((b) => [b.name, 'HKCU\\Software\\' + b.regSuffix + '\\NativeMessagingHosts\\' + HOST_NAME]);

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail ? '  ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (cmd) => spawnSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).stdout || '';
const hostPids = () =>
  ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'host\\.js' } | ForEach-Object { $_.ProcessId }")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
const listeners = () =>
  ps("(Get-NetTCPConnection -LocalPort 7801 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '0');
const installedHostRunning = () => ps("Get-CimInstance Win32_Process -Filter \"Name='recallflow-native-host.exe'\" | ForEach-Object { $_.CommandLine }").includes('Programs\\RecallFlow');
const regQuery = (key) => {
  const r = spawnSync('reg', ['query', key, '/ve'], { encoding: 'utf8', windowsHide: true });
  const m = /REG_SZ\s+(.+)\s*$/.exec(String(r.stdout || '').trim());
  return m ? m[1].trim() : '';
};
const sha = (p) => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
  } catch (e) {
    return '';
  }
};

function findSetup() {
  const dir = path.join(ROOT, 'dist');
  if (!fs.existsSync(dir)) return '';
  const f = fs.readdirSync(dir).find((x) => /^RecallFlow-Setup-.*\.exe$/i.test(x));
  return f ? path.join(dir, f) : '';
}

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--setup');
  const setup = path.resolve(i >= 0 ? argv[i + 1] : findSetup());
  if (!setup || !fs.existsSync(setup)) {
    console.error('找不到安装器。先构建：node scripts/build-dist.mjs --from-local-node');
    return 2;
  }
  const payloadReadmeSha = sha(path.join(ROOT, 'packaging', 'PAYLOAD-README.txt'));

  console.log('0) 清场（上一轮失败可能留下占着文件的宿主）');
  for (const p of hostPids()) spawnSync('taskkill', ['/PID', p, '/F'], { stdio: 'ignore' });
  for (const p of listeners()) spawnSync('taskkill', ['/PID', p, '/F'], { stdio: 'ignore' });
  spawnSync('taskkill', ['/IM', 'recallflow-native-host.exe', '/F'], { stdio: 'ignore' });
  await sleep(1500);
  fs.rmSync(APP, { recursive: true, force: true });
  record('清场：安装目录已删除', !fs.existsSync(APP));

  console.log('\n1) 先装一次');
  record('首次静默安装', spawnSync(setup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true }).status === 0);
  await sleep(800);
  const exeBefore = sha(HOST_EXE);
  // 正确的"载荷被替换"探针：篡改一个**安装器管得到的**文件，升级后它应被还原。
  // （不能拿"自己造的文件还在不在"当探针 —— Inno 不删除它没装过的文件。）
  const readme = path.join(APP, 'README.txt');
  fs.appendFileSync(readme, '\nTAMPERED-BY-TEST\n');
  const tamperedSha = sha(readme);

  console.log('\n2) 让扩展按注册表拉起"已安装"的宿主（杀掉开发态宿主即可）');
  for (const p of hostPids()) spawnSync('taskkill', ['/PID', p, '/F'], { stdio: 'ignore' });
  let installedUp = false;
  // 窗口给到 120s：扩展的重连退避上限是 20s，但浏览器里可能还加载着更老的版本
  for (let n = 0; n < 120 && !installedUp; n += 1) {
    await sleep(1000);
    installedUp = installedHostRunning();
  }
  record('已安装的宿主被浏览器拉起', installedUp);
  await sleep(1500);
  record('服务在运行（宿主已 ensure）', listeners().length > 0, 'pid=' + listeners().join(','));

  console.log('\n3) 运行中再装一次（升级）');
  const log = path.join(os.tmpdir(), 'rf-setup-upgrade.log');
  const up = spawnSync(setup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + log], { windowsHide: true, encoding: 'utf8' });
  record('升级退出码 0（说明文件没被占用）', up.status === 0, 'status=' + up.status);
  await sleep(1200);
  const afterSha = sha(readme);
  record('载荷被真的替换（被篡改的文件已还原）', afterSha === payloadReadmeSha && afterSha !== tamperedSha, tamperedSha + ' → ' + afterSha);
  record('exe 仍存在', fs.existsSync(HOST_EXE), sha(HOST_EXE) + '（升级前 ' + exeBefore + '）');
  record('注册表仍指向已安装 manifest', regQuery(KEYS[0][1]) === path.join(APP, HOST_NAME + '.json'), regQuery(KEYS[0][1]));

  console.log('\n4) 等扩展自动恢复');
  let back = false;
  for (let n = 0; n < 120 && !back; n += 1) {
    await sleep(1000);
    back = listeners().length > 0;
  }
  record('服务自动恢复', back, back ? 'pid=' + listeners().join(',') : '120s 内未恢复');

  console.log('\n5) 卸载并恢复开发态注册');
  const unins = fs.existsSync(APP) ? fs.readdirSync(APP).find((f) => /^unins\d+\.exe$/i.test(f)) : '';
  if (unins) spawnSync(path.join(APP, unins), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true });
  await sleep(2500);
  const left = fs.existsSync(APP) ? fs.readdirSync(APP) : [];
  record('卸载后载荷文件全部删除', left.length === 0, left.join(',') || '（目录已删）');
  const restore = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'install-native-host.mjs'), '--no-verify'], { encoding: 'utf8', cwd: ROOT });
  record('开发态注册已恢复', restore.status === 0 && regQuery(KEYS[0][1]).includes('bookmark-sorter'), regQuery(KEYS[0][1]));

  const failed = results.filter((x) => !x.ok);
  console.log('\n' + (failed.length ? '✖ ' + failed.length + ' 项未通过：' + failed.map((f) => f.name).join('；') : '✔ 全部通过（' + results.length + ' 项）'));
  console.log('升级日志：' + log);
  return failed.length ? 1 : 0;
}

process.exit(await main());
