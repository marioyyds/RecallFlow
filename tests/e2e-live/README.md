# 真实站点实验室（T1）

> 复用 `tests/e2e/` 的 harness（真 Chromium + 装扩展 + 脚本化模型），但把夹具页换成**真实站点**。
> 它验证的是定位器 / 时序 / 登录态在真实 DOM 上的成色，不花真钱（模型决定是脚本化的）。
> 对应方案文档：`docs/testing-live-sites-plan.md` 的 T1。

## 为什么这个目录独立

- **不进 CI**：真实站点随时会改版，断言必碎；把它混进 `tests/e2e/*.spec.mjs` 会把黄金任务拖红。
- **默认不跑**：用环境变量 `E2E_LIVE=1` 显式打开，脚本里默认 `test.skip(...)`。
- **登录态用 `storageState`**：跑前手动登录一次并导出，跑时免登录。

## 用法（占位，等 P1 实现）

```powershell
E2E_LIVE=1 node scripts/run-e2e-live.mjs    # 待建：前置检查 + 跑 tests/e2e-live/*.spec.mjs
```

## 第一批站点清单（见 `sites.mjs`）

百度/必应搜索、一个电商详情页、知乎/文档站长文、小红书发布页（草稿模式）。
