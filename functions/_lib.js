// functions/_lib.js —— 共享工具函数（以下划线开头，不会被 Pages Functions 注册为路由）
// 用途：消除各 handler 中重复的 json/clamp/鉴权样板代码。

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// 数值钳制：非法值回退到 fallback，防止越界参数
export function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// 从中间件注入的 data 中取 userId
export function getUserId(data) {
  return data?.userId || null;
}

export function unauthorized() {
  return json({ error: '未登录' }, 401);
}

// 各接口的输入限制（集中管理）
export const LIMITS = {
  contact_id: 100,
  display_name: 100,
  name: 100,            // 角色 meta.name（meta.js 长度校验用，此前为 undefined 导致校验失效）
  greeting: 500,
  format: 500,
  prompt: 20000,
  avatar: 500,
  scene: 500,           // 角色：聊天背景（第 11 项）
  appearance: 500,      // 角色：外貌（第 11 项）
  preference: 1000,     // 用户：关于我自己（第 12 项）
  safeword: 200,        // 用户：安全词（第 15 项）
  content: 10000,       // messages 内容
  message: 10000,       // AI 消息
  contact: 200,         // AI contact 参数
  contactIdQuery: 200,  // messages contact_id
};

export const ALLOWED_CONTACT_TYPES = ['ai', 'user'];

// ============================================================
// 密码哈希（PBKDF2-SHA256，10 万次迭代 + 16 字节随机盐）
// 存储格式：pbkdf2:<盐hex>:<哈希hex>；旧版无盐 SHA-256 登录时自动迁移
// ============================================================
export const PBKDF2_ITERATIONS = 100000;
export const SALT_BYTES = 16;

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

export async function hashPasswordPBKDF2(password, saltHex) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(derivedBits));
}

export async function hashPasswordSHA256(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hash));
}

export async function createPBKDF2Hash(password) {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
  const hash = await hashPasswordPBKDF2(password, salt);
  return `pbkdf2:${salt}:${hash}`;
}

// 校验密码；返回 { valid, needsUpgrade }
export async function verifyPassword(password, storedHash) {
  if (typeof storedHash === 'string' && storedHash.startsWith('pbkdf2:')) {
    const parts = storedHash.split(':');
    if (parts.length === 3) {
      const [, salt, hash] = parts;
      try {
        const computed = await hashPasswordPBKDF2(password, salt);
        return { valid: computed === hash, needsUpgrade: false };
      } catch (e) {
        return { valid: false, needsUpgrade: false };
      }
    }
    return { valid: false, needsUpgrade: false };
  }
  // 旧格式：无盐 SHA-256
  try {
    const computed = await hashPasswordSHA256(password);
    const valid = computed === storedHash;
    return { valid, needsUpgrade: valid };
  } catch (e) {
    return { valid: false, needsUpgrade: false };
  }
}

// ============================================================
// 聊天历史：D1 主存储 + KV 热缓存（统一读路径）
// 参考 legacy workers/internal-worker.js 的“KV 优先、D1 回源”方案并改进：
//  - 缓存键带版本号（v2 条目带 id），旧版无版本键在读取时顺带清理
//  - 读取时以 D1 计数校验缓存完整性，命中率低/缓存不完整时自动回源并回填
//  - 回源与翻页查询均按 (role, content, created_at) 防御性去重，
//    消除历史版本可能写入的重复行（“碎片化”修复）
//  - history.js 与 stream.js 共用本模块，杜绝两处缓存逻辑漂移
// ============================================================
export const CHAT_CACHE_PREFIX = 'chat_cache_v2_';
export const CHAT_CACHE_TTL = 7 * 24 * 60 * 60; // 秒
export const CHAT_CACHE_MAX = 100;              // 热缓存条数上限（可支持最大上下文 100 条）

// 去重后的历史总数（与各页查询的 GROUP BY 口径一致）
// 口径：排除 kind='director'（导演词仅当前会话展示，不落库、不进历史）
export async function countChatHistory(env, userId, contact) {
  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM (
         SELECT 1 FROM chat_history
         WHERE user_id = ? AND contact_id = ? AND (kind IS NULL OR kind != 'director')
         GROUP BY role, content, created_at
       )`
    ).bind(userId, contact).first();
    return row?.count || 0;
  } catch (e) {
    console.warn('统计聊天历史失败:', e.message);
    return 0;
  }
}

// 读取最近 CHAT_CACHE_MAX 条（KV 优先，未命中/不完整时回源 D1 并回填）
// 返回 { messages, total, fromCache }
export async function loadChatHistory(env, userId, contact) {
  const cacheKey = `${CHAT_CACHE_PREFIX}${userId}_${contact}`;

  // 并行：KV 热缓存读取 与 D1 去重计数互相独立，不再串行等待（原实现先 count 再读 KV）
  // - count 只用于校验缓存完整性（expectCached）
  // - KV 命中（条数 >= expectCached）直接返回，不再回源 D1；未命中时 count 早已就绪，直接回源
  const [cached, total] = await Promise.all([
    env.CHAT_HISTORY.get(cacheKey, { type: 'json' }).catch((e) => {
      console.warn('读取历史缓存失败:', e.message);
      return null;
    }),
    countChatHistory(env, userId, contact),
  ]);
  const expectCached = Math.min(CHAT_CACHE_MAX, total);
  if (cached && Array.isArray(cached) && cached.length >= expectCached) {
    return { messages: cached, total, fromCache: true };
  }

  // 缓存缺失/不完整 → 回源 D1（防御性去重），并回填缓存
  // 排除 kind='director'：导演词不进历史上下文（历史遗留数据兜底）
  let messages = [];
  try {
    const rows = await env.DB.prepare(
      `SELECT id, role, content, kind, reply_to, created_at as timestamp
       FROM chat_history
       WHERE user_id = ? AND contact_id = ? AND (kind IS NULL OR kind != 'director')
       GROUP BY role, content, created_at
       ORDER BY created_at DESC, id DESC
       LIMIT ${CHAT_CACHE_MAX}`
    ).bind(userId, contact).all();
    messages = (rows.results || []).reverse();
    if (messages.length > 0) {
      await env.CHAT_HISTORY.put(cacheKey, JSON.stringify(messages), {
        expirationTtl: CHAT_CACHE_TTL,
      });
    }
  } catch (e) {
    console.warn('回源聊天历史失败:', e.message);
  }

  // 顺带清理旧版无版本号缓存键（一次性，避免键残留）
  try {
    await env.CHAT_HISTORY.delete(`chat_cache_${userId}_${contact}`);
  } catch (e) { /* 忽略 */ }

  return { messages, total, fromCache: false };
}

// 翻页查询（第 2 页起）：与首页同口径去重，按时间倒序分页
export async function loadChatHistoryPage(env, userId, contact, page, pageSize) {
  const rows = await env.DB.prepare(
    `SELECT id, role, content, kind, reply_to, created_at as timestamp
     FROM chat_history
     WHERE user_id = ? AND contact_id = ? AND (kind IS NULL OR kind != 'director')
     GROUP BY role, content, created_at
     ORDER BY created_at DESC, id DESC
     LIMIT ? OFFSET ?`
  ).bind(userId, contact, pageSize, (page - 1) * pageSize).all();
  return (rows.results || []).reverse();
}

// 注意：不要重置 sqlite_sequence。
// 重置自增序列会让新消息 id 回退到 MAX(id)+1，破坏 chat_history 的 id 单调递增，
// 导致 maybeExtractMemory 的 maxId - lastId 计算失真、记忆提取失效。

// ============================================================
// 聊天历史写入：D1 双写 + KV 热缓存（统一写路径，与 loadChatHistory 同 key、同口径）
// 从 api/ai/stream.js 的 saveHistory 抽出，SQL / 字段顺序 / KV key 与抽取前完全一致：
//   1) INSERT user（skipUserSave=false 且 userMessage 非空时）
//   2) INSERT assistant
//   3) 就地更新调用方的 historyArray（追加本轮新增行，保持引用不变）
//   4) 以 CHAT_CACHE_MAX 截断后写回 KV 热缓存（值仍为数组 JSON，TTL 不变）
// 注意：
//  - assistantReply 必须是已处理过“删除记忆”指令的文本。清理逻辑依赖本次请求的
//    injectedMemoryIds 白名单，必须留在 stream.js 内、并在调用本函数之前执行；
//    本函数不对回复内容做任何加工（否则会丢白名单，导致误删手工记忆）。
//  - 记忆提取（maybeExtractMemory）、埋点（writeEvent）、心情/亲密度
//    （updateMoodAndIntimacy）不在本函数内，由调用方在本函数成功后自行触发。
//  - historyArray 为调用方数组，会被就地修改；调用方需保证传入数组。
// ============================================================
export async function saveChatTurn(env, userId, contact, opts) {
  const o = opts || {};
  const userMessage = o.userMessage;
  const assistantReply = o.assistantReply;
  const replyTo = (o.replyTo === undefined) ? null : o.replyTo;
  const skipUserSave = o.skipUserSave === true;
  const historyArray = o.historyArray;

  const timestamp = new Date().toISOString();
  const newUserRows = []; // { id, role, content, kind, reply_to }
  if (!skipUserSave && userMessage) {
    const r = await env.DB.prepare(
      "INSERT INTO chat_history (user_id, contact_id, role, content, kind, reply_to, created_at) VALUES (?, ?, ?, ?, 'normal', ?, ?)"
    ).bind(userId, contact, 'user', userMessage, replyTo, timestamp).run();
    newUserRows.push({ id: r.meta.last_row_id, role: 'user', content: userMessage, kind: 'normal', reply_to: replyTo });
  }
  const assistantRes = await env.DB.prepare(
    "INSERT INTO chat_history (user_id, contact_id, role, content, kind, created_at) VALUES (?, ?, ?, ?, 'normal', ?)"
  ).bind(userId, contact, 'assistant', assistantReply, timestamp).run();

  for (const row of newUserRows) historyArray.push(row);
  const assistantRow = { id: assistantRes.meta.last_row_id, role: 'assistant', content: assistantReply, kind: 'normal', timestamp };
  historyArray.push(assistantRow);
  const trimmed = historyArray.slice(-CHAT_CACHE_MAX);
  const cacheKey = `${CHAT_CACHE_PREFIX}${userId}_${contact}`;
  await env.CHAT_HISTORY.put(cacheKey, JSON.stringify(trimmed), {
    expirationTtl: CHAT_CACHE_TTL,
  });

  return { userRow: newUserRows[0] || null, assistantRow };
}

// ============================================================
// 长期记忆（AI 自动提取）
// ============================================================
// 记忆窗口 memory_window：每攒够 N 条聊天消息，就调用大模型把该段对话
// 提炼成一条记忆存入 memories 表；提取位置记录在 KV（mem_state_*），
// 下次从上次的位置继续，从而形成“30 条提取一次、60 条提取 31~60”的节奏。
// 提取为尽力而为：模型失败 / 无新消息 / 次数达上限时静默跳过，不影响主流程。

// 导出：0.12.0 的数据导入需要把「记忆提取进度」推进到导入后的最大 id，
// 否则下一次聊天会把整批导入的历史当成积压对话去补提记忆（额外消耗额度）。
export const MEMORY_STATE_PREFIX = 'mem_state_';
export const MEMORY_WINDOW_MIN = 5;
export const MEMORY_WINDOW_MAX = 200;
export const MEMORY_WINDOW_DEFAULT = 30;
export const MEMORY_READ_MAX = 15; // 每次注入系统提示词的记忆条数上限
const MEMORY_EXTRACT_MAX_BATCH = 8; // 单次调用最多补提的窗口数（防一次性烧太多额度）

// 发送给 AI 的上下文条数（context_window）：每次请求携带最近 N 条聊天消息
export const CONTEXT_WINDOW_MIN = 5;
export const CONTEXT_WINDOW_MAX = 100;
export const CONTEXT_WINDOW_DEFAULT = 20;

// ============================================================
// AI 接口地址与模型（统一入口）
// 优先级：请求体自定义 apiBase > 环境变量 AI_GATEWAY_URL（Cloudflare AI Gateway）> 直连 DeepSeek
// AI Gateway 地址格式：
//   https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/deepseek
// 安全：API Key 只从 env.DEEPSEEK_API_KEY 读取，任何情况下不接受客户端传入。
// ============================================================
export const DEFAULT_AI_MODEL = 'deepseek-flash';
const DIRECT_DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

export function resolveAiBase(env, providerApiBase) {
  const custom = (providerApiBase && /^https?:\/\//.test(String(providerApiBase)))
    ? String(providerApiBase).replace(/\/+$/, '')
    : '';
  if (custom) return custom;
  const gateway = (env && env.AI_GATEWAY_URL) ? String(env.AI_GATEWAY_URL).trim().replace(/\/+$/, '') : '';
  if (gateway && /^https?:\/\//.test(gateway)) return gateway;
  return DIRECT_DEEPSEEK_BASE;
}

// 允许的用户情绪标签（第 17 项，白名单）
export const EMOTION_TAGS = ['开心', '平静', '低落', '焦虑', '愤怒'];

// 按 Asia/Shanghai（UTC+8）格式化当前时间（第 28 项）
// 注意：Pages Functions 运行时 new Date() 是 UTC，必须手动 +8 小时，
// 否则下午 3 点会被算成早上 07:00。这里统一用 UTC getter 读取偏移后的时间。
export function formatChinaTime(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()];
  const pad = (n) => String(n).padStart(2, '0');
  const hour = d.getUTCHours();
  const period = hour < 6 ? '凌晨' : hour < 12 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
  return `${d.getUTCFullYear()}年${pad(d.getUTCMonth() + 1)}月${pad(d.getUTCDate())}日 周${week} ${period} ${pad(hour)}:${pad(d.getUTCMinutes())}`;
}

// 北京时间（Asia/Shanghai，UTC+8）的日期键 YYYY-MM-DD。
// user_usage.date 统一用它，保证「每日用量」按用户所在时区切天（与洞察 / 统计口径一致）。
export function chinaDateKey(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 剥离模型输出里可能包裹的 ```json 代码围栏
function stripCodeFence(s) {
  const t = String(s || '').trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1].trim() : t;
}

// 用大模型把一段对话提炼成结构化记忆（失败返回 null）
// 返回：{ memory, emotion, emotion_score, commitments[] }（第 17、18 项）
async function summarizeMemory(env, messages) {
  try {
    const apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) return null;
    const text = messages.map((m) => (m.role === 'user' ? '用户' : 'AI') + '：' + m.content).join('\n');
    const res = await fetch(`${resolveAiBase(env)}/chat/completions`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        Authorization: `Bearer ${apiKey}`,
        'cf-aig-authorization': `Bearer ${env.CF_AIG_TOKEN}`,},
      body: JSON.stringify({
        model: DEFAULT_AI_MODEL,
        messages: [
          {
            role: 'system',
            content:
              '你是记忆与情绪分析助手。请分析以下对话并只输出一个 JSON 对象，不要输出任何解释或代码围栏。\n' +
              'JSON 结构如下：\n' +
              '{\n' +
              '  "memory": "值得长期记住的信息提炼，用要点列出，每条一行，最多6条；无内容则空字符串",\n' +
              `  "emotion": "用户当前的情绪，必须是以下之一：${EMOTION_TAGS.join('/')}",\n` +
              '  "emotion_score": 0.0~1.0 之间的小数，表示情绪强度,\n' +
              '  "commitments": ["AI 在这段对话中明确答应用户要做到的事，例如「明天提醒你」「下次带伞」；没有则空数组"]\n' +
              '}\n' +
              '要求：不要虚构；memory 只写对话中真实出现的信息；commitments 只记录 AI 的明确承诺，不要记录用户的请求。',
          },
          { role: 'user', content: text },
        ],
        temperature: 0.3,
        max_tokens: 700,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) return null;

    let parsed = null;
    try {
      parsed = JSON.parse(stripCodeFence(reply));
    } catch (e) {
      // 兜底：模型没按 JSON 输出时，把整段文本当作记忆内容
      return { memory: reply.trim().slice(0, 2000), emotion: null, emotion_score: null, commitments: [] };
    }

    const memory = (parsed && typeof parsed.memory === 'string') ? parsed.memory.trim().slice(0, 2000) : '';
    let emotion = (parsed && typeof parsed.emotion === 'string') ? parsed.emotion.trim() : '';
    emotion = EMOTION_TAGS.find((t) => emotion.includes(t)) || null;
    let score = Number(parsed?.emotion_score);
    if (!Number.isFinite(score)) score = null;
    else score = Math.min(1, Math.max(0, score));

    const commitments = Array.isArray(parsed?.commitments)
      ? parsed.commitments
          .filter((c) => typeof c === 'string' && c.trim())
          .map((c) => c.trim().slice(0, 300))
          .slice(0, 5)
      : [];

    return { memory, emotion, emotion_score: score, commitments };
  } catch (e) {
    console.warn('记忆提炼失败:', e.message);
    return null;
  }
}

// 读取记忆提取进度（KV）
async function readMemoryState(env, userId, contact) {
  const stateKey = `${MEMORY_STATE_PREFIX}${userId}_${contact}`;
  let lastId = 0;
  const raw = await env.PROMPTS_KV.get(stateKey).catch(() => null);
  if (raw) {
    try { lastId = Number(JSON.parse(raw).lastId) || 0; } catch (e) { lastId = 0; }
  }
  return { stateKey, lastId };
}

// 核心提炼循环
// windowSize：每次取多少条消息；force=true 时无视剩余量是否够一个窗口（把剩余全部按窗口提炼）
async function runMemoryExtraction(env, userId, contact, windowSize, force) {
  const win = Math.min(Math.max(Math.round(windowSize) || MEMORY_WINDOW_DEFAULT, MEMORY_WINDOW_MIN), MEMORY_WINDOW_MAX);
  const { stateKey, lastId: startId } = await readMemoryState(env, userId, contact);
  let lastId = startId;

  const maxRow = await env.DB.prepare(
    "SELECT MAX(id) AS maxId FROM chat_history WHERE user_id = ? AND contact_id = ? AND (kind IS NULL OR kind != 'director')"
  ).bind(userId, contact).first();
  const maxId = maxRow?.maxId || 0;

  let extracted = 0;
  // force 模式：只要还有新消息就继续（窗口大小仍生效），仍受批次数上限保护
  while ((force ? (maxId - lastId > 0) : (maxId - lastId >= win)) && extracted < MEMORY_EXTRACT_MAX_BATCH) {
    const rows = await env.DB.prepare(
      "SELECT id, role, content FROM chat_history WHERE user_id = ? AND contact_id = ? AND id > ? AND (kind IS NULL OR kind != 'director') ORDER BY id ASC LIMIT ?"
    ).bind(userId, contact, lastId, win).all();
    const slice = rows.results || [];
    if (slice.length === 0) break;

    const result = await summarizeMemory(env, slice);
    const endId = slice[slice.length - 1].id;
    if (result && result.memory) {
      const ins = await env.DB.prepare(
        'INSERT INTO memories (user_id, contact_id, content, source_start, source_end, emotion, emotion_score) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(userId, contact, result.memory, slice[0].id, endId, result.emotion, result.emotion_score).run();
      // 第 7 项：为新记忆写入向量（未绑定 Vectorize 时自动跳过）
      const newId = ins.meta?.last_row_id;
      if (newId) {
        try { await upsertMemoryVector(env, userId, contact, newId, result.memory); } catch (e) { /* 忽略 */ }
      }
      writeEvent(env, { type: 'memory_extract', userId, contactId: contact, value: 1, detail: result.emotion || '' });
    }
    // 承诺（第 18 项）：去重后写入
    if (result && result.commitments && result.commitments.length > 0) {
      for (const c of result.commitments) {
        try {
          const dup = await env.DB.prepare(
            'SELECT id FROM commitments WHERE user_id = ? AND contact_id = ? AND content = ? AND done = 0'
          ).bind(userId, contact, c).first();
          if (!dup) {
            await env.DB.prepare(
              'INSERT INTO commitments (user_id, contact_id, content, done) VALUES (?, ?, ?, 0)'
            ).bind(userId, contact, c).run();
          }
        } catch (e) { console.warn('写入承诺失败:', e.message); }
      }
    }
    lastId = endId;
    extracted += 1;
  }

  if (lastId > startId) {
    await env.PROMPTS_KV.put(stateKey, JSON.stringify({ lastId }), { expirationTtl: 60 * 60 * 24 * 365 });
  }
  return extracted;
}

// 检查并执行记忆提取（每 memory_window 条提取一次；可循环补提历史积压）
export async function maybeExtractMemory(env, userId, contact) {
  try {
    const contactRow = await env.DB.prepare(
      'SELECT memory_window FROM contacts WHERE user_id = ? AND contact_id = ?'
    ).bind(userId, contact).first();
    const window = Math.round(contactRow?.memory_window) || MEMORY_WINDOW_DEFAULT;
    return await runMemoryExtraction(env, userId, contact, window, false);
  } catch (e) {
    console.warn('记忆提取异常（忽略）:', e.message);
    return 0;
  }
}

// 强制提取（第 16 项）：无视 memory_window，把 lastId→maxId 之间剩余的对话按窗口全部提炼
export async function forceExtractMemory(env, userId, contact) {
  try {
    const contactRow = await env.DB.prepare(
      'SELECT memory_window FROM contacts WHERE user_id = ? AND contact_id = ?'
    ).bind(userId, contact).first();
    const window = Math.round(contactRow?.memory_window) || MEMORY_WINDOW_DEFAULT;
    return await runMemoryExtraction(env, userId, contact, window, true);
  } catch (e) {
    console.warn('强制记忆提取异常:', e.message);
    return 0;
  }
}

// 读取该联系人的最近记忆（注入系统提示词用，按时间正序）
// 第 7 项：绑定 Vectorize 时优先「语义检索」（用当前用户消息做 query）；
//         未绑定/检索失败时回退到"最近 N 条"。
// 返回字段含 emotion（第 17 项：供拼提示词时附加情绪倾向）
export async function loadRecentMemories(env, userId, contact, queryText = '') {
  // 1) 语义检索
  const ids = await searchMemoryIds(env, userId, contact, queryText, MEMORY_READ_MAX);
  if (ids && ids.length > 0) {
    try {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = await env.DB.prepare(
        `SELECT id, content, emotion, emotion_score FROM memories
         WHERE user_id = ? AND contact_id = ? AND id IN (${placeholders})`
      ).bind(userId, contact, ...ids).all();
      const byId = new Map((rows.results || []).map((r) => [r.id, r]));
      const ordered = ids.map((i) => byId.get(i)).filter(Boolean);
      if (ordered.length > 0) return ordered;
    } catch (e) {
      console.warn('按向量 id 读取记忆失败（回退最近记忆）:', e.message);
    }
  }

  // 2) 回退：最近 N 条
  try {
    const rows = await env.DB.prepare(
      'SELECT id, content, emotion, emotion_score FROM memories WHERE user_id = ? AND contact_id = ? ORDER BY id DESC LIMIT ?'
    ).bind(userId, contact, MEMORY_READ_MAX).all();
    return (rows.results || []).reverse();
  } catch (e) {
    console.warn('读取记忆失败:', e.message);
    return [];
  }
}

// 读取未完成的承诺（第 18 项：注入系统提示词，让角色记得自己答应过的事）
export async function loadPendingCommitments(env, userId, contact) {
  try {
    const rows = await env.DB.prepare(
      'SELECT id, content, due_at FROM commitments WHERE user_id = ? AND contact_id = ? AND done = 0 ORDER BY id DESC LIMIT 10'
    ).bind(userId, contact).all();
    return rows.results || [];
  } catch (e) {
    console.warn('读取承诺失败:', e.message);
    return [];
  }
}

// ============================================================
// 系统提示词构建（从 api/ai/stream.js 原样抽出，拼接顺序与文案保持不变）
// 抽取范围：stream.js 中「系统提示词 = promptRaw ...」到「【本次重新生成的特殊要求】...」段。
// 拼接顺序（顺序即行为，改动会改变模型看到的提示词）：
//   1) 角色设定 prompt_{contact}（缺失时回退默认人设）
//   2) 安全词分支：命中 → 只保留中性安全响应指令，跳过下面全部角色化内容
//      未命中 → 回复格式要求 → 当前场景 → 你的外貌 → 关于用户 → 你此刻的心情 → 关系阶段
//   3) 长期记忆（内含用户近期情绪倾向）
//   4) 你答应过用户的事（未完成的承诺，安全词触发时跳过）
//   5) 导演词说明 → 6) 当前时间 → 7) 本次重新生成的特殊要求
// 调用方负责加载数据并通过 opts 传入（安全词触发时必须传空数组，与原实现一致）；
// opts.promptRaw 未提供时本函数自行读 KV（键名 prompt_{contact} 不变）。
// 注意：userId 仅为对齐调用签名保留，偏好已由调用方加载传入 userPreference。
// ============================================================
export async function buildSystemPrompt(env, userId, contact, opts) {
  const o = opts || {};

  // 角色设定：优先用调用方已并行加载的 promptRaw，未传时自行回源 KV（键名与原来一致）
  const promptRaw = (o.promptRaw !== undefined)
    ? o.promptRaw
    : await env.PROMPTS_KV.get(`prompt_${contact}`).catch((e) => {
        console.warn('读取提示词失败:', e.message);
        return null;
      });

  const meta = o.meta || null;
  const memories = Array.isArray(o.memories) ? o.memories : [];
  const pendingCommitments = Array.isArray(o.pendingCommitments) ? o.pendingCommitments : [];
  const contactRow = o.contactRow || null;
  const userPreference = o.userPreference;
  const safewordTriggered = o.safewordTriggered === true;
  const regenerateInstruction = o.regenerateInstruction || '';

  let systemPrompt = (typeof promptRaw === 'string' && promptRaw) ? promptRaw : '';
  if (!systemPrompt) systemPrompt = '你是一位友好的AI助手，请用中文回复。';

  if (safewordTriggered) {
    // 清空角色扮演设定与历史上下文，只保留中性的安全响应指令
    systemPrompt = '你是一位冷静、客观、中性的助手。请用平和、不代入任何角色设定的语气回应用户，' +
      '不要继续角色扮演、不要使用角色口吻或动作描写。';
    systemPrompt += '\n\n【安全词已触发】用户发送了安全词，请立即停止角色扮演，简短确认并询问用户是否需要帮助。';
  } else {
    // 追加“回复格式要求”（管理后台角色设定 → meta.format）
    if (meta && typeof meta.format === 'string' && meta.format.trim()) {
      systemPrompt += '\n\n【回复格式要求】\n' + meta.format.trim() + '\n请严格遵守上述回复格式要求。';
    }
    // 追加“当前场景”与“你的外貌”（第 11 项）
    if (meta && typeof meta.scene === 'string' && meta.scene.trim()) {
      systemPrompt += '\n\n【当前场景】\n' + meta.scene.trim();
    }
    if (meta && typeof meta.appearance === 'string' && meta.appearance.trim()) {
      systemPrompt += '\n\n【你的外貌】\n' + meta.appearance.trim();
    }
    // 追加“关于用户”偏好（第 12 项）
    if (typeof userPreference === 'string' && userPreference.trim()) {
      systemPrompt += '\n\n【关于用户】\n' + userPreference.trim().slice(0, 1000);
    }
    // 追加“你此刻的心情”（第 13 项）
    if (contactRow && typeof contactRow.mood === 'string' && contactRow.mood.trim()) {
      systemPrompt += `\n\n【你此刻的心情】${contactRow.mood.trim()}（请带着这种情绪继续对话，不要每次都重置情绪）`;
    }
    // 追加“关系阶段”（第 14 项：按亲密度映射）
    if (contactRow && contactRow.intimacy !== null && contactRow.intimacy !== undefined) {
      systemPrompt += `\n\n【你与用户的关系】${intimacyStage(contactRow.intimacy)}（亲密度 ${Math.round(Number(contactRow.intimacy) || 0)}/100）`;
    }
  }

  // 追加“长期记忆”（安全词触发时调用方传入空数组 memories = []，此处自然跳过，不再注入记忆）
  if (memories.length > 0) {
    systemPrompt += '\n\n【长期记忆（按时间先后）】\n' +
      memories.map((m) => `${m.id}. ${m.content}`).join('\n') +
      '\n\n如果某条记忆已过时或错误，请在回复末尾单独输出【删除记忆：编号】来删除它（编号为上面记忆前的数字）。';

    // 用户近期情绪倾向（第 17 项）：取最近若干条带情绪标签的记忆做简单统计
    const emotionCount = {};
    for (const m of memories) {
      if (m.emotion) emotionCount[m.emotion] = (emotionCount[m.emotion] || 0) + 1;
    }
    const ranked = Object.entries(emotionCount).sort((a, b) => b[1] - a[1]);
    if (ranked.length > 0) {
      systemPrompt += `\n\n【用户近期情绪倾向】${ranked.map(([e, n]) => `${e}(${n})`).join('、')}——请体贴地照顾用户的情绪状态。`;
    }
  }

  // 未完成的承诺（第 18 项）：让角色记得自己答应过的事
  if (!safewordTriggered && pendingCommitments.length > 0) {
    systemPrompt += '\n\n【你答应过用户的事（尚未完成，请适时回应或兑现）】\n' +
      pendingCommitments.map((c) => `- ${c.content}${c.due_at ? `（约定时间：${c.due_at}）` : ''}`).join('\n');
  }

  // 说明“导演词”消息的含义（导演词仅本次生效、不落库）
  systemPrompt += '\n\n对话消息中带有【导演词】前缀的是用户对你的导演指令（临时提示词），请优先遵守；它们不是用户的提问，无需当作问题回答。';

  // 时间感知（第 28 项）：按 Asia/Shanghai（UTC+8）注入当前时间
  systemPrompt += `\n\n【当前时间】${formatChinaTime()}`;

  // 自定义重新生成指令（第 22 项）：仅对本次生成生效，不入库
  if (regenerateInstruction) {
    systemPrompt += '\n\n【本次重新生成的特殊要求】\n' + regenerateInstruction + '\n请在这次重新生成中优先满足该要求。';
  }

  return systemPrompt;
}

// ============================================================
// 角色心情 / 亲密度（第 13、14 项）
// ============================================================
// 心情标签集合（白名单，避免模型输出自由文本）
export const MOOD_TAGS = ['开心', '平静', '低落', '焦虑', '愤怒', '疲惫', '想你', '吃醋', '害羞', '期待'];
const DEFAULT_MOOD_MODEL = '@cf/meta/llama-3.2-3b-instruct';

// ============================================================
// 第 8 项：Analytics Engine 埋点
// 未绑定时静默跳过；注意 AE 数据只能在 Cloudflare 仪表板 / Grafana 查看，
// Pages Function 内无法读回（统计展示请走 D1 聚合，见 /api/stats）。
// ============================================================
export function writeEvent(env, event) {
  try {
    if (!env || !env.AE || typeof env.AE.writeDataPoint !== 'function') return;
    env.AE.writeDataPoint({
      indexes: [String((event && event.index) || 'pchat')],
      blobs: [
        String((event && event.type) || ''),
        String((event && event.userId) || ''),
        String((event && event.contactId) || ''),
        String((event && event.detail) || '').slice(0, 200),
      ],
      doubles: [Number((event && event.value) || 0)],
    });
  } catch (e) {
    console.warn('Analytics Engine 写入失败（忽略）:', e.message);
  }
}

// ============================================================
// 第 7 项：Vectorize 语义记忆检索
// 需要绑定：[[vectorize]] binding = "VECTORIZE" index_name = "..." + [ai] binding = "AI"
// 未绑定时全部函数优雅降级（返回 null / false），记忆检索回退到"最近 N 条"。
// ============================================================
export const EMBED_MODEL = '@cf/baai/bge-small-zh-v1.5';

export function hasVectorize(env) {
  return !!(env && env.VECTORIZE && env.AI && typeof env.VECTORIZE.upsert === 'function');
}

// 生成文本向量（512 维，中文小模型）
export async function embedTexts(env, texts) {
  if (!env || !env.AI || !Array.isArray(texts) || texts.length === 0) return null;
  try {
    const out = await env.AI.run(EMBED_MODEL, { text: texts });
    const data = out?.data || out?.result?.data;
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  } catch (e) {
    console.warn('生成向量失败（忽略）:', e.message);
    return null;
  }
}

// 写入/更新一条记忆的向量
export async function upsertMemoryVector(env, userId, contactId, memoryId, content) {
  if (!hasVectorize(env)) return false;
  try {
    const vecs = await embedTexts(env, [String(content || '').slice(0, 1000)]);
    if (!vecs || !vecs[0]) return false;
    await env.VECTORIZE.upsert([{
      id: `mem_${memoryId}`,
      values: vecs[0],
      metadata: { userId: Number(userId), contactId: String(contactId), memoryId: Number(memoryId) },
    }]);
    return true;
  } catch (e) {
    console.warn('写入记忆向量失败（忽略）:', e.message);
    return false;
  }
}

// 删除若干记忆的向量
export async function deleteMemoryVectors(env, memoryIds) {
  if (!hasVectorize(env) || !Array.isArray(memoryIds) || memoryIds.length === 0) return;
  try {
    await env.VECTORIZE.deleteByIds(memoryIds.map((i) => `mem_${i}`));
  } catch (e) {
    console.warn('删除记忆向量失败（忽略）:', e.message);
  }
}

// 语义检索：返回与 queryText 最相似的记忆 id 列表（失败返回 null → 调用方回退）
export async function searchMemoryIds(env, userId, contactId, queryText, topN = MEMORY_READ_MAX) {
  if (!hasVectorize(env) || !queryText) return null;
  try {
    const vecs = await embedTexts(env, [String(queryText).slice(0, 1000)]);
    if (!vecs || !vecs[0]) return null;
    const res = await env.VECTORIZE.query(vecs[0], {
      topK: topN,
      returnMetadata: true,
      filter: { userId: Number(userId), contactId: String(contactId) },
    });
    const matches = res?.matches || [];
    const ids = matches
      .map((m) => Number(m?.metadata?.memoryId))
      .filter((n) => Number.isInteger(n) && n > 0);
    return ids.length > 0 ? ids : null;
  } catch (e) {
    console.warn('向量检索失败（忽略）:', e.message);
    return null;
  }
}

// ============================================================
// 第 9 项：Turnstile 人机验证
// 未配置 TURNSTILE_SECRET 时跳过（保持可用）；校验异常也放行，避免误伤正常用户。
// ============================================================
export async function verifyTurnstile(env, token, ip) {
  const secret = env && env.TURNSTILE_SECRET;
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: '缺少人机验证令牌' };
  try {
    const form = new FormData();
    form.append('secret', String(secret));
    form.append('response', String(token));
    if (ip) form.append('remoteip', String(ip));
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.success) return { ok: true };
    return { ok: false, error: '人机验证失败，请重试' };
  } catch (e) {
    console.warn('Turnstile 校验异常（放行）:', e.message);
    return { ok: true, skipped: true };
  }
}

// 亲密度 → 关系阶段（第 14 项）
export function intimacyStage(intimacy) {
  const n = Number(intimacy) || 0;
  if (n <= 20) return '刚认识';
  if (n <= 50) return '熟悉';
  if (n <= 80) return '亲近';
  return '亲密';
}

// 用 Workers AI 生成角色当前心情标签（失败返回 null，静默降级）
export async function generateMood(env, messages) {
  try {
    if (!env.AI) return null; // 未绑定 Workers AI → 跳过
    const text = (messages || [])
      .slice(-6)
      .map((m) => (m.role === 'user' ? '用户' : '角色') + '：' + String(m.content || '').slice(0, 200))
      .join('\n');
    if (!text.trim()) return null;
    const model = (env.AI_MOOD_MODEL && String(env.AI_MOOD_MODEL).trim()) || DEFAULT_MOOD_MODEL;
    const out = await env.AI.run(model, {
      messages: [
        {
          role: 'system',
          content: `你是情绪分析助手。根据对话判断角色此刻的心情，只输出一个词，必须从以下列表中选择：${MOOD_TAGS.join('、')}。不要输出任何其他内容。`,
        },
        { role: 'user', content: text },
      ],
      max_tokens: 16,
    });
    const raw = typeof out === 'string' ? out : (out?.response || '');
    const cleaned = String(raw).replace(/[^\u4e00-\u9fa5]/g, '');
    if (!cleaned) return null;
    return MOOD_TAGS.find((t) => cleaned.includes(t)) || null;
  } catch (e) {
    console.warn('生成心情失败（忽略）:', e.message);
    return null;
  }
}

// 每轮对话后更新心情与亲密度（异步执行，不阻塞响应流关闭）
export async function updateMoodAndIntimacy(env, userId, contact, messages) {
  try {
    const mood = await generateMood(env, messages);
    if (mood) {
      await env.DB.prepare(
        'UPDATE contacts SET mood = ?, mood_updated_at = ? WHERE user_id = ? AND contact_id = ?'
      ).bind(mood, new Date().toISOString(), userId, contact).run();
    }
  } catch (e) {
    console.warn('更新心情失败（忽略）:', e.message);
  }
  try {
    // 亲密度每轮 +1，上限 100（SQLite 标量 MIN）
    await env.DB.prepare(
      'UPDATE contacts SET intimacy = MIN(COALESCE(intimacy, 0) + 1, 100) WHERE user_id = ? AND contact_id = ?'
    ).bind(userId, contact).run();
  } catch (e) {
    console.warn('更新亲密度失败（忽略）:', e.message);
  }
}

// ============================================================
// 多用户安全架构 Phase 1：底层工具
// ------------------------------------------------------------
// 本节只提供「与业务无关」的底层能力，供 Phase 2 的接口/管理端复用：
//   getClientIp()        审计日志统一取 IP 口径（admin_logs / login_logs）
//   getAppSettings()     应用级配置：D1 主存储 + KV 缓存，异常回退默认值
//   setAppSetting()      写入单条配置并失效缓存（setAppSettings 批量版本同理）
//   encryptSecret()      AES-GCM 加密用户密钥（主密钥来自 env.SECRET_MASTER_KEY）
//   decryptSecret()      AES-GCM 解密；密钥缺失 / 密文损坏 / 主密钥不匹配时返回 null
//   logAdminAction()     写 admin_logs，并按 env.ADMIN_LOG_MAX_COUNT 自动清理超额旧日志
//
// 涉及绑定与环境变量（均为可选，未配置时按注释降级，不会中断现有功能）：
//   env.DB                    D1（配置类功能必需）
//   env.APP_SETTINGS_KV       设置缓存专用 KV（未绑定则复用 env.PROMPTS_KV）
//   env.SECRET_MASTER_KEY     加解密主密钥（必需且必须是高熵随机串，否则加解密直接失败）
//   env.ADMIN_LOG_MAX_COUNT   审计日志保留条数上限（默认 2000）
//
// 兼容性：只新增导出，未改动任何既有函数；不触碰前端与接口代码。
// ============================================================

// 用户角色 / 状态的允许值（与 schema.sql 注释保持一致，供 Phase 2 校验用）
export const USER_ROLES = ['user', 'admin'];
export const USER_STATUSES = ['active', 'disabled', 'banned'];

// 环境变量管理员（env.ADMIN_USERNAME / env.ADMIN_PASSWORD）的密码哈希占位值：
// 这类账号永远不走密码校验，普通用户命中该占位值一律拒绝登录。
export const ENV_ADMIN_PROTECTED_HASH = 'ENV_ADMIN_PROTECTED';

// 用户自备 AI API Key 在 user_secrets 表中的名称（api-key.js 与 ai/stream.js 共用）
export const USER_API_KEY_NAME = 'deepseek_api_key';

// 恒定时间字符串比较：用于比对环境变量里的管理员密码。
// 先比较长度，再对所有字符做异或累加（不短路），避免通过响应时间推测密码前缀。
export function constantTimeEqual(a, b) {
  const sa = String(a === null || a === undefined ? '' : a);
  const sb = String(b === null || b === undefined ? '' : b);
  let diff = sa.length ^ sb.length;
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    diff |= (sa.charCodeAt(i) || 0) ^ (sb.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// 取客户端真实 IP：Cloudflare 一定有 CF-Connecting-IP；
// 本地 dev / 反向代理场景回退 X-Forwarded-For 的第一段。
export function getClientIp(request) {
  if (!request || !request.headers || typeof request.headers.get !== 'function') return '';
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return String(cf).trim().slice(0, 64);
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return String(forwarded).split(',')[0].trim().slice(0, 64);
  return '';
}

// ============================================================
// 应用级设置（app_settings 表 + KV 缓存）
// ------------------------------------------------------------
// 存储口径：所有值按 TEXT 存取（'1'/'0' 表示布尔，数字以字符串保存）。
// 读取口径：数据库中的键覆盖 DEFAULT_APP_SETTINGS，未配置的键使用默认值；
//           表里出现 DEFAULT_APP_SETTINGS 之外的键也会原样返回（便于 Phase 2 扩展）。
// 缓存口径：KV 只缓存「表里真实存在的键」，因此修改代码里的默认值会立即生效；
//           缓存 TTL 60 秒，写入设置时主动删除缓存，跨 PoP 的最终一致延迟上限即 TTL。
// 异常兜底：KV 异常 → 直读 D1；D1 异常 → 返回默认配置（绝不抛错，页面不会因配置读取失败而 500）。
// ============================================================
export const APP_SETTINGS_CACHE_KEY = 'app_settings_v1';
export const APP_SETTINGS_CACHE_TTL = 60; // 秒

// 默认配置（冻结，防止调用方误改）。值是字符串，布尔项用 '1' / '0'。
export const DEFAULT_APP_SETTINGS = Object.freeze({
  site_name: 'PersonalChat',   // 站点名称
  allow_register: '0',         // 是否开放注册（默认关闭，仅管理员可建号）
  invite_required: '1',        // 注册是否必须邀请码（默认开启）
  daily_token_limit: '0',      // 每用户每日 token 配额，0 = 不限制（配合 user_usage 表）
  max_users: '0',              // 用户总数上限，0 = 不限制
  turnstile_enabled: '0',      // 登录 / 注册是否强制人机验证
  maintenance_mode: '0',       // 维护模式（Phase 2 在中间件里拦截非管理员）
  announcement: '',            // 全站公告（空字符串 = 不展示）

  // ---- AI 密钥 / 用量（Phase 3）----
  user_api_key_enabled: '1',       // 是否允许用户保存并使用自己的 AI API Key（user_secrets）
  system_api_key_enabled: '1',     // 是否允许使用服务端系统 Key（还需 env.USE_SYSTEM_API_KEY）
  system_key_rate_limit: '10',     // 使用系统 Key 时每用户每分钟最多请求次数，0 = 不限制
  login_log_retention_days: '30',  // 登录日志保留天数（管理端可调，超出部分会被清理）

  // ---- 可选功能开关（Phase 3）：关闭后对应接口在入口直接返回 403 ----
  favorites_enabled: '1',          // 消息收藏
  reactions_enabled: '1',          // 消息表情回应
  memory_enabled: '1',             // 长期记忆（列表 / 手动增删改）
  memory_extract_enabled: '1',     // 记忆自动提炼（需 memory_enabled 同时开启）
  commitments_enabled: '1',        // 待办 / 承诺追踪
  insights_enabled: '1',           // 会话洞察
  stats_enabled: '1',              // 统计面板
  replay_enabled: '1',             // 时光机回放
  search_enabled: '1',             // 聊天记录搜索
  export_enabled: '1',             // 对话导出 / 完整备份导出
  import_enabled: '1',             // 对话导入
});

// 设置缓存用的 KV：优先专用绑定，未绑定时复用 PROMPTS_KV；都没有则只走 D1
function getSettingsKv(env) {
  if (!env) return null;
  const candidates = ['APP_SETTINGS_KV', 'SETTINGS_KV', 'PROMPTS_KV'];
  for (const name of candidates) {
    const kv = env[name];
    if (kv && typeof kv.get === 'function' && typeof kv.put === 'function') return kv;
  }
  return null;
}

// 返回一份默认配置的浅拷贝（调用方可安全修改）
export function defaultAppSettings() {
  return { ...DEFAULT_APP_SETTINGS };
}

// 读取全部配置。opts.skipCache = true 时跳过 KV 缓存（管理端编辑后立即读最新值）。
export async function getAppSettings(env, opts) {
  const o = opts || {};
  const defaults = defaultAppSettings();
  const kv = getSettingsKv(env);
  const cacheKey = o.cacheKey || APP_SETTINGS_CACHE_KEY;

  // 1) KV 缓存（只含表里存在的键，读时与默认值合并）
  if (kv && o.skipCache !== true) {
    try {
      const cached = await kv.get(cacheKey, { type: 'json' });
      if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
        return { ...defaults, ...cached };
      }
    } catch (e) {
      console.warn('读取 app_settings 缓存失败（回退 D1）:', e.message);
    }
  }

  // 2) D1 回源
  let rows = [];
  try {
    const res = await env.DB.prepare('SELECT key, value FROM app_settings').all();
    rows = (res && res.results) || [];
  } catch (e) {
    console.warn('读取 app_settings 失败（回退默认配置）:', e.message);
    return defaults;
  }

  const stored = {};
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !row.key) continue;
    stored[row.key] = (row.value === null || row.value === undefined) ? '' : String(row.value);
  }

  // 3) 回填缓存（失败不影响读取结果）
  if (kv) {
    try {
      await kv.put(cacheKey, JSON.stringify(stored), { expirationTtl: APP_SETTINGS_CACHE_TTL });
    } catch (e) {
      console.warn('写入 app_settings 缓存失败（忽略）:', e.message);
    }
  }

  return { ...defaults, ...stored };
}

// 删除设置缓存（下次 getAppSettings 会回源 D1）
export async function invalidateAppSettingsCache(env) {
  const kv = getSettingsKv(env);
  if (!kv) return false;
  try {
    await kv.delete(APP_SETTINGS_CACHE_KEY);
    return true;
  } catch (e) {
    console.warn('清理 app_settings 缓存失败（忽略）:', e.message);
    return false;
  }
}

// 写入 / 更新单条设置（UPSERT）。失败会抛错，由接口层决定如何响应。
// 注意：value 统一转成字符串存储；传 null / undefined 存为空字符串。
export async function setAppSetting(env, key, value) {
  const k = String(key === null || key === undefined ? '' : key).trim();
  if (!k) throw new Error('setAppSetting: key 不能为空');
  if (k.length > 100) throw new Error('setAppSetting: key 过长（上限 100）');
  const v = (value === null || value === undefined) ? '' : String(value);
  const now = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind(k, v, now).run();

  await invalidateAppSettingsCache(env);
  return { key: k, value: v, updated_at: now };
}

// 批量写入设置（管理端一次保存多个开关）：D1 batch 单次往返，写完只失效一次缓存。
// entries 形如 { allow_register: '1', max_users: '50' }；返回实际写入条数。
export async function setAppSettings(env, entries) {
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new TypeError('setAppSettings: entries 必须是 { key: value } 对象');
  }
  const now = new Date().toISOString();
  const statements = [];
  for (const [key, value] of Object.entries(entries)) {
    const k = String(key === null || key === undefined ? '' : key).trim();
    if (!k || k.length > 100) continue;
    const v = (value === null || value === undefined) ? '' : String(value);
    statements.push(env.DB.prepare(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind(k, v, now));
  }
  if (statements.length === 0) return 0;

  await env.DB.batch(statements);
  await invalidateAppSettingsCache(env);
  return statements.length;
}

// 布尔开关解析（兼容 '1' / 'true' / 'on' / 'yes' 与真正的布尔值）
export function isSettingEnabled(settings, key) {
  if (!settings) return false;
  const v = settings[key];
  if (typeof v === 'boolean') return v;
  if (v === null || v === undefined) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

// 环境变量布尔开关：未配置（undefined / null / 空串）时取 defaultValue。
// 用于 USE_SYSTEM_API_KEY 这类「默认开启、可用环境变量显式关闭」的开关。
export function isEnvFlagEnabled(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const s = String(value).trim().toLowerCase();
  if (s === '0' || s === 'false' || s === 'off' || s === 'no' || s === 'disabled') return false;
  if (s === '1' || s === 'true' || s === 'on' || s === 'yes' || s === 'enabled') return true;
  return defaultValue;
}

// 功能开关守卫：返回 null 表示允许继续；返回 403 Response 表示该功能已被管理员关闭。
// 用法（接口入口、鉴权之后调用）：
//   const denied = await requireFeature(env, 'favorites_enabled');
//   if (denied) return denied;
// 读取走 getAppSettings（KV 缓存），单次请求最多一次 D1 / KV 读。
export async function requireFeatures(env, keys) {
  const settings = await getAppSettings(env);
  const list = Array.isArray(keys) ? keys : [keys];
  for (const key of list) {
    if (!key) continue;
    if (!isSettingEnabled(settings, key)) {
      return json({ error: '该功能已被管理员关闭' }, 403);
    }
  }
  return null;
}

export async function requireFeature(env, key) {
  return requireFeatures(env, [key]);
}

// 管理员身份守卫：中间件已拦截 /api/admin/*，处理器内再校验一次，
// 防止将来路由调整（或把 handler 复用到别的路径）时漏掉保护。
export function requireAdminRole(data) {
  return (data && data.userRole === 'admin') ? null : json({ error: '需要管理员权限' }, 403);
}

// ============================================================
// 用户密钥加解密（Web Crypto AES-GCM 256）
// ------------------------------------------------------------
// 密文格式：v1:<iv base64>:<密文 base64>，其中 iv 为 12 字节随机数，
//          密文尾部自带 GCM 的 16 字节认证标签（篡改 / 换了主密钥都会解密失败）。
// 主密钥派生：对 env.SECRET_MASTER_KEY 做一次 SHA-256 得到 256 位密钥，
//            因此主密钥可以是任意高熵字符串（推荐 openssl rand -base64 32 生成），
//            不需要自己凑够 32 字节。派生结果按主密钥字符串缓存，避免每次请求重复派生。
// 安全约定：
//   - 缺少 SECRET_MASTER_KEY 时加密直接抛错、解密返回 null，绝不降级为明文或固定密钥；
//   - 解密失败只记录警告，不输出密文 / 主密钥，避免密钥材料进日志；
//   - v1 前缀为后续主密钥轮换留出版本位（换密钥时新增 v2 分支即可）。
// ============================================================
export const SECRET_CIPHER_VERSION = 'v1';
const AES_GCM_IV_BYTES = 12;
const aesKeyCache = new Map(); // masterKey 字符串 -> Promise<CryptoKey>

function bytesToBase64(bytes) {
  const chunkSize = 0x8000; // 分块，避免超长密文触发 String.fromCharCode 参数上限
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(String(b64));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// 是否配置了主密钥（Phase 2 可在保存密钥前用它给出友好提示）
export function hasSecretMasterKey(env) {
  return !!(env && env.SECRET_MASTER_KEY && String(env.SECRET_MASTER_KEY).trim());
}

// 判断字符串是否为本模块产出的密文
export function isEncryptedSecret(stored) {
  return typeof stored === 'string' && stored.startsWith(`${SECRET_CIPHER_VERSION}:`);
}

// 由主密钥派生 AES-GCM 密钥（同一 isolate 内缓存派生结果）
async function deriveAesKey(env) {
  const master = hasSecretMasterKey(env) ? String(env.SECRET_MASTER_KEY).trim() : '';
  if (!master) throw new Error('缺少环境变量 SECRET_MASTER_KEY，无法加解密用户密钥');
  if (master.length < 16) {
    console.warn('SECRET_MASTER_KEY 长度不足 16 字符，请改用高熵随机串（如 openssl rand -base64 32）');
  }

  const cached = aesKeyCache.get(master);
  if (cached) return cached;

  const derived = (async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(master));
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  })();
  aesKeyCache.set(master, derived);
  derived.catch(() => aesKeyCache.delete(master)); // 派生失败不缓存坏结果
  return derived;
}

// 加密：返回可直接存入 user_secrets.ciphertext 的字符串。
// 主密钥缺失时抛错（调用方应把「服务端未配置加密」作为 500 处理，而不是存明文）。
export async function encryptSecret(env, plaintext) {
  const text = (plaintext === null || plaintext === undefined) ? '' : String(plaintext);
  const key = await deriveAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(text)
  );
  return `${SECRET_CIPHER_VERSION}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(cipher))}`;
}

// 解密：成功返回明文；格式不对 / 主密钥缺失 / 主密钥不匹配 / 密文被篡改一律返回 null。
// 调用方拿到 null 应按「该密钥不可用」处理（例如提示用户重新填写），不要当空字符串用。
export async function decryptSecret(env, stored) {
  if (typeof stored !== 'string' || !stored) return null;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== SECRET_CIPHER_VERSION) {
    console.warn('解密失败：密文格式不是 v1:<iv>:<data>');
    return null;
  }
  try {
    const key = await deriveAesKey(env);
    const iv = base64ToBytes(parts[1]);
    if (iv.length !== AES_GCM_IV_BYTES) throw new Error('IV 长度不正确');
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      base64ToBytes(parts[2])
    );
    return new TextDecoder().decode(plain);
  } catch (e) {
    console.warn('解密用户密钥失败（主密钥不匹配或密文损坏）:', e.message);
    return null;
  }
}

// ============================================================
// 管理员操作审计（admin_logs）
// ------------------------------------------------------------
// 保留条数上限由 env.ADMIN_LOG_MAX_COUNT 决定（非正整数按默认 2000 处理）。
// 写法：先 INSERT，再删掉「比保留数量更旧」的行，始终只保留最新 N 条。
// 清理语句只做一次索引定位：
//   OFFSET N 取到第 N+1 新的 id；把它之前的行全删，正好剩 N 条。
//   行数 ≤ N 时子查询返回 NULL，`id <= NULL` 不成立，因此不会误删。
// 可靠性：审计是旁路能力，任何失败都只记警告并返回 false / 0，绝不影响管理操作本身。
// ============================================================
export const ADMIN_LOG_MAX_COUNT_DEFAULT = 2000;
export const ADMIN_LOG_ACTION_MAX = 100;
export const ADMIN_LOG_TARGET_MAX = 500;
const ADMIN_LOG_IP_MAX = 64;

// 读取保留条数上限（环境变量非法时回退默认值，避免「配错一个字符串就无限增长」）
export function getAdminLogMaxCount(env) {
  const raw = env && env.ADMIN_LOG_MAX_COUNT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return ADMIN_LOG_MAX_COUNT_DEFAULT;
  return Math.min(Math.floor(n), 100000); // 上限 10 万，防止误配成天文数字
}

// 通用审计日志裁剪：只保留最新 max 条，返回删除行数（失败返回 0）。
// table 只接受本模块内部传入的常量表名，不接受任何外部输入，避免拼接注入。
async function pruneLogTable(env, table, max) {
  try {
    const res = await env.DB.prepare(
      `DELETE FROM ${table} WHERE id <= (SELECT id FROM ${table} ORDER BY id DESC LIMIT 1 OFFSET ?)`
    ).bind(max).run();
    return (res && res.meta && res.meta.changes) || 0;
  } catch (e) {
    console.warn(`清理 ${table} 失败（忽略）:`, e.message);
    return 0;
  }
}

// 只保留最新 maxCount 条，返回删除行数（失败返回 0）
export async function pruneAdminLogs(env, maxCount) {
  const n = Number(maxCount);
  const max = (Number.isFinite(n) && n > 0) ? Math.floor(n) : getAdminLogMaxCount(env);
  return pruneLogTable(env, 'admin_logs', max);
}

// 写入一条管理员操作日志，然后自动清理超额旧记录。
// 用法：logAdminAction(env, {
//   adminId: '管理员的 users.id',
//   action: 'user.disable',        // 动作标识，如 user.disable / settings.update
//   target: 'user:12',             // 操作对象（可选）
//   ip: getClientIp(request),      // 客户端 IP（可选）
// })
// 返回 true = 已写入；false = 参数无效或写入失败（已记录警告）。
export async function logAdminAction(env, entry) {
  const e = entry || {};
  const adminId = Number(e.adminId === undefined ? e.admin_id : e.adminId);
  if (!Number.isInteger(adminId) || adminId <= 0) {
    console.warn('logAdminAction: adminId 无效，已跳过审计写入');
    return false;
  }
  const action = String(e.action === null || e.action === undefined ? '' : e.action)
    .trim().slice(0, ADMIN_LOG_ACTION_MAX);
  if (!action) {
    console.warn('logAdminAction: action 为空，已跳过审计写入');
    return false;
  }
  const target = (e.target === null || e.target === undefined)
    ? ''
    : String(e.target).trim().slice(0, ADMIN_LOG_TARGET_MAX);
  const ip = (e.ip === null || e.ip === undefined)
    ? ''
    : String(e.ip).trim().slice(0, ADMIN_LOG_IP_MAX);

  try {
    await env.DB.prepare(
      'INSERT INTO admin_logs (admin_id, action, target, ip) VALUES (?, ?, ?, ?)'
    ).bind(adminId, action, target, ip).run();
  } catch (err) {
    console.warn('写入 admin_logs 失败（忽略）:', err.message);
    return false;
  }

  await pruneAdminLogs(env);
  return true;
}

// ============================================================
// 登录审计（login_logs）
// ------------------------------------------------------------
// 只记录「已通过限流 / 人机验证后的凭据判定」结果，避免被刷请求灌爆日志：
//   success  登录成功
//   failed   账号不存在 / 密码错误 / 命中环境变量管理员占位账号
//   blocked  账号被停用（status != 'active'）
// 保留条数由 env.LOGIN_LOG_MAX_COUNT 控制（默认 5000，非法值回退默认）。
// 与 admin_logs 一样属于旁路能力：写入失败只记警告，绝不影响登录本身。
// 注意：本表只保存结果与原因，不保存密码、token、密文等敏感内容。
// ============================================================
export const LOGIN_LOG_MAX_COUNT_DEFAULT = 5000;
export const LOGIN_LOG_STATUSES = ['success', 'failed', 'blocked'];
const LOGIN_LOG_REASON_MAX = 200;
const LOGIN_LOG_USER_AGENT_MAX = 512;

// 读取保留条数上限（环境变量非法时回退默认值）
export function getLoginLogMaxCount(env) {
  const raw = env && env.LOGIN_LOG_MAX_COUNT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return LOGIN_LOG_MAX_COUNT_DEFAULT;
  return Math.min(Math.floor(n), 100000);
}

// 只保留最新 maxCount 条，返回删除行数（失败返回 0）
export async function pruneLoginLogs(env, maxCount) {
  const n = Number(maxCount);
  const max = (Number.isFinite(n) && n > 0) ? Math.floor(n) : getLoginLogMaxCount(env);
  return pruneLogTable(env, 'login_logs', max);
}

// 写入一条登录审计日志，然后自动清理超额旧记录。
// 用法：logLoginAttempt(env, {
//   userId: 12,                 // 可空（账号不存在时没有 userId）
//   ip: getClientIp(request),
//   userAgent: request.headers.get('User-Agent') || '',
//   status: 'failed',           // 'success' | 'failed' | 'blocked'
//   reason: 'bad_password',
// })
// 返回 true = 已写入；false = 参数无效或写入失败（已记录警告）。
export async function logLoginAttempt(env, entry) {
  const e = entry || {};
  const rawUserId = Number(e.userId === undefined ? e.user_id : e.userId);
  const userId = (Number.isInteger(rawUserId) && rawUserId > 0) ? rawUserId : null;

  const status = String(e.status === null || e.status === undefined ? '' : e.status).trim().toLowerCase();
  if (!LOGIN_LOG_STATUSES.includes(status)) {
    console.warn('logLoginAttempt: status 无效，已跳过审计写入');
    return false;
  }

  const ip = (e.ip === null || e.ip === undefined) ? '' : String(e.ip).trim().slice(0, 64);
  const userAgent = (e.userAgent === null || e.userAgent === undefined)
    ? ''
    : String(e.userAgent).trim().slice(0, LOGIN_LOG_USER_AGENT_MAX);
  const reason = (e.reason === null || e.reason === undefined)
    ? ''
    : String(e.reason).trim().slice(0, LOGIN_LOG_REASON_MAX);

  try {
    await env.DB.prepare(
      'INSERT INTO login_logs (user_id, ip, user_agent, status, reason) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, ip, userAgent, status, reason).run();
  } catch (err) {
    console.warn('写入 login_logs 失败（忽略）:', err.message);
    return false;
  }

  await pruneLoginLogs(env);
  return true;
}
