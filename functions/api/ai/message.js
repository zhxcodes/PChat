// functions/api/ai/message.js
// PUT /api/ai/message?contact=kayoko&role=assistant  { content }
// 编辑该联系人最新一条指定角色（默认 assistant，可传 user）消息的内容。
// 更新 D1 后使 KV 热缓存失效，下次读取自动回源，保证缓存与主存储一致。

import { json, getUserId, LIMITS, CHAT_CACHE_PREFIX } from '../../_lib.js';

const ALLOWED_ROLES = ['user', 'assistant'];

export async function onRequestPut({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const url = new URL(request.url);
  const contact = url.searchParams.get('contact') || '';
  const role = url.searchParams.get('role') || 'assistant';
  // 可选：按消息 id 精确定位（编辑导演词等任意消息）；不传则回退到该角色最新一条
  const rawId = url.searchParams.get('id') || '';
  const msgId = /^\d+$/.test(rawId) ? Number(rawId) : null;
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  if (!ALLOWED_ROLES.includes(role)) return json({ error: 'role 参数不合法' }, 400);
  if (String(contact).length > LIMITS.contact) {
    return json({ error: 'contact 参数过长' }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return json({ error: '内容不能为空' }, 400);
  if (content.length > LIMITS.message) {
    return json({ error: `内容长度不能超过 ${LIMITS.message} 字符` }, 400);
  }

  // 定位目标消息：优先按 id；否则取该联系人最新一条指定角色的消息
  let target = null;
  if (msgId) {
    target = await env.DB.prepare(
      `SELECT id, content FROM chat_history
       WHERE id = ? AND user_id = ? AND contact_id = ? AND role = ?`
    ).bind(msgId, userId, contact, role).first();
  } else {
    target = await env.DB.prepare(
      `SELECT id, content FROM chat_history
       WHERE user_id = ? AND contact_id = ? AND role = ?
       ORDER BY id DESC LIMIT 1`
    ).bind(userId, contact, role).first();
  }
  if (!target) return json({ error: '没有可编辑的消息' }, 404);

  // 编辑历史（第 25 项）：先把旧内容写入 message_edits，再更新 chat_history
  try {
    await env.DB.prepare(
      'INSERT INTO message_edits (message_id, old_content, new_content) VALUES (?, ?, ?)'
    ).bind(target.id, target.content || '', content).run();
  } catch (e) {
    console.warn('写入编辑历史失败（忽略）:', e.message);
  }

  await env.DB.prepare('UPDATE chat_history SET content = ? WHERE id = ? AND user_id = ?')
    .bind(content, target.id, userId).run();

  // 使 KV 缓存失效，下次读取自动回源
  try {
    await env.CHAT_HISTORY.delete(`${CHAT_CACHE_PREFIX}${userId}_${contact}`);
  } catch (e) {
    console.warn('失效历史缓存失败:', e.message);
  }

  return json({ success: true, id: target.id, content });
}

// GET /api/ai/message?contact=kayoko&id=123
// 返回该消息的编辑历史（含当前内容），供前端"已编辑"标记查看历史版本
export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const url = new URL(request.url);
  const contact = url.searchParams.get('contact') || '';
  const rawId = url.searchParams.get('id') || '';
  const msgId = /^\d+$/.test(rawId) ? Number(rawId) : null;
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  if (!msgId) return json({ error: '缺少 id 参数' }, 400);

  const current = await env.DB.prepare(
    'SELECT id, content, role FROM chat_history WHERE id = ? AND user_id = ? AND contact_id = ?'
  ).bind(msgId, userId, contact).first();
  if (!current) return json({ error: '消息不存在' }, 404);

  const rows = await env.DB.prepare(
    'SELECT old_content, new_content, edited_at FROM message_edits WHERE message_id = ? ORDER BY id ASC LIMIT 50'
  ).bind(msgId).all();

  return json({
    message_id: msgId,
    current: current.content,
    edits: rows.results || [],
  });
}
