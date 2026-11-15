// functions/api/contacts/[id]/index.js
// GET    /api/contacts/:id   -> 单个联系人详情
// PUT    /api/contacts/:id   -> 更新联系人（名称 + AI 参数 + 头像）
// DELETE /api/contacts/:id   -> 删除联系人（级联删除其全部聊天记录与 KV 数据）
// 安全：SQL 全部使用 ? 占位符（SET 子句仅由硬编码白名单字段名拼接，值全部绑定）；
//      字段长度与 AI 参数范围受限；错误响应不泄露内部信息。

import { json, clamp, getUserId, LIMITS, maybeExtractMemory, MEMORY_WINDOW_MIN, MEMORY_WINDOW_MAX, MEMORY_WINDOW_DEFAULT, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_DEFAULT } from '../../../_lib.js';

const CONTACT_COLUMNS = 'id, contact_type, contact_id, display_name, avatar, temperature, top_p, max_tokens, frequency_penalty, presence_penalty, memory_window, context_window, mood, mood_updated_at, intimacy, archived';

export async function onRequestGet({ env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const { id } = params;
  const contact = await env.DB.prepare(
    `SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = ? AND user_id = ?`
  ).bind(id, userId).first();

  if (!contact) return json({ error: '联系人不存在' }, 404);
  return json(contact);
}

export async function onRequestPut({ request, env, data, params, ctx }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  try {
    const { id } = params;
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: '请求体不是有效的 JSON' }, 400);
    }
    const { display_name, temperature, top_p, max_tokens, frequency_penalty, presence_penalty, memory_window, context_window, avatar } = body;

    if (display_name !== undefined && String(display_name).length > LIMITS.display_name) {
      return json({ error: `display_name 长度不能超过 ${LIMITS.display_name} 字符` }, 400);
    }
    if (avatar !== undefined && String(avatar).length > LIMITS.avatar) {
      return json({ error: 'avatar 路径过长' }, 400);
    }

    const existing = await env.DB.prepare(
      'SELECT id, contact_id FROM contacts WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first();
    if (!existing) return json({ error: '联系人不存在' }, 404);

    // updates 数组只允许硬编码白名单字段名；值全部经 ? 绑定，杜绝注入
    const updates = [];
    const values = [];
    let memWindowChanged = false;
    if (display_name !== undefined) {
      updates.push('display_name = ?');
      values.push(String(display_name).slice(0, LIMITS.display_name));
    }
    if (avatar !== undefined) {
      updates.push('avatar = ?');
      values.push(String(avatar).trim() || null);
    }
    if (temperature !== undefined) {
      updates.push('temperature = ?');
      values.push(clamp(temperature, 0, 2, 0.7));
    }
    if (top_p !== undefined) {
      updates.push('top_p = ?');
      values.push(clamp(top_p, 0, 1, 0.9));
    }
    if (max_tokens !== undefined) {
      updates.push('max_tokens = ?');
      values.push(Math.round(clamp(max_tokens, 256, 8192, 2048)));
    }
    if (frequency_penalty !== undefined) {
      updates.push('frequency_penalty = ?');
      values.push(clamp(frequency_penalty, -2, 2, 0));
    }
    if (presence_penalty !== undefined) {
      updates.push('presence_penalty = ?');
      values.push(clamp(presence_penalty, -2, 2, 0));
    }
    if (memory_window !== undefined) {
      updates.push('memory_window = ?');
      values.push(Math.round(clamp(memory_window, MEMORY_WINDOW_MIN, MEMORY_WINDOW_MAX, MEMORY_WINDOW_DEFAULT)));
      memWindowChanged = true;
    }
    if (context_window !== undefined) {
      updates.push('context_window = ?');
      values.push(Math.round(clamp(context_window, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_DEFAULT)));
    }

    if (updates.length === 0) {
      return json({ error: '没有要更新的字段' }, 400);
    }

    values.push(id, userId);
    const result = await env.DB.prepare(
      `UPDATE contacts SET ${updates.join(', ')} WHERE id = ? AND user_id = ? RETURNING *`
    ).bind(...values).first();

    // 记忆窗口被修改 → 立即把尚未提取的消息补提成记忆（后台执行，不阻塞响应）
    if (memWindowChanged && existing.contact_id) {
      try {
        if (ctx && typeof ctx.waitUntil === 'function') {
          ctx.waitUntil(maybeExtractMemory(env, userId, existing.contact_id));
        } else {
          maybeExtractMemory(env, userId, existing.contact_id);
        }
      } catch (e) {
        console.warn('触发记忆补提失败（忽略）:', e.message);
      }
    }

    return json(result);
  } catch (err) {
    console.error('PUT /api/contacts/:id 错误:', err);
    return json({ error: '服务器错误' }, 500);
  }
}

// 删除联系人 → 语义改为「归档」（第 29 项）：从列表隐藏但保留全部数据，
// 可在管理后台归档区恢复；彻底删除请用 DELETE /api/contacts/:id/archive?purge=1
export async function onRequestDelete({ env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  try {
    const { id } = params;
    const contact = await env.DB.prepare(
      'SELECT id, contact_id FROM contacts WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first();
    if (!contact) return json({ error: '联系人不存在' }, 404);

    await env.DB.prepare('UPDATE contacts SET archived = 1 WHERE id = ? AND user_id = ?')
      .bind(id, userId).run();

    return json({ success: true, archived: true, contact_id: contact.contact_id });
  } catch (err) {
    console.error('DELETE(archive) /api/contacts/:id 错误:', err);
    return json({ error: '服务器错误' }, 500);
  }
}
