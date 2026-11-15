// functions/api/favorites/index.js
// 消息收藏（第 23 项）
// GET    /api/favorites?contact=xxx        -> 列出收藏（含消息原文）
// POST   /api/favorites                    -> 收藏 { contact, message_id, note? }
// DELETE /api/favorites?id=NN              -> 取消收藏
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, LIMITS, requireFeature } from '../../_lib.js';

const MAX_NOTE = 200;

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'favorites_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const contact = (url.searchParams.get('contact') || '').slice(0, LIMITS.contact);
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);

  const rows = await env.DB.prepare(
    `SELECT f.id, f.message_id, f.note, f.created_at, h.content, h.role
     FROM favorites f
     LEFT JOIN chat_history h ON h.id = f.message_id
     WHERE f.user_id = ? AND f.contact_id = ?
     ORDER BY f.id DESC LIMIT 200`
  ).bind(userId, contact).all();

  return json({ favorites: rows.results || [] });
}

export async function onRequestPost({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'favorites_enabled');
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const contact = String(body.contact || '').slice(0, LIMITS.contact);
  const messageId = parseInt(body.message_id, 10);
  const note = body.note === undefined ? null : String(body.note).slice(0, MAX_NOTE);
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  if (!Number.isInteger(messageId) || messageId <= 0) return json({ error: '缺少 message_id' }, 400);

  const dup = await env.DB.prepare(
    'SELECT id FROM favorites WHERE user_id = ? AND contact_id = ? AND message_id = ?'
  ).bind(userId, contact, messageId).first();
  if (dup) return json({ success: true, id: dup.id, duplicated: true });

  const result = await env.DB.prepare(
    'INSERT INTO favorites (user_id, contact_id, message_id, note) VALUES (?, ?, ?, ?) RETURNING id'
  ).bind(userId, contact, messageId, note).first();

  return json({ success: true, id: result?.id }, 201);
}

export async function onRequestDelete({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'favorites_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id') || '', 10);
  const messageId = parseInt(url.searchParams.get('message_id') || '', 10);

  if (Number.isInteger(id) && id > 0) {
    const res = await env.DB.prepare('DELETE FROM favorites WHERE id = ? AND user_id = ?')
      .bind(id, userId).run();
    if (!res.meta.changes) return json({ error: '收藏不存在' }, 404);
    return json({ success: true });
  }
  if (Number.isInteger(messageId) && messageId > 0) {
    await env.DB.prepare('DELETE FROM favorites WHERE user_id = ? AND message_id = ?')
      .bind(userId, messageId).run();
    return json({ success: true });
  }
  return json({ error: '缺少 id 或 message_id' }, 400);
}
