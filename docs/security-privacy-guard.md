# 支付 / 账号安全与隐私护栏

## 硬拦截

以下动作不依赖模型自觉，也不受“自动批准”或“站点信任”影响：

- 支付确认、下单/购买提交、转账、提现、充值；
- 银行卡绑定/解绑、卡号/CVV 输入；
- 登录提交、密码/OTP/MFA、账号恢复；
- 修改邮箱/手机号、注销账号、授权应用、API Key/Token 创建。

实现分两道：

1. `agent.js` 在审批前调用 `preflightSensitiveToolCall`，避免先让用户批准支付再阻止；
2. `executeTool` 内再次调用同一预检，覆盖宏回放等嵌套执行路径。

命中后 run 进入 `waiting_user_action`，面板显示“安全操作已阻止自动执行”，模型被告知不要重试或换工具绕过。

## 敏感数据最小化

页面正文、DOM 快照、console/network、工具结果在进入模型上下文前统一脱敏：

- 密码、OTP、CVV、银行卡号、Cookie、Authorization、Bearer/JWT、API Key、私钥；
- URL 中的 token/session/code/password 等查询参数；
- `type_text` 只回执长度与是否匹配，不再回显输入值；
- 宏轨迹拒绝记录明显秘密；
- 支付/账号安全页面截图不发送给多模态模型。

## 验证

- `tests/sensitive-data.test.mjs`：脱敏规则与误伤边界；
- `tests/sensitive-action-policy.test.mjs`：动作分类与页面上下文；
- `tests/security-action-wiring.test.mjs`：审批前拦截、嵌套执行、脱敏接线；
- `tests/e2e/security-guard.spec.mjs`：真实 Chromium 中自动批准仍不能支付、密码不能写入、LLM 请求不含哨兵秘密。

## 残余边界

- 规则无法证明任意第三方按钮语义；明确的支付/账号页面会采用更保守的点击拦截。
- 跨域 iframe 内的坐标点击依赖顶层命中信息；敏感页面 URL 仍会触发页面级拦截。
- 本地会话记录属于用户自己的浏览器数据；护栏目标是禁止敏感值进入 LLM 请求。
