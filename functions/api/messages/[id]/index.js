// functions/api/messages/[id]/index.js
// DELETE /api/messages/:id  -> 删除单条普通消息（按 id + 用户归属）

import { json, getUserId } from '../../../_lib.js';

export async function onRequestDelete({ env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const { id } = params;
  const result = await env.DB.prepare(
    'DELETE FROM messages WHERE id = ? AND user_id = ?'
  ).bind(id, userId).run();

  if ((result.meta.changes || 0) === 0) {
    return json({ error: '消息不存在' }, 404);
  }
  return json({ success: true });
}
