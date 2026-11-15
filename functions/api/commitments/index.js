// functions/api/commitments/index.js
// 待办 / 承诺追踪（第 18 项）——AI 在对话中答应过用户的事
// GET    /api/commitments?contact=xxx[&done=0]  -> 列出承诺
// POST   /api/commitments                        -> 新增 { contact, content, due_at? }
// PUT    /api/commitments?id=NN                  -> 更新 { content?, due_at?, done? }
// DELETE /api/commitments?id=NN                  -> 删除
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, LIMITS, requireFeature } from '../../_lib.js';

const MAX_CONTENT = 300;

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'commitments_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const contact = (url.searchParams.get('contact') || '').slice(0, LIMITS.contact);
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  const doneFilter = url.searchParams.get('done');

  let sql = 'SELECT id, contact_id, content, due_at, done, created_at FROM commitments WHERE user_id = ? AND contact_id = ?';
  const args = [userId, contact];
  if (doneFilter === '0' || doneFilter === '1') {
    sql += ' AND done = ?';
    args.push(Number(doneFilter));
  }
  sql += ' ORDER BY done ASC, id DESC LIMIT 200';

  const rows = await env.DB.prepare(sql).bind(...args).all();
  return json({ commitments: rows.results || [] });
}

export async function onRequestPost({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'commitments_enabled');
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const contact = String(body.contact || '').slice(0, LIMITS.contact);
  const content = String(body.content || '').trim();
  const dueAt = body.due_at ? String(body.due_at).slice(0, 40) : null;
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  if (!content) return json({ error: '内容不能为空' }, 400);
  if (content.length > MAX_CONTENT) return json({ error: `内容不能超过 ${MAX_CONTENT} 字` }, 400);

  const result = await env.DB.prepare(
    'INSERT INTO commitments (user_id, contact_id, content, due_at, done) VALUES (?, ?, ?, ?, 0) RETURNING id, contact_id, content, due_at, done, created_at'
  ).bind(userId, contact, content, dueAt).first();

  return json(result, 201);
}

export async function onRequestPut({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'commitments_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: '缺少 id 参数' }, 400);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }

  const updates = [];
  const values = [];
  if (body.content !== undefined) {
    const content = String(body.content).trim();
    if (!content) return json({ error: '内容不能为空' }, 400);
    if (content.length > MAX_CONTENT) return json({ error: `内容不能超过 ${MAX_CONTENT} 字` }, 400);
    updates.push('content = ?');
    values.push(content);
  }
  if (body.due_at !== undefined) {
    updates.push('due_at = ?');
    values.push(body.due_at ? String(body.due_at).slice(0, 40) : null);
  }
  if (body.done !== undefined) {
    updates.push('done = ?');
    values.push(body.done ? 1 : 0);
  }
  if (updates.length === 0) return json({ error: '没有要更新的字段' }, 400);

  values.push(id, userId);
  const result = await env.DB.prepare(
    `UPDATE commitments SET ${updates.join(', ')} WHERE id = ? AND user_id = ? RETURNING id, contact_id, content, due_at, done, created_at`
  ).bind(...values).first();
  if (!result) return json({ error: '承诺不存在' }, 404);

  return json(result);
}

export async function onRequestDelete({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'commitments_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (!Number.isInteger(id) || id <= 0) return json({ error: '缺少 id 参数' }, 400);

  const res = await env.DB.prepare('DELETE FROM commitments WHERE id = ? AND user_id = ?')
    .bind(id, userId).run();
  if (!res.meta.changes) return json({ error: '承诺不存在' }, 404);

  return json({ success: true });
}
