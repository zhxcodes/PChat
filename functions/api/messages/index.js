// functions/api/messages/index.js
// GET  /api/messages?contact_type=&contact_id=&since=
// POST /api/messages  { content, contact_type, contact_id }
// 普通（非 AI）消息的存储与查询。
// 安全：所有用户输入均通过 ? 占位符绑定（无 SQL 拼接）；内容长度受限。

import { json, getUserId, LIMITS, ALLOWED_CONTACT_TYPES } from '../../_lib.js';

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const url = new URL(request.url);
  const contactType = url.searchParams.get('contact_type');
  const contactId = url.searchParams.get('contact_id');
  const since = url.searchParams.get('since');

  // 参数全部通过 ? 占位符绑定，杜绝 SQL 注入
  let query = `
    SELECT id, username, content, created_at, contact_type, contact_id
    FROM messages
    WHERE user_id = ? AND contact_type = ? AND contact_id = ?
  `;
  const params = [userId, contactType || 'user', contactId || 'default'];

  if (since) {
    query += ' AND created_at > ? ORDER BY created_at ASC';
    params.push(since);
  } else {
    query += ' ORDER BY created_at DESC LIMIT 100';
  }

  const rows = await env.DB.prepare(query).bind(...params).all();
  return json((rows.results || []).reverse());
}

export async function onRequestPost({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const { content, contact_type, contact_id } = payload;

  if (typeof content !== 'string' || content.trim().length === 0) {
    return json({ error: '内容不能为空' }, 400);
  }
  if (content.trim().length > LIMITS.content) {
    return json({ error: `内容长度不能超过 ${LIMITS.content} 字符` }, 400);
  }

  const type = contact_type || 'user';
  if (!ALLOWED_CONTACT_TYPES.includes(type)) {
    return json({ error: 'contact_type 不合法' }, 400);
  }
  const cid = contact_id || 'default';
  if (String(cid).length > LIMITS.contactIdQuery) {
    return json({ error: 'contact_id 过长' }, 400);
  }

  const user = await env.DB.prepare('SELECT username FROM users WHERE id = ?')
    .bind(userId).first();
  if (!user) return json({ error: '用户不存在' }, 401);

  const nowISO = new Date().toISOString();
  const msg = {
    id: Date.now(),
    username: user.username,
    content: content.trim().slice(0, LIMITS.content),
    created_at: nowISO,
    contact_type: type,
    contact_id: String(cid).slice(0, LIMITS.contactIdQuery),
    user_id: userId,
  };

  await env.DB.prepare(`
    INSERT INTO messages (id, username, content, created_at, contact_type, contact_id, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(msg.id, msg.username, msg.content, msg.created_at, msg.contact_type, msg.contact_id, msg.user_id).run();

  return json(msg, 201);
}
