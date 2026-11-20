<div align="center">

# 💬 PChat

**多用户 AI 角色扮演聊天室 · Cloudflare 全栈无服务器 · 业务数据留在自己的账号里**

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Cloudflare Pages](https://img.shields.io/badge/Cloudflare-Pages-orange)](https://pages.cloudflare.com/)
[![Version](https://img.shields.io/badge/version-0.14.4-green)](CHANGELOG.md)

[📖 文档](https://bypc.us.ci/docs/) · [🚀 从零部署](https://bypc.us.ci/docs/) · [💬 快速上手](https://bypc.us.ci/docs/)

<!-- 替换：导航链接改为文档站对应子页面 -->

</div>

<!-- 替换：建议放两张截图 -->
<p align="center">
  <img src="images/demo-chat.png" alt="聊天界面" width="46%">
  <img src="images/demo-studio.png" alt="外观与玩法中心" width="46%">
</p>

PChat 不是又一个聊天框：长期记忆、情绪与亲密度、导演词 / 安全词、时光机、可定制外观和管理后台都在同一个应用里。它原生跑在 Cloudflare Pages + Functions 上，没有构建步骤，也不需要自备服务器；AI 走 DeepSeek 或任意兼容 OpenAI 的接口。

## ✨ 差异化亮点

- **导演词 / 安全词**：临时指令只对本次生效、不进历史；命中安全词立即中止扮演并跳过记忆注入。
- **长期记忆与承诺追踪**：自动提炼带情绪标签的长期记忆，未完成承诺持续注入提示词；可选 Vectorize 语义检索，未绑定时自动降级到最近记忆。
- **心情与亲密度**：每轮对话由 Workers AI 打心情标签，亲密度映射为「刚认识 / 熟悉 / 亲近 / 亲密」注入提示词。
- **时光机与分享卡片**：按天倍速重播对话；右键消息在本地 Canvas 生成 PNG 分享卡。
- **外观与玩法中心（`/studio`）**：主题、背景纹理、氛围粒子、场景预设、排版、朗读、命令面板，全部实时预览。
- **多用户与安全**：PBKDF2 密码、AES-GCM 加密用户 Key、CORS fail-closed、数据按 `user_id` 隔离、登录审计与限流。

## 🚀 60 秒上手

1. **Fork / 克隆**：在 Cloudflare Pages 新建项目并连接仓库，构建命令留空、输出目录填 `/`。→ [从零部署](https://bypc.us.ci/docs/)
2. **绑定资源与密钥**：D1 绑定 `DB`，KV 绑定 `CHAT_HISTORY`、`PROMPTS_KV`，并配置 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`SECRET_MASTER_KEY`、`DEEPSEEK_API_KEY`。→ [环境变量与绑定](https://bypc.us.ci/docs/)
3. **建表并登录**：把仓库里的 `schema.sql` 执行到 D1（`npx wrangler d1 execute pchat-db --remote --file=./schema.sql`），部署后用管理员账号登录，再新建一个 AI 角色。→ [首次登录](https://bypc.us.ci/docs/)

## ⚠️ 部署前必读

1. **多用户隔离**：KV 键 `prompt_<contact_id>` / `meta_<contact_id>` 不含 `user_id`，不同用户创建相同 `contact_id` 的角色会共用提示词。多人服务前请先改造键名。
2. **Turnstile**：只配 `TURNSTILE_SECRET` 会始终提示「缺少人机验证令牌」，需同时手动填写 `index.html` 的 `<meta name="turnstile-site-key">`，或不要配置 secret。
3. **注册默认关闭**：开放注册需先写 `app_settings` 打开 `allow_register`，再在「系统管理 → 邀请码管理」生成邀请码。

## 🧱 技术栈

原生 HTML / CSS / JS · Pages Functions · D1 · KV · DeepSeek API · 可选 Workers AI / Vectorize / Analytics Engine。

## 📚 文档导航

| 你想做的事 | 入口 |
| :--- | :--- |
| 从零部署（小白版） | [文档](https://bypc.us.ci/docs/) |
| 交接与改造 | [文档](https://bypc.us.ci/docs/) |
| 新人快速上手 | [文档](https://bypc.us.ci/docs/) |
| API / 数据模型 / 安全设计 | [文档](https://bypc.us.ci/docs/) |

<details>
<summary>架构速览（点击展开）</summary>

- **前端**：原生 HTML / CSS / JS，由 Pages 直接托管，无构建步骤。
- **后端**：`functions/api/*` 即路由；`_middleware.js` 统一做认证、CORS 与管理员拦截。
- **数据**：D1 存用户、联系人、聊天、记忆与日志；KV 存聊天热缓存、角色提示词、偏好与限流计数。
- **AI**：调用 `/chat/completions` 流式接口；Workers AI / Vectorize / Analytics Engine 均为可选，未绑定自动降级。
- **完整链路、数据表与安全设计**：[文档](https://bypc.us.ci/docs/)

</details>

## 🤝 贡献

- 前端不引入构建步骤，新增脚本直接以 `<script>` 引入。
- 新增接口放在 `functions/api/` 对应目录，认证交给 `_middleware.js`。
- 新增设置项需同步 `_lib.DEFAULT_APP_SETTINGS`、`functions/api/admin/settings.js` 的白名单、`admin/admin.js` 的 `SETTING_LABELS`。
- 不要把密钥、`.dev.vars`、个人数据提交进仓库。

## 📄 License

本项目基于 [GPL-3.0](LICENSE) 开源。当前版本 **v0.14.4**，更新记录见 [CHANGELOG.md](CHANGELOG.md)。
