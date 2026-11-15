// functions/api/contacts/[id]/config.js
// PUT /api/contacts/:id/config -> 更新联系人的 AI 参数（temperature/top_p/max_tokens/frequency_penalty/presence_penalty/memory_window）
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, clamp, getUserId, MEMORY_WINDOW_MIN, MEMORY_WINDOW_MAX, MEMORY_WINDOW_DEFAULT, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_DEFAULT } from '../../../_lib.js';

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
  const { temperature, top_p, max_tokens, frequency_penalty, presence_penalty, memory_window, context_window } = body;

  const temperatureVal = clamp(temperature, 0, 2, 0.7);
  const topPVal = clamp(top_p, 0, 1, 0.9);
  const maxTokensVal = Math.round(clamp(max_tokens, 256, 8192, 2048));
  const freqPenaltyVal = clamp(frequency_penalty, -2, 2, 0);
  const presPenaltyVal = clamp(presence_penalty, -2, 2, 0);
  const memWindowVal = Math.round(clamp(memory_window, MEMORY_WINDOW_MIN, MEMORY_WINDOW_MAX, MEMORY_WINDOW_DEFAULT));
  const ctxWindowVal = Math.round(clamp(context_window, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_DEFAULT));

  await env.DB.prepare(
    `UPDATE contacts
     SET temperature = ?, top_p = ?, max_tokens = ?, frequency_penalty = ?, presence_penalty = ?, memory_window = ?, context_window = ?
     WHERE id = ? AND user_id = ?`
  ).bind(temperatureVal, topPVal, maxTokensVal, freqPenaltyVal, presPenaltyVal, memWindowVal, ctxWindowVal, id, userId).run();

  const updated = await env.DB.prepare(
    `SELECT id, contact_type, contact_id, display_name, avatar,
            temperature, top_p, max_tokens, frequency_penalty, presence_penalty, memory_window, context_window
     FROM contacts
     WHERE id = ? AND user_id = ?`
  ).bind(id, userId).first();

  return json(updated);
}
