// functions/api/ai/history.js
// GET /api/ai/history?contact=kayoko&page=1
// 返回 AI 对话历史（分页）。
// 首页优先 KV 热缓存（含完整性校验），翻页回源 D1；
// 读取逻辑统一走 _lib.js 的 loadChatHistory/loadChatHistoryPage，
// 与 stream.js 保持完全一致的缓存口径（KV→D1、去重、回填）。

import { json, getUserId, loadChatHistory, loadChatHistoryPage, countChatHistory, CHAT_CACHE_PREFIX } from '../../_lib.js';

const PAGE_SIZE = 30;
const MAX_DELETE_IDS = 200;

// DELETE /api/ai/history?contact=kayoko&ids=1,2,3
// 删除指定 id 的聊天记录（含更晚的由前端勾选），删除后使 KV 缓存失效
export async function onRequestDelete({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const url = new URL(request.url);
  const contact = url.searchParams.get('contact') || '';
  const idsParam = url.searchParams.get('ids') || '';
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);

  const ids = idsParam.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return json({ error: '缺少 ids 参数' }, 400);
  if (ids.length > MAX_DELETE_IDS) return json({ error: `一次最多删除 ${MAX_DELETE_IDS} 条` }, 400);

  // 逐条删除（受 SQLite 变量数量限制，用占位符拼接）
  const placeholders = ids.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `DELETE FROM chat_history WHERE user_id = ? AND contact_id = ? AND id IN (${placeholders})`
  ).bind(userId, contact, ...ids).run();

  // 使 KV 缓存失效，下次读取自动回源
  try {
    await env.CHAT_HISTORY.delete(`${CHAT_CACHE_PREFIX}${userId}_${contact}`);
  } catch (e) { console.warn('失效历史缓存失败:', e.message); }

  // 注意：不要重置自增序列（会导致新消息 id 回退、记忆提取的 maxId-lastId 失真）
  return json({ success: true, deleted: result.meta.changes || 0 });
}

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  try {
    const url = new URL(request.url);
    const contact = url.searchParams.get('contact') || 'kayoko';
    const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);

    const totalMessages = await countChatHistory(env, userId, contact);
    const totalPages = Math.max(1, Math.ceil(totalMessages / PAGE_SIZE));

    let messages;
    let fromCache = false;
    if (page === 1) {
      const loaded = await loadChatHistory(env, userId, contact);
      messages = loaded.messages;
      fromCache = loaded.fromCache;
    } else {
      messages = await loadChatHistoryPage(env, userId, contact, page, PAGE_SIZE);
    }

    return json({
      messages,
      currentPage: page,
      totalPages,
      totalMessages,
      hasMore: page < totalPages,
      fromCache,
    });
  } catch (err) {
    console.error('GET /api/ai/history 错误:', err);
    return json({ error: '服务器错误' }, 500);
  }
}
