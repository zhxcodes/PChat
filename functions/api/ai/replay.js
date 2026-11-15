// functions/api/ai/replay.js
// ============================================================
// 0.13.0 新增：时光机数据接口
// ------------------------------------------------------------
// GET /api/ai/replay?contact=kayoko
//   → { contact, days: [{ day: '2026-10-24', count: 12 }, …] }
//     最近 365 天里「有消息的日子」（倒序，最多返回 60 天），用于日期选择
//
// GET /api/ai/replay?contact=kayoko&date=2026-10-24
//   → { contact, day, count, messages: [{ id, role, content, created_at }] }
//     那一天的全部消息（按时间正序，最多 500 条）
//
// 时区：与 /api/stats、/api/insights 一致，按 Asia/Shanghai（UTC+8）切天。
// 只读接口，不改缓存、不写库；认证由 /api/_middleware.js 统一处理。
// ============================================================

import { json, getUserId, LIMITS, requireFeature } from '../../_lib.js';

const DAY_EXPR = "date(datetime(created_at, '+8 hours'))";
const NOT_DIRECTOR = "(kind IS NULL OR kind != 'director')";
const MAX_DAYS = 60;
const MAX_DAY_MESSAGES = 500;

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'replay_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const contact = (url.searchParams.get('contact') || '').slice(0, LIMITS.contact);
  const date = (url.searchParams.get('date') || '').trim();
  if (!contact) return json({ error: '缺少 contact 参数' }, 400);

  try {
    // ---- 不带 date：返回可选日期列表 ----
    if (!date) {
      const rows = await env.DB.prepare(
        `SELECT ${DAY_EXPR} AS day, COUNT(*) AS count
         FROM chat_history
         WHERE user_id = ? AND contact_id = ? AND ${NOT_DIRECTOR}
           AND datetime(created_at) >= datetime('now', '-365 days')
         GROUP BY day
         ORDER BY day DESC
         LIMIT ?`
      ).bind(userId, contact, MAX_DAYS).all();

      return json({
        contact,
        days: (rows.results || []).map((r) => ({
          day: String(r.day),
          count: Number(r.count) || 0,
        })),
      });
    }

    // ---- 带 date：返回当天消息 ----
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return json({ error: 'date 格式应为 YYYY-MM-DD' }, 400);
    }

    const rows = await env.DB.prepare(
      `SELECT id, role, content, created_at
       FROM chat_history
       WHERE user_id = ? AND contact_id = ? AND ${NOT_DIRECTOR}
         AND ${DAY_EXPR} = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    ).bind(userId, contact, date, MAX_DAY_MESSAGES).all();

    const messages = (rows.results || []).map((m) => ({
      id: m.id,
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
      created_at: m.created_at,
    }));

    return json({ contact, day: date, count: messages.length, messages });
  } catch (err) {
    console.error('GET /api/ai/replay 错误:', err);
    return json({ error: '回放数据读取失败' }, 500);
  }
}
