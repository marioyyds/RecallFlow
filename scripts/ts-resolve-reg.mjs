// 注册器：`node --import ./scripts/ts-resolve-reg.mjs …` 时会先加载本文件，
// 把 resolve hook 挂上，再跑真正的入口。
//
// 为什么不直接 `node --import ./scripts/ts-resolve.mjs`：module.register 需要
// 在**被解析之前**执行，而 `--import` 加载的就是注册器本身；把「注册」与
// 「hook 实现」分开，测试也能单独 import hook 做单元验证。
//
// ⚠ 与 scripts/ts-resolve.mjs 同为**迁移期脚手架**，Batch 5 收口时一并删除。
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
