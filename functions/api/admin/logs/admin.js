// functions/api/admin/logs/admin.js
// GET /api/admin/logs/admin?limit=100 —— 管理员操作日志（只读）
// 返回最新在前，附带操作者用户名（管理员被删除后仍保留日志，用户名回退为空）。
// 权限：/api/admin/* 由中间件强制要求管理员，这里再做一次防御性校验。

import { json, requireAdminRole } from '../../../_lib.js';

export async function onRequestGet({ request, env, data }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  const url = new URL(request.url);
  const raw = parseInt(url.searchParams.get('limit') || '100', 10);
  const limit = Math.min(Math.max(Number.isFinite(raw) ? raw : 100, 1), 200);

  try {
    const rows = await env.DB.prepare(
      `SELECT l.id, l.admin_id, COALESCE(u.username, '') AS admin_username,
              l.action, l.target, l.ip, l.created_at
         FROM admin_logs l
         LEFT JOIN users u ON u.id = l.admin_id
        ORDER BY l.id DESC
        LIMIT ?`
    ).bind(limit).all();
    return json({ logs: rows.results || [] });
  } catch (err) {
    console.error('GET /api/admin/logs/admin 错误:', err);
    return json({ error: '读取操作日志失败' }, 500);
  }
}
