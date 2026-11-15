// functions/api/ai/search.js
// GET /api/ai/search?contact=xxx&q=关键词&page=1  -> 搜索聊天记录（第 20 项）
// SQL LIKE 匹配（对 % _ \ 做转义，使用 ESCAPE），按 id 倒序分页返回。
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, LIMITS, requireFeature } from '../../_lib.js';

const PAGE_SIZE = 30;
const MAX_KEYWORD = 100;

// 转义 LIKE 通配符，避免用户输入 % _ 造成全表匹配
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'search_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const contact = (url.searchParams.get('contact') || '').slice(0, LIMITS.contact);
  const q = (url.searchParams.get('q') || '').trim().slice(0, MAX_KEYWORD);
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);

  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  if (!q) return json({ results: [], hasMore: false });

  const pattern = `%${escapeLike(q)}%`;
  const offset = (page - 1) * PAGE_SIZE;

  const rows = await env.DB.prepare(
    `SELECT id, role, content, kind, created_at
     FROM chat_history
     WHERE user_id = ? AND contact_id = ?
       AND content LIKE ? ESCAPE '\\'
       AND (kind IS NULL OR kind != 'director')
     ORDER BY id DESC
     LIMIT ? OFFSET ?`
  ).bind(userId, contact, pattern, PAGE_SIZE + 1, offset).all();

  const all = rows.results || [];
  const hasMore = all.length > PAGE_SIZE;
  const results = all.slice(0, PAGE_SIZE);

  return json({ results, hasMore, page, q });
}
