// functions/api/admin/users/[id].js
// PUT /api/admin/users/:id  { status: 'active' | 'disabled' | 'banned' }
// 封禁 / 解封普通用户；封禁时立即删除该用户所有 session（强制下线）。
// 安全约束：
//  - 不能修改自己的状态；不能修改管理员账号；不能修改环境变量管理员（env.ADMIN_USERNAME）；
//  - 只允许操作 role = 'user' 的普通用户；
//  - 每次操作写 admin_logs 审计。
// 权限：/api/admin/* 由中间件强制要求管理员，这里再做一次防御性校验。

import {
  json,
  getClientIp,
  logAdminAction,
  requireAdminRole,
  USER_STATUSES,
} from '../../../_lib.js';

const MANAGEABLE_STATUSES = ['active', 'disabled', 'banned'];

export async function onRequestPut({ request, env, data, params }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  const adminId = data && data.userId;
  const targetId = parseInt(params && params.id, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return json({ error: '用户 id 不合法' }, 400);
  }
  if (targetId === adminId) {
    return json({ error: '不能修改自己的账号状态' }, 400);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const status = String((body && body.status) || '').trim();
  if (!MANAGEABLE_STATUSES.includes(status) || !USER_STATUSES.includes(status)) {
    return json({ error: '状态只能是 active / disabled / banned' }, 400);
  }

  const target = await env.DB.prepare(
    'SELECT id, username, role, status FROM users WHERE id = ?'
  ).bind(targetId).first();
  if (!target) return json({ error: '用户不存在' }, 404);

  // 只管理普通用户；管理员（含环境变量管理员）不允许在这里被停用
  if (target.role !== 'user') {
    return json({ error: '只能管理普通用户' }, 403);
  }
  const adminName = env.ADMIN_USERNAME ? String(env.ADMIN_USERNAME).trim().toLowerCase() : '';
  if (adminName && String(target.username).toLowerCase() === adminName) {
    return json({ error: '不能修改环境变量管理员账号' }, 403);
  }

  if (target.status === status) {
    return json({ success: true, unchanged: true, user: { id: target.id, username: target.username, status } });
  }

  try {
    await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, targetId).run();
    // 非 active 状态立即失效该用户全部会话（不必等 session 过期）
    if (status !== 'active') {
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId).run();
    }
  } catch (err) {
    console.error('PUT /api/admin/users/:id 更新失败:', err);
    return json({ error: '更新用户状态失败' }, 500);
  }

  const action = status === 'banned' ? 'user.ban' : (status === 'active' ? 'user.unban' : 'user.status');
  await logAdminAction(env, {
    adminId,
    action,
    target: `user:${targetId}`,
    ip: getClientIp(request),
  });

  return json({
    success: true,
    user: { id: target.id, username: target.username, role: target.role, status },
  });
}
