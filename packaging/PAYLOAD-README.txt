RecallFlow 本地服务宿主
======================

这个目录装的是 RecallFlow 浏览器扩展需要的"本地服务宿主"。
它让浏览器在需要时自动启动 127.0.0.1 上的本地服务 —— 你不需要打开终端、也不需要装 Node.js。

目录内容
--------
  node.exe                     便携版 Node 运行时（随包分发，用户无需自行安装）
  recallflow-native-host.exe   浏览器通过 native messaging 启动的宿主
  host.js                      宿主逻辑
  server.bundle.mjs            本地服务本体（已打包成单文件）
  install-host.mjs             注册/反注册脚本（安装器与「修复宿主注册」快捷方式调用）
  install-host.cmd             手动重跑注册的入口
  host.config.json             端口与入口配置
  LICENSE-node.txt             Node.js 的许可证

怎么用
------
1. 在 Edge / Chrome 打开扩展页（edge://extensions 或 chrome://extensions）；
2. 启用「开发人员模式」→「加载解压缩的扩展」→ 指向扩展所在目录；
3. 回到开始菜单，运行「RecallFlow 修复宿主注册」
   （若第 1-2 步在安装之后才做，这一步是必须的：宿主注册需要知道扩展 ID）。
4. 之后浏览器一开，本地服务自动就绪。设置页的「本地服务」会显示状态灯。

日志与排障
----------
  %LOCALAPPDATA%\RecallFlow\logs\launcher.log     启动器（浏览器 → 宿主）
  %LOCALAPPDATA%\RecallFlow\logs\native-host.log  宿主（状态、看门狗、归属）
  %LOCALAPPDATA%\RecallFlow\logs\mcp-server.log   本地服务本体

卸载
----
设置 → 应用 → 已安装的应用 → RecallFlow → 卸载。
卸载只删程序与注册项，**不动日志与用户数据**。
