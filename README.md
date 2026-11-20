<div align="center">

# PChat

**自托管的 AI 角色对话站点 · Cloudflare Pages 静态页与 Functions · 业务数据留在自有 Cloudflare 账号**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-orange)](https://pages.cloudflare.com/)
[![Version](https://img.shields.io/badge/version-0.14.4-green)](CHANGELOG.md)

[文档](https://bypc.us.ci/docs/) · [网页端部署](https://bypc.us.ci/docs/deploy-web) · [命令行部署](https://bypc.us.ci/docs/deploy-cli) · [快速上手指南](https://bypc.us.ci/docs/getting-started)

</div>

PChat 为自托管的多用户 AI 角色对话站点，原生运行于 Cloudflare Pages 与 Functions，无需构建步骤与独立服务器。数据存储于自有 D1，缓存使用 KV，对话内容由 DeepSeek 或任意兼容 OpenAI 的接口生成。

## 功能范围

- **导演词与安全词**：导演词仅对单轮生成生效，不进入聊天历史；消息命中安全词时中止角色扮演，并跳过记忆注入。
- **长期记忆与承诺追踪**：按记忆窗口自动提炼长期记忆并附带情绪标签；未完成的承诺持续注入系统提示词。绑定 Vectorize 时启用语义检索，未绑定时回退为最近记忆。
- **心情与亲密度**：每轮对话由 Workers AI 判定心情标签；亲密度按「刚认识 / 熟悉 / 亲近 / 亲密」映射后注入提示词。
- **对话重放与分享卡片**：按日期重播对话；分享卡片在浏览器本地由 Canvas 绘制为 PNG。
- **外观与玩法中心（`/studio`）**：配色、背景纹理、氛围粒子、场景预设、排版、朗读、命令面板，支持实时预览。
- **多用户与安全**：PBKDF2 密码哈希、AES-GCM 加密用户 Key、CORS 白名单、数据按 `user_id` 隔离、登录审计与限流。

## 仓库内容

| 路径 | 内容 |
|---|---|
| `static/` | 前端静态页面与资源（登录页、聊天页、外观中心、管理后台） |
| `functions/` | Pages Functions，全部 `/api/*` 接口 |
| `package.json` | 构建命令 `npm run build` 与迁移脚本 `npm run postbuild` |
| `tools/` | 构建与迁移脚本（静态资源校验、D1 迁移执行器、配置守卫） |
| `migrations/` | D1 迁移（含基线），生产构建时自动执行并写入 `d1_migrations` 账本 |
| `schema.sql` | D1 结构参照；基线迁移由它生成（`npm run db:baseline:sync`） |
| `wrangler.example.toml` | 命令行部署 / 本地开发的配置模板（生效的 `wrangler.toml` 不入库） |

仓库不包含生效的 `wrangler.toml`：Pages 项目一旦读到它就会以它作为配置来源，控制台里的绑定与环境变量随之变为只读。
需要命令行部署时，`npm run dev` / `npm run deploy` 会自动把模板复制为本地 `wrangler.toml`（已被 `.gitignore` 忽略）。
文档源 `docs-src/` 与构建产物 `static/docs/` 属于可选内容，两种部署方式都不需要它们。

> [!WARNING]
> 跨大版本升级前请先备份数据库，并阅读该版本的迁移说明。
> 不要绕过 `d1_migrations` 直接改表结构，否则自动迁移可能重复执行或状态不一致。

## 部署

站点需要 Cloudflare 账号与 DeepSeek API Key。提供两种部署方式，结果一致：

| 方式 | 适用情形 | 操作位置 | 文档 |
|---|---|---|---|
| 网页端部署（推荐） | 首次部署、本地无开发环境 | Cloudflare 控制台 | <https://bypc.us.ci/docs/deploy-web> |
| 命令行部署 | 需要本地预览、版本控制或脚本化部署 | 本地终端 | <https://bypc.us.ci/docs/deploy-cli> |

两种方式的差异、前置资源清单、部署后的初始化与上线检查见 <https://bypc.us.ci/docs/deploy>。

前置条件：

- Cloudflare 账号：<https://dash.cloudflare.com/sign-up>（免费，无需绑定信用卡；自动分配 `xxx.pages.dev` 子域）
- DeepSeek API Key：<https://platform.deepseek.com>（按 token 计费）
- 网页端部署另需 GitHub 账号；命令行部署另需 Node.js 22 或更高版本

### 网页端部署步骤

1. 在 GitHub **Fork** 本仓库，或通过 **Import repository** 导入为自有仓库。
2. 在 Cloudflare 控制台 **Workers & Pages → D1 SQL database** 创建数据库 `PersonalChat`。
3. 在 **Workers & Pages → KV** 创建两个命名空间：`CHAT_HISTORY`、`PROMPTS_KV`。
4. 在 **Workers & Pages → Create application → Pages → Connect to Git** 选择该仓库，生产分支 `main`，**构建命令填 `npm run build`**，**构建输出目录填 `static`**。
5. 项目 **Settings → Bindings** 添加绑定：`DB`（D1）、`CHAT_HISTORY`（KV）、`PROMPTS_KV`（KV）；可选 `AI`（Workers AI）、`VECTORIZE`（Vectorize，索引 512 维 / cosine）、`AE`（Analytics Engine）。
6. 项目 **Settings → Environment variables**（Production）添加运行期变量：`DEEPSEEK_API_KEY`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`SECRET_MASTER_KEY`，密钥类须选择加密。
7. 同一页添加构建期迁移变量：`CLOUDFLARE_API_TOKEN`（D1 编辑权限）、`CLOUDFLARE_ACCOUNT_ID`、`PCHAT_D1_DATABASE_ID`、`NODE_ENV=development`。
8. 重新部署（**Deployments → Retry deployment**）。构建日志出现 `[db:migrate] ✓ 迁移完成` 即表示建表完成。
9. 访问 `https://<项目名>.pages.dev`，使用管理员账号登录。

完整步骤与常见问题见 <https://bypc.us.ci/docs/deploy-web>；迁移机制见 <https://bypc.us.ci/docs/database>。

### 命令行部署步骤

```powershell
git clone <仓库地址> pchat && cd pchat
npm install
# 自动生成 wrangler.toml（来自 wrangler.example.toml），并把占位符换成自己的 ID
npx wrangler login
npx wrangler d1 create PersonalChat
npx wrangler kv namespace create CHAT_HISTORY
npx wrangler kv namespace create PROMPTS_KV
# 将返回的 ID 填入 wrangler.toml
npm run db:migrate        # 或 npx wrangler d1 migrations apply DB --remote
npm run deploy            # 或 npx wrangler pages deploy
# 再写入 4 个 secret：DEEPSEEK_API_KEY / ADMIN_USERNAME / ADMIN_PASSWORD / SECRET_MASTER_KEY
```

完整命令与报错对照见 <https://bypc.us.ci/docs/deploy-cli>。

## 部署注意事项

1. **绑定名称固定**：`DB`、`CHAT_HISTORY`、`PROMPTS_KV` 由代码直接引用；`AI`、`VECTORIZE`、`AE` 为可选，缺失时对应功能自动降级。
2. **Turnstile 生效条件**：`TURNSTILE_SITE_KEY` 与 `TURNSTILE_SECRET` 同时配置，并在管理后台打开「登录 / 注册人机验证」。站点密钥由服务端从环境变量注入登录页，无需修改 `index.html`。仅配置 `TURNSTILE_SECRET` 时，聊天接口会要求验证令牌并返回「缺少人机验证令牌」。
3. **管理员账号必需**：`ADMIN_USERNAME` 与 `ADMIN_PASSWORD` 缺一不可，否则系统无任何可用账号（注册默认关闭，不提供默认账号），站点无法登录。
4. **注册默认关闭**：开放注册需在「系统管理 → 功能开关」打开允许注册；邀请制须同时开启「注册需邀请码」并在「邀请码管理」生成邀请码。
5. **密钥不得进入仓库**：管理员密码、API Key、主密钥仅通过控制台加密变量或 `wrangler pages secret put` 配置。
6. **数据库迁移**：建表与升级统一走 `migrations/`，账本为 D1 的 `d1_migrations` 表；网页端由生产构建自动执行，命令行端执行 `npm run db:migrate`。不要绕过账本直接用 `schema.sql` 建表，也不要手工删改账本记录。
7. **仓库不含真实资源标识**：`wrangler.example.toml` 只有占位符；生成的 `wrangler.toml`、`.dev.vars` 均已被 `.gitignore` 忽略。

## 技术栈

原生 HTML / CSS / JavaScript · Cloudflare Pages Functions · D1 · KV · DeepSeek API · 可选 Workers AI / Vectorize / Analytics Engine。

## 文档导航

完整手册：<https://bypc.us.ci/docs/>

| 主题 | 地址 |
|---|---|
| 部署指南（方式对比、资源清单、上线检查） | <https://bypc.us.ci/docs/deploy> |
| 网页端部署 | <https://bypc.us.ci/docs/deploy-web> |
| 命令行部署 | <https://bypc.us.ci/docs/deploy-cli> |
| 数据库与迁移（自动迁移、账本规则、编写规范） | <https://bypc.us.ci/docs/database> |
| 交接与改造 | <https://bypc.us.ci/docs/customize> |
| 快速上手指南 | <https://bypc.us.ci/docs/getting-started> |
| 功能使用指南 | <https://bypc.us.ci/docs/playbook> |
| 快捷键 | <https://bypc.us.ci/docs/shortcuts> |
| 高级设置（导演词、提示词、记忆） | <https://bypc.us.ci/docs/advanced> |
| 角色参数设置 | <https://bypc.us.ci/docs/recommended> |
| 数据管理（导出、导入、备份） | <https://bypc.us.ci/docs/data> |
| 常见问题 | <https://bypc.us.ci/docs/faq> |

<details>
<summary>架构速览</summary>

- **前端**：原生 HTML / CSS / JavaScript，由 Pages 直接托管，无构建步骤。
- **后端**：`functions/api/*` 即路由；`_middleware.js` 统一处理认证、CORS 与管理员拦截。
- **数据**：D1 存储用户、联系人、聊天、记忆与日志；KV 存储聊天热缓存、角色提示词与限流计数。
- **AI**：调用 `/chat/completions` 流式接口；Workers AI、Vectorize、Analytics Engine 均为可选，未绑定时自动降级。

</details>

## 相关链接

- Cloudflare 控制台：<https://dash.cloudflare.com/>
- Cloudflare Pages 文档：<https://developers.cloudflare.com/pages/>
- Cloudflare D1 文档：<https://developers.cloudflare.com/d1/>
- Cloudflare Workers AI 文档：<https://developers.cloudflare.com/workers-ai/>
- DeepSeek 开放平台：<https://platform.deepseek.com/>

## 贡献

- 前端不引入构建步骤，新增脚本以 `<script>` 引入。
- 新增接口置于 `functions/api/` 对应目录，认证交由 `_middleware.js` 处理。
- 修改 `functions/` 后须同步 `static/functions/` 副本（两者内容一致，供仅上传静态目录的场景使用）。
- 新增设置项需同步 `_lib.DEFAULT_APP_SETTINGS`、`functions/api/admin/settings.js` 的白名单与 `admin/admin.js` 的 `SETTING_LABELS`。
- 修改表结构：在 `migrations/` 新增 `YYYYMMDDHHMMSS_描述.sql`（幂等优先，破坏性变更走 expand-contract）；
  若改的是 `schema.sql`，须执行 `npm run db:baseline:sync` 同步基线，并用 `npm run db:baseline:check` 校验。
  详细规则见 [migrations/README.md](migrations/README.md)。
- 不得将密钥、`.dev.vars`、`wrangler.toml`（含真实 ID）或个人数据提交至仓库。

## 许可证

本项目基于 [GPL-3.0](LICENSE) 开源。当前版本 v0.14.4，更新记录见 [CHANGELOG.md](CHANGELOG.md)。
