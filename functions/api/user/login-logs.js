// functions/api/user/login-logs.js
// GET /api/user/login-logs?limit=20 —— 查看自己的登录日志（时间 / 结果 / IP）
// 认证由 /api/_middleware.js 统一处理（data.userId）；只返回当前用户自己的记录。
// 表未迁移/查询失败时返回空数组，不影响设置面板其他功能。

import { json, getUserId } from '../../_lib.js';

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const url = new URL(request.url);
  const raw = parseInt(url.searchParams.get('limit') || '20', 10);
  const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 20, 1), 50);

  try {
    const rows = await env.DB.prepare(
      `SELECT status, reason, ip, created_at
         FROM login_logs
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT ?`
    ).bind(userId, limit).all();
    return json({ logs: rows.results || [] });
  } catch (e) {
    console.warn('读取登录日志失败（忽略）:', e.message);
    return json({ logs: [] });
  }
}
