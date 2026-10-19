import { defineConfig } from '@playwright/test';

// **第三层：真模型 eval** —— 刻意与常规 E2E 分目录、分配置。
//
// 为什么不放进 tests/e2e/：
//   · 它需要**真实 API key**（花钱）；
//   · 结果**非确定**（同一个模型两次可能不同）→ 放进 CI 会变成随机红灯，
//     而随机红灯的唯一后果是大家开始无视红灯；
//   · 它要回答的问题与常规 E2E **不同**：常规 E2E 问"这套能力成不成立"，
//     它问"这段技能文案对真模型有没有用"。
// 混在一起，"脚本下能过"会被误读成"技能有效"—— 那正是本轮想避免的假信心。
//
// 跑法：node scripts/eval-real-model.mjs（它会做前置检查并设置代理环境变量）
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.eval\.mjs/,
  // eval 可能很慢（真模型 + 多轮工具调用），给足时间；一次只跑一条，避免并发干扰夹具计数。
  //
  // ⚠ 180s → 360s → **540s**（阈值暴露，实测）：有些场景模型**做得到但收尾慢** ——
  //   富文本真模型一次跑了 **53 次工具调用**（inspect_element / read_current_page / styles 反复核验），
  //   在 180s 被测试超时掐掉；提到 360s 后又出现"跑了 55 次仍未收尾"被**运行上限**掐掉 ✗
  //   ⇒ 测试超时 = 运行上限（real-model.eval.mjs 的 420s）+ 起停余量 ⇒ **必须配套改** ✓
  //   探针是"跑完再看判据"，不是"跑得快才算过" ✓
  timeout: 540_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  // eval 不重试：它的产出是"模型这次的表现"，重试会让分数变成一个被挑过的好样本，
  // 那样"分数下降即回归"就永远判断不了。偶发失败应当如实记录，而不是抹掉。
  retries: 0,
  // 结果**必须落成机器可读**：eval 的唯一长期价值是"这一轮比上一轮差没差"，
  // 而此前唯一记录是人工维护的 docs/real-model-eval-log.md —— 没法自动比，
  // 于是"技能文案改坏了"只能靠人翻 markdown 发现。
  // 落盘后可用 node scripts/eval-compare.mjs 做基线对比。
  reporter: [
    ['list'],
    [
      'json',
      {
        outputFile: process.env.EVAL_RESULT_JSON || 'test-results/eval-results.json',
      },
    ],
  ],
});
