// functions/api/admin/users/index.js
// GET /api/admin/users?q=&page=1&page_size=20 —— 用户列表（含今日 / 累计 token）
// 权限：/api/admin/* 由中间件强制要求管理员，这里再做一次防御性校验。

import { json, chinaDateKey, requireAdminRole } from '../../../_lib.js';

const PAGE_SIZE_MAX = 100;

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

export async function onRequestGet({ request, env, data }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 50);
  const page = Math.min(Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1), 10000);
  const pageSize = Math.min(Math.max(parseInt(url.searchParams.get('page_size') || '20', 10) || 20, 1), PAGE_SIZE_MAX);
  const offset = (page - 1) * pageSize;
  const today = chinaDateKey();

  const where = q ? "WHERE u.username LIKE ? ESCAPE '\\'" : '';
  const whereArgs = q ? [`%${escapeLike(q)}%`] : [];

  try {
    const totalRow = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM users u ${where}`
    ).bind(...whereArgs).first();

    const rows = await env.DB.prepare(
      `SELECT u.id, u.username, u.avatar, u.role, u.status, u.created_at,
              COALESCE((SELECT tokens_used FROM user_usage WHERE user_id = u.id AND date = ?), 0) AS today_tokens,
              COALESCE((SELECT SUM(tokens_used) FROM user_usage WHERE user_id = u.id), 0) AS total_tokens
         FROM users u
         ${where}
        ORDER BY u.id ASC
        LIMIT ? OFFSET ?`
    ).bind(today, ...whereArgs, pageSize, offset).all();

    return json({
      users: rows.results || [],
      total: totalRow ? totalRow.c : 0,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    console.error('GET /api/admin/users 错误:', err);
    return json({ error: '读取用户列表失败' }, 500);
  }
}
