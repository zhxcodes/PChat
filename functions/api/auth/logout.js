// functions/api/auth/logout.js
// 退出登录：删除与当前 token 对应的会话。公开路径（幂等，无副作用风险）。
import { json } from '../../_lib.js';

export async function onRequestPost({ request, env }) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  }
  return json({ success: true });
}
