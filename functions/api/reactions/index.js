// functions/api/reactions/index.js
// 消息表情回应（第 24 项）
// GET    /api/reactions?contact=xxx   -> 列出该联系人的全部反应（前端按 message_id 聚合）
// POST   /api/reactions               -> 添加/取消 { contact, message_id, emoji }
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, LIMITS, requireFeature } from '../../_lib.js';

const ALLOWED_EMOJI = ['❤', '😂', '😢', '😮', '👍'];

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'reactions_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const contact = (url.searchParams.get('contact') || '').slice(0, LIMITS.contact);
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);

  const rows = await env.DB.prepare(
    'SELECT id, message_id, emoji, created_at FROM reactions WHERE user_id = ? ORDER BY id ASC LIMIT 2000'
  ).bind(userId).all();

  // 仅返回属于该联系人消息的反应
  const ids = [...new Set((rows.results || []).map(r => r.message_id))];
  if (ids.length === 0) return json({ reactions: [] });

  const placeholders = ids.map(() => '?').join(', ');
  const owned = await env.DB.prepare(
    `SELECT id FROM chat_history WHERE user_id = ? AND contact_id = ? AND id IN (${placeholders})`
  ).bind(userId, contact, ...ids).all();
  const ownedSet = new Set((owned.results || []).map(r => r.id));

  const reactions = (rows.results || []).filter(r => ownedSet.has(r.message_id));
  return json({ reactions });
}

export async function onRequestPost({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'reactions_enabled');
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const contact = String(body.contact || '').slice(0, LIMITS.contact);
  const messageId = parseInt(body.message_id, 10);
  const emoji = String(body.emoji || '').trim();
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  if (!Number.isInteger(messageId) || messageId <= 0) return json({ error: '缺少 message_id' }, 400);
  if (!ALLOWED_EMOJI.includes(emoji)) return json({ error: '不支持的表情' }, 400);

  // 校验消息归属（防止给别人的消息加反应）
  const owned = await env.DB.prepare(
    'SELECT id FROM chat_history WHERE id = ? AND user_id = ? AND contact_id = ?'
  ).bind(messageId, userId, contact).first();
  if (!owned) return json({ error: '消息不存在' }, 404);

  const existing = await env.DB.prepare(
    'SELECT id FROM reactions WHERE user_id = ? AND message_id = ? AND emoji = ?'
  ).bind(userId, messageId, emoji).first();

  if (existing) {
    // 已存在 → 取消（切换语义）
    await env.DB.prepare('DELETE FROM reactions WHERE id = ? AND user_id = ?').bind(existing.id, userId).run();
    return json({ success: true, removed: true });
  }

  const result = await env.DB.prepare(
    'INSERT INTO reactions (user_id, message_id, emoji) VALUES (?, ?, ?) RETURNING id'
  ).bind(userId, messageId, emoji).first();

  return json({ success: true, id: result?.id }, 201);
}
