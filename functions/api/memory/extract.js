// functions/api/memory/extract.js
// POST /api/memory/extract?contact=xxx  -> 强制提炼一次记忆（第 16 项）
// 无视 memory_window，把上次提取位置到最新消息之间的剩余对话按窗口全部提炼；
// 受 _lib 的 MEMORY_EXTRACT_MAX_BATCH 上限保护；KV 频率限制：每用户每 5 分钟最多 1 次。
// 注意：本文件为静态路由，优先于同目录的 [id].js（否则 extract 会被当作记忆 id）。

import { json, getUserId, LIMITS, forceExtractMemory, requireFeatures } from '../../_lib.js';

const EXTRACT_COOLDOWN_MS = 5 * 60 * 1000;

export async function onRequestPost({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  // 记忆总开关关闭时，提炼也一并停用；memory_extract_enabled 可单独关闭提炼
  const denied = await requireFeatures(env, ['memory_enabled', 'memory_extract_enabled']);
  if (denied) return denied;

  const url = new URL(request.url);
  const contact = (url.searchParams.get('contact') || '').slice(0, LIMITS.contact);
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);

  // 频率限制（KV 近似计数；KV 异常时放行）
  const rlKey = `rl_extract_${userId}`;
  try {
    const raw = await env.PROMPTS_KV.get(rlKey);
    if (raw) {
      const last = Number(raw) || 0;
      const wait = EXTRACT_COOLDOWN_MS - (Date.now() - last);
      if (wait > 0) {
        return json({ error: `操作过于频繁，请 ${Math.ceil(wait / 1000)} 秒后再试` }, 429);
      }
    }
    await env.PROMPTS_KV.put(rlKey, String(Date.now()), {
      expirationTtl: Math.ceil(EXTRACT_COOLDOWN_MS / 1000),
    });
  } catch (e) {
    console.warn('记忆提炼频率限制检查失败（放行）:', e.message);
  }

  const extracted = await forceExtractMemory(env, userId, contact);
  return json({ success: true, extracted });
}
