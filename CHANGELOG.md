此文件为工程向，页面用 static/ 下那份
# 更新日志

本文件记录 PChat 的版本变更。版本号遵循语义化版本（SemVer）。

自 1.0.0 起进入大版本线：接口与数据结构以迁移为准，破坏性变更会在版本说明中单独标注。
1.0 的主要改动是「部署与数据库迁移」：从 Pages 构建期迁移改为 GitHub Actions 自动迁移 + Direct Upload。

## [1.0.0] - 2026-11-20

> 首个大版本：部署与数据库迁移架构重做 —— Pages Git 集成构建期迁移 → GitHub Actions 自动迁移 + Direct Upload。
> 仓库不再包含任何 Pages 构建期迁移脚本；账本 `d1_migrations` 由 Wrangler 独占托管。
> **破坏性变更**：部署方式、Secrets、仓库目录均有变化，请按「升级步骤」操作。

### 架构

- 新增 `.github/workflows/deploy.yml`，顺序固定：
  `checkout → setup-node(22) → npm ci → 应用 D1 迁移 → 构建 → wrangler pages deploy`（Direct Upload，上传预构建产物）。
- 工作流拆为 `preflight` + `deploy` 两个 job：未配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 时
  `preflight` 判定「跳过」，`deploy` 显示为 skipped，整个运行**成功**——上游仓库不会因为没有 Secrets 而出现红叉；
  fork 补上 Secrets 后自动开始部署。
- 删除 Pages 构建期迁移：`tools/db-migrate.mjs`、`tools/db-baseline.mjs`、`postbuild` 钩子、
  `CF_PAGES` / 分支门禁 / 临时配置生成逻辑，以及 `db:migrate*`、`db:baseline:*`、`db:init*` 脚本。
- 删除旧 workflow `.github/workflows/d1-migrate.yml`：由 `deploy.yml` 统一入口，避免两套流水线。
- Pages 项目改为 **Direct Upload**：不再监听 Git，构建与发布全部由 Actions 完成。

### 数据库

- 迁移命令统一为 `npx wrangler d1 migrations apply DB --remote --force`
  （`--force` 自 wrangler 4.165.0+ 支持；更早版本在 CI 中会自动跳过确认）。
- 迁移使用运行时生成的临时配置 `.wrangler-ci.toml`：模板里的 `database_id` 占位符由 Secret
  `D1_DATABASE_ID` 替换，真实 ID 仍然不入库。
- 基线 `migrations/20261120000000_baseline.sql` **冻结**：头部注明由 Wrangler 执行并记账、
  请勿在 D1 Console 手动执行、已发布基线不可修改，后续只追加带时间戳的增量迁移。
- `schema.sql` 保留，但降级为「阅读参考」：不参与部署，也不得用于初始化数据库（会绕过账本）。
- 明确 Time Travel 备份窗口：Workers Free 7 天 / Workers Paid 30 天，写入「首次迁移前」章节。

### 仓库

- 删除 `static/functions/`（45 个文件，与根 `functions/` 逐字节相同）：Direct Upload 会把它当静态资源公开，
  而根 `functions/` 已由 Wrangler 自动打包为 Pages Functions；`npm run build` 会检测并阻止再次出现。
- `wrangler` 精确锁定 `4.166.0`（`devDependencies`），脚本统一用 `npx wrangler`。
- `package-lock.json` 的 `resolved` 统一为 `registry.npmjs.org`（原本指向国内镜像，
  GitHub Runner 上 `npm ci` 可能变慢或失败）；锁定的版本与 integrity 不变。
- 移除 `deploy` / `predeploy` 脚本：本地发布改用 `npx wrangler pages deploy static --project-name <项目名>`，
  Actions 侧不需要这两个脚本。
- 版本号：`package.json`、`static/js/version.js`、页面占位统一为 `1.0.0`。

### 文档

- README 与 `docs-src/` 全量改写：新增「数据库与迁移」页，把部署拆成「控制台准备（Direct Upload）」
  与「GitHub Actions 自动部署」，命令行路径降级为开发者兜底。
- 删除全部 `CF_PAGES`、`postbuild`、`NODE_ENV=development`、`schema.sql 作为基线来源` 的表述。
- 应用内 3 处「使用手册」入口改为打开官方在线手册（`https://bypc.us.ci/docs/`），
  仓库不再依赖站内 `/docs/` 路径。

### 升级步骤（必须）

1. 在 Cloudflare 控制台把 Pages 项目改为 **Direct Upload**（Git 集成项目无法原地切换：
   需要新建 Direct Upload 项目，重新绑定 D1 / KV 与环境变量，再改 GitHub 里的部署目标）。
2. GitHub：Actions 页面启用 workflows；添加 Secrets `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`
   （Token 需要 `Cloudflare Pages: Edit` 与 `D1: Edit`）。
3. 第一次部署（先不加 `D1_DATABASE_ID`）：只上传代码，确认绑定、环境变量、Functions 都正常。
4. 添加 Secret `D1_DATABASE_ID`，再跑一次：迁移建表，账本落库。
5. 老库不需要手工建表：基线对已有结构是空操作，只会补上账本记录。

### 验证

- `node --check` 覆盖全部 `tools/*.mjs`；`npm run build` 通过且不触发任何迁移。
- `wrangler pages functions build` 编译通过，确认 `pages deploy static` 会打包根目录 `functions/`（不再需要 `static/functions`）。
- 全仓断言：docs / README / workflow 中不再出现 `CF_PAGES`、`postbuild`、
  `PAGES_WRANGLER_MAJOR_VERSION`、`db:baseline`、`NODE_ENV=development`。
- 敏感信息扫描：仓库内无真实 `database_id`、API Token、账号 ID；`wrangler.example.toml` 只有占位符。
- 公开仓库自检：无 `node_modules`、`.wrangler`、`wrangler.toml`、`docs-src`、`static/docs`。

## [0.14.4] - 2026-11-15

> 体验与安全补丁：登录防爆破升级为「IP + 账号」双维度、聊天页移动端顶部按钮收纳、
> 管理后台日志表格与角色列表可读性修复。
> 无数据库变更、无新增环境变量，部署后直接生效。

### 安全

- **登录接口新增账号维度防爆破**（`functions/api/auth/login.js`）：
  - 每次密码校验失败时，除原有 IP 计数（`rl_login_<ip>`，15 分钟 10 次）外，
    同时累加该账号的失败计数 `rl_login_user_<username>`（KV，TTL 15 分钟）；
  - 15 分钟窗口内失败达 5 次后，后续请求直接返回 `429`：
    `{"error":"该账号尝试过于频繁，请稍后再试"}` + `Retry-After: 900`，
    **即使密码正确也不再放行**，直到窗口结束；
  - 登录成功（含「密码正确但账号已停用」）清空该账号计数，避免误伤正常用户；
  - 计数 key 归一化（去首尾空白 + 转小写）：`Admin` / `admin ` / `ADMIN` 共用同一计数器，
    防止用大小写变体绕过；
  - 覆盖环境变量管理员账号，且不存在的用户名同样计数（避免用「是否被锁」反推账号是否存在）；
  - KV 异常时放行（与 IP 限流口径一致），不会因存储故障锁死账号。
- 登录审计新增拦截原因 `user_rate_limited`：管理页「登录日志」与用户端
  「我的登录日志」均显示为「账号失败次数过多」。

### 新增：移动端顶部按钮收纳

- 聊天页顶部操作栏新增「更多（⋮）」按钮与底部弹出面板
  （`#chatMoreBtn` / `#chatMorePanel`）：
  - `<768px` 只保留「搜索」，时光机 / 收藏 / 导出 / AI 承诺 / AI 设置 / 清空记录收进面板；
  - 面板为 3 列网格（≤380px 自动降为 2 列），每项带图标与文字说明；
  - 面板项用 `data-more-target` 指向原按钮，点击即转发 `click()` 到原按钮并自动关闭面板，
    导出弹窗、时光机、清空记录等业务逻辑零复制；
  - 面板项可用性跟随原按钮：未选联系人时「收藏 / 导出」、非管理员时的「系统管理」，
    在原按钮被 `display:none` 时面板项同样隐藏。
- 右上角账号区同样收纳（`#userMoreBtn` / `#userMorePanel`）：
  移动端保留「设置 / 退出登录」，命令面板 / 管理后台 / 系统管理 / 同步数据 / 个人资料进面板。
- 交互细节：点遮罩、点关闭、`Esc`、视口离开移动端都会自动收起；
  桌面端不显示 ⋮，布局与改动前完全一致。

### 修复：管理后台表格

- **操作日志 `target` 截断**：超过 20 字符截断为「前 20 字符 + …」并加 `title` 展示全貌，
  长 JSON 不再把表格撑变形；配套 `.cell-clamp`（单行省略）兜底，
  超长文本不会换行拉高行高。
- **日志表格限高滚动**：操作日志 / 登录日志容器改用 `.table-wrap-scroll`
  （`max-height: 400px` + 纵向滚动），表头 `position: sticky` 吸顶；
  sticky 表头用不透明背景 + `inset` 阴影补分隔线，滚动时内容不会从表头下方透出。
- **角色管理列表精简**：删除「温度 / Top P / 最大令牌」三列，只保留「类型 / 名称 / 操作」，
  列宽改为 14% / 50% / 36%（名称列 30% → 50%），手机端不再拥挤；
  三个参数仍可在「编辑角色」弹窗中查看与修改。
  - 归档行同步改为 3 列，「已归档」标记并入名称列（新增 `.archived-tag` 胶囊样式）；
  - 空态 / 搜索无结果 / 加载失败行的 `colspan` 由 6 改为 3。

### 版本

- `static/js/version.js`、`package.json`、页面兜底文案统一为 `0.14.4`；
  根目录 `CHANGELOG.md` 与 `static/CHANGELOG.md` 同步更新。

### 文档与验证

- 登录限流：用内存版 KV / D1 跑真实 handler，20 项断言通过
  （5 次锁定、锁定期内正确密码仍 429、`Retry-After`、大小写变体共用计数、
  成功清空计数、不存在账号同样计数、IP 维度仍独立生效）。
- 操作日志渲染：抽取真实 `loadAdminLogs` 跑假数据，17 项断言通过
  （20 字符边界、省略号、`title` 全貌与 HTML 转义、`null` → `—`、空态）。
- 角色列表渲染：抽取真实 `renderContacts`，14 项断言通过
  （每行 3 单元格、归档行对齐、`colspan` 与参数列已移除）。
- 移动端收纳：headless Chrome 加载真实 `index.html` 标记与真实 `initMorePanels`，
  390 / 768px 各 43 项断言、1200px 10 项断言通过。
- 后台表格：1262px / 504px 各 23 项断言通过（限高 400、可滚动、表头吸顶偏移 <12px、
  不横溢）；角色表 1280 / 504px 各 15 项通过（列宽 14/50/36、行单元格数一致）。
- `node --check` 覆盖 `app.js` / `features.js` / `admin.js` / `roles.js` / `login.js`。

## [0.14.3] - 2026-11-14

> 0.14.x 样式架构收尾：管理后台 CSS 合并、四层 CSS 拆分、按钮交互修复。
> 无数据库变更，部署后直接生效。

### 重构

- **管理后台 CSS 模块化**：
  - 新增 `static/admin/AGM.css`：后台公共顶栏、面板、统计栏、`.data-table`
  - `admin.css` / `roles.css` / `stats.css` 只保留页面专属规则
  - 删除重复按钮、表格、面板、Toast 定义；后台 CSS 总量约减少 25%
- **四层 CSS 架构**：
  - `theme.css`：只保留设计令牌（颜色 / 圆角 / 阴影 / 过渡 / 强调色）
  - `base.css`：全局 reset、body、滚动条、全局动画、明暗过渡、登录/角色遗留
  - `components.css`：按钮、弹窗、表单、Toast、`.settings-option-btn`、`.enh-switch`、加载指示
  - `chat.css`：聊天布局、侧栏、消息气泡、Markdown、命令面板、洞察、时光机、分享卡片及全部增强包样式
  - 删除 `enhance.css`，其增强样式与主题令牌分别并入 `chat.css` / `theme.css`
  - `studio.html` 加载 `chat.css` 以复用实时预览的消息气泡样式

### 修复

- **按钮 hover 闪烁/抖动**：
  - 全局 `*` 过渡移除无法插值的 `background`，增加 `transform`
  - 清理 `base.css` / `chat.css` / `studio.css` 中的 `transition: all`
  - 删除全局 `button:not(:disabled):not(.expand-btn):active` 缩放，避免与单按钮动画冲突
- **暗色按钮白底白字**：
  - `#sendButton` / `#sendButton:hover` 统一使用 `var(--accent-text)`
  - `.btn-primary:hover` / `.btn-accent:hover` 明确设置 `color: var(--accent-text)`
  - `.user-actions button:hover` / `.chat-header-btn:hover` 背景改为 `var(--border-color)`，不再过透
- **归档 / 清除记录按钮卡在“归档中 / 删除中”**：
  - 角色归档：`openDeleteModal` 打开时复位，`doDelete` 在 `finally` 中恢复按钮
  - 清空聊天记录：`openClearHistory` 打开时复位，删除流程在 `finally` 中恢复按钮
  - 成功关闭弹窗后，下次打开按钮恢复可用且文案正确

### 文档与验证

- 管理后台 22 项、四层 CSS 21 项、按钮状态 5 项 Chrome 检查通过
- 组件层与聊天层 `!important` 数量为 0
- `wrangler pages functions build` 通过
- 版本号提升到 `0.14.3`

## [0.14.2] - 2026-11-14

> 0.14.x 补丁合集：多用户 KV 串号修复、管理后台邀请码管理、ECharts 6 统计图表与主题联动。
> 无数据库变更，部署后直接生效。

### 修复

- **角色设定 KV 按用户隔离**：
  - `meta` / `prompt` 的 KV key 从 `meta_${cid}` / `prompt_${cid}` 改为 `meta_${userId}_${cid}` / `prompt_${userId}_${cid}`
  - 覆盖 `contacts/index.js`、`role/[id]/meta.js`、`role/[id]/prompt.js`、`ai/stream.js`、`_lib.js#buildSystemPrompt` 与 `contacts/[id]/archive.js` 的 purge 清理
  - 不同用户拥有相同 `contact_id` 时不再互相覆盖；彻底删除只清理当前用户的 key，不会误删别人的设定
- **新建联系人头像入库**：`contacts/index.js` 的 INSERT 补上 `avatar` 字段并校验长度；同时写入角色 `meta.avatar`
- **图表主题残留**：ECharts 6 调用 `setTheme()` 后统一用 `{ notMerge: true }` 重设 option，避免切换主题后系列/状态残留
- **旧 KV 数据**：旧的 `meta_${cid}` / `prompt_${cid}` 不再读取；升级后需重新保存角色设定，或按用户 ID 手工迁移

### 新添加

- **邀请码接口** `functions/api/admin/invites.js`：
  - `GET /api/admin/invites?page=1&page_size=20`：分页返回 `code` / `used_by` / `used_by_username` / `expires_at` / `created_at` / `expired`
  - `POST /api/admin/invites`：接收 `{ count: 1, expire_days: 7 }`，生成 `XXXX-XXXX-XXXX` 格式邀请码（1~50 个，1~3650 天）
  - `requireAdminRole` 双重校验；生成后写 `admin_logs`：`action='invites.create'`
- **管理页邀请码面板**：有效天数输入、生成按钮、只读表格（ID / 邀请码 / 状态 / 到期时间 / 操作）、未使用高亮、复制按钮、分页
- 操作日志新增「生成邀请码」中文动作

### 改进

- **统计页 ECharts 6**：
  - 每日消息量：平滑折线图
  - 情绪趋势：`stack: 'emotion'` 堆叠柱状图
  - 情绪分布 / 各角色消息量：横向条形图
  - 活跃时段：极坐标柱状图（0-23 时）
- **管理页用量统计**：`.usage-chart` 改为 200px 高的 `#usageChart`，用 ECharts 折线图展示 token 用量趋势
- **主题联动**：
  - `stats.js` / `admin.js` 均维护 `chartInstances`，初始化时按 `data-theme` 选择 `dark` / `default`
  - `updateAllChartThemes(isDark)` 遍历实例调用 `setTheme()`，再用 `notMerge` 重绘
  - 管理页 / 统计页新增主题切换按钮；监听 `storage` 与系统主题变化，跨标签页同步
  - 窗口 resize 时统一 `chart.resize()`
- **样式清理**：删除 `stats.css` 中 `.bar-fill` / `.hourly-cell` / `.dist-*` 等旧图表样式；删除 `admin.css` 的 `.usage-chart` / `.usage-bar`
- 版本号提升到 `0.14.2`

### 文档与验证

- 新增 KV 隔离 29 项断言、邀请码后端 23 项 + UI 17 项、ECharts UI 20 项断言，全部通过
- `wrangler pages functions build` 通过
- `regression.md` 增加 0.14.2 检查项

## [0.14.1] - 2026-11-14

> 0.14.0 补丁：补齐管理后台「功能开关（运行级配置）」模块。
> 无数据库变更，部署后直接生效。

### 新添加

- **管理接口** `functions/api/admin/settings.js`：
  - `GET /api/admin/settings`：`getAppSettings(env, { skipCache: true })` 读最新配置，返回 `{ settings }`
  - `PUT /api/admin/settings`：接收 `{ settings: { key: '1' | '0' } }`，用 `setAppSettings()` 批量更新
  - 管理员权限双重校验（`requireAdminRole`）；只允许写 15 个功能开关（白名单），值只接受 `'1'` / `'0'`（布尔值归一化）
  - 更新成功后写 `admin_logs`：`action='settings.update'`，`target` 记录开关名与最终值
- **管理页**（`static/admin/admin.html` / `admin.css` / `admin.js`）：
  - 新增「功能开关（运行级配置）」面板：注册 / 邀请码 / 自备 Key / 系统 Key / 记忆 / 自动提取 / 收藏 / 表情 / 承诺 / 洞察 / 统计 / 时光机 / 搜索 / 导出 / 导入，共 15 项
  - 仿 iOS 拨动开关（44×24，选中绿色 `#10b981`），网格自适应；关闭后对应接口立即返回 403
  - 保存后自动刷新开关状态、系统初始化状态与操作日志；操作日志动作显示「更新功能开关」

### 修复

- 保存按钮在请求完成后立即恢复，不再被保存后的面板刷新拖住而一直显示「保存中…」

### 文档与验证

- 版本号提升到 `0.14.1`（`package.json` / `static/js/version.js` / 页面占位 / `studio`）
- 新增后端 22 项断言（读写 / 权限 / 参数校验 / 审计 / 开关真实生效）与 headless Chrome 18 项断言（15 项渲染 / 样式 / 切换 / 保存 / 审计 / 刷新保持 / 无 JS 错误），全部通过
- `regression.md` 增加 0.14.1 检查项

## [0.14.0] - 2026-11-14

> 「多用户安全架构」：角色与状态、注册 / 邀请码、用户自备 API Key、功能开关、
> 登录 / 操作审计、系统管理页。**破坏性升级**：必须执行迁移 `002`，默认管理员不再自动写入。

### 新添加

- **数据库**：`users` 增加 `role`（`user` / `admin`）与 `status`（`active` / `disabled` / `banned`）；新增 `app_settings`、`user_secrets`、`user_usage`、`invite_codes`、`login_logs`、`admin_logs` 六张表及索引
- **迁移** `migrations/002_security_and_audit.sql`：存量库加列、建表，并把旧 `admin` 账号提升为管理员（保留数据）；`schema.sql` 成为全新库基线，删除默认账号与默认联系人初始化
- **安全内核**（`functions/_lib.js`）：
  - `getAppSettings` / `setAppSetting(s)`：D1 + KV（TTL 60s），KV / D1 异常分别回源与回退默认值
  - `encryptSecret` / `decryptSecret`：Web Crypto AES-GCM 256，密文格式 `v1:<iv>:<密文>`，主密钥由 `SHA-256(SECRET_MASTER_KEY)` 派生；缺主密钥时加密抛错、解密返回 null
  - `logAdminAction` / `logLoginAttempt`：分别按 `ADMIN_LOG_MAX_COUNT`（2000）/ `LOGIN_LOG_MAX_COUNT`（5000）自动裁剪
  - `constantTimeEqual`、`requireFeature(s)`、`requireAdminRole`、`chinaDateKey`、`isEnvFlagEnabled`
- **登录 / 注册**：
  - `login.js`：`env.ADMIN_USERNAME` 走 `env.ADMIN_PASSWORD` 明文恒定时间比对，首次登录自动建号（`password_hash='ENV_ADMIN_PROTECTED'`、`role='admin'`）；同名存量账号会被认领并覆盖哈希；普通用户命中占位哈希一律拒绝；`status !== 'active'` 密码正确后返回 403
  - `register.js`（新增）：`allow_register` 总开关、邀请码校验与原子核销（失败回滚账号）、禁止注册 `ADMIN_USERNAME`、角色固定 `user`、用户名 3~32 / 密码 8~128
- **中间件**：`ALLOWED_ORIGINS` 改为环境变量（空 = 仅同源，不支持 `*`）；session `JOIN users` 注入 `data.userRole` 并拦截非 `active`；`/api/admin/*` 强制管理员 403
- **用户自备 Key**（`user/api-key.js`，新增）：GET 只回 `{configured}`、PUT 加密保存、DELETE 幂等删除；三个方法都受 `user_api_key_enabled` 控制
- **聊天取 Key**（`ai/stream.js`）：用户 Key 优先 → 系统 Key（`USE_SYSTEM_API_KEY` + `system_api_key_enabled` + `DEEPSEEK_API_KEY`）→ 503；系统 Key 每用户每分钟 N 次 KV 限流（429）；流结束统计 token，仅系统 Key 累加 `user_usage`（Asia/Shanghai 切天）
- **功能开关**：`favorites` / `reactions` / `memory` / `memory_extract` / `commitments` / `insights` / `stats` / `replay` / `search` / `export` / `import` 共 11 个 `*_enabled`，关闭时对应接口在入口返回 403
- **管理端**（`/admin/admin.html` + `admin.js` / `admin.css`）：系统初始化状态与随机主密钥（10 分钟倒计时，不落库）、操作日志、登录日志（保留天数）、用户用量、用户封禁 / 解封；新增 `/api/admin/system|users|users/:id|logs/admin|logs/login|usage` 与 `GET /api/user/login-logs`
- **前端**：登录页登录 / 注册选项卡（含邀请码、确认密码、Turnstile）；设置面板「我的 API Key」「我的登录日志」；聊天页仅管理员显示系统管理入口

### 修复

- **系统 Key 外泄**：原实现把客户端 `provider.apiBase` 与 `env.DEEPSEEK_API_KEY` 一起用于请求，任何登录用户都能把地址指向自己的服务器收走系统 Key。现在系统 Key 只走 `AI_GATEWAY_URL` / 直连 DeepSeek，客户端 apiBase 仅对用户自备 Key 生效
- **Gateway Token 外泄**：`cf-aig-authorization` 原为无条件发送，会随自定义地址泄露 `CF_AIG_TOKEN`；现在只在发往配置的 AI Gateway 且 Token 存在时携带
- 默认管理员 `admin / admin123` 的公开凭据不再随 schema 写入；迁移后请立即改密或停用旧账号

### 新变化

- 版本号提升到 `0.14.0`（`package.json` / `static/js/version.js` / 页面占位 / `studio`）
- 新增默认设置：`allow_register='0'`、`invite_required='1'`、`user_api_key_enabled='1'`、`system_api_key_enabled='1'`、`system_key_rate_limit='10'`、`login_log_retention_days='30'`，功能开关默认全开（保持旧行为）
- 登录响应新增 `user.role`；公开路径改为精确匹配并加入 `/api/auth/register`
- 管理接口统一在中间件 + 处理器内双重校验管理员

### 升级提示

1. 备份 D1 → 执行 `migrations/001`（若从未执行）→ 执行 `002`
2. 配置 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（secret）/ `SECRET_MASTER_KEY`（secret）
3. 前后端不同源时配置 `ALLOWED_ORIGINS`
4. 注册默认关闭；开放注册需 `app_settings.allow_register='1'`，邀请制还需 `invite_codes`
5. 存量 `admin` 账号迁移后会成为管理员，请立即改密或停用

### 文档与验证

- 新增 `UPDATE_LOG_0.14.0.md`；`static/CHANGELOG.md` 补 0.14.0 面向用户版本；`regression.md` 增加 0.14.0 清单
- 本轮为一次性验证脚本（未入库）：Phase 1 55 项、Phase 2 48 + 32 项、Phase 3 56 + 23 项、Phase 4 49 项后端 + headless Chrome 37 项（2 项 URL 断言修正后复跑）+ 10 项路由复检 + 7 项最终 UI 冒烟；`wrangler pages functions build` 通过
- 使用手册（`docs-src/`）尚未同步注册 / API Key / 管理页，下一轮补

## [0.13.0] - 2026-10-24

> 「好玩三件套」：**时光机**回放、**分享卡片**、**场景预设**。
> 数据库 / KV / 现有接口零变更；新增 1 个只读接口、1 个前端文件、1 个 API 扩展。

### 新添加

- **时光机**（`GET /api/ai/replay` + `static/js/enhance-cinema.js`）：
  - `?contact=` 返回最近 365 天里「有消息的日子」（最多 60 天，带条数）；`&date=YYYY-MM-DD` 返回当天全部消息（≤500 条，按时间正序）
  - 聊天页标题栏新增时钟按钮；弹窗内按日期分段播放，支持 **暂停 / 继续 / 1x–3x 倍速 / 重播 / 收起**，进度显示 `n / m`，自动滚到底部
  - 时间按 `Asia/Shanghai` 切天，与洞察 / 统计口径一致；只读，不动缓存与数据库
- **分享卡片**：右键消息 →「生成分享卡片」，把该条（自动带上前面那条我的问题）用 **Canvas 手绘**成 PNG
  - 760px 宽、2x 像素密度；深浅两套配色可切换；气泡形状 / 文字最大宽度 / 自动换行（按字符宽度测量，中文友好）
  - 颜色取自当前主题的 CSS 变量（`--bubble-sent` / `--enh-accent` 等），导出的卡片和界面观感一致
  - 头部显示角色名与时间，底部有水印与版本号；`canvas.toBlob` 直接下载
- **场景预设**（`enhance.js` 场景模块 + 管理中心「场景预设」区）：
  - 一套场景 = 明暗 + 配色 + 氛围 + 背景 + 气泡形状 + 字号 + 疏密 + 入场动画
  - 内置 4 套：雨夜书房 / 樱花午后 / 深夜电台 / 极简纸墨；用户可保存最多 12 套（`localStorage.enh_scenes`）
  - 卡片刻意复用配色卡样式：`data-accent` + `data-theme` 挂在卡片上，因此**每张卡片显示的是该场景真实的气泡与按钮配色**
  - 支持「把当前外观存为预设」「删除单个 / 清空自定义」；场景只改外观，不动聊天数据
- `window.enhance` 新增：`getScenes / applyScene / saveScene / deleteScene / setThemeMode / disableBackground`

### 新变化

- 新增 `static/js/enhance-cinema.js`（时光机 + 分享卡片），只在聊天页加载，避免 chat 主包继续膨胀
- `enhance.js` 统一了明暗切换入口 `applyThemeMode()`（聊天页 / 管理中心 / 场景预设共用），并区分「关闭背景（保留图片）」与「删除背景（连图一起删）」
- 命令面板新增「时光机：回放某一天的对话」「把最后一条对话做成分享卡片」

### 文档

- 新增 `UPDATE_LOG_0.13.0.md`；`static/CHANGELOG.md` 补 0.13.0 面向用户版本
- 使用手册「玩法手册」补时光机 / 分享卡片 / 场景预设；快捷键与玩法表同步
- `regression.md` 增加 0.13.0 检查项

## [0.12.0] - 2026-10-24

> 「数据与手感」：新增对话**导入**、**完整备份**、**聊天背景**、**排版**、**动画开关**、
> **年度热力图**，以及断网也能跑的本地调试配置。数据库结构 / 现有接口零变更。

### 新添加

- **对话导入**（`POST /api/ai/import`，`functions/api/ai/import.js`）：
  - 接受本项目导出的 JSON（单角色文件 / 整包备份），先 `dry_run` 预览再写库
  - 去重指纹 `role|created_at|length|hash(content)`，合并模式重复条目自动跳过；同一文件内的重复也只导一次
  - 目标三选一：合并到现有角色 / 覆盖该角色历史 / 新建角色；整包备份按原 `contact_id` 还原（不存在则新建）
  - 单次上限 5000 条、单条上限 10000 字（与导出、`LIMITS.content` 对齐），超出返回 400
  - **导入后副作用（关键）**：删除该联系人的 KV 热缓存 `chat_cache_v2_*`，否则 AI 仍按旧上下文回复；同时把 `mem_state_*` 的 `lastId` 推进到导入后的最大 id，避免下一次聊天把整批历史当成积压去补提记忆
- **完整备份**（`GET /api/ai/export-all`）：一次导出全部角色（≤50 角色 / ≤20000 条），带 `app`、`schema`、`counts`，导入端可直接整包还原
- **聊天背景**（`enhance.js` 背景模块 + `studio` 背景区）：
  - 6 套内置纹理（纸纹 / 点阵 / 网格 / 晨雾 / 夜雨 / 晚霞），纯 CSS，无图片请求
  - 自定义图片：本地选图 → canvas 压到最长边 1600px、JPEG 0.82 → 存 **IndexedDB**（不占 localStorage 配额），可调模糊 0–12px（画布预模糊）与遮罩 0–60%
  - 也支持填写图片链接 / 站内路径；改遮罩即时生效，不挡文字
- **排版**：气泡形状（微信式 / 全圆角 / 直角）、内容行宽（全宽 / 舒适 900px）、头像尺寸（32/38/44）、时间标签（完整日期 / 相对时间）
- **动画**：消息入场 4 档（默认 / 左右滑入 / 仅淡入 / 无）+ **性能模式**（一键关闭动画、粒子与过渡）
- **年度热力图**：`/api/insights?heatmap=1` 返回最近 371 天日聚合，管理中心渲染 53 周 × 7 天的方格图
- **本机用量**：云端消息数、localStorage 占用、本地缓存条目、背景图大小，并支持一键清理本地缓存（不动云端数据与外观偏好）
- **离线调试**：`wrangler.offline.toml` + `tools/dev-offline.mjs`（`npm run dev:offline`）。AI / Vectorize 绑定在本地 dev 会建立远程会话，断网时 `npm run dev` 直接启动失败；离线配置去掉这两个绑定（代码对缺失有兜底），D1 / KV / AE 仍为本地模拟

### 修复

- `.studio-mock` 的背景被 `background` 简写（`.studio-preview-card .studio-mock`）重置为 `none`：预览区改用同优先级选择器，背景终于能在预览里看到
- 内置纹理的 CSS 值不能带 `0 0 / 26px 26px` 这类 **background 简写**语法，否则 `background-image: var(...)` 整条声明非法被丢弃；改为「纯 gradient + 独立 `--enh-bg-size` / `--enh-bg-repeat`」

### 新变化

- `enhance.js` 新增背景 IndexedDB 模块与 `setBackgroundPattern / setBackgroundFile / setBackgroundUrl / setBackgroundTuning / clearBackground / getBackgroundInfo` 等 API；`getState()` 扩展到 17 个字段
- 外观中心拆出 `studio-data.js`（备份 / 导入 / 用量 / 洞察 / 热力图），`studio.js` 只负责外观类界面，避免单文件继续膨胀
- `wrangler.toml` 保持原样；离线配置单独存放，`dev:offline` 启动时临时替换、退出自动还原

### 文档

- 新增 `UPDATE_LOG_0.12.0.md`；`static/CHANGELOG.md` 补 0.12.0 面向用户版本
- 使用手册「数据管理」补导入 / 备份 / 用量；「玩法手册」补背景 / 排版 / 动画 / 热力图
- `regression.md` 增加 0.12.0 导入 / 备份 / 背景 / 排版 / 热力图检查项

## [0.11.0] - 2026-10-24

> 修复 0.10.0 的「换配色后文字看不清」问题：把配色的**深色阶（按钮）**与
> **浅色阶（气泡）**拆成两套，6 套配色 × 明暗主题实测全部达到 WCAG AA；
> 同时把散在设置面板里的外观功能收进独立页面 `/studio`「外观与玩法中心」。
> 数据库 / KV / 现有接口零变更。

### 修复

- 配色对比度（0.10.0 实测：白字压在渐变浅端只有 **1.9~2.5:1**，远低于 AA 的 4.5:1）：
  - `--primary-gradient` / `--primary-hover` / `--accent-text` 改为**深色阶**，专供主按钮、发送键、登录标题（白字 4.8~7.2:1）。
  - `--bubble-sent` / `--bubble-sent-text` 独立为**浅色阶 + 深墨字**（7.8~10.6:1）；明暗主题各一套。
  - `--enh-accent` 重新挑选，浅灰底上 ≥ 4.7:1（原先 sunset 仅 2.7:1）。
  - 气泡内的 `**强调**` 与链接改为继承气泡文字色 + 下划线（原先蓝字压在浅粉气泡上 2~3:1）。
  - `/me` 动作气泡文字由 `--text-secondary`（3.3:1）改为主文字色 + 72% 不透明度（≥ 5.3:1）。
- 「气泡疏密」形同虚设：0.10.0 只改 2px 的消息外间距。现在同时调整气泡内边距（5/9/13px）、行高（1.42/1.6/1.8）与时间标签间距（8/14/20px），三档差异一眼可辨。
- 语音开关只有 22×40 的小方块可点、点文字没反应（容易被当成「没实装」）：改为 `<label>` 包裹，整行可点。

### 新添加

- **`/studio` 外观与玩法中心**（`static/studio.html` + `studio.css` + `studio.js`）：
  - 实时预览：收到的 / 发出的 / 动作气泡三种样式，改任何一项立刻生效
  - 主题与配色：明暗 3 档 + 6 套配色卡片，**每张卡片自带真实气泡与按钮预览，并实时显示 WCAG 对比度**（不达标标红）
  - 氛围特效、阅读舒适度、语音朗读（含「检测到 N 个语音」状态）、联系人置顶、会话洞察、玩法与快捷键、关于与重置（一键恢复默认）
  - 左侧分区导航随滚动高亮；移动端自动变横向滚动条
- `static/js/version.js`：版本号唯一来源（聊天页 / 外观中心 / 登录页共用），`features.js` 保留兜底。
- `window.enhance` 扩成正式 API：`getState` / `getVoiceInfo` / `setTtsAuto` / `setTtsRate` / `resetPreferences` / `getPins` / `isPinned` / `togglePin`，并通过 `enhance:change` 自定义事件广播变更。
- 命令面板新增「打开外观与玩法中心」（共 41 条命令）。
- 冒烟测试新增：6 套配色 × 亮/暗的**对比度矩阵**、疏密三档差异、`/studio` 页面结构与交互、移动端外观中心不溢出（68 项断言）。

### 新变化

- 设置面板里 0.10.0 新增的四个分区（配色 / 氛围 / 阅读 / 朗读）整体迁到 `/studio`，设置面板只保留一个入口卡片，避免功能越堆越散。
- `enhance.js` 只保留「能力」（配色变量、粒子引擎、朗读、置顶、指令），界面全部交给 `studio.js`；两边共用同一套实现，不会各改各的。

### 文档

- 新增 `UPDATE_LOG_0.11.0.md`；`static/CHANGELOG.md` 补 0.11.0 面向用户版本。
- 使用手册「玩法手册」补充外观中心入口与对比度说明；快捷键页标注设置入口变化。
- `regression.md` 增加 0.11.0 对比度 / 疏密 / 外观中心检查项。

## [0.10.0] - 2026-10-24

> 「灵动增强包」：新增 6 套配色、4 种氛围粒子、命令面板、会话洞察、语音朗读、
> 阅读舒适度、联系人置顶、本地彩蛋指令。数据库 / KV 零变更，无需迁移；
> 对既有文件的改动仅 4 处小钩子，详见根目录 `UPDATE_LOG_0.10.0.md`。

### 新添加

- 主题配色（`static/css/enhance.css`）：`graphite` / `sakura` / `ocean` / `forest` / `sunset` / `violet` 六套，通过覆盖 `--primary-gradient`、`--primary-hover`、`--accent-text`、`--bubble-sent`、`--bubble-sent-text` 五个变量实现；不改 `--primary` / `--text-*`，正文对比度保持原样；明暗主题各一套色值。
- 氛围粒子（`static/js/enhance.js` ambience 引擎）：樱花 / 星尘 / 细雨 / 飘雪 四套 Canvas 粒子 + 双击聊天区爱心爆破；单 rAF 循环、DPR≤2、后台标签页暂停、`prefers-reduced-motion` 时自动禁用。
- 命令面板（`Ctrl/Cmd + Shift + P`）：40 条命令（含每个联系人一条「跳转会话」），支持多关键词过滤、↑↓/Enter/Esc 键盘操作。
- 会话洞察：新增 `GET /api/insights?contact=<id>`（`functions/api/insights/index.js`，纯 SELECT）；面板展示相识天数、累计消息、今日条数、最长/当前连续天数、近 14 天柱状图、活跃时段、情绪分布、第一句话日期。
- 语音朗读：`speechSynthesis` 封装（剥 Markdown 标记、优先中文语音、语速 0.5~2x）；双击 AI 气泡 / 右键「朗读这条」/ `Ctrl+Shift+L` / 自动朗读开关 / `Esc` 停止。
- 阅读舒适度：`data-fontsize`（4 档）+ `data-density`（3 档），CSS 变量落到 `.msg-bubble` 的 `font-size` / `line-height`。
- 联系人置顶：`localStorage.enh_pins`；包装 `renderContacts` 做置顶排序 + 图钉按钮。
- 本地指令：`/me`（动作气泡 + 照常发送）、`/roll`、`/coin`、`/pick`、`/time`、`/help`；除 `/me`、`/cmd` 外均不产生网络请求。
- 自动化冒烟测试 `tools/browser-smoke.mjs`（`npm run smoke`）：基于 Node 内置 `fetch` + `WebSocket` 直连 CDP，无需 puppeteer/playwright；53 项断言 + 10 张截图。

### 修复

- `static/js/features.js` 删除消息成功后调用 `showToast('success')`，会弹出字面量 `success`；改为「消息已删除」。

### 新变化

- `static/index.html` 首屏内联脚本除 `data-theme` 外同时应用 `data-accent` / `data-fontsize` / `data-density`，避免刷新时闪默认样式。
- 新功能全部落在独立文件（`enhance.css` / `enhance.js`），对 `app.js` 仅加两处调用钩子（`handleLocalCommand`、`renderActionText`），其余通过函数包装挂接，任一初始化失败不会白屏。

### 文档

- 新增 `UPDATE_LOG_0.10.0.md`（详细更新日志）；`static/CHANGELOG.md` 补 0.10.0 面向用户版本。
- 使用手册新增「玩法手册」（`docs-src/playbook.md`）并更新快捷键页。

## [0.9.3] - 2026-10-24

> 0.9.2 同日的两处收尾修正（review 反馈）；并新增「版本号展示 / 更新日志查看」。接口未变。

### 新添加

- 版本号展示与更新日志查看：登录页底部低调显示 `v0.9.3 · 更新日志`（`--text-tertiary` / 0.75rem / 居中 / 悬浮高亮）；设置面板底部新增「关于项目」区（当前版本 + 「查看更新日志」按钮）。
- `openChangelog()`（`static/js/features.js`）：`createModal()` 建拟态框 → `fetch('/CHANGELOG.md')` → `window.marked.parse()` → `window.DOMPurify.sanitize()` → 注入 `.changelog-content`（`max-height:60vh` 可滚动）；404 / 解析异常降级为「暂无更新日志」。
- 版本号唯一来源 `window.APP_VERSION`（与 `package.json` 一致）；`static/CHANGELOG.md` 是根目录 `CHANGELOG.md` 的副本（Pages 只托管 `static/`，需随根文件同步）。

### 修复

- P2-5: 把 `isGenerating = true` 从 `sendAIMessage` 的 `try` **之前**挪到 `try` **首行**。0.9.2 的置位点在 `try` 外，若紧随其后的同步渲染（`renderMessage` / `appendChatMessageCache` → `localStorage.setItem` 配额超限）抛出，标志会卡在 `true` 直到刷新页面，所有入口被永久封死。挪进 `try` 后任何抛出都必然走 `finally` 复位；置位前没有 `await`，连点/双击的原子性不变。
- P2-5: 补齐第 7 个入口——发送失败后的「重新发送」（`markSendFailed` 闭包）。0.9.2 只覆盖 6 个入口，而该按钮挂在失败的用户消息上、可被反复点击；若此时恰有新一轮生成在跑，它会绕过标志直接再次调用 `sendAIMessage`。

### 新变化

- P2-5: 不采用「在 `stopAllReceivers()` 里复位标志」的方案——该函数在**切换联系人**时也会执行，而 TTFB 窗口内 `aiStreamReader` 尚未赋值、不会取消任何请求，在此复位等于重新打开一个「两条流并发」的窗口。卡死问题改由「置位进 `try`」单点解决。

### 文档

- 回归清单补充 0.9.3 两条（失败重发入口拦截、失败路径后 `isGenerating` 必须为 `false`），见 [docs/regression.md](docs/regression.md)。

## [0.9.2] - 2026-10-24

> 修复「生成请求已发出但响应头未返回」窗口内的重复发起问题。0.9.1 之前的防护只看
> `aiStreamReader`，而它要等 `fetch` 返回后（`res.body.getReader()`）才有值，
> 因此连点、或在首字到达前点「继续 / 重新生成 / 自定义指令」都会并发发起第二条流。

### 修复

- P2-5: AI 生成期间新增全局标志 `isGenerating` 统一控制所有入口。`sendAIMessage` 进入即置 `true`、`finally` 复位，覆盖「点击 → 建流 → 流式读完整」整个窗口；发送按钮 / Enter、「继续」、「重新生成」、「用自定义指令重新生成」（操作栏与右键菜单共 6 个入口）点击时先判 `isGenerating`，命中则 `showToast('正在生成中，请稍候', 'info')` 并直接 return。原 `aiStreamReader` 检查全部保留作为双保险。

### 新变化

- P2-5: 双保险分层——`isGenerating` 覆盖「尚未建流」的阶段，`aiStreamReader` 覆盖「已建流」的阶段；两者互不替代，也不改变 `sendAIMessage` 原有的 continue/regenerate 放行条件。

### 文档

- 回归清单已补进 [docs/regression.md](docs/regression.md)：聊天页新增「0.9.2 / P2-5」分组（快速连点发送、流式期间点继续、流式期间点重新生成）。

## [0.9.1] - 2026-10-24

> 补齐 `[0.9.0]` 中 `P2-1~4` 一行的明细。0.9.0 发布时该批工作只落了一行占位，
> 本次按实际落地情况展开，并把对应回归清单补进 [docs/regression.md](docs/regression.md)。
> 三项改动均为「行为保持型」重构 / 加固：对外接口、SQL、KV key 均未变。

### 修复

- P2-4: SSE 流解析——客户端中途断开时 `writer.write` 抛错被当成「流处理错误」捕获，导致该轮 AI 回复**不落库**，并在日志里留一条 `console.error`。现在单次写入失败静默跳过、继续读完上游，`saveHistory` 照常执行（回复完整入库，重进会话可见）。

### 新变化

- P2-1: `stream.js` 拆解①——系统提示词拼接（安全词分支 / 回复格式 / 场景 / 外貌 / 关于用户 / 心情 / 关系阶段 / 长期记忆 / 承诺 / 导演词说明 / 当前时间 / 重新生成要求）抽为 `_lib.buildSystemPrompt(env, userId, contact, opts)`。拼接顺序、空行与文案逐字保留（7 组场景对拍无差异）；`prompt_{contact}` 仍由 `stream.js` 并行加载后经 `opts.promptRaw` 传入，避免重复读 KV。
- P2-2: `stream.js` 拆解②——D1 双写 + KV 热缓存抽为 `_lib.saveChatTurn(env, userId, contact, { userMessage, assistantReply, replyTo, skipUserSave, historyArray })`。两条 `INSERT` 的 SQL 文本与字段顺序、`chat_cache_v2_*` key 与 TTL 均未变；`processMemoryDeletions`（含 `injectedMemoryIds` 白名单）仍留在 `stream.js` 且在调用前执行；`maybeExtractMemory` / `writeEvent` / `updateMoodAndIntimacy` 仍由 `stream.js` 触发。
- P2-3: XSS 扫描——`static/admin/roles.js` 与 `static/js/features.js` 全量 `innerHTML` 审计（含 `renderContacts` / `renderCommitments` / `renderSearchResults` / `loadFavorites` / `renderClearHistoryList`）。结论：五个重点函数中仅 `renderContacts` 有 1 处未转义属性（`roles.js:356` 的 `data-contact-id`，同文件另两处 `data-export-cid` 已转义），其余输出均已 `escapeHtml`。**本次仅扫描并输出清单，未改代码**，修复待确认。
- P2-4: SSE 流解析加固——改为按「空行分隔的完整事件」消费，并延迟归一化 `\r`：`\r\n` 统一为 `\n`，缓冲若以孤立 `\r` 结尾则等下一块补齐；`JSON.parse` 失败不再静默吞掉，改 `console.debug` 输出 payload 前 100 字符且不中断流。

### 文档

- 每个 P2 改动附回归验证清单，已按模块汇总进 [docs/regression.md](docs/regression.md)：聊天页 P2-1 / P2-2 / P2-4，管理页 P2-3（标注为「仅审计、修复后待执行」）。

## [0.9.0] - 2026-10-24

### 修复

- P0-1: 归档失败文案错位
- P0-2: 时间标签全局污染
- P0-3: 相同内容 AI 回复的 id 串位

### 新变化

- P1-1: stream.js 并行加载（`_lib.loadChatHistory` 内 `countChatHistory` 与 KV 读取并行，KV 命中不再回源 D1）
- P1-2: export.js 文件名 RFC 5987 编码（`filename` ASCII 回退 + `filename*` UTF-8 百分号编码，前端解析同步优先 `filename*`）
- P2-1~4: stream.js 拆解、XSS 扫描、SSE 加固

### 文档

- 每个 P0/P1 改动附回归验证清单（见 [docs/regression.md](docs/regression.md)）
