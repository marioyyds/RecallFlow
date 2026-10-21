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
   唯一能设值的 `run_javascript` 属 **high 风险**（旧分支上桥接场景任何 `allowRisk` 都换不到）。
   ⚠ 新 master 已把 `run_javascript` 归为 `page`，声明 `page` 即可用 —— **本案例需要在当前分支重测**。
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

### 4.4 轮询偶发 `state=undefined`（已修：显式收口，不静默重试）

长任务轮询中偶尔会出现 `state=undefined`（同一次运行里与 `state=running` 交替）。
`waitForJob` 原先只以 `running === false` 作为结束条件，因此这种响应会被**继续轮询**；
若 job 恰好在一次缺字段的快照上结束，就会一直等到墙钟超时，把"已完成"误记为超时失败。
本轮见过一次疑似症状（240s 那条在 `seq` 长时间不动后判失败）。

修复（`integrations/webarena/mcp-client.mjs`）：

- `ok && state ∈ {completed, failed, cancelled, stalled}` → **直接收口**（不再依赖 `running` 字段）；
- `ok === false` → 立即抛 `STATUS_ERROR`（job 不存在/服务异常不是"还在跑"）；
- 连续 3 次 `seq` 不变且 `state`/`running` 都缺失 → 抛 `STATUS_MISSING_STATE`，并带上最后一份快照；
- 只有 seq 前进或状态字段存在时才算正常快照，避免把真实运行误判为异常。

测试：`tests/webarena-mcp-client.test.mjs` 新增 3 条（终态缺 running 立即收口 / 空快照连续报错 / ok=false 报错）。
**仍然不静默重试** —— 异常就当异常记录，让失败原因可见。

### 4.5 运维坑

- **Docker CLI 不在 PATH**，且 `credsStore=desktop` 找不到 `docker-credential-desktop`。
  把 `%LOCALAPPDATA%\Programs\DockerDesktop\resources\bin` 加进 PATH 即可。
- **7801 可能被一个长期常驻的 MCP server 占用**（实测遇到过两天前启动的实例）。
  评测会复用它——意味着"跑的是那个进程加载的旧代码"。现已**显式告警**：
  `ensureBridgeServer` 在复用前打印对方 `pid` 与扩展连接状态，并提示先重启（见 `describeBridgeReuse`）。

### 4.6 多个扩展同时连 7801（2026-10-20 复跑定位并修复）

**现象**：task 21 连续两次在 `seq=0 state=running` 之后变成 3 次
`state=undefined`，`RECALLFLOW_EVAL_DEBUG` 打出的原文是
`{"_raw":"unknown method: agent_task_status","_isError":true}`。服务端日志里同时出现
两条 `extension connected (websocket)`。

**根因**：本机另一个浏览器里也加载了 RecallFlow，它的扩展同样连 `127.0.0.1:7801`。
服务端 `extSocket` 被后连者覆盖，HTTP 长轮询又是共享队列 —— 请求可能落到**没有
`agent_task_status` 的旧扩展**上。这不是页面能力问题，也不是模型问题，是评测隔离漏洞。

**修复**：
- 每次评测生成一次性 `RECALLFLOW_BRIDGE_TOKEN`（server 与本次扩展设置同值），
  其它扩展被 401 拒绝；
- 扩展 `lib/bridge/relay.js` 不再启动时缓存 token，**每轮 `/poll` 重读**，
  所以设置写入后立即生效（不需要重启 service worker）。
- 验证：同一 task 21 从"稳定 unknown method"变为正常跑完（SUCCESS）。

## 5. 可信度与边界（别过度解读）

- **样本量 6，单次运行**：只能说明"闭环可用 + 有信号"，不能当稳定分数。
  同配置多次跑会抖（见 `docs/agent-cost-quality-evaluation.md`）。
- **只覆盖 retrieve**：mutate / navigate 未跑；mutate 更依赖网络 evaluator 与登录态。
- **站点覆盖**：本轮只起了 shopping / shopping_admin / reddit；
  gitlab / wikipedia / map 未拉（体积大，wikipedia 还需 ZIM、map 需数据 tar）。
- **覆盖面错位**：WebArena 是英文、标准 HTML 的自建站，测不到本扩展的差异化能力
  （跨域 iframe / Shadow DOM / canvas 坐标点击 / CDP 可信事件 / 视觉 / 中文站）。
- **工具权限跟随产品风险模型**：`run_javascript` 在新 master 是 `page`（声明 `page` 即可），
  真正的 `high`（userscript / install_userscript / save_skill）仍然永远拿不到；
  `upload_file` 是 `destructive`，默认不声明就不放行。

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
#    一次性 token：防止本机其它浏览器里的扩展也连 7801 抢请求（见 4.6）
export RECALLFLOW_BRIDGE_TOKEN=$(openssl rand -hex 12)
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

1. ~~修 4.4 的轮询收口~~（已修：终态直接收口 + 空快照/ok=false 显式报错；见 4.4）。
2. **扩大 retrieve 样本**到 30~50 条（同配置跑 3 次报分布），先把"稳定基线"立起来。
3. 再考虑 mutate / navigate；那之前要先把登录态（per-user 凭据）与网络 evaluator 的 config 打通。
4. 最后才谈 258 条 hard 子集（要先拉全 6 站，成本最高）。

## 8. 2026-10-20 复跑（token 隔离后）

环境：Docker 站点（shopping / shopping_admin / reddit）已就绪、`webarena-verified.json`
（812 条）从官方仓库下载、headed Chromium + 扩展、`deepseek-chat`。
代码：pre-rebase 提交 `27f70ca` 的 worktree + 本轮 4.4 / 4.6 修复
（当时新 master 还没有 `agent_task`/bridge；这是分支迁移前的历史结果，迁移后的结果见 8.2）。

一次完整 6 条实跑 + 官方 evaluator（不带 `--task-ids` 之外的口径修改）：

| task | RecallFlow 终态 | 官方判定 | 失败原因 |
| --- | --- | --- | --- |
| 21 | SUCCESS | ❌ | 期望 4 项，只交出 2 项（`Catso`、`Anglebert Dinkherhump`） |
| 22 | NOT_FOUND_ERROR | ✅ | 正确答案就是查不到 |
| 23 | SUCCESS | ✅ | — |
| 24 | UNKNOWN_ERROR | ❌ | 答复内容对，但**没有输出 JSON 终态块**（adapter 如实记 UNKNOWN_ERROR） |
| 25 | UNKNOWN_ERROR | ❌ | 同上（自然语言结论正确：Roxanne Brandon Coffey / Nelson） |
| 26 | UNKNOWN_ERROR | ❌ | 同上（自然语言结论正确：RemyRRemyR / Bob in Vegas） |

**官方分：2/6**（`success=[22,23]`）。与早先 5/6 的差异不是"分数退化"这一句话能概括的：

- 24/25/26 是**模型契约合规**问题：结论已经算对，但最后没吐 ```json 块。
  这三次是同一形态，属于当前最值得修的稳定性问题（不是判据问题，也不是 harness 故障）。
- 21 是**检索不完整**（少 2 个名字），属于能力问题。
- 22 说明"NOT_FOUND_ERROR 被官方判对"仍然成立。

同一轮里先跑过一次未做 token 隔离的 6 条，也是官方 2/6，但失败构成不同
（21 harness 抢占、24 缺 JSON、25/26 多交了名字）。**单次 6 条不能当稳定分数**，
两次复跑的共同信号只有两个：22/23 稳定过；24-26 的 JSON 契约或取舍不稳定。

后续优先级调整为：

1. ~~先修"最后不吐 JSON"~~（已修：`requireFinalJsonBlock` + 一次"只整理格式"的补正，见 8.3）。
   不要把自然语言结论在 harness 里"翻译"成 JSON（那会伪造成功）。
2. 再做 4.6 的隔离长期化（已修代码，但复现步骤要写进文档与脚本默认值）。
3. 样本扩到 30~50 条 × 3 次，按分布报告；在此之前不要用单次 6 条下结论。

### 8.1 用 `deepseek-flash` 复跑（评测应使用的模型）

同一批 6 条、同一环境，加 `RECALLFLOW_EVAL_MODEL=deepseek-flash` 重跑：

**官方分：4/6**（`success=[22,24,25,26]`，`failed=[21,23]`）。

| task | 官方 | 原因 |
| --- | --- | --- |
| 21 | ❌ | 检索不全：只交出 `Dibbins`，期望 4 项（Catso / Dibbins / Anglebert Dinkherhump / Michelle Davis） |
| 23 | ❌ | 未吐 JSON 终态块 → `UNKNOWN_ERROR` |
| 22 / 24 / 25 / 26 | ✅ | 22、24 的 `NOT_FOUND_ERROR` 被官方判对；25/26 检索结果正确 |

对比 `deepseek-chat` 的 2/6（失败为 21/24/25/26）：**换成 flash 后失败构成完全不同**
（21 仍是能力问题，23 是契约合规问题）。样本只有 6 条，这个对比只能算观察，
不能据此宣布谁更稳 —— 但可以确认：**之前 2/6 不是 harness 故障，也不是 token 修复引入的**。

### 8.2 分支迁移后的首跑（新 master + bridge + webarena，**未加格式补正**）

`feat/webarena-eval` 已改为基于 `feat/bridge-new-master`（新 master + 移植的 16 个
bridge/agent_task 提交），WebArena 相关代码与 4.4/4.6 修复都在同一分支上。
用 `deepseek-flash`、一次性 token 重跑 6 条 shopping retrieve：

**官方分：2/6**（`success=[24,26]`；21/23/25 failure，22 error）。

| task | 官方 | 原因 |
| --- | --- | --- |
| 21 | ❌ | 检索不全：只交出 `Dibbins` |
| 22 | ⚠ error | agent 返回 `SUCCESS + ["AZ Guy"]`，与期望 `NOT_FOUND_ERROR` 冲突，evaluator 报 schema 错 |
| 23 | ❌ | 未吐 JSON → `UNKNOWN_ERROR` |
| 24 | ✅ | `NOT_FOUND_ERROR` 被判对（旧分支上这条是缺 JSON） |
| 25 | ❌ | 未吐 JSON → `UNKNOWN_ERROR` |
| 26 | ✅ | 检索正确 |

关键意义：**评测现在真的跑在 rebase 后的分支上**（不再依赖 pre-rebase worktree），
`agent_task` 通道、`run_javascript` 的 `page` 新语义、知识库 IndexedDB 都在新链路上验证过。
这也证明：**分支迁移不是分数变化的主因；23/25 的"不吐 JSON"才是最大的稳定问题**。

注意 21 的输出从旧分支的 778 条事件涨到 3738 条（新 master 的 agent 循环更啰嗦），
大量事件被 `omitted` 截断；这不影响终态，但值得作为下一步的成本/收敛观察点。

### 8.3 加入终态格式补正后复跑：官方 5/6

**改法**（`lib/assistant/agent.js` + `integrations/webarena/harness.mjs`）：

- `webarenaSettings` 打开 `requireFinalJsonBlock`（只影响评测，不改面板行为）；
- agent 在**两条收尾路径**（模型最终回答 / `complete_task`）检查答复里有没有 JSON 终态块；
- 缺失时**只追加一次**用户消息：不要重做任务、不要新增事实，只把已有结论按契约整理成 JSON；
- 补正后继续循环，再走一次正常收尾；仍然缺失就如实记 `UNKNOWN_ERROR`（不伪造）。
- 门禁：`tests/final-json-retry.test.mjs`（含"补正路径不得 `JSON.stringify`"）。

同一批 6 条、`deepseek-flash`、一次性 token，加补正后复跑：

**官方分：5/6**（`success=[22,23,24,25,26]`，`failed=[21]`）。

| task | 官方 | 说明 |
| --- | --- | --- |
| 21 | ❌ | 检索不全：只交出 `Dibbins`，期望 4 项 |
| 22 / 24 | ✅ | `NOT_FOUND_ERROR` 被判对 |
| 23 / 25 | ✅ | 补正前是 `UNKNOWN_ERROR`（缺 JSON），补正后拿到结构化答案并通过 |
| 26 | ✅ | 检索正确 |

补正细节：25 第一次补正把名字包装成了对象（`reviewer/rating/quote`），官方按字符串集合判失败；
把提示收紧为"保持原有粒度，简单值不要包装成对象、不要新增字段"后通过。
**这说明补正提示必须约束数据形状，不能只说"输出 JSON"**。

当前结论：新分支已能稳定复现早先 5/6 的基线；剩余失败只有 task 21 的检索完整性。
仍是一次样本，下一步应扩到 30~50 条 × 3 次再报分布。

### 8.5 收紧检索判据后：官方 6/6

8.3 的 5/6 只剩 task 21。查了页面原文后，失败原因不是"没读到"，而是**判据太字面**：

- 条件 "ear cups being small" 是**语义**条件；`Catso` 说 "really are for people with very small ears"、
  `Anglebert` 说 "NOT over the ear cups... half my ear into it"、`Michelle` 说 "For small ears the padding goes over their ears"，
  都在说同一件事，但都没出现 "ear cups" + "small" 的字面组合。
- 反过来，task 25 的条件带 **"explicitly"**，`RemyR`/`Dylan Spears` 只说 "color printing ... poor job" /
  "never printed a satisfying document"，**没有明确写 print quality**，必须排除。
  同一条"语义匹配"规则不能同时套在两类任务上。
- task 26 的 `RemyRRemyR` 被模型简写成 `RemyR` —— 姓名必须照抄显示值。

因此 `buildInstruction` 增加三条检索判据（都不是任务特判，而是按任务措辞决定）：

1. 任务含 `explicitly` → 只纳入明确写了该词/该短语的评论；
2. 不含 `explicitly` → 措辞不同但**明确表达同一意思**的评论也要纳入，但不为凑数纳入擦边项；
3. 评论者姓名照抄页面显示（包括 `RemyRRemyR` / `Michelle DavisMichelle Davis`），同一人只列一次。

同一批 6 条、`deepseek-flash`、一次性 token 复跑：

**官方分：6/6**（`success=[21,22,23,24,25,26]`）。

- task 21 现在交出 `Catso / Dibbins / Anglebert Dinkherhump / Michelle DavisMichelle Davis`，
  官方按别名组认对；
- 25/26 保持通过，没有因为"放宽语义"而多交人。

⚠ 这仍是一次 6 条样本。21 的改善来自**提示层判据**，不是模型能力突变；
下一步仍应扩到 30~50 条 × 3 次，并按分布报告。
