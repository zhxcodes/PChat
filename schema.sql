-- ============================================================
-- PChat · D1 建表脚本
-- 执行：npx wrangler d1 execute pchat-db --remote --file=./schema.sql
-- 本地：npx wrangler d1 execute pchat-db --local  --file=./schema.sql
-- 字段类型仅用于表达意图（SQLite 为动态类型）。
-- ============================================================

-- 账号
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  avatar        TEXT,
  role          TEXT    NOT NULL DEFAULT 'user',    -- user | admin
  status        TEXT    NOT NULL DEFAULT 'active',  -- active | disabled | banned
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 登录会话（7 天有效；同一用户只保留一个有效 token）
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- 联系人 / AI 角色
CREATE TABLE IF NOT EXISTS contacts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER NOT NULL,
  contact_id        TEXT    NOT NULL,
  contact_type      TEXT    NOT NULL DEFAULT 'ai',    -- ai | user
  display_name      TEXT    NOT NULL,
  avatar            TEXT,
  temperature       REAL    DEFAULT 0.7,
  top_p             REAL    DEFAULT 0.9,
  max_tokens        INTEGER DEFAULT 2048,
  frequency_penalty REAL    DEFAULT 0,
  presence_penalty  REAL    DEFAULT 0,
  memory_window     INTEGER DEFAULT 30,
  context_window    INTEGER DEFAULT 20,
  mood              TEXT,
  mood_updated_at   TEXT,
  intimacy          INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id, archived);

-- AI 对话消息（kind='director' 为导演词，不进入历史上下文）
CREATE TABLE IF NOT EXISTS chat_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  contact_id TEXT    NOT NULL,
  role       TEXT    NOT NULL,                    -- user | assistant
  content    TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'normal',   -- normal | director
  reply_to   INTEGER,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_user_contact ON chat_history(user_id, contact_id, id);
CREATE INDEX IF NOT EXISTS idx_chat_user_time    ON chat_history(user_id, contact_id, created_at);

-- 普通联系人消息（非 AI 通道）
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY,               -- 由服务端写入毫秒时间戳
  user_id      INTEGER NOT NULL,
  username     TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  contact_type TEXT    NOT NULL DEFAULT 'user',
  contact_id   TEXT    NOT NULL DEFAULT 'default',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);

-- 消息编辑历史
CREATE TABLE IF NOT EXISTS message_edits (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL,
  old_content TEXT,
  new_content TEXT,
  edited_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edits_message ON message_edits(message_id);

-- 长期记忆
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  contact_id    TEXT    NOT NULL,
  content       TEXT    NOT NULL,
  source_start  INTEGER,
  source_end    INTEGER,
  emotion       TEXT,
  emotion_score REAL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id, contact_id, id);

-- 承诺 / 待办
CREATE TABLE IF NOT EXISTS commitments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  contact_id TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  due_at     TEXT,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_commitments_user ON commitments(user_id, contact_id, done);

-- 收藏
CREATE TABLE IF NOT EXISTS favorites (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  contact_id TEXT    NOT NULL,
  message_id INTEGER NOT NULL,
  note       TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, contact_id);

-- 表情回应
CREATE TABLE IF NOT EXISTS reactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  emoji      TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON reactions(user_id, message_id);

-- 邀请码（一码一人）
CREATE TABLE IF NOT EXISTS invite_codes (
  code       TEXT    NOT NULL UNIQUE,
  created_by INTEGER,
  used_by    INTEGER,
  expires_at TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 登录审计
CREATE TABLE IF NOT EXISTS login_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  ip         TEXT,
  user_agent TEXT,
  status     TEXT    NOT NULL,   -- success | failed | blocked
  reason     TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs(user_id, id);

-- 管理员操作审计
CREATE TABLE IF NOT EXISTS admin_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER NOT NULL,
  action     TEXT    NOT NULL,
  target     TEXT,
  ip         TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id, id);

-- 运行级配置（KV 缓存 60 秒）
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 每用户每日 token 用量
CREATE TABLE IF NOT EXISTS user_usage (
  user_id     INTEGER NOT NULL,
  date        TEXT    NOT NULL,   -- 北京时间 YYYY-MM-DD
  tokens_used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

-- 加密后的用户 API Key
CREATE TABLE IF NOT EXISTS user_secrets (
  user_id    INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  ciphertext TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, name)
);
