// functions/api/contacts/[id]/archive.js
// 角色归档 / 恢复 / 彻底删除（第 29 项）
// PUT    /api/contacts/:id/archive?restore=1  -> 从归档区恢复
// PUT    /api/contacts/:id/archive            -> 归档（与 DELETE /api/contacts/:id 等价）
// DELETE /api/contacts/:id/archive?purge=1    -> 彻底删除（级联清理聊天记录/记忆/KV）
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, CHAT_CACHE_PREFIX, deleteMemoryVectors } from '../../../_lib.js';

export async function onRequestPut({ request, env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const { id } = params;
  const url = new URL(request.url);
  const restore = url.searchParams.get('restore') === '1';

  const contact = await env.DB.prepare(
    'SELECT id, contact_id FROM contacts WHERE id = ? AND user_id = ?'
  ).bind(id, userId).first();
  if (!contact) return json({ error: '联系人不存在' }, 404);

  await env.DB.prepare('UPDATE contacts SET archived = ? WHERE id = ? AND user_id = ?')
    .bind(restore ? 0 : 1, id, userId).run();

  return json({ success: true, archived: !restore, contact_id: contact.contact_id });
}

// 彻底删除（不可恢复）：级联清理 chat_history / messages / memories / commitments 与 KV
export async function onRequestDelete({ request, env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const url = new URL(request.url);
  if (url.searchParams.get('purge') !== '1') {
    return json({ error: '彻底删除需要 purge=1（普通删除请用 DELETE /api/contacts/:id 归档）' }, 400);
  }

  try {
    const { id } = params;
    const contact = await env.DB.prepare(
      'SELECT id, contact_id FROM contacts WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first();
    if (!contact) return json({ error: '联系人不存在' }, 404);

    const cid = contact.contact_id;

    // 先取出该联系人的记忆 id（用于清理 Vectorize 向量）
    let memIds = [];
    try {
      const rows = await env.DB.prepare(
        'SELECT id FROM memories WHERE user_id = ? AND contact_id = ?'
      ).bind(userId, cid).all();
      memIds = (rows.results || []).map((r) => r.id);
    } catch (e) { /* 忽略 */ }

    // 级联删除（每步独立容错）
    for (const [sql, msg] of [
      ['DELETE FROM chat_history WHERE user_id = ? AND contact_id = ?', 'chat_history'],
      ['DELETE FROM messages WHERE user_id = ? AND contact_id = ?', 'messages'],
      ['DELETE FROM memories WHERE user_id = ? AND contact_id = ?', 'memories'],
      ['DELETE FROM commitments WHERE user_id = ? AND contact_id = ?', 'commitments'],
    ]) {
      try {
        await env.DB.prepare(sql).bind(userId, cid).run();
      } catch (e) { console.error(`删除 ${msg} 失败:`, e.message); }
    }

    try {
      await env.DB.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?')
        .bind(id, userId).run();
    } catch (e) {
      console.error('删除 contacts 失败:', e.message);
      return json({ error: '删除联系人记录失败' }, 500);
    }

    // 清理 KV（失败不影响删除结果）
    try { await env.CHAT_HISTORY.delete(`${CHAT_CACHE_PREFIX}${userId}_${cid}`); } catch (e) {}
    try { await env.PROMPTS_KV.delete(`prompt_${cid}`); } catch (e) {}
    try { await env.PROMPTS_KV.delete(`meta_${cid}`); } catch (e) {}
    try { await env.PROMPTS_KV.delete(`mem_state_${userId}_${cid}`); } catch (e) {}

    // 清理向量（第 7 项，未绑定 Vectorize 时自动跳过）
    try { await deleteMemoryVectors(env, memIds); } catch (e) {}

    return json({ success: true, purged: true });
  } catch (err) {
    console.error('DELETE /api/contacts/:id/archive 错误:', err);
    return json({ error: '服务器错误' }, 500);
  }
}
