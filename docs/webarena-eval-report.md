# WebArena 评测实测报告

> 日期：2026-10-20 ｜ 分支：`feat/webarena-eval`（`08d7c24`）｜ 模型：`deepseek-chat`
> 环境：Windows 11 + 本地 Docker（WebArena-Verified 官方镜像）+ 真 Chromium（headed）+ 已装扩展
> 结论口径：**以官方 `webarena-verified` evaluator 的分数为准**，不是我们 `summary.json` 的 `status=SUCCESS` 计数。

## 1. 结论摘要

- **评测闭环打通**：真站点 → 扩展内 agent 跑任务 → 落 `agent_response.json` + `network.har`
  → 官方 evaluator 离线复算 → 出分。
- **实测基线：shopping 站 retrieve 6 条，官方评分 5/6**（`success=[22,23,24,25,26]`，`failed=[21]`）。
- **`shopping_admin` 长表单任务是当前短板**：能自动登录、能进 Bestsellers 报表，
  卡在「原生 `<select>` 选 Year + 填日期」。
- 仓库单测未受影响的证据：测试数快照 **1684 / 127 文件**，`silent-failure-regressions` 全过。

## 2. 逐条结果

| task | 我们的终态 | retrieved_data | 耗时 | 官方判定 |
| --- | --- | --- | --- | --- |
| 21 | SUCCESS | `["Catso","Dibbins","Anglebert Dinkherhump"]` | 78s | ❌ 漏了 `Michelle Davis` 等 |
| 22 | NOT_FOUND_ERROR | `[]` | 108s | ✅ 正确答案就是"查不到" |
| 23 | SUCCESS | `["Rachel","T. Gannon"]` | 103s | ✅ |
| 24 | NOT_FOUND_ERROR | `[]` | 102s | ✅ 正确答案就是"查不到" |
| 25 | SUCCESS | `["Roxanne Brandon Coffey","Nelson"]` | 102s | ✅ |
| 26 | SUCCESS | `["Bob in Vegas","RemyRRemyR"]` | 102s | ✅ |

**评分口径差异（必须记住）**：task 22/24 我们记 `NOT_FOUND_ERROR`，官方判**对**——
它们的期望就是 `status=NOT_FOUND_ERROR`。反过来 task 21 我们记 `SUCCESS`，官方判**错**——
期望集合里有 4 项（含 `["Michelle Davis","Michelle DavisMichelle Davis"]` 这种别名组），
我们只交出 3 项。**"自己说成功" ≠ "任务做成"**，这正是引入外部基准的意义。

## 3. 案例：task 0（shopping_admin，长表单）

期望：2022 年销量第一的商品名。实际过程（`recallflow.json` 的 `answer` 原文可复核）：

1. 起始页 `http://localhost:7780/admin`，**自动登录成功**（见下方"请求头"一节），进入后台。
2. 导航到 Reports → Bestsellers，找到 Period 下拉与 From/To 日期框。
3. 卡点：Period 是原生 `<select>`，`click_element` 打不开下拉；没有可用的日期输入路径；
   唯一能设值的 `run_javascript` 属 **high 风险**（桥接场景任何 `allowRisk` 都换不到）。
4. 反复尝试后触发**无进展守卫**，agent 结束并如实回答"没有拿到数据，不凭空给答案"。

**判定**：这是 **agent 能力边界**（表单控件处理 + 高风险工具的取舍），不是评测 harness 故障。
按约定**本轮不修改 RecallFlow 核心**，如实记录为已知限制。

## 4. 工程发现（本轮已修 / 已记录）

### 4.1 请求头只在 Playwright 创建的页面生效（已修）

WebArena 的 admin 站靠 **请求头自动登录**（`X-M2-Admin-Auto-Login: admin:admin1234`）。
`context({ extraHTTPHeaders })` 只对 **Playwright 创建的页面**生效；扩展用 `chrome.tabs.create`
开的 tab **不带这些头**，于是 agent 停在登录页——现象是"agent 说它看到了登录框"，不会报错。

- 服务端验证：`curl -H "X-M2-Admin-Auto-Login: admin:admin1234" localhost:7780/admin`
  → 302 到 `/admin/admin/dashboard/`。
- 修复：`open_tab` 之后让 Playwright **接管该 tab 再导航一次**
  （`integrations/webarena/harness.mjs` 的 `navigateTabWithHeaders`），头才跟得上。
- 验证：修复前 task 0 停在登录页；修复后能进 Bestsellers 报表。

### 4.2 产物目录必须对齐 evaluator（已修）

evaluator 只认 `<out>/<task_id>/agent_response.json` 与 `<out>/<task_id>/network.har`
（默认文件名见 `webarena_verified/types/config.py`）。用别的层级/名字，它只会说
"0 条可评测任务"，不会提示文件名不对。`run.mjs` 已改为该布局。

### 4.3 评分必须传 `--config`（已修）

不给 config 时，evaluator 会"best-effort 从 HAR 猜站点地址"，实测猜到了
`http://127.0.0.1:7801`（我们的桥接地址），并告警 "This is not recommended"。
模板见 `integrations/webarena/site-config.example.json`。

### 4.4 待修：轮询偶发 `state=undefined`（未改，风险已记录）

长任务轮询中偶尔会出现 `state=undefined`（同一次运行里与 `state=running` 交替）。
`waitForJob` 以 `running === false` 作为结束条件，因此这种响应会被**继续轮询**；
若 job 恰好在一次缺字段的快照上结束，就会一直等到墙钟超时，把"已完成"误记为超时失败。
本轮见过一次疑似症状（240s 那条在 `seq` 长时间不动后判失败）。
建议：把"连续多次 `seq` 不变且响应缺 `running`"视为异常并显式报错，或对
`ok && state ∈ 终态集合` 直接收口。**不要**用静默重试掩盖。

### 4.5 运维坑

- **Docker CLI 不在 PATH**，且 `credsStore=desktop` 找不到 `docker-credential-desktop`。
  把 `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` 加进 PATH 即可。
- **7801 可能被一个长期常驻的 MCP server 占用**（实测遇到过两天前启动的实例）。
  评测会复用它——意味着"跑的是那个进程加载的旧代码"。建议评测前重启该服务，
  或加一条"端口被非本次启动的 server 占用就明确告警"。

## 5. 可信度与边界（别过度解读）

- **样本量 6，单次运行**：只能说明"闭环可用 + 有信号"，不能当稳定分数。
  同配置多次跑会抖（见 `docs/agent-cost-quality-evaluation.md`）。
- **只覆盖 retrieve**：mutate / navigate 未跑；mutate 更依赖网络 evaluator 与登录态。
- **站点覆盖**：本轮只起了 shopping / shopping_admin / reddit；
  gitlab / wikipedia / map 未拉（体积大，wikipedia 还需 ZIM、map 需数据 tar）。
- **覆盖面错位**：WebArena 是英文、标准 HTML 的自建站，测不到本扩展的差异化能力
  （跨域 iframe / Shadow DOM / canvas 坐标点击 / CDP 可信事件 / 视觉 / 中文站）。
- **`high` 风险工具永远拿不到**（`run_javascript` / 用户脚本 / 上传），依赖它们的任务注定失败。

## 6. 复现步骤

```bash
# 0) 起站点（示例：shopping / shopping_admin / reddit）
docker run -d --name webarena-verified-shopping      -p 7770:80 -p 7771:8877 am1n3e/webarena-verified-shopping:latest
docker run -d --name webarena-verified-shopping_admin -p 7780:80 -p 7781:8877 am1n3e/webarena-verified-shopping_admin:latest
docker run -d --name webarena-verified-reddit        -p 9999:80 -p 9998:8877 am1n3e/webarena-verified-reddit:latest
docker exec webarena-verified-shopping env-ctrl status   # 期望 [OK]

# 1) 前置：headed 浏览器 + 已装扩展；Python 不需要（评分走 Docker）
npx playwright install chromium

# 2) 实跑（6 条 shopping retrieve）
RECALLFLOW_EVAL_API_KEY=sk-xxx node scripts/run-webarena.mjs \
  --tasks webarena-verified.json --task-id 21,22,23,24,25,26 \
  --site-url SHOPPING=http://localhost:7770 \
  --out webarena-out --timeout-ms 420000

# 3) 官方评分
docker run --rm -v "<out>:/out" -v "<repo>/integrations/webarena:/cfg" python:3.12-slim sh -c \
  "pip install -q webarena-verified && webarena-verified eval-tasks \
     --output-dir /out --config /cfg/site-config.example.json --task-ids 21,22,23,24,25,26"
```

admin 站另加：`--site-url SHOPPING_ADMIN=http://localhost:7780/admin --header "X-M2-Admin-Auto-Login: admin:admin1234"`。

## 7. 下一步建议（按性价比排序）

1. **修 4.4 的轮询收口**（小改、影响所有长任务的可信度）。
2. **扩大 retrieve 样本**到 30~50 条（同配置跑 3 次报分布），先把"稳定基线"立起来。
3. 再考虑 mutate / navigate；那之前要先把登录态（per-user 凭据）与网络 evaluator 的 config 打通。
4. 最后才谈 258 条 hard 子集（要先拉全 6 站，成本最高）。
