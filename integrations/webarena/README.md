# integrations/webarena

RecallFlow × WebArena-Verified 的评测适配层。完整说明见
[`docs/webarena-eval.md`](../../docs/webarena-eval.md)。

| 文件 | 作用 |
| --- | --- |
| `run.mjs` | 编排器：任务 → 指令 → 真浏览器跑 → 落盘 `agent_response_*` + `*.har` |
| `harness.mjs` | 浏览器原语：起真 Chromium、装扩展、**清存储做隔离**、抓 HAR |
| `mcp-client.mjs` | 7801 桥接的最小 HTTP JSON-RPC 客户端（init / tools-call / 轮询 job） |
| `config.mjs` | 纯参数解析 / 任务选择 / allowRisk 校验（可单测） |
| `sample-tasks.json` | 三条示例任务，供 `--dry-run` 演示 |

```bash
node scripts/run-webarena.mjs --tasks integrations/webarena/sample-tasks.json --dry-run
```
