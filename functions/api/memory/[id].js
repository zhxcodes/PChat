// functions/api/memory/[id].js
// PUT    /api/memory/:id  -> 编辑记忆内容 { content }
// DELETE /api/memory/:id  -> 删除一条记忆
// 第 7 项：同步维护 Vectorize 向量（未绑定时自动跳过）
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, upsertMemoryVector, deleteMemoryVectors, requireFeature } from '../../_lib.js';

export async function onRequestPut({ request, env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'memory_enabled');
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const content = String(body.content || '').trim();
  if (!content) return json({ error: '记忆内容不能为空' }, 400);
  if (content.length > 2000) return json({ error: '记忆内容过长（最多 2000 字）' }, 400);

  const { id } = params;
  const result = await env.DB.prepare(
    'UPDATE memories SET content = ? WHERE id = ? AND user_id = ? RETURNING id, content, contact_id, created_at'
  ).bind(content, id, userId).first();
  if (!result) return json({ error: '记忆不存在' }, 404);

  // 内容变了 → 重新生成向量
  try {
    await upsertMemoryVector(env, userId, result.contact_id, result.id, content);
  } catch (e) { /* 忽略 */ }

  return json({ id: result.id, content: result.content, created_at: result.created_at });
}

export async function onRequestDelete({ env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'memory_enabled');
  if (denied) return denied;

  const { id } = params;
  const res = await env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  if (!res.meta.changes) return json({ error: '记忆不存在' }, 404);

  // 同步删除向量
  try {
    await deleteMemoryVectors(env, [Number(id)]);
  } catch (e) { /* 忽略 */ }

  return json({ success: true });
}
