// functions/api/messages/long-poll.js
// GET /api/messages/long-poll?lastId=0
// 长轮询：有 id 大于 lastId 的新消息时立即返回该消息；
// 25 秒内无新消息则返回 { timeout: true }（前端随即发起下一次轮询）。

import { json, getUserId } from '../../_lib.js';

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const url = new URL(request.url);
  const lastId = parseInt(url.searchParams.get('lastId') || '0') || 0;

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const msg = await env.DB.prepare(
      `SELECT id, username, content, created_at, contact_type, contact_id
       FROM messages
       WHERE user_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT 1`
    ).bind(userId, lastId).first();

    if (msg) return json(msg);
    await new Promise((r) => setTimeout(r, 1000));
  }

  return json({ timeout: true });
}
