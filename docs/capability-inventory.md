# 能力剧本清单（自动生成，请勿手改）

由 `scripts/gen-capability-inventory.mjs` 从产物推导；`npm test` 里的
`tests/capability-inventory.test.mjs` 每次重算比对 —— 产物变了而本文件没跟上就会红。

三层形状 = **夹具页**（造出该类真正的难点）+ **剧本**（`tools` 作契约锚点）+
**真浏览器 E2E**（断言页面状态 **AND** 模型实际收到了什么）+ **内置技能**。
「结果所在」列说明该剧本的判据落在哪里：`page`（页面状态）/ `storage`（扩展存储，如知识库）——
**空的页面判据必须显式声明理由**，否则门禁不放过。

| 剧本 | 触发词 | 夹具页 | 工具 | 技能 | E2E | 页面判据 | 回执判据 | 结果所在 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `canvas-coordinate-click` | 画布 | `/canvas` ✓ | 4 | `canvas-coordinate-click` | ✓ | 3 | 2 | page |
| `cascade-select` | 配送范围 | `/cascade` ✓ | 5 | `cascade-select` | ✓ | 3 | 1 | page |
| `cdp-drag-slider` | 拖拽 | `/drag` ✓ | 3 | `cdp-drag-slider` | ✓ | 3 | 1 | page |
| `checkout-form` | 下单 | `/checkout` ✓ | 6 | `checkout-form` | ✓ | 6 | 2 | page |
| `cross-tab-handoff` | 验证码 | `/handoff` ✓ | 4 | `cross-tab-handoff` | ✓ | 2 | 1 | page |
| `csp-page-world-js` | 核对总价 | `/csp` ✓ | 3 | `page-world-js` | ✓ | 2 | 1 | page |
| `date-picker-custom` | 入住 | `/datepicker` ✓ | 5 | `date-picker-custom` | ✓ | 3 | 1 | page |
| `debug-console-error` | 没反应 | `/debug` ✓ | 4 | `debug-console-error` | ✓ | 3 | 2 | page |
| `dismiss-overlay` | 弹窗 | `/blocked` ✓ | 4 | `dismiss-overlay` | ✓ | 5 | 2 | page |
| `download-verify` | 报表 | `/download` ✓ | 4 | `dialog-handling` | ✓ | 0 | 1 | payload |
| `extract-merged-table` | 表格 | `/table` ✓ | 2 | `extract-merged-table` | ✓ | 1 | 4 | page |
| `form-validation` | 报名表 | `/validate` ✓ | 5 | `form-validation` | ✓ | 4 | 1 | page |
| `infinite-scroll-hover-preview` | 信息流 | `/feed` ✓ | 6 | `infinite-scroll-hover-preview` | ✓ | 4 | 3 | page |
| `knowledge-save-retrieve` | 知识库 | `/notes` ✓ | 3 | `knowledge-save-retrieve` | ✓ | 0 | 4 | storage |
| `knowledge-search-fallback` | 打开很慢 | `/notes` ✓ | 3 | `knowledge-search-fallback` | ✓ | 0 | 3 | storage |
| `macro-save-replay` | 存成宏 | `/macro` ✓ | 6 | `macro-save-replay` | ✓ | 3 | 3 | page |
| `multi-candidate-convergence` | 比价 | `/pick` ✓ | 4 | `multi-candidate-convergence` | ✓ | 7 | 2 | page |
| `new-tab-takeover` | 新标签页 | `/portal` ✓ | 3 | `new-tab-takeover` | ✓ | 2 | 3 | page |
| `operate-in-cross-origin-iframe` | 跨域 | `/framed` ✓ | 5 | `operate-in-cross-origin-iframe` | ✓ | 4 | 2 | page |
| `paginate-async` | 翻页 | `/paged` ✓ | 4 | `paginate-async` | ✓ | 3 | 2 | page |
| `paywall-preview-limit` | 没会员 | `/paywall` ✓ | 4 | `paywall-boundary` | ✓ | 4 | 2 | page |
| `pierce-shadow-dom` | 自定义组件 | `/shadow` ✓ | 4 | `pierce-shadow-dom` | ✓ | 3 | 3 | page |
| `read-select-options` | 最便宜 | `/shipping` ✓ | 4 | `read-select-options` | ✓ | 3 | 2 | page |
| `readability-fix` | 美化 | `/article` ✓ | 3 | `readability-fix` | ✓ | 6 | 1 | page |
| `recover-from-rejection` | 购买 | `/recover` ✓ | 5 | `recover-from-rejection` | ✓ | 7 | 2 | page |
| `site-search` | 站内搜 | `/search` ✓ | 5 | `find-skill-skillhub` | ✓ | 3 | 4 | page |
| `undo-last-action` | 撤销 | `/undo` ✓ | 7 | `undo-last-action` | ✓ | 2 | 2 | page |
| `upload-file` | 上传文件 | `/upload` ✓ | 4 | `upload-file` | ✓ | 3 | 2 | page |
| `video-playback-verify` | 视频在播 | `/video` ✓ | 4 | `video-playback-verify` | ✓ | 8 | 4 | page |
| `virtual-list-scroll` | VL-87 | `/vlist` ✓ | 4 | `virtual-list-scroll` | ✓ | 4 | 1 | page |

**合计**：30 个剧本；页面判据 101 条、回执判据 64 条；夹具路由已接线 30/30；E2E 已引用 30/30；有内置技能 30/30。
