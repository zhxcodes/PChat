// functions/api/auth/profile.js
// PUT /api/auth/profile  { current_password, username?, password?, avatar? }
// 修改当前用户的名称 / 密码 / 头像（头像支持 images/xxx.png 等路径）。
// 认证由 /api/_middleware.js 统一处理（data.userId）。

import { json, getUserId, createPBKDF2Hash, verifyPassword, LIMITS } from '../../_lib.js';

export async function onRequestPut({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }

  const { current_password, username, password, avatar } = body;

  // 任何修改都需要验证当前密码
  if (!current_password || String(current_password).length > 128) {
    return json({ error: '请输入当前密码' }, 400);
  }

  const user = await env.DB.prepare(
    'SELECT id, username, password_hash, avatar FROM users WHERE id = ?'
  ).bind(userId).first();
  if (!user) return json({ error: '用户不存在' }, 401);

  const { valid } = await verifyPassword(String(current_password), user.password_hash);
  if (!valid) return json({ error: '当前密码错误' }, 401);

  const updates = [];
  const values = [];

  if (username !== undefined && username !== user.username) {
    const name = String(username).trim();
    if (!name || name.length > LIMITS.display_name) {
      return json({ error: '用户名不合法' }, 400);
    }
    const dup = await env.DB.prepare(
      'SELECT id FROM users WHERE username = ? AND id != ?'
    ).bind(name, userId).first();
    if (dup) return json({ error: '用户名已被占用' }, 400);
    updates.push('username = ?');
    values.push(name);
  }

  if (password !== undefined && String(password).length > 0) {
    const pwd = String(password);
    if (pwd.length < 6 || pwd.length > 128) {
      return json({ error: '新密码长度需在 6~128 之间' }, 400);
    }
    updates.push('password_hash = ?');
    values.push(await createPBKDF2Hash(pwd));
  }

  if (avatar !== undefined) {
    const av = String(avatar).trim();
    if (av.length > LIMITS.avatar) {
      return json({ error: '头像路径过长' }, 400);
    }
    updates.push('avatar = ?');
    values.push(av || null);
  }

  if (updates.length === 0) {
    return json({ error: '没有要修改的字段' }, 400);
  }

  values.push(userId);
  await env.DB.prepare(
    `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...values).run();

  const updated = await env.DB.prepare(
    'SELECT id, username, avatar FROM users WHERE id = ?'
  ).bind(userId).first();

  return json({ success: true, user: updated });
}
