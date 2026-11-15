// functions/api/memory/index.js
// GET    /api/memory?contact=xxx            -> 列出该联系人的全部记忆（含情绪标签）
// POST   /api/memory                        -> 手动新增一条记忆 { contact, content }
// DELETE /api/memory?contact=xxx&all=1      -> 清空该联系人的全部记忆
// 强制提炼：POST /api/memory/extract?contact=xxx（见同目录 extract.js）
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, LIMITS, deleteMemoryVectors, requireFeature } from '../../_lib.js';

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'memory_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const contact = (url.searchParams.get('contact') || '').slice(0, LIMITS.contact);
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);

  const rows = await env.DB.prepare(
    'SELECT id, content, source_start, source_end, emotion, emotion_score, created_at FROM memories WHERE user_id = ? AND contact_id = ? ORDER BY id ASC'
  ).bind(userId, contact).all();
  return json({ memories: rows.results || [] });
}

export async function onRequestPost({ request, env, data }) {
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
  const contact = String(body.contact || '').slice(0, LIMITS.contact);
  const content = String(body.content || '').trim();
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  if (!content) return json({ error: '记忆内容不能为空' }, 400);
  if (content.length > 2000) return json({ error: '记忆内容过长（最多 2000 字）' }, 400);

  const result = await env.DB.prepare(
    'INSERT INTO memories (user_id, contact_id, content) VALUES (?, ?, ?) RETURNING id, content, created_at'
  ).bind(userId, contact, content).first();

  return json(result, 201);
}

export async function onRequestDelete({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'memory_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const contact = (url.searchParams.get('contact') || '').slice(0, LIMITS.contact);
  const all = url.searchParams.get('all') === '1';
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  if (!all) return json({ error: '缺少 all 参数' }, 400);

  // 先取出待删除的 id（用于清理 Vectorize 向量），再删除
  let ids = [];
  try {
    const rows = await env.DB.prepare(
      'SELECT id FROM memories WHERE user_id = ? AND contact_id = ?'
    ).bind(userId, contact).all();
    ids = (rows.results || []).map((r) => r.id);
  } catch (e) { /* 忽略 */ }

  const res = await env.DB.prepare('DELETE FROM memories WHERE user_id = ? AND contact_id = ?')
    .bind(userId, contact).run();

  try {
    await deleteMemoryVectors(env, ids);
  } catch (e) { /* 忽略 */ }

  return json({ success: true, deleted: res.meta.changes || 0 });
}
