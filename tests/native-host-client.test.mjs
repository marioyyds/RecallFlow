// 扩展侧的 native messaging 客户端 + 发行态/开发态的扩展 ID 探测。
//
// 这两处都"错了也不报错"，只是功能静默失效，所以必须钉住：
//   · describeLastError：浏览器只给英文原文（not found / forbidden / exited），
//     翻译错了用户就永远不知道该做什么；
//   · 扩展 ID 探测：allowed_origins 与扩展 ID 差一个字符 → 浏览器拒绝启动宿主，
//     而 manifest 里的来源是安装器从浏览器 Profile 里反查出来的，探测逻辑必须准。
//
// ⚠ 单测里的扩展 ID 一律用 'x'.repeat(32) 生成。手写 32 位字符串已经错过一次
//   （31 位会被格式校验正确地拒绝，于是测试红得莫名其妙）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeLastError, stateLabel, NATIVE_HOST_STATE_KEY, isPortStale, PORT_STALE_MS } from '../lib/bridge/native-host.js';
import {
  detectExtensionIdsByPath,
  detectExtensionIdsByName,
  detectExtensionIdsByStorageMarker,
  detectExtensionIdsByDirName,
  readExtensionEntries,
} from '../integrations/native-host/detect-extension.mjs';
import { detectIds } from '../packaging/dist-install.mjs';

test('NATIVE_HOST_STATE_KEY: 存储键固定（设置页与 SW 共享同一份状态）', () => {
  assert.equal(NATIVE_HOST_STATE_KEY, 'recallflow.nativeHost');
});

test('describeLastError: 三种浏览器错误都翻译成"下一步做什么"', () => {
  const notFound = describeLastError('Specified native messaging host not found.');
  assert.match(notFound.message, /尚未安装本地宿主/);
  assert.match(notFound.hint, /install-native-host\.mjs/);

  const forbidden = describeLastError('Access to the specified native messaging host is forbidden.');
  assert.match(forbidden.message, /allowed_origins/);
  assert.match(forbidden.hint, /install-native-host\.mjs/);

  const exited = describeLastError('Native host has exited.');
  assert.match(exited.message, /刚启动就退出/);
  assert.match(exited.hint, /launcher\.log/);

  const empty = describeLastError('');
  assert.match(empty.message, /宿主已断开/);
  assert.ok(empty.hint.length > 0, '即使没有原文也要给出可操作的提示');

  const other = describeLastError('some unexpected failure');
  assert.equal(other.message, 'some unexpected failure', '未知错误要原样保留，不吞信息');
});

test('stateLabel: 状态 → 颜色档与文案（设置页状态灯直接用）', () => {
  assert.deepEqual(stateLabel({ status: 'ready', serverPid: 42 }), { tone: 'ok', text: '已就绪 · 本地服务运行中（pid 42）' });
  // 复用别人启动的实例时没有 pid，但不能因此显示成异常
  assert.equal(stateLabel({ status: 'ready' }).tone, 'ok');
  assert.equal(stateLabel({ status: 'ready' }).text, '已就绪 · 本地服务运行中');

  assert.equal(stateLabel({ status: 'degraded' }).tone, 'warn');
  assert.equal(stateLabel({ status: 'connecting' }).tone, 'wait');
  assert.equal(stateLabel({ status: 'unsupported' }).tone, 'bad');
  assert.match(stateLabel({ status: 'unsupported' }).text, /重新加载/);

  const disc = stateLabel({ status: 'disconnected', message: '尚未安装', hint: '去装' });
  assert.equal(disc.tone, 'bad');
  assert.equal(disc.text, '尚未安装（去装）');

  assert.equal(stateLabel(null).tone, 'wait');
  assert.equal(stateLabel({}).text, '未检查');
});

test('isPortStale: 僵尸端口必须能被识别（否则 connect 会被 if(port)return 永久挡住）', () => {
  assert.equal(isPortStale(false, 0, 1000), true, '没有端口时视为需要连接');
  assert.equal(isPortStale(true, 1000, 1000), false, '刚连上不算僵尸');
  assert.equal(isPortStale(true, 1000, 1000 + PORT_STALE_MS), false, '刚好到阈值仍算活着');
  assert.equal(isPortStale(true, 1000, 1000 + PORT_STALE_MS + 1), true, '超过阈值判为僵尸');
  // 阈值必须明显大于两个心跳周期，否则会把心跳稍有延迟的健康端口误判成僵尸、反复重连。
  assert.ok(PORT_STALE_MS > 45000, '阈值过小会把健康端口误判为僵尸：' + PORT_STALE_MS);
});

// ---------------- 合成浏览器 Profile 的小工具 ----------------

function makeProfile(userData, profileName, settings) {
  const dir = path.join(userData, profileName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Secure Preferences'), JSON.stringify({ extensions: { settings } }), 'utf8');
  return dir;
}

function makeLocalExtensionSettings(userData, profileName, id, marker) {
  const dir = path.join(userData, profileName, 'Local Extension Settings', id);
  fs.mkdirSync(dir, { recursive: true });
  // 模仿 leveldb：二进制 + 文本混合，只要包含我们写的存储键就算命中
  fs.writeFileSync(path.join(dir, '000049.ldb'), Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from('xx' + marker + 'yy', 'utf8')]));
  return dir;
}

// ---------------- 按路径识别（开发态） ----------------

test('detectExtensionIdsByPath: 只认"路径正好是本仓库目录"的扩展（大小写与斜杠形式无关）', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-profiles-'));
  const root = path.join(userData, 'my ext');
  const id = 'jfcapbkljjpeggbcogfpcobffkgfejjd';
  const other = 'bdcpdmmgjoimibpagmmgahboafhgjmei';
  try {
    makeProfile(userData, 'Default', {
      [id]: { path: root.toUpperCase() }, // Windows 大小写不敏感
      [other]: { path: path.join(userData, 'somewhere-else') },
      notAnExtensionId: { path: root }, // 不是合法扩展 ID：必须忽略
    });
    assert.deepEqual(detectExtensionIdsByPath(userData, root), [id]);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('detectExtensionIdsByPath: 扫多个 Profile；目录不存在时返回空数组（不抛异常）', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-profiles2-'));
  const root = path.join(userData, 'ext');
  const idA = 'a'.repeat(32);
  const idB = 'b'.repeat(32);
  try {
    makeProfile(userData, 'Default', { [idA]: { path: root + path.sep } }); // 末尾斜杠也不能影响匹配
    makeProfile(userData, 'Profile 2', { [idB]: { path: root } });
    assert.deepEqual(detectExtensionIdsByPath(userData, root).sort(), [idA, idB]);
    assert.deepEqual(detectExtensionIdsByPath(path.join(userData, 'nope'), root), []);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('detectExtensionIdsByPath: 坏 JSON 的 Profile 被跳过，不影响其它 Profile', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-profiles3-'));
  const root = path.join(userData, 'ext');
  const id = 'c'.repeat(32);
  try {
    const bad = path.join(userData, 'Default');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'Secure Preferences'), '{ this is not json', 'utf8');
    makeProfile(userData, 'Profile 1', { [id]: { path: root } });
    assert.deepEqual(detectExtensionIdsByPath(userData, root), [id]);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------- 按名称识别（仅当 Preferences 里真有 manifest.name） ----------------

test('detectExtensionIdsByName: 有 manifest.name 时可用；真实 Profile 没有该字段，所以返回空', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-profiles4-'));
  const idOurs = 'd'.repeat(32);
  const idOther = 'e'.repeat(32);
  try {
    makeProfile(userData, 'Default', {
      [idOurs]: { path: 'C:\\somewhere\\else\\bookmark-sorter', manifest: { name: 'RecallFlow', version: '0.0.1' } },
      [idOther]: { path: 'C:\\other\\ext', manifest: { name: 'Other Extension', version: '1.0.0' } },
    });
    makeProfile(userData, 'Profile 3', { [idOurs]: { path: 'D:\\portable\\recallflow', manifest: { name: 'RecallFlow' } } });
    assert.deepEqual(detectExtensionIdsByName(userData, 'RecallFlow'), [idOurs]);
    assert.deepEqual(detectExtensionIdsByName(userData, '不存在的名字'), []);
    assert.deepEqual(detectExtensionIdsByName(userData, ''), [], '空名字不能匹配到任何东西');

    // 真实 Profile 实测：解压扩展的条目里**没有** manifest/name（只有 path/location），
    // 所以这条路在发行态不可用 —— 这正是引入存储标记识别的原因。
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-profiles-real-'));
    try {
      makeProfile(real, 'Default', { [idOurs]: { path: 'D:\\Desktop\\workspace\\code\\ai\\bookmark-sorter', location: 4 } });
      assert.deepEqual(detectExtensionIdsByName(real, 'RecallFlow'), []);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('readExtensionEntries: 过滤掉非扩展 ID 的键，返回 id/path/name 三件套', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-profiles5-'));
  const id = 'f'.repeat(32);
  try {
    makeProfile(userData, 'Default', {
      [id]: { path: 'C:\\x', manifest: { name: 'RecallFlow' } },
      someOtherKey: { path: 'C:\\y' },
      [id + 'zz']: { path: 'C:\\z' },
    });
    const entries = readExtensionEntries(userData);
    assert.equal(entries.length, 1, JSON.stringify(entries));
    assert.equal(entries[0].id, id);
    assert.equal(entries[0].name, 'RecallFlow');
    assert.equal(entries[0].path, 'C:\\x');
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

// ---------------- 发行态识别：靠我们自己的存储记录 + 目录名 ----------------

test('detectExtensionIdsByStorageMarker: 靠"我们自己的存储键 + 目录名"认出扩展（发行态唯一精确办法）', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-marker-'));
  const idOurs = 'a'.repeat(32);
  const idOther = 'b'.repeat(32);
  try {
    makeLocalExtensionSettings(userData, 'Default', idOurs, 'recallflow.nativeHost');
    makeLocalExtensionSettings(userData, 'Default', idOther, 'someOtherExtensionKey');
    assert.deepEqual(detectExtensionIdsByStorageMarker(userData), [idOurs]);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('detectExtensionIdsByStorageMarker: 目录名不是合法扩展 ID 时忽略；目录不存在不抛异常', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-marker2-'));
  try {
    makeLocalExtensionSettings(userData, 'Default', 'not-an-extension-id', 'recallflow.skills');
    assert.deepEqual(detectExtensionIdsByStorageMarker(userData), []);
    assert.deepEqual(detectExtensionIdsByStorageMarker(path.join(userData, 'nope')), []);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('detectExtensionIdsByDirName: 只认白名单里的**完整目录名**（包含匹配会把无关扩展也放进来）', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-dirname-'));
  const idOk = 'c'.repeat(32);
  const idTrap = 'd'.repeat(32);
  try {
    makeProfile(userData, 'Default', {
      [idOk]: { path: 'C:\\Users\\x\\Downloads\\bookmark-sorter' },
      [idTrap]: { path: 'C:\\Users\\x\\not-recallflow-test' }, // 含 'recallflow' 但不是白名单完整名
    });
    assert.deepEqual(detectExtensionIdsByDirName(userData), [idOk]);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('dist-install.detectIds: 识别顺序 —— 命令行 > 安装目录 > 存储记录 > 目录名', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-order-'));
  const idByPath = 'e'.repeat(32);
  const idByMarker = 'f'.repeat(32);
  const appDir = path.join(userData, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  try {
    // 只有存储记录时：用存储记录
    makeLocalExtensionSettings(userData, 'Default', idByMarker, 'recallflow.nativeHost');
    let r = detectIds(userData, appDir, []);
    assert.deepEqual(r.ids, [idByMarker]);
    assert.match(r.how, /存储/);

    // 再加一个"扩展目录 = 安装目录"的条目：应当优先命中路径匹配
    makeProfile(userData, 'Profile 1', { [idByPath]: { path: appDir } });
    r = detectIds(userData, appDir, []);
    assert.deepEqual(r.ids, [idByPath]);
    assert.match(r.how, /安装目录/);

    // 命令行指定优先级最高
    const explicit = 'a'.repeat(32);
    r = detectIds(userData, appDir, [explicit]);
    assert.deepEqual(r.ids, [explicit]);
    assert.match(r.how, /命令行/);

    // 什么都没有：返回空并说明没有识别方式（调用方据此走交互提示 / 退出码 3）
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-order-empty-'));
    try {
      const none = detectIds(empty, appDir, []);
      assert.deepEqual(none.ids, []);
      assert.equal(none.how, '');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
