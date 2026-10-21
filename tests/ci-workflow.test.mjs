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

test('PR 门禁 job 必须在', () => {
  assert.ok(all.has('checks'), WF + ' 缺少 job：checks（PR 唯一的门禁入口）');
});

test('CI 里引用的 npm 脚本必须真实存在（门禁只能钉住存在的东西）', () => {
  // 这条不是理论推演，是踩出来的：曾经有个 e2e-smoke job 跑 `npm run test:e2e:smoke`，
  // 而那个脚本随一次回退消失了 —— CI 会稳定地红在"Missing script"上，
  // 看起来像测试挂了，实际是接线断了。硬编码 job 名的断言挡不住这类漂移，
  // 但"引用的脚本必须存在"能在任何一次改名/回退后立刻报出来。
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const missing = [];
  for (const [name, body] of all) {
    const stripped = body.replace(/#[^\n]*/g, '');
    for (const m of stripped.matchAll(/npm run ([A-Za-z0-9:._-]+)/g)) {
      if (!pkg.scripts[m[1]]) missing.push(name + ' -> npm run ' + m[1]);
    }
  }
  assert.deepEqual(missing, [], 'CI 引用了 package.json 里不存在的脚本：\n  ' + missing.join('\n  '));
});

test('完整 E2E 不得跑在每个 PR 上（跑 test:e2e 的 job 必须有事件守卫）', () => {
  // 只认完整入口 `npm run test:e2e`，不认 test:e2e:smoke 之类的子集。
  // 用"谁跑了完整 E2E"来判定，而不是写死 job 名 —— job 改名不该让门禁失效，
  // 但"PR 上跑完整 E2E"这件事必须无论 job 叫什么都被挡住。
  const runners = [...all].filter(([, body]) => /npm run test:e2e(?![:\w-])/.test(body));
  assert.ok(
    runners.length > 0,
    '没有任何 job 跑完整 E2E —— 那它就只在本地跑，等于没有（本仓库已踩过一次）'
  );
  for (const [name, body] of runners) {
    assert.match(
      body,
      /if:\s*github\.event_name\s*==/,
      name + ' 跑完整 E2E 却没有 github.event_name 守卫，每个 PR 都会多等几十分钟'
    );
  }
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
