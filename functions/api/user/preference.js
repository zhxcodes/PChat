// functions/api/user/preference.js
// GET /api/user/preference  -> 读取用户偏好（"关于我自己"文本）
// PUT /api/user/preference  -> 保存用户偏好 { preference }
// 存储：KV preference_{userId}（每用户一段，限 1000 字）
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, LIMITS } from '../../_lib.js';

const prefKey = (userId) => `preference_${userId}`;

export async function onRequestGet({ env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const preference = (await env.PROMPTS_KV.get(prefKey(userId))) || '';
  return json({ preference });
}

export async function onRequestPut({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const text = body.preference === undefined ? '' : String(body.preference);
  if (text.length > LIMITS.preference) {
    return json({ error: `用户偏好不能超过 ${LIMITS.preference} 字符` }, 400);
  }

  await env.PROMPTS_KV.put(prefKey(userId), text.slice(0, LIMITS.preference));
  return json({ success: true });
}
