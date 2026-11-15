// functions/api/contacts/index.js
// GET  /api/contacts          -> 联系人列表
// POST /api/contacts          -> 新建联系人（含 AI 角色设定写入 KV）
// 安全：所有输入通过 ? 占位符绑定；字段长度与 AI 参数范围均受限。

import { json, clamp, getUserId, LIMITS, ALLOWED_CONTACT_TYPES, MEMORY_WINDOW_MIN, MEMORY_WINDOW_MAX, MEMORY_WINDOW_DEFAULT, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_DEFAULT } from '../../_lib.js';

const CONTACT_COLUMNS = 'id, contact_type, contact_id, display_name, avatar, temperature, top_p, max_tokens, frequency_penalty, presence_penalty, memory_window, context_window, mood, mood_updated_at, intimacy, archived';

function checkLength(field, value, max) {
  return value !== undefined && value !== null && String(value).length > max;
}

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  try {
    // 归档（第 29 项）：默认只返回未归档；?archived=1 返回归档区
    const url = new URL(request.url);
    const wantArchived = url.searchParams.get('archived') === '1';
    const contacts = await env.DB.prepare(
      `SELECT ${CONTACT_COLUMNS} FROM contacts
       WHERE user_id = ? AND COALESCE(archived, 0) = ?
       ORDER BY contact_type, display_name`
    ).bind(userId, wantArchived ? 1 : 0).all();
    return json(contacts.results || []);
  } catch (err) {
    console.error('GET /api/contacts 错误:', err);
    return json({ error: '服务器错误' }, 500);
  }
}

export async function onRequestPost({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  try {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: '请求体不是有效的 JSON' }, 400);
    }
    const {
      contact_id,
      display_name,
      contact_type,
      temperature,
      top_p,
      max_tokens,
      frequency_penalty,
      presence_penalty,
      memory_window,
      context_window,
      greeting,
      prompt,
      format,
      scene,
      appearance,
    } = body;

    if (!contact_id || !display_name) {
      return json({ error: '缺少必填字段' }, 400);
    }

    // 输入校验
    if (checkLength('contact_id', contact_id, LIMITS.contact_id) ||
        checkLength('display_name', display_name, LIMITS.display_name) ||
        checkLength('greeting', greeting, LIMITS.greeting) ||
        checkLength('format', format, LIMITS.format) ||
        checkLength('prompt', prompt, LIMITS.prompt) ||
        checkLength('scene', scene, LIMITS.scene) ||
        checkLength('appearance', appearance, LIMITS.appearance)) {
      return json({ error: '字段长度超出限制' }, 400);
    }

    const type = contact_type || 'ai';
    if (!ALLOWED_CONTACT_TYPES.includes(type)) {
      return json({ error: 'contact_type 不合法' }, 400);
    }

    const cid = String(contact_id).slice(0, LIMITS.contact_id);
    const name = String(display_name).slice(0, LIMITS.display_name);
    const tempVal = clamp(temperature, 0, 2, 0.7);
    const topPVal = clamp(top_p, 0, 1, 0.9);
    const maxTokensVal = Math.round(clamp(max_tokens, 256, 8192, 2048));
    const freqPenaltyVal = clamp(frequency_penalty, -2, 2, 0);
    const presPenaltyVal = clamp(presence_penalty, -2, 2, 0);
    const memWindowVal = Math.round(clamp(memory_window, MEMORY_WINDOW_MIN, MEMORY_WINDOW_MAX, MEMORY_WINDOW_DEFAULT));
    const ctxWindowVal = Math.round(clamp(context_window, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_DEFAULT));

    const existing = await env.DB.prepare(
      'SELECT id FROM contacts WHERE user_id = ? AND contact_id = ?'
    ).bind(userId, cid).first();
    if (existing) {
      return json({ error: '该联系人ID已存在' }, 400);
    }

    const result = await env.DB.prepare(
      `INSERT INTO contacts (user_id, contact_id, contact_type, display_name, temperature, top_p, max_tokens, frequency_penalty, presence_penalty, memory_window, context_window)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(userId, cid, type, name, tempVal, topPVal, maxTokensVal, freqPenaltyVal, presPenaltyVal, memWindowVal, ctxWindowVal).first();

    // AI 角色：把角色设定同步写入 KV
    if (type === 'ai') {
      if (greeting !== undefined || format !== undefined || scene !== undefined || appearance !== undefined || name) {
        const meta = {};
        if (name) meta.name = name;
        if (greeting !== undefined) meta.greeting = String(greeting).slice(0, LIMITS.greeting);
        if (format !== undefined) meta.format = String(format).slice(0, LIMITS.format);
        if (scene !== undefined) meta.scene = String(scene).slice(0, LIMITS.scene);
        if (appearance !== undefined) meta.appearance = String(appearance).slice(0, LIMITS.appearance);
        await env.PROMPTS_KV.put(`meta_${cid}`, JSON.stringify(meta));
      }
      if (prompt !== undefined) {
        await env.PROMPTS_KV.put(`prompt_${cid}`, String(prompt).slice(0, LIMITS.prompt));
      }
    }

    return json(result, 201);
  } catch (err) {
    console.error('POST /api/contacts 错误:', err);
    return json({ error: '服务器错误' }, 500);
  }
}
