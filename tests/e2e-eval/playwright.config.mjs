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
  // ⚠ 180s → 360s（阈值暴露，实测）：有些场景模型**做得到但收尾慢** —— 例如「富文本」真模型一次跑了
  //   **53 次工具调用**（inspect_element / read_current_page / styles 反复核验），在 180s 处被
  //   Playwright 的**测试超时**掐掉，读数因此不可信 ✗。探针是"跑完再看判据"，不是"跑得快才算过" ✓
  timeout: 360_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
});
