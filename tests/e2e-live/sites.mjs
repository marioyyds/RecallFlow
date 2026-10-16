// 真实站点清单（T1）：纯数据模块，零副作用，占位。
//
// 每条 shape（等 P1 实现 harness 时补齐 script/checks）：
//   {
//     id: 'baidu-search',
//     name: '百度搜索',
//     url: 'https://www.baidu.com/',
//     storageState: null,          // 需要登录的站点填 'tests/e2e-live/storage/<id>.json'
//     instruction: '在百度搜「数据库索引」，把前三条结果的标题告诉我。',
//     script: null,                // 脚本化工具序列（先占位，跑通一个再铺开）
//     checks: [],                  // 页面判据：站点自己的数据，不是「工具返回 ok」
//     draftOnly: false,            // 小红书等：只允许草稿，绝不自动发布
//   }
export const LIVE_SITES = Object.freeze([
  { id: 'baidu-search', name: '百度搜索', url: 'https://www.baidu.com/', storageState: null, draftOnly: false },
  { id: 'jd-product', name: '电商详情页（待定具体 URL）', url: '', storageState: null, draftOnly: false },
  { id: 'zhihu-article', name: '知乎长文', url: '', storageState: null, draftOnly: false },
  { id: 'xhs-draft', name: '小红书发布（草稿模式）', url: 'https://creator.xiaohongshu.com/publish/publish', storageState: null, draftOnly: true },
]);
