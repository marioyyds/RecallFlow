#!/usr/bin/env node
/**
 * 能力档位真机验证：一条命令回答"接进来的方法，扩展那边认得吗、能不能往返"。
 *
 * 用法：
 *   node scripts/verify-capability-tiers.mjs              # 默认：全部方法，跳过网络/重活类
 *   node scripts/verify-capability-tiers.mjs --all        # 连 web_search / take_screenshot 也探
 *   node scripts/verify-capability-tiers.mjs 3080         # 指定 DSH 端口
 *
 * ## 为什么这事**能**用脚本查
 *
 * `verify-live-gate.mjs` 的头部原本写着"DSH 里调用 recallflow_browser 能往返 —— 脚本查不了，
 * 那个工具只能由模型调用"。**工具**确实只有模型能调，但插件把**探针入口**挂成了
 * `POST /recallflow/probe-tool`，而且**路径由 status 自己报出来**（`status.probeToolPath`），
 * 所以脚本不必硬编码路径。该入口只放行 `BROWSER_METHODS`（只读档白名单），于是它一次验证两件事：
 *
 *   ① 只读档的每个方法，扩展 dispatch **真的认得**（不是 `unknown method`）；
 *   ② 三档受控方法**打不进去** —— 被白名单挡下。
 *      这正是一条被契约测试钉住的安全性质：**诊断入口永远不会触发有副作用的动作**。
 *
 * ## 判据是**载荷**，不是 HTTP 状态码（写这个脚本时踩过两次）
 *
 * - 只看状态码 → 探针在"扩展不认得这个方法"时也会回 **200**，载荷里才是
 *   `{error:'unknown method: …'}`。第一版因此把 19 个未接线的方误报成"58/58 往返成功"。
 * - 把所有 `{error}` 都当失败 → 又太严：探针只传空参数，`browser_read`（要 url）、
 *   `handoff_get`（要 id）、`get_attribute`（要 selector）会**合理地**报参数错，
 *   那恰恰说明**方法被认得了**。
 *
 * 所以真正的判据只有一条：**扩展是不是回 `unknown method`**。
 *
 * ## 安全性
 *
 * 受控方法是在**执行之前**被白名单拒掉的：插件里那句
 * `if (!BROWSER_METHODS.includes(method)) { … 400 … return; }` 位于 `callBrowser` **之前**。
 * 所以这个脚本**不可能**触发点击/输入/写数据 —— 这不是"我相信它不会"，而是代码顺序决定它到不了那一步。
 *
 * ## 什么时候要跑
 *
 * 插件是**启动时载入**的：改了插件必须**重启 DSH**。
 * 改了 `lib/bridge/*` 或 `lib/assistant/*` 要**重载扩展**（chrome://extensions → ↻）。
 * 注意**只刷新页面是不够的**：扩展后台是 MV3 service worker，而它与 `/recallflow/ws`
 * 的长连接会让它一直活着、不会因为空闲而重启，所以旧代码会一直留在那里。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  BRIDGE_METHODS,
  BROWSER_ACTION_METHODS,
  DANGEROUS_METHODS,
  EXTENSION_METHODS,
  PAGE_ACTION_BACKGROUND_METHODS,
  PAGE_ACTION_CONTENT_METHODS,
  READONLY_BACKGROUND_METHODS,
  READONLY_CONTENT_METHODS,
} from '../lib/shared/bridge-methods.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_FILE = path.join(ROOT, 'integrations', 'dsh-plugin-recallflow-one', 'index.js');

const args = process.argv.slice(2);
const probeAll = args.includes('--all');
const port = Number(args.filter((a) => /^\d+$/.test(a))[0] || 3080);
const base = 'http://127.0.0.1:' + port;

/** 网络/重活类：默认跳过（会真的发网络请求，或产出很大的截图）。用 --all 才探。 */
const SKIP_BY_DEFAULT = new Set(['web_search', 'take_screenshot']);

/** 方法 → 它属于哪一档（用于打印，以及判断"被挡下"是不是预期内的）。 */
function tierOf(method) {
  if (BRIDGE_METHODS.includes(method)) return 'MCP 清单';
  if (READONLY_CONTENT_METHODS.includes(method)) return '只读·页面';
  if (READONLY_BACKGROUND_METHODS.includes(method)) return '只读·后台';
  if (PAGE_ACTION_CONTENT_METHODS.includes(method)) return '改页面（受控）';
  if (PAGE_ACTION_BACKGROUND_METHODS.includes(method)) return '改页面（受控）';
  if (BROWSER_ACTION_METHODS.includes(method)) return '浏览器/网络（受控）';
  if (DANGEROUS_METHODS.includes(method)) return '危险（受控）';
  return '未归类';
}

const GATED = new Set([
  ...PAGE_ACTION_CONTENT_METHODS,
  ...PAGE_ACTION_BACKGROUND_METHODS,
  ...BROWSER_ACTION_METHODS,
  ...DANGEROUS_METHODS,
]);

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let text = '';
  try {
    text = await res.text();
  } catch {}
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body };
}

async function getJson(url) {
  const res = await fetch(url);
  let text = '';
  try {
    text = await res.text();
  } catch {}
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, text, body };
}

function sha12(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
}

async function main() {
  console.log('--- 能力档位验证（DSH :' + port + '）---');

  // 第 0 步：已载入的是不是磁盘上的代码？不是的话后面全是白测。
  const wantSha = sha12(PLUGIN_FILE);
  const status = await getJson(base + '/recallflow/status');
  if (status.status !== 200 || !status.body) {
    console.log('  ✗ 读不到 /recallflow/status（HTTP ' + status.status + '）—— DSH 在跑吗？插件载入了吗？');
    process.exit(2);
  }
  const loaded = (status.body.build && status.body.build.sha256_12) || '(status 里没有 build 字段)';
  const fresh = loaded === wantSha;
  console.log('  ' + (fresh ? '✓' : '✗') + ' 插件是新代码：磁盘=' + wantSha + '  已载入=' + loaded);
  if (!fresh) {
    console.log('      → 插件是**启动时载入**的。请**重启 DSH** 后再跑本脚本；在那之前下面所有结论都不作数。');
    process.exit(2);
  }
  const clients = Number(status.body.clients || 0);
  console.log('  ' + (clients >= 1 ? '✓' : '✗') + ' 扩展已连上（clients=' + clients + '）');
  if (clients < 1) {
    console.log('      → 打开浏览器面板让扩展连上 ' + status.body.wsPath + ' 再跑。');
    process.exit(2);
  }

  const probePath = status.body.probeToolPath || '/recallflow/probe-tool';
  console.log('  探针入口：' + probePath + '（由 status 自己报出，脚本不硬编码）');
  console.log('');

  const rows = [];
  for (const method of EXTENSION_METHODS) {
    if (!probeAll && SKIP_BY_DEFAULT.has(method)) {
      rows.push({ method, tier: tierOf(method), verdict: '跳过（--all 才探）', ok: true, note: '' });
      continue;
    }
    const r = await postJson(base + probePath, { method });
    const gated = GATED.has(method);
    const topErr = String((r.body && r.body.error) || '');
    const valueErr = String((r.body && r.body.value && r.body.value.error) || '');
    const anyErr = topErr || valueErr;

    let verdict;
    let ok;
    let note = '';
    if (/不允许的方法/.test(topErr)) {
      // 被白名单挡下：受控档这是**预期且想要**的结果；其余档出现则是接线漏了。
      verdict = gated ? '被白名单挡下（预期）' : '被白名单挡下（✗ 不该）';
      ok = gated;
    } else if (/unknown method/.test(anyErr)) {
      // ★ 唯一的硬判据：扩展不认得 = 清单与 dispatch 不一致（通常是扩展没重载）
      verdict = '✗ 扩展不认得（清单 ↔ dispatch 不一致）';
      ok = false;
      note = anyErr.slice(0, 100);
    } else if (anyErr) {
      // 方法被认得了，错误在业务/参数层（探针只传空参数）。接线是通的。
      verdict = '方法认得（业务/参数层报错，接线通）';
      ok = true;
      note = anyErr.slice(0, 100);
    } else if (r.status === 200) {
      verdict = '往返成功';
      ok = true;
    } else if (r.status === 503) {
      verdict = '方法认得，浏览器侧无连接/业务失败（接线通）';
      ok = true;
    } else {
      verdict = '其它（HTTP ' + r.status + '）';
      ok = false;
    }
    rows.push({ method, tier: tierOf(method), verdict, ok, note });
  }

  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  console.log('  ' + pad('方法', 24) + pad('档位', 18) + '结果');
  for (const r of rows) {
    console.log(
      '  ' +
        (r.ok ? '✓ ' : '✗ ') +
        pad(r.method, 22) +
        pad(r.tier, 18) +
        r.verdict +
        (r.note && !r.ok ? '  ← ' + r.note : '')
    );
  }

  const bad = rows.filter((r) => !r.ok);
  console.log('');
  console.log('  合计 ' + rows.length + ' 个方法：' + (rows.length - bad.length) + ' 通过、' + bad.length + ' 有问题');
  if (bad.length) {
    console.log('  有问题的：' + bad.map((r) => r.method).join('、'));
    console.log('      → 若报的是 `unknown method`，先确认扩展是否**重载过**（只刷新页面不够）。');
    process.exit(1);
  }
  console.log('  ✓ 只读档全部被扩展认得；三档受控方法全部被白名单挡下（诊断入口永不触发有副作用的动作）');
}

main().catch((e) => {
  console.log('  ✗ 脚本自身出错：' + (e && e.message));
  process.exit(3);
});
