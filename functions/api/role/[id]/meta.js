// functions/api/role/[id]/meta.js
// GET /api/role/:id/meta   -> 读取角色元数据（KV）
// PUT /api/role/:id/meta   -> 更新角色元数据（KV）
// 认证由 /api/_middleware.js 统一处理（data.userId）
// 注意：KV key 必须带 userId（meta_${userId}_${id}），否则不同用户的同名 contact_id 会互相覆盖。

import { json, getUserId, LIMITS } from '../../../_lib.js';

export async function onRequestGet({ env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const { id } = params;
  const raw = await env.PROMPTS_KV.get(`meta_${userId}_${id}`);
  let parsed = {};
  if (raw) {
    try { parsed = JSON.parse(raw); } catch (e) { parsed = {}; }
  }
  return json(parsed);
}

export async function onRequestPut({ request, env, data, params }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const { id } = params;
  const kvKey = `meta_${userId}_${id}`;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const { name, avatar, greeting, format, scene, appearance } = body;

  for (const [field, value] of Object.entries({ name, avatar, greeting, format, scene, appearance })) {
    if (value !== undefined && String(value).length > LIMITS[field]) {
      return json({ error: `${field} 长度不能超过 ${LIMITS[field]} 字符` }, 400);
    }
  }

  // 读取现有 meta 并合并
  const existing = await env.PROMPTS_KV.get(kvKey);
  let meta = {};
  if (existing) {
    try { meta = JSON.parse(existing); } catch (e) { meta = {}; }
  }
  if (name !== undefined) meta.name = String(name).slice(0, LIMITS.name);
  if (avatar !== undefined) meta.avatar = String(avatar).slice(0, LIMITS.avatar);
  if (greeting !== undefined) meta.greeting = String(greeting).slice(0, LIMITS.greeting);
  if (format !== undefined) meta.format = String(format).slice(0, LIMITS.format);
  if (scene !== undefined) meta.scene = String(scene).slice(0, LIMITS.scene);
  if (appearance !== undefined) meta.appearance = String(appearance).slice(0, LIMITS.appearance);

  await env.PROMPTS_KV.put(kvKey, JSON.stringify(meta));

  return json({ success: true, meta });
}
