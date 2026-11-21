-- ============================================================
-- 迁移 20261120000000_baseline：全量基线（幂等）
-- ------------------------------------------------------------
-- 适用：全新数据库；也会在老库上执行一次（对老库是空操作，只补账本记录）。
-- 内容：全部 CREATE ... IF NOT EXISTS —— 空库能建出完整结构，重复执行无副作用。
--
-- 执行方式：**由 Wrangler 自动执行并记账**。
--   - GitHub Actions（.github/workflows/deploy.yml）在生产部署时执行；
--   - 本地兜底：npx wrangler d1 migrations apply DB --remote --force
--   - 请勿在 D1 Console 中手动执行本文件：手工执行不会写入 d1_migrations 账本，
--     之后 Wrangler 会误以为库是空的。
--
-- 冻结声明：本文件已发布，**不可修改**。后续任何结构变更都必须新增
-- YYYYMMDDHHMMSS_描述.sql 的增量迁移；破坏性变更走 expand-contract（见 migrations/README.md）。
-- schema.sql 只是仓库内的阅读参考，不参与部署，也不得用它初始化数据库。
-- ============================================================

-- 用户表（多用户：角色 + 状态）
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,            -- pbkdf2:<盐hex>:<哈希hex>
    avatar TEXT,
    role TEXT NOT NULL DEFAULT 'user',      -- 'user' | 'admin'
    status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'disabled' | 'banned'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 会话表（登录 token）
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at DATETIME NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 应用级配置表（键值对；由 _lib.js 的 getAppSettings 读取，带 KV 缓存）
-- 说明：value 统一按 TEXT 存储（'1' / '0' / 数字 / JSON 字符串均可），
--       默认值集中维护在 functions/_lib.js 的 DEFAULT_APP_SETTINGS，本表无需预置数据。
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 用户级密钥表（如用户自备的 AI API Key）
-- ciphertext 由 _lib.js 的 encryptSecret() 生成，格式 v1:<iv base64>:<密文 base64>；
-- 主密钥只存在于环境变量 SECRET_MASTER_KEY，绝不落库。
CREATE TABLE IF NOT EXISTS user_secrets (
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,                     -- 密钥名，如 'deepseek_api_key'
    ciphertext TEXT NOT NULL,               -- AES-GCM 密文（含 IV）
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 用户用量表（按天累计 token；date 为 Asia/Shanghai 的 YYYY-MM-DD）
-- 一个用户一天一行，写入用 UPSERT（ON CONFLICT(user_id, date) DO UPDATE）。
CREATE TABLE IF NOT EXISTS user_usage (
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_usage_date ON user_usage(date);

-- 邀请码表（注册需邀请时使用）
-- created_by / used_by 可为 NULL：NULL 表示系统生成 / 尚未使用；
-- 用户被删除时置 NULL，保留邀请码本身作为审计记录。
CREATE TABLE IF NOT EXISTS invite_codes (
    code TEXT PRIMARY KEY,
    created_by INTEGER,
    used_by INTEGER,
    expires_at DATETIME,                    -- NULL = 永不过期
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (used_by) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invite_codes_used_by ON invite_codes(used_by);

-- 登录日志表（成功 / 失败 / 被封禁）
-- user_id 可为 NULL（用户名不存在或密码错误时无法确定用户）；
-- 刻意不加外键：审计日志必须在用户被删除后仍然保留。
CREATE TABLE IF NOT EXISTS login_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    ip TEXT,
    user_agent TEXT,
    status TEXT NOT NULL,                   -- 'success' | 'failed' | 'blocked'
    reason TEXT,                            -- 失败原因（如 'bad_password'）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_login_logs_created_at ON login_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs(user_id, created_at DESC);

-- 管理员操作审计表
-- 由 _lib.js 的 logAdminAction() 写入，写入后按 ADMIN_LOG_MAX_COUNT 自动清理旧记录；
-- 同样刻意不加外键，保证管理员账号被删除后审计记录仍在。
CREATE TABLE IF NOT EXISTS admin_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL,
    action TEXT NOT NULL,                   -- 如 'user.disable' / 'settings.update'
    target TEXT,                            -- 操作对象，如 'user:12'
    ip TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON admin_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id, id);

-- 联系人表（含 AI 参数字段）
-- 注意：D1 不支持 ALTER TABLE ADD COLUMN IF NOT EXISTS，
-- 已有数据库的新增列请手动执行迁移 SQL（见 migrations/），不要依赖本文件补列。
CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    contact_type TEXT NOT NULL,          -- 'ai' 或 'user'
    contact_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    avatar TEXT,
    temperature REAL DEFAULT 0.7,
    top_p REAL DEFAULT 0.9,
    max_tokens INTEGER DEFAULT 2048,
    frequency_penalty REAL DEFAULT 0.0,
    presence_penalty REAL DEFAULT 0.0,
    memory_window INTEGER DEFAULT 30,
    context_window INTEGER DEFAULT 20,
    mood TEXT,                          -- 角色当前心情（第 13 项）
    mood_updated_at DATETIME,
    intimacy INTEGER DEFAULT 0,         -- 亲密度 0~100（第 14 项）
    archived INTEGER DEFAULT 0,         -- 归档标记（第 29 项）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(user_id, contact_type, contact_id)
);

-- 消息表（支持联系人过滤）
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    contact_type TEXT DEFAULT 'user',
    contact_id TEXT DEFAULT 'default',
    user_id INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 长期记忆表（AI 自动提取 / 手动管理）
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    contact_id TEXT NOT NULL,
    content TEXT NOT NULL,
    source_start INTEGER,          -- 来源消息 id 范围（自动提取时记录）
    source_end INTEGER,
    emotion TEXT,                  -- 用户情绪标签（第 17 项）
    emotion_score REAL,            -- 情绪强度 0~1
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_memories_user_contact ON memories(user_id, contact_id);

-- 聊天历史表（D1 主存储）
-- kind: 'normal' 普通消息；'director' 导演词（仅当前会话展示，不落库、不进历史）
CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    contact_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    kind TEXT DEFAULT 'normal',
    reply_to INTEGER,              -- 被引用的消息 id（第 21 项）
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 收藏表（第 23 项）
CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    contact_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user_contact ON favorites(user_id, contact_id);

-- 消息表情反应表（第 24 项）
CREATE TABLE IF NOT EXISTS reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(user_id, message_id);

-- 待办 / 承诺追踪表（第 18 项）
CREATE TABLE IF NOT EXISTS commitments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    contact_id TEXT NOT NULL,
    content TEXT NOT NULL,
    due_at DATETIME,
    done INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_commitments_user_contact ON commitments(user_id, contact_id);

-- 消息编辑历史表（第 25 项）
CREATE TABLE IF NOT EXISTS message_edits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    old_content TEXT,
    new_content TEXT,
    edited_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_message_edits_message ON message_edits(message_id);

-- 索引：加速查询
CREATE INDEX IF NOT EXISTS idx_chat_history_user_contact ON chat_history(user_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_created_at ON chat_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user_contact ON messages(user_id, contact_type, contact_id);

-- ------------------------------------------------------------
-- 以下索引依赖 users.role / users.status（放在文件最后）
-- 全新库：上方 CREATE TABLE users 已包含这两列，可正常创建；
-- 存量库：请先执行 migrations/002_security_and_audit.sql 再跑本文件。
-- 若这里报 "no such column: role"，说明本文件被直接跑在了未迁移的旧库上：
-- 除该索引外不会有任何破坏（以上语句全是 IF NOT EXISTS），执行迁移后重跑即可。
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);
