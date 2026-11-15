// functions/api/role/[id]/prompt.js
// GET /api/role/:id/prompt   -> 读取角色提示词（KV）
// PUT /api/role/:id/prompt   -> 更新角色提示词（KV）
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, LIMITS } from '../../../_lib.js';

export async function onRequestGet({ env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const { id } = params;
  const prompt = (await env.PROMPTS_KV.get(`prompt_${id}`)) || '';
  return json({ prompt });
}

export async function onRequestPut({ request, env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const { id } = params;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const prompt = body.prompt === undefined ? '' : String(body.prompt);
  if (prompt.length > LIMITS.prompt) {
    return json({ error: `提示词长度不能超过 ${LIMITS.prompt} 字符` }, 400);
  }

  await env.PROMPTS_KV.put(`prompt_${id}`, prompt);
  return json({ success: true });
}
