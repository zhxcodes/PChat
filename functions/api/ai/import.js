// functions/api/ai/import.js
// ============================================================
// 0.12.0 新增：对话导入（POST /api/ai/import）
// ------------------------------------------------------------
// 只接受本项目「导出对话」生成的 JSON（结构见 /api/ai/export）：
//   { contact_id, exported_at, count, messages: [{ role, content, created_at }] }
// 也接受「完整备份」里的单个角色片段（同样有 messages 数组）。
//
// 请求体：
//   {
//     target: { type: 'existing', contact_id: 'kayoko' }
//           | { type: 'new', display_name: '新角色', contact_type?: 'ai'|'user' }
//     mode: 'merge' | 'replace',      // replace = 先删该角色全部历史再导入
//     dry_run: true | false,          // true 只统计不写库
//     messages: [ { role, content, created_at } ]
//   }
//
// 返回：
//   { ok, dry_run, contact_id, contact_created, total, valid, duplicates,
//     imported, skipped, replaced, first_at, last_at }
//
// 重要副作用（写库后）：
//   1) 删除该联系人的 KV 热缓存 chat_cache_v2_{uid}_{contact}
//      —— 否则 AI 仍按旧上下文回复（这是最容易漏的一步）
//   2) 把记忆提取进度 mem_state_{uid}_{contact}.lastId 推进到导入后的最大 id
//      —— 否则下一次聊天会把导入的历史当成积压，批量补提记忆（烧额度）
//
// 认证由 /api/_middleware.js 统一处理（data.userId）
// ============================================================

import {
  json,
  getUserId,
  LIMITS,
  CHAT_CACHE_PREFIX,
  MEMORY_STATE_PREFIX,
  ALLOWED_CONTACT_TYPES,
  requireFeature,
} from '../../_lib.js';

const MAX_IMPORT = 5000;      // 单次最多导入条数（与导出上限一致）
const INSERT_CHUNK = 30;      // D1 batch 每批语句数
const MAX_CONTENT = LIMITS.content; // 10000 字

// ---------------- 工具 ----------------
function toIsoString(ms) {
  // 与 _lib.saveChatTurn 写库格式保持一致（ISO + 毫秒 + Z），
  // 这样导入的行与后续聊天产生的新行在 ORDER BY created_at 里排序一致
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// 兼容三种时间写法：
//   1. "2026-10-24T12:00:00.000Z"（本项目新写入）
//   2. "2026-10-24 12:00:00"（SQLite CURRENT_TIMESTAMP / 种子数据，按 UTC 解释）
//   3. 数字时间戳（毫秒）
function normalizeDate(value, fallbackMs) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toIsoString(value) || toIsoString(fallbackMs);
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return toIsoString(fallbackMs);
    // 形如 2026-10-24 12:00[:00[.000]]
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*Z?$/);
    if (m) {
      const ms = Date.parse(
        `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}.${(m[7] || '0').padEnd(3, '0')}Z`
      );
      if (!Number.isNaN(ms)) return toIsoString(ms);
    }
    const direct = Date.parse(s);
    if (!Number.isNaN(direct)) return toIsoString(direct);
  }
  return toIsoString(fallbackMs);
}

// 内容指纹：role + 时间 + 长度 + 双 FNV-1a 变体。
// 用哈希而不是整段字符串做去重键，避免 5000 条 × 10000 字的 Set 把内存吃满；
// 同时带上长度，进一步降低碰撞概率（碰撞只会导致跳过一条，不会写错）。
function fingerprint(role, content, createdAt) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `${role}|${createdAt}|${content.length}|${h1.toString(36)}${h2.toString(36)}`;
}

function safeContactId(input) {
  const raw = String(input || '').trim();
  // 保留中文、字母数字与 . _ -，其余（空格、引号、斜杠）统一转成 -
  const cleaned = raw.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 40);
}

function generatedContactId(displayName) {
  const base = safeContactId(displayName) || 'import';
  return `${base}-${Date.now().toString(36).slice(-5)}`.slice(0, 48);
}

// ---------------- 校验 ----------------
function validateMessages(raw) {
  if (!Array.isArray(raw)) return { error: 'messages 必须是数组' };
  if (raw.length === 0) return { error: '没有可导入的消息' };
  if (raw.length > MAX_IMPORT) {
    return { error: `单次最多导入 ${MAX_IMPORT} 条，当前 ${raw.length} 条` };
  }

  const out = [];
  let invalid = 0;
  const now = Date.now();
  raw.forEach((m, i) => {
    if (!m || typeof m !== 'object') { invalid += 1; return; }
    const role = m.role === 'assistant' ? 'assistant' : (m.role === 'user' ? 'user' : null);
    if (!role) { invalid += 1; return; }
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) { invalid += 1; return; }
    if (content.length > MAX_CONTENT) { invalid += 1; return; }
    // 时间缺失/非法时按「消息顺序」造一个递增时间，保证导入后顺序不乱
    const createdAt = normalizeDate(m.created_at || m.timestamp, now + i);
    out.push({ role, content, createdAt });
  });

  return { list: out, invalid };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------- 主处理 ----------------
export async function onRequestPost({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'import_enabled');
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是合法 JSON' }, 400);
  }
  if (!isPlainObject(body)) return json({ error: '请求体格式错误' }, 400);

  const dryRun = body.dry_run === true;
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  const target = isPlainObject(body.target) ? body.target : {};
  const messages = body.messages;

  const checked = validateMessages(messages);
  if (checked.error) return json({ error: checked.error }, 400);
  const { list, invalid } = checked;

  try {
    // ---------- 1. 确定目标联系人 ----------
    let contactId = '';
    let displayName = '';
    let contactType = 'ai';
    let contactCreated = false;

    if (target.type === 'new') {
      displayName = String(target.display_name || '').trim().slice(0, LIMITS.display_name);
      if (!displayName) return json({ error: '新建角色需要填写名称' }, 400);
      contactType = ALLOWED_CONTACT_TYPES.includes(target.contact_type) ? target.contact_type : 'ai';
      // 允许前端指定 contact_id（导入备份时保留原 id），否则自动生成。
      // 若该 id 已存在则直接沿用（按合并处理），避免 UNIQUE 冲突导致整次导入失败。
      contactId = safeContactId(target.contact_id) || generatedContactId(displayName);
    } else {
      contactId = String(target.contact_id || '').trim();
      if (!contactId) return json({ error: '缺少目标联系人 contact_id' }, 400);
      if (contactId.length > LIMITS.contact_id) return json({ error: 'contact_id 过长' }, 400);
      const row = await env.DB.prepare(
        'SELECT contact_id, display_name, contact_type FROM contacts WHERE user_id = ? AND contact_id = ?'
      ).bind(userId, contactId).first();
      if (!row) return json({ error: '目标角色不存在' }, 404);
      displayName = row.display_name;
      contactType = row.contact_type;
    }

    // ---------- 2. 读取现有历史做去重（merge 模式） ----------
    const existing = new Set();
    if (mode === 'merge') {
      const rows = await env.DB.prepare(
        `SELECT role, content, created_at FROM chat_history
         WHERE user_id = ? AND contact_id = ? AND (kind IS NULL OR kind != 'director')
         ORDER BY id DESC LIMIT 20000`
      ).bind(userId, contactId).all();
      for (const r of rows.results || []) {
        existing.add(fingerprint(r.role, String(r.content || ''), String(r.created_at || '')));
      }
    }

    const picked = [];
    let duplicates = 0;
    for (const m of list) {
      const fp = fingerprint(m.role, m.content, m.createdAt);
      if (mode === 'merge' && existing.has(fp)) { duplicates += 1; continue; }
      existing.add(fp); // 同一文件内的重复也只导入一次
      picked.push(m);
    }

    const sorted = picked.slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const firstAt = sorted.length ? sorted[0].createdAt : null;
    const lastAt = sorted.length ? sorted[sorted.length - 1].createdAt : null;

    // ---------- 3. dry-run：只回报统计 ----------
    if (dryRun) {
      return json({
        ok: true,
        dry_run: true,
        contact_id: contactId,
        display_name: displayName,
        contact_type: contactType,
        contact_created: false,
        mode,
        total: list.length + invalid,
        valid: list.length,
        invalid,
        duplicates,
        will_import: sorted.length,
        imported: 0,
        skipped: duplicates + invalid,
        first_at: firstAt,
        last_at: lastAt,
      });
    }

    // ---------- 4. 正式写库 ----------
    // 新角色：先落 contacts 行
    if (target.type === 'new') {
      const exists = await env.DB.prepare(
        'SELECT id FROM contacts WHERE user_id = ? AND contact_id = ?'
      ).bind(userId, contactId).first();
      if (!exists) {
        await env.DB.prepare(
          `INSERT INTO contacts (user_id, contact_type, contact_id, display_name)
           VALUES (?, ?, ?, ?)`
        ).bind(userId, contactType, contactId, displayName).run();
        contactCreated = true;
      }
    }

    let replaced = false;
    if (mode === 'replace') {
      await env.DB.prepare(
        'DELETE FROM chat_history WHERE user_id = ? AND contact_id = ?'
      ).bind(userId, contactId).run();
      replaced = true;
    }

    let imported = 0;
    let maxRowId = 0;
    for (let i = 0; i < sorted.length; i += INSERT_CHUNK) {
      const chunk = sorted.slice(i, i + INSERT_CHUNK);
      const stmts = chunk.map((m) =>
        env.DB.prepare(
          `INSERT INTO chat_history (user_id, contact_id, role, content, kind, created_at)
           VALUES (?, ?, ?, ?, 'normal', ?)`
        ).bind(userId, contactId, m.role, m.content, m.createdAt)
      );
      const res = await env.DB.batch(stmts);
      imported += res.length;
      for (const r of res) {
        const id = Number(r?.meta?.last_row_id) || 0;
        if (id > maxRowId) maxRowId = id;
      }
    }

    // ---------- 5. 失效热缓存 + 推进记忆提取进度 ----------
    // 缓存失效失败不影响导入结果，但必须记日志（否则会出现「导入了但 AI 不知道」）
    try {
      await env.CHAT_HISTORY.delete(`${CHAT_CACHE_PREFIX}${userId}_${contactId}`);
    } catch (e) {
      console.warn('导入后清理热缓存失败:', e.message);
    }
    try {
      if (maxRowId > 0) {
        await env.PROMPTS_KV.put(
          `${MEMORY_STATE_PREFIX}${userId}_${contactId}`,
          JSON.stringify({ lastId: maxRowId })
        );
      }
    } catch (e) {
      console.warn('导入后推进记忆进度失败:', e.message);
    }

    return json({
      ok: true,
      dry_run: false,
      contact_id: contactId,
      display_name: displayName,
      contact_type: contactType,
      contact_created: contactCreated,
      mode,
      replaced,
      total: list.length + invalid,
      valid: list.length,
      invalid,
      duplicates,
      imported,
      skipped: duplicates + invalid,
      first_at: firstAt,
      last_at: lastAt,
    });
  } catch (err) {
    console.error('POST /api/ai/import 错误:', err);
    return json({ error: '导入失败，请稍后重试' }, 500);
  }
}

// 只允许 POST
export async function onRequestGet() {
  return json({ error: '请使用 POST' }, 405);
}
