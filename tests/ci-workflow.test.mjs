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
function jobs(text = src) {
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

/**
 * 切出某个 job 的 step 列表，带文件内 1 基行号。
 *
 * 为什么需要行号：这次的退化（根依赖没装 / action 停留在 node20）都是"顺序"和
 * "版本"问题，报错里必须能指出是哪一行，否则下一个人在 70 行 yml 里找不出来。
 */
function stepsOf(text, name) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inJob = false;
  let cur = null;
  let keyIndent = 8; // step 的 `- ` 缩进 + 2；进入 job 后按实际缩进重算
  let collecting = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const jobHead = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobHead) {
      if (jobHead[1] === name) {
        inJob = true;
        cur = null;
      } else if (inJob) {
        break; // 下一个 job 开始，本 job 结束
      }
      continue;
    }
    if (!inJob) continue;
    const stepHead = line.match(/^(\s+)-\s(.*)$/);
    if (stepHead) {
      keyIndent = stepHead[1].length + 2;
      cur = {
        line: i + 1,
        run: '',
        workingDirectory: null,
        uses: (stepHead[2].match(/uses:\s*(\S+)/) || [])[1] || null,
      };
      out.push(cur);
      collecting = false;
      continue;
    }
    if (!cur) continue;
    if (collecting) {
      const cont = line.match(new RegExp('^ {' + (keyIndent + 2) + ',}(.*)$'));
      if (cont) {
        cur.run += (cur.run ? '\n' : '') + cont[1];
        continue;
      }
      collecting = false;
    }
    const kv = line.match(new RegExp('^ {' + keyIndent + '}(working-directory|run|uses):\\s*(.*)$'));
    if (!kv) continue;
    if (kv[1] === 'working-directory') {
      cur.workingDirectory = kv[2].trim();
      continue;
    }
    if (kv[1] === 'uses') {
      cur.uses = kv[2].trim();
      continue;
    }
    // `run: |` / `run: >` 是块标量，后续更缩进的行都归它。
    if (/^[|>]-?\s*$/.test(kv[2])) {
      cur.run = '';
      collecting = true;
    } else {
      cur.run = kv[2].trim();
    }
  }
  return out;
}

// actions/* 的「最低可用 major」。低于这个值，action 自己跑在 Node.js 20 上，
// GitHub 会在每次 run 顶部挂一条弃用告警（runs.using: node20）。
// 取值口径：node24 的第一个 major —— checkout/setup-node/cache 是 v5，
// upload-artifact 是 v6（它的 v5 仍然是 node20，这是最容易踩错的一条）。
const MIN_ACTION_MAJOR = {
  'actions/checkout': 5,
  'actions/setup-node': 5,
  'actions/cache': 5,
  'actions/upload-artifact': 6,
};

// 浮动标签：ubuntu-latest 会在 GitHub 决定迁移的那天悄悄换掉整个系统镜像
// （2026-10-19 起 ubuntu-latest 开始指向 Ubuntu 26）。门禁要的是可复现，
// 不是"自动尝鲜"。
const FLOATING_RUNNERS = new Set(['ubuntu-latest', 'windows-latest', 'macos-latest']);

/** checks job 里「根目录的 npm ci」（没有 working-directory 前缀的那一条）。 */
function rootCiStep(text) {
  return (
    stepsOf(text, 'checks').find((s) => /(^|\n)\s*npm ci\b/.test(s.run) && !s.workingDirectory) ||
    null
  );
}

function runAllChecksStep(text) {
  return stepsOf(text, 'checks').find((s) => /run-all-checks\.mjs/.test(s.run)) || null;
}

/** 所有低于最低 major 的 action，报 `文件:行号 + 当前版本 + 最低要求`。 */
function actionViolations(text) {
  const bad = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@v(\d+)/);
    if (!m) return;
    const min = MIN_ACTION_MAJOR[m[1]];
    if (min === undefined) return;
    if (Number(m[2]) < min) bad.push(`${WF}:${i + 1} ${m[1]}@v${m[2]}（最低要求 v${min}）`);
  });
  return bad;
}

function floatingRunners(text) {
  const bad = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/^\s*runs-on:\s*(\S+)/);
    if (m && FLOATING_RUNNERS.has(m[1])) bad.push(`${WF}:${i + 1} runs-on: ${m[1]}`);
  });
  return bad;
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

// ---------------------------------------------------------------------------
// TITA-18-A 补牙（2026-10-24，run 40114474817）
//
// checks job 只装了 MCP 子包依赖，从来没装根 devDependencies，于是
// run-all-checks 第一步就 ERR_MODULE_NOT_FOUND: esbuild，整个 job exit 1
// —— 而 PR 页面上只看得到一行「Process completed with exit code 1」。
// 同一次 run 里还有 Node.js 20 弃用告警和 ubuntu-latest 迁移告警。
// 这三件事的共同点：改一行 yml 就能退化，退化后没有任何东西会报出来。
// 下面三条就是冲着这三行去的。
// ---------------------------------------------------------------------------

test('checks job 必须安装根依赖，且必须在 run-all-checks 之前', () => {
  // 扩展「运行时」零依赖，但测试门禁不是：`scripts/build-content.mjs` 静态
  // import esbuild、`tests/e2e/playwright.config.mjs` 动态 import @playwright/test，
  // 两者都在根 devDependencies 里。只装 MCP 子包 → run-all-checks 第一步必挂。
  // 判定用「没有 working-directory 的那条 npm ci」，而不是看有没有 node_modules：
  // MCP 子包那条也带 npm ci，写死"存在 npm ci"抓不到这次的退化。
  const rootCi = rootCiStep(src);
  assert.ok(
    rootCi,
    `${WF} 的 checks job 里没有根目录的 npm ci —— 测试门禁需要 esbuild / @playwright/test，` +
      '只装 MCP 子包会让 run-all-checks 第一步就 ERR_MODULE_NOT_FOUND（TITA-18-A）'
  );
  const runAll = runAllChecksStep(src);
  assert.ok(runAll, `${WF} 的 checks job 里找不到 run-all-checks.mjs`);
  assert.ok(
    rootCi.line < runAll.line,
    `${WF}:${rootCi.line} 的根 npm ci 排在 ${WF}:${runAll.line} 的 run-all-checks 之后 —— ` +
      '依赖必须在测试前装好，装晚了等于没装'
  );
});

test('action 不得回落到 Node.js 20（低于最低 major 即失败）', () => {
  const bad = actionViolations(src);
  assert.deepEqual(
    bad,
    [],
    '以下 action 跑在 Node.js 20 上（GitHub 已弃用，每个 run 顶部都会挂告警）：\n  ' +
      bad.join('\n  ') +
      '\n  upgrading 到 node24 的第一个 major 即可，不要跳到更新的 major。'
  );
});

test('runner 不得用浮动标签（可复现性 > 自动尝鲜）', () => {
  // ubuntu-latest 会在 GitHub 决定的那天换掉整个系统镜像（2026-10-19 起指向
  // Ubuntu 26）。门禁跑的是"同一份代码在同一环境里的同一结果"，钉死版本，
  // 要迁移时显式改标签并跑一次夜间 E2E。
  const bad = floatingRunners(src);
  assert.deepEqual(
    bad,
    [],
    '以下 runner 用了浮动标签，系统镜像会在 GitHub 迁移时静默变化，结果不可复现：\n  ' +
      bad.join('\n  ') +
      '\n  请钉成具体版本（如 ubuntu-24.04）。'
  );
});

test('新门禁本身有牙齿：四种退化样本必须各自被抓到', () => {
  const yml = (steps) => ['jobs:', '  checks:', '    runs-on: ubuntu-24.04', '    steps:', ...steps, ''].join('\n');
  const mcpCi = ['      - name: 安装 MCP 子包依赖', '        working-directory: integrations/opencode/recallflow-mcp', '        run: npm ci'];
  const runAll = ['      - name: 单元测试 + 静态门禁', '        run: node scripts/run-all-checks.mjs'];

  // ① 只装 MCP 子包：TITA-18-A 的原始形态。
  assert.equal(
    rootCiStep(yml([...mcpCi, ...runAll])),
    null,
    '只装 MCP 子包时必须判定为「没有根 npm ci」 —— 否则上面那条是恒真的'
  );

  // ② 根 npm ci 装晚了：顺序断言要能抓到。
  const late = yml([...runAll, '      - name: 安装根依赖', '        run: npm ci --prefer-offline --no-audit --no-fund']);
  assert.ok(
    rootCiStep(late).line > runAllChecksStep(late).line,
    '根 npm ci 排在 run-all-checks 之后时，行号比较必须翻转 —— 否则顺序断言是恒真的'
  );

  // ③ node20 action：版本映射要能抓到（含最容易漏的 upload-artifact v5）。
  assert.deepEqual(
    actionViolations(yml(['      - uses: actions/checkout@v4', '      - uses: actions/upload-artifact@v5'])),
    [`${WF}:5 actions/checkout@v4（最低要求 v5）`, `${WF}:6 actions/upload-artifact@v5（最低要求 v6）`],
    'node20 action 必须被逐条报出来 —— 否则版本映射是恒真的'
  );

  // ④ 浮动 runner。
  assert.deepEqual(
    floatingRunners(['jobs:', '  checks:', '    runs-on: ubuntu-latest', ''].join('\n')),
    [`${WF}:3 runs-on: ubuntu-latest`],
    '浮动 runner 必须被报出来 —— 否则 runner 断言是恒真的'
  );
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
