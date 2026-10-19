# integrations/webarena

RecallFlow × WebArena-Verified 的评测适配层。完整说明见
[`docs/webarena-eval.md`](../../docs/webarena-eval.md)。

| 文件 | 作用 |
| --- | --- |
| `run.mjs` | 编排器：任务 → 指令 → 真浏览器跑 → 落盘 `agent_response_*` + `*.har` |
| `harness.mjs` | 浏览器原语：起真 Chromium、装扩展、**清存储做隔离**、抓 HAR |
| `mcp-client.mjs` | 7801 桥接的最小 HTTP JSON-RPC 客户端（init / tools-call / 轮询 job） |
| `config.mjs` | 纯参数解析 / 任务选择 / allowRisk 校验 / `__SITE__` 占位符替换（可单测） |
| `sample-tasks.json` | 三条示例任务，供 `--dry-run` 演示 |

```bash
node scripts/run-webarena.mjs --tasks integrations/webarena/sample-tasks.json --dry-run
```

## 用官方数据集

官方 `webarena-verified.json`（812 条）的字段与本适配层**直接兼容**，只有 `start_urls`
里的 `__SHOPPING__` / `__GITLAB__` 等占位符需要换成你本地站点地址——用 `--site-url` 完成，
不必预先改文件：

```bash
# 下载官方数据集（含 258 条 hard 子集的 task_ids：assets/dataset/subsets/webarena-verified-hard.json）
curl -L -o webarena-verified.json \
  https://raw.githubusercontent.com/ServiceNow/webarena-verified/main/assets/dataset/webarena-verified.json

# 用占位符映射跑 task 0（admin 站）
node scripts/run-webarena.mjs --tasks webarena-verified.json --task-id 0 \
  --site-url SHOPPING_ADMIN=http://localhost:7780 --dry-run
```

未映射的占位符会**原样保留**并在选中任务时告警（不会静默变成空地址）。
