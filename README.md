<div align="center">

# PChat

**自托管的 AI 角色对话站点 · Cloudflare Pages（Direct Upload）+ Functions · 数据留在自有 Cloudflare 账号**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-orange)](https://pages.cloudflare.com/)
[![Version](https://img.shields.io/badge/version-1.0.0-green)](CHANGELOG.md)

[文档](https://bypc.us.ci/docs/) · [部署指南](https://bypc.us.ci/docs/deploy) · [数据库与迁移](https://bypc.us.ci/docs/database) · [快速上手指南](https://bypc.us.ci/docs/getting-started)

</div>

PChat 为自托管的多用户 AI 角色对话站点，运行于 Cloudflare Pages 与 Functions。数据存储于自有 D1，缓存使用 KV，对话内容由 DeepSeek 或任意兼容 OpenAI 的接口生成。

从 **1.0** 起，部署与数据库升级全部由 GitHub Actions 完成：推送代码后自动「应用 D1 迁移 → 构建 → Direct Upload 部署」，使用者不需要安装 Node.js、wrangler，也不需要执行任何 SQL。

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
| `static/` | 前端静态资源（登录页、聊天页、外观中心、管理后台），也是 Direct Upload 上传的目录 |
| `functions/` | Pages Functions，全部 `/api/*` 接口；部署时由 Wrangler 自动打包 |
| `migrations/` | D1 迁移（基线 + 增量），由 Actions 执行并写入 `d1_migrations` 账本 |
| `.github/workflows/deploy.yml` | 唯一部署入口：迁移 → 构建 → 部署 |
| `package.json` | 构建脚本与依赖（`wrangler` 精确锁定 `4.166.0`） |
| `tools/` | 构建自检与本地开发辅助（4 个脚本） |
| `wrangler.example.toml` | 配置模板（全部占位符，不含真实 ID） |
| `schema.sql` | 结构阅读参考，**不参与部署**，不用于初始化数据库 |

## 部署

### 使用者需要做的两步（GitHub 侧）

1. 打开仓库的 **Actions** 页面，点击启用 workflows（fork 默认不运行任何工作流）。
2. **Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret | 必需 | 说明 |
|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 是 | Cloudflare 账号 ID |
| `CLOUDFLARE_API_TOKEN` | 是 | 自定义 API Token：`Account → 开发人员平台 → Cloudflare Pages: Edit` 与 `D1: Edit` |
| `D1_DATABASE_ID` | 第二次部署时 | D1 数据库 ID（首次部署先不加，见下方「两次部署」） |

可选 Variable：`PAGES_PROJECT_NAME`（默认 `pchat`），当 Cloudflare 里的 Pages 项目名不是 `pchat` 时需要设置。

### Cloudflare 侧（一次性准备）

1. **创建 Pages 项目（Direct Upload）**：Workers & Pages → Create → Pages → **Upload assets**，项目名默认用 `pchat`。
2. **创建 D1 数据库**：Storage & Databases → D1 → Create，名称建议 `PersonalChat`。
3. **创建两个 KV 命名空间**：`CHAT_HISTORY`、`PROMPTS_KV`。
4. **绑定到 Pages 项目**：Settings → Bindings，绑定名必须与代码一致：
   `DB`（D1）、`CHAT_HISTORY`（KV）、`PROMPTS_KV`（KV）；可选 `AI`、`VECTORIZE`、`AE`。
5. **运行期环境变量**：`DEEPSEEK_API_KEY`、`ADMIN_USERNAME`、`ADMIN_PASSWORD`（必需），
   建议 `SECRET_MASTER_KEY`；可选 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET` / `ALLOWED_ORIGINS` / `AI_GATEWAY_URL`。

### 两次部署的节奏

| 次数 | 前提 | 结果 |
|---|---|---|
| 第 1 次 | 已配置 Account ID + API Token（未配 `D1_DATABASE_ID`） | 迁移步骤**跳过并警告**，应用照常部署：站点可打开、接口已连通，但登录会因缺少数据表报错 |
| 第 2 次 | 补上 Secret `D1_DATABASE_ID` 后重新运行 | 迁移执行、表建好，登录正常 |

这样设计是为了先确认「项目功能初始化」通过（绑定、环境变量、Functions 都正常），再做「数据结构初始化」，避免一次失败全部卡住。

> 若连 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` 都没配置，工作流会直接**跳过**（deploy 作业显示为 skipped，不会失败），所以上游仓库不会因此出现红叉。

> 用户侧的全部操作都在 GitHub 网页与 Cloudflare 控制台完成；不需要 Node.js、wrangler 或任何命令行。

## 迁移规则

- `migrations/` 是唯一事实来源；账本为 D1 中的 `d1_migrations`，由 Wrangler 自动创建与写入。
- **基线已冻结**：`20261120000000_baseline.sql` 不可修改；任何结构变更都新增 `YYYYMMDDHHMMSS_描述.sql`。
- 不要手工执行 SQL（包括 `schema.sql`、基线文件），也不要手工删改 `d1_migrations` 的行。
- 破坏性变更采用 expand-contract，分多次完成：先加列/加表，再回填/双写，最后在无回滚需求时删旧列。
- 详见 [migrations/README.md](migrations/README.md) 与 [数据库与迁移](https://bypc.us.ci/docs/database)。

## 本地开发（可选，普通使用者可跳过）

> 需要 Node.js 22 与 wrangler。日常部署不需要这一步。

```powershell
npm install
# 首次运行会从 wrangler.example.toml 生成本地 wrangler.toml（已被 .gitignore 忽略）
npm run dev                  # 本地页面：http://127.0.0.1:8788
npm run dev:offline          # 断网 / 连不上 Cloudflare 时使用
npx wrangler d1 migrations apply DB --local     # 本地库建表
```

## 技术栈

原生 HTML / CSS / JavaScript · Cloudflare Pages Functions · D1 · KV · DeepSeek API · 可选 Workers AI / Vectorize / Analytics Engine。

## 文档导航

完整手册：<https://bypc.us.ci/docs/>

| 主题 | 地址 |
|---|---|
| 部署指南（Actions + 控制台准备 + 上线检查） | <https://bypc.us.ci/docs/deploy> |
| 网页端部署（控制台准备，Direct Upload） | <https://bypc.us.ci/docs/deploy-web> |
| 数据库与迁移（账本、Time Travel、预览环境边界） | <https://bypc.us.ci/docs/database> |
| 命令行部署（开发者兜底） | <https://bypc.us.ci/docs/deploy-cli> |
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

- **前端**：原生 HTML / CSS / JavaScript，随仓库提供，无编译步骤；`static/` 即 Direct Upload 的产物目录。
- **后端**：`functions/api/*` 即路由；`_middleware.js` 统一处理认证、CORS 与管理员拦截。
- **数据**：D1 存储用户、联系人、聊天、记忆与日志；KV 存储聊天热缓存、角色提示词与限流计数。
- **部署**：GitHub Actions 先 `wrangler d1 migrations apply`，再 `wrangler pages deploy`（Direct Upload）。
- **AI**：调用 `/chat/completions` 流式接口；Workers AI、Vectorize、Analytics Engine 均为可选，未绑定时自动降级。

</details>

## 相关链接

- Cloudflare 控制台：<https://dash.cloudflare.com/>
- API Token 权限说明：<https://developers.cloudflare.com/fundamentals/api/reference/permissions/>
- Pages Direct Upload + CI：<https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/>
- D1 迁移：<https://developers.cloudflare.com/d1/reference/migrations/>
- D1 Time Travel：<https://developers.cloudflare.com/d1/reference/time-travel/>
- DeepSeek 开放平台：<https://platform.deepseek.com/>

## 贡献

- 前端不引入构建步骤，新增脚本以 `<script>` 引入。
- 新增接口置于 `functions/api/` 对应目录，认证交由 `_middleware.js` 处理。
- 修改表结构：在 `migrations/` 新增 `YYYYMMDDHHMMSS_描述.sql`（幂等优先，破坏性变更走 expand-contract）；
  `schema.sql` 仅作文档参考，同步更新即可，不需要重新生成基线。详细规则见 [migrations/README.md](migrations/README.md)。
- 新增设置项需同步 `_lib.DEFAULT_APP_SETTINGS`、`functions/api/admin/settings.js` 的白名单与 `admin/admin.js` 的 `SETTING_LABELS`。
- 不得将密钥、`.dev.vars`、`wrangler.toml`（含真实 ID）或个人数据提交至仓库。

## 许可证

本项目基于 [GPL-3.0](LICENSE) 开源。当前版本 v1.0.0，更新记录见 [CHANGELOG.md](CHANGELOG.md)。
