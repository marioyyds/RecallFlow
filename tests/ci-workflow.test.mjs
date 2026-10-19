// CI 工作流的结构门禁。
//
// 起因：完整 E2E（87 条，真浏览器 + 真扩展）跑完要好几分钟，绝不能挂在每个 PR 上。
// 于是它被放进一个靠 `if: github.event_name == ...` 守卫的 job 里。
// 但**这个守卫没有任何东西保护** —— 谁顺手删掉那一行，每个 PR 就会多等 45 分钟，
// 而 PR 页面上看不出为什么变慢了。这类"配置写对了但没人盯"的情况，
// 正是本仓库在 .github/ 里已经踩过一次的坑（门禁不被强制运行就等于不存在）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WF = '.github/workflows/checks.yml';
const src = fs.readFileSync(WF, 'utf8');

/** 按缩进切出每个 job 块（只认顶层两个空格缩进的 job）。 */
function jobs(text) {
  const out = new Map();
  let cur = null;
  let buf = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      if (cur) out.set(cur, buf.join('\n'));
      cur = m[1];
      buf = [];
      continue;
    }
    if (cur) buf.push(line);
  }
  if (cur) out.set(cur, buf.join('\n'));
  return out;
}

const all = jobs(src);

test('关键 job 必须都在：单测门禁 / E2E 烟雾 / 完整 E2E', () => {
  for (const name of ['checks', 'e2e-smoke', 'e2e-nightly']) {
    assert.ok(all.has(name), WF + ' 缺少 job：' + name);
  }
});

test('完整 E2E 不得跑在每个 PR 上（必须有事件守卫）', () => {
  // 这是本文件最要紧的一条：没有守卫的话，每个 PR 都会多等几十分钟。
  const nightly = all.get('e2e-nightly');
  assert.match(
    nightly,
    /if:\s*github\.event_name\s*==/,
    'e2e-nightly 必须靠 github.event_name 守卫，否则每个 PR 都会跑完整 E2E'
  );
  // 烟雾集则**必须**无条件跑在每个 PR 上（它是 PR 的第一道防线）。
  const smoke = all.get('e2e-smoke');
  assert.doesNotMatch(smoke, /if:\s*github\.event_name\s*==/, 'e2e-smoke 不应被事件守卫挡掉');
});

test('定时已配置：夜间任务要有 schedule 才能真正定时', () => {
  assert.match(src, /schedule:/, '缺少 schedule —— 夜间任务没有触发器就永远不会自动跑');
  assert.match(src, /cron:/, '缺少 cron 表达式');
});

test('变异测试与桥接握手必须在 PR 门禁里（它们是最容易静默失效的两道）', () => {
  const checks = all.get('checks');
  assert.match(checks, /run-all-checks\.mjs/, 'PR 必须跑 run-all-checks（内含变异测试）');
  assert.match(checks, /verify-bridge-ws-handshake/, 'PR 必须验证桥接握手');
});

test('这条门禁本身有牙齿：删掉守卫必须被抓到', () => {
  const broken = src.replace(/if:\s*github\.event_name\s*==[^\n]*/, '');
  assert.doesNotMatch(
    jobs(broken).get('e2e-nightly') || '',
    /if:\s*github\.event_name\s*==/,
    '构造出的坏样本应确实没有守卫 —— 否则上面的断言是恒真的'
  );
  assert.ok(path.basename(WF) === 'checks.yml');
});
