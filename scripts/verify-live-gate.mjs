#!/usr/bin/env node
/**
 * 闸门检查：端到端验证开始之前，这五条必须成立（见 docs/deletion-plan.md）。
 *
 * 用法：
 *   node scripts/verify-live-gate.mjs                # 只做无副作用的检查
 *   node scripts/verify-live-gate.mjs --say          # 额外真的发一句话进会话（有副作用！）
 *   node scripts/verify-live-gate.mjs 3080 7801      # 指定 DSH 端口与桥接端口
 *
 * 为什么单独写一个：闸门里既有"新通道好了没"也有"旧链路有没有被弄坏"，
 * 混在人工核对里最容易漏掉后者 —— 而我恰恰干过一次（把扩展的桥接连接换成指向 DSH，
 * 差点让 opencode 的页面工具静默失效）。把它变成一条命令，就不会靠记忆。
 *
 * 说明：第 5 条（DSH 里调用 recallflow_browser 能往返）**脚本查不了** ——
 * 那个工具只能由模型调用。因此这里只打印提醒，不假装检查了。
 */

const args = process.argv.slice(2);
const withSay = args.includes('--say');
const ports = args.filter((a) => /^\d+$/.test(a));
const dshPort = Number(ports[0] || 3080);
const bridgePort = Number(ports[1] || 7801);

const results = [];
function check(label, ok, detail) {
  results.push({ label, ok });
  console.log('  ' + (ok ? '✓ ' : '✗ ') + label + (ok || !detail ? '' : '\n      → ' + detail));
}

async function get(url, init) {
  const res = await fetch(url, init);
  let text = '';
  try {
    text = await res.text();
  } catch {}
  return { status: res.status, text };
}

async function main() {
  console.log('--- 闸门检查（DSH :' + dshPort + '，桥接 :' + bridgePort + '）---');

  // 1) 插件是不是新代码：/recallflow/status 只在新版里有
  let snap = null;
  try {
    const r = await get('http://127.0.0.1:' + dshPort + '/recallflow/status');
    if (r.status === 200) {
      try {
        snap = JSON.parse(r.text);
      } catch {}
    }
    check(
      '插件是新代码（GET /recallflow/status 返回 200）',
      r.status === 200 && !!snap,
      '实际 HTTP ' + r.status + ' ' + r.text.slice(0, 120) + '（404 = DSH 还没重启）'
    );
  } catch (e) {
    check('插件是新代码（GET /recallflow/status 返回 200）', false, e.message);
  }

  // 2) 扩展是否连上了新通道
  if (snap) {
    check(
      '扩展已连上新通道（status.clients >= 1）',
      Number(snap.clients) >= 1,
      'clients=' + snap.clients + ' wsReady=' + snap.wsReady + '（0 = 扩展还没重新加载）'
    );
    check(
      '插件已认到会话（status.sessions 非空）',
      Array.isArray(snap.sessions) && snap.sessions.length > 0,
      'sessions=' + JSON.stringify(snap.sessions) + '（空 = 注册表兜底也没找到 agent）'
    );
  } else {
    check('扩展已连上新通道（status.clients >= 1）', false, '拿不到 status，无法判断');
    check('插件已认到会话（status.sessions 非空）', false, '拿不到 status，无法判断');
  }

  // 3) 旧链路没被弄坏：桥接还活着，而且有客户端连着
  //    这一条是"没删坏"的基线 —— 桥接服务 opencode，不能因为新架构把它晾着。
  try {
    const r = await get('http://127.0.0.1:' + bridgePort + '/health', {
      headers: { 'X-RecallFlow-Token': 'recallflow-local-bridge-v1' },
    });
    let health = null;
    try {
      health = JSON.parse(r.text);
    } catch {}
    check('桥接存活（/health ok）', !!(health && health.ok), 'HTTP ' + r.status + ' ' + r.text.slice(0, 120));
    check(
      '桥接有客户端连着（opencode 那条链路的基线）',
      !!(health && health.ws),
      'health.ws=' + (health ? health.ws : '(无)') + ' —— false 时 opencode 的页面工具会拿不到结果'
    );
  } catch (e) {
    check('桥接存活（/health ok）', false, e.message);
    check('桥接有客户端连着（opencode 那条链路的基线）', false, e.message);
  }

  // 4) 输入通道（有副作用，需显式开启）
  if (withSay) {
    try {
      const r = await get('http://127.0.0.1:' + dshPort + '/recallflow/say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '【自检】闸门检查：这条消息应当以真用户消息出现在会话里。' }),
      });
      let body = null;
      try {
        body = JSON.parse(r.text);
      } catch {}
      check(
        'POST /recallflow/say 把话送进了会话（ok:true 且带 sessionId）',
        !!(body && body.ok && body.sessionId),
        'HTTP ' + r.status + ' ' + r.text.slice(0, 160)
      );
    } catch (e) {
      check('POST /recallflow/say 把话送进了会话（ok:true 且带 sessionId）', false, e.message);
    }
  } else {
    console.log('  · 跳过输入通道检查（加 --say 才会真的发一句话，那有副作用）');
  }

  // 5) 脚本查不了的那一条，明确说出来
  console.log('  · 第 5 条（DSH 里调用 recallflow_browser 能往返）脚本查不了：');
  console.log('    那个工具只能由模型调用。请在会话里让它读一次当前页面来确认。');

  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(failed ? '✗ ' + failed + ' 条未成立（端到端验证还不能开始）' : '✓ 闸门成立（' + results.length + ' 条）');
  // 用 process.exitCode 而**不是** process.exit()：
  // 在 Windows 上，process.exit() 会在 undici 的 socket 收尾时撞上 libuv 断言
  // （uv_async.c:94），把"验证通过"变成崩溃退出码 0xC0000409 ——
  // 脚本自己打印 ✓、退出码却是崩溃，任何自动化都会把它判成失败。
  // 这条经验仓库文档里早有记载，我第一版仍然用了 process.exit()，实测复现了 0xC0000409。
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.log('闸门脚本异常：' + (e && e.message));
  process.exitCode = 1;
});
