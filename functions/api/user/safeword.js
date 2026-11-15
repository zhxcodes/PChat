// functions/api/user/safeword.js
// GET /api/user/safeword  -> 读取安全词
// PUT /api/user/safeword  -> 保存安全词 { safeword }
// 存储：KV safeword_{userId}（限 200 字）
// 作用：用户消息中出现安全词时，立即中止角色扮演，要求以冷静中性语气回应。

import { json, getUserId, LIMITS } from '../../_lib.js';

const safeKey = (userId) => `safeword_${userId}`;

export async function onRequestGet({ env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const safeword = (await env.PROMPTS_KV.get(safeKey(userId))) || '';
  return json({ safeword });
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
  const text = body.safeword === undefined ? '' : String(body.safeword).trim();
  if (text.length > LIMITS.safeword) {
    return json({ error: `安全词不能超过 ${LIMITS.safeword} 字符` }, 400);
  }

  await env.PROMPTS_KV.put(safeKey(userId), text.slice(0, LIMITS.safeword));
  return json({ success: true });
}
