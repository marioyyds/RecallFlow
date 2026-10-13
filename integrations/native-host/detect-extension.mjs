// 从浏览器 Profile 里找出 RecallFlow 扩展 ID。
//
// 为什么必须准：native messaging 的 allowed_origins 必须与扩展 ID 完全一致，
// 差一个字符就是 "Access to the specified native messaging host is forbidden"，
// 而浏览器**不会**告诉用户原因。所以这里做成纯函数并单测（tests/native-host-client.test.mjs）。
//
// 两种识别方式，各有用处：
//   · 按路径：解压扩展的 ID 由绝对路径推导，仓储开发态（扩展就在本仓库里）用这个最准；
//   · 按名称：发行包里我们**不知道**用户从哪个目录加载的扩展，只能靠 manifest.name 认人。
import fs from 'node:fs';
import path from 'node:path';

/** 路径归一化后比较：Windows 大小写不敏感，浏览器存的可能是正/反斜杠混合。 */
export function normPath(p) {
  return path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** 列出浏览器用户数据目录下的 Profile（Default / Profile N）。 */
export function listProfileDirs(userDataDir) {
  try {
    return fs
      .readdirSync(userDataDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
      .map((d) => path.join(userDataDir, d.name));
  } catch (e) {
    return [];
  }
}

/**
 * 读出所有扩展条目：{ id, path, name }。
 * 两个文件都要读：新版 Chrome/Edge 把扩展信息放 Secure Preferences，旧版/部分字段在 Preferences。
 * 坏 JSON 直接跳过（不能因为一个 Profile 坏掉就整个探测失败）。
 */
export function readExtensionEntries(userDataDir) {
  const out = [];
  for (const profile of listProfileDirs(userDataDir)) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      const p = path.join(profile, file);
      if (!fs.existsSync(p)) continue;
      let json = null;
      try {
        json = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        continue;
      }
      const settings = json && json.extensions && json.extensions.settings;
      if (!settings || typeof settings !== 'object') continue;
      for (const [id, entry] of Object.entries(settings)) {
        if (!entry || typeof entry !== 'object') continue;
        if (!/^[a-p]{32}$/.test(id)) continue; // 只认合法扩展 ID，避免把别的键当扩展
        const manifest = entry.manifest && typeof entry.manifest === 'object' ? entry.manifest : {};
        out.push({ id, path: entry.path || '', name: manifest.name || '', file: p });
      }
    }
  }
  return out;
}

/** 按"扩展目录 = 指定根目录"识别（仓储开发态）。 */
export function detectExtensionIdsByPath(userDataDir, rootDir) {
  const want = normPath(rootDir);
  const ids = new Set();
  for (const e of readExtensionEntries(userDataDir)) {
    if (e.path && normPath(e.path) === want) ids.add(e.id);
  }
  return Array.from(ids);
}

/** 按扩展名识别（发行包：扩展可能被加载在任意目录）。 */
export function detectExtensionIdsByName(userDataDir, name = 'RecallFlow') {
  const want = String(name || '').trim();
  if (!want) return [];
  const ids = new Set();
  for (const e of readExtensionEntries(userDataDir)) {
    if (e.name && e.name.trim() === want) ids.add(e.id);
  }
  return Array.from(ids);
}

/**
 * 按「我们自己的 chrome.storage 键」识别。
 *
 * 为什么需要它（实测教训）：浏览器 Preferences 里**只有 path**，没有 manifest/name
 * （解压扩展的条目只有 path/location 等字段），所以"按名称识别"在真实 Profile 上什么都找不到。
 * 但 chrome.storage.local 落盘在 `<Profile>\Local Extension Settings\<扩展ID>\` —— **目录名就是扩展 ID**，
 * 而内容里能找到我们写的存储键。这是发行态唯一既精确又不依赖扩展安装路径的办法。
 *
 * @param {string[]} markers 我们自己写的存储键（不是通用前缀匹配，避免误判成别的扩展）
 */
export function detectExtensionIdsByStorageMarker(userDataDir, markers = ['recallflow.nativeHost', 'recallflow.skills', 'recallflow.handoff.', 'recallflow.lastPicked']) {
  const wanted = markers.map((m) => Buffer.from(String(m), 'utf8'));
  const ids = new Set();
  for (const profile of listProfileDirs(userDataDir)) {
    const dir = path.join(profile, 'Local Extension Settings');
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !/^[a-p]{32}$/.test(e.name)) continue;
      const sub = path.join(dir, e.name);
      let hit = false;
      try {
        for (const f of fs.readdirSync(sub)) {
          const p = path.join(sub, f);
          let st = null;
          try {
            st = fs.statSync(p);
          } catch (err) {
            continue;
          }
          // leveldb 文件可能很大（本项目实测最大的 3MB+）：超过阈值就跳过，避免安装器变慢
          if (!st.isFile() || st.size === 0 || st.size > 16 * 1024 * 1024) continue;
          const buf = fs.readFileSync(p);
          if (wanted.some((w) => buf.includes(w))) {
            hit = true;
            break;
          }
        }
      } catch (err) {
        /* 目录被浏览器占用/权限不足：跳过这个 ID */
      }
      if (hit) ids.add(e.name);
    }
  }
  return Array.from(ids);
}

/**
 * 最后的启发式：扩展目录名像个 RecallFlow 目录。
 * 刻意用**完整目录名白名单**而不是包含匹配 —— 包含匹配会把 `not-recallflow-test` 也算进来，
 * 而 allowed_origins 多写一个就等于多允许一个扩展调用本地宿主。
 */
export function detectExtensionIdsByDirName(userDataDir, names = ['bookmark-sorter', 'recallflow', 'recallflow-extension']) {
  const allow = new Set(names.map((n) => String(n).toLowerCase()));
  const ids = new Set();
  for (const e of readExtensionEntries(userDataDir)) {
    if (!e.path) continue;
    const base = path.basename(e.path.replace(/[\\/]+$/, '')).toLowerCase();
    if (allow.has(base)) ids.add(e.id);
  }
  return Array.from(ids);
}

/** 本机所有浏览器（有用户数据目录的）及其扩展 ID。 */
export function browserTargets(localAppData) {
  return [
    { id: 'edge', name: 'Edge', regSuffix: 'Microsoft\\Edge', userData: path.join(localAppData, 'Microsoft', 'Edge', 'User Data') },
    { id: 'chrome', name: 'Chrome', regSuffix: 'Google\\Chrome', userData: path.join(localAppData, 'Google', 'Chrome', 'User Data') },
  ];
}
