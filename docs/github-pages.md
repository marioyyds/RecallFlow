# GitHub Pages 站点上线说明

> 本文只讲**站点怎么发上去、怎么验、出问题怎么查**。页面本体（`site/index.html`、`styles.css`、`app.js`）的设计与文案不在这里。

## 1. 架构：发布什么、不发布什么

```text
docs/assets/**          # 资源的唯一来源（GIF / SVG / 图标），入库
   │
   │  node scripts/site-assets.mjs     ← 复制，不入库产物
   ▼
site/index.html         # 站点页面，入库
site/styles.css
site/app.js
site/assets/**          # 由脚本生成，.gitignore 忽略（CI 里同样由脚本生成）
   │
   │  node scripts/verify-site.mjs     ← 发布前静态门禁
   ▼
GitHub Pages            # https://marioyyds.github.io/RecallFlow/
```

两个约定：

- **`site/assets/` 不入库**：它是 `docs/assets/` 的副本，提交进去只会和源头慢慢分叉。CI 每次都重新生成。
- **站点零依赖**：页面和两道脚本都只用 Node 内置模块，所以流水线里没有 `npm ci` —— 站点不需要任何 `devDependencies`。

## 2. 一次性人工步骤：启用 Pages

> **当前状态：未启用。** 仓库 `has_pages: false`，Pages API 返回 404，因此**必须先由仓库管理员在 GitHub 网页上开启一次**；不开的话 workflow 的 deploy 步骤会失败、站点一直是 404。这一步无法用脚本或 API 代劳（本环境没有 `gh` CLI，也没有可用的 token）。

1. 打开 <https://github.com/marioyyds/RecallFlow/settings/pages>
2. **Build and deployment** → **Source** 选 **GitHub Actions**（不要选 “Deploy from a branch” —— 那样会绕过校验直接发 `site/`，门禁就没意义了）
3. 保存后回到 **Actions** 页，若 `pages` workflow 没自动跑，手动 **Run workflow**（`workflow_dispatch`）
4. 首次部署通常要等 **1~2 分钟**；job 详情里的 `page_url` 就是站点地址

仓库级权限无需额外配置：`pages: write` 与 `id-token: write` 已写在 workflow 里。若组织策略收紧了默认 token，需在 Settings → Actions → General → Workflow permissions 里允许读写。

## 3. 本地预览与校验

```bash
# 预览（页面自带，热更新用）
node scripts/preview-site.mjs

# 发布前必跑：生成资源 + 静态门禁
node scripts/site-assets.mjs && node scripts/verify-site.mjs
```

`verify-site.mjs` 在仓库根运行，检查四类问题，任一失败退出码 1：

| 检查 | 失败示例 |
| --- | --- |
| 资源存在性 | `site/styles.css:3` 里的 `url(assets/bg.png)` 在磁盘上不存在 |
| 引用不越界 | `<img src="../outside.png">` —— 解析后落在 `site/` 之外 |
| 站外子资源 | `<script src="https://cdn...">`：只有 `<a href="https://...">` 这类**超链接**允许指向站外 |
| 体积红线 | `site/index.html` > 1MB，或 `site/` 下任一文件 > 8MB |

它同时会挡住 `file://`、盘符路径（`C:/...`）、UNC 路径和根绝对路径（`/...` —— 站点挂在 `/RecallFlow/` 子路径下，`/...` 会指到 `github.io` 根域）。

CI 里完全相同的两条命令也会各跑一次（`.github/workflows/pages.yml`），**门禁不通过就不会上传产物、不会部署**。

## 4. 部署后验证

1. 打开 <https://marioyyds.github.io/RecallFlow/>
2. 首屏渲染正常（无白屏、无样式缺失）
3. GIF 能加载并播放（资源来自 `site/assets/`，最容易在这一步 404）
4. 页内文档链接可跳转，浏览器控制台无 404 / MIME 报错

## 5. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 站点 404 | Pages 未启用（本文 §2），或 deploy job 根本没跑 | 先看 Actions 里 `pages` 有没有成功运行；再看 Settings → Pages 的 Source 是不是 **GitHub Actions** |
| 资源 404（图裂 / 样式丢） | 漏了 `node scripts/site-assets.mjs`，产物里没有 `site/assets/` | 补跑脚本；本地用 `node scripts/verify-site.mjs` 复现 |
| `verify-site` 报体积超限 | GIF 太大 | 压缩或换更轻的资源；红线是 `index.html` 1MB、其他单文件 8MB |
| deploy 报权限不足 | 缺 `pages: write` 或 `id-token: write` | 核对 workflow 顶层与 deploy job 的 `permissions`；组织默认 token 为只读时需放行 |
| 改了 `site/**` 但没部署 | `paths` 没命中 | workflow 只在 `site/**`、`docs/assets/**`、两个站点脚本、workflow 自身变动时触发；其他改动请手动 **Run workflow** |

## 6. 已知限制

- **没有自定义域名**：站点固定在 `https://marioyyds.github.io/RecallFlow/`，不配 CNAME / DNS。
- **没有访问统计**：不接 Analytics，只看 Actions 的部署记录。
- **单页站点，不是文档站**：不做 Markdown 渲染 / 多页导航；想看文档直接读仓库里的 `docs/**`。
