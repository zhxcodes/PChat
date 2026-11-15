// functions/api/stats/index.js
// GET /api/stats?days=30  -> 管理后台统计面板数据（第 30、31 项）
// 数据源：全部来自 D1 聚合查询（Analytics Engine 数据在 Function 内无法读回，见第 8 项）。
// 时区：统一按 Asia/Shanghai（UTC+8）聚合，避免 UTC 造成"活跃时段"错位。
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, requireFeature } from '../../_lib.js';

const ALLOWED_DAYS = [7, 30, 90];

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'stats_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const days = ALLOWED_DAYS.includes(Number(url.searchParams.get('days')))
    ? Number(url.searchParams.get('days'))
    : 30;

  try {
    // 1. 总量：消息数 / 对话天数（排除导演词行）
    const totals = await env.DB.prepare(
      `SELECT COUNT(*) AS total_messages,
              COUNT(DISTINCT date(datetime(created_at, '+8 hours'))) AS total_days
       FROM chat_history
       WHERE user_id = ? AND (kind IS NULL OR kind != 'director')`
    ).bind(userId).first();

    // 2. 每个联系人的消息数量对比（关联 contacts 取显示名）
    const perContact = await env.DB.prepare(
      `SELECT h.contact_id,
              COALESCE(c.display_name, h.contact_id) AS display_name,
              COUNT(*) AS count
       FROM chat_history h
       LEFT JOIN contacts c ON c.user_id = h.user_id AND c.contact_id = h.contact_id
       WHERE h.user_id = ? AND (h.kind IS NULL OR h.kind != 'director')
       GROUP BY h.contact_id
       ORDER BY count DESC
       LIMIT 30`
    ).bind(userId).all();

    // 3. 活跃时间段热力图（按 UTC+8 的小时聚合）
    const hourly = await env.DB.prepare(
      `SELECT CAST(strftime('%H', datetime(created_at, '+8 hours')) AS INTEGER) AS hour,
              COUNT(*) AS count
       FROM chat_history
       WHERE user_id = ? AND (kind IS NULL OR kind != 'director')
       GROUP BY hour
       ORDER BY hour ASC`
    ).bind(userId).all();

    // 4. 情绪分布（全部记忆）
    const emotionDist = await env.DB.prepare(
      `SELECT emotion, COUNT(*) AS count
       FROM memories
       WHERE user_id = ? AND emotion IS NOT NULL
       GROUP BY emotion
       ORDER BY count DESC`
    ).bind(userId).all();

    // 5. 情绪趋势（近 N 天，按天 + 情绪聚合）
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const emotionTrend = await env.DB.prepare(
      `SELECT date(datetime(created_at, '+8 hours')) AS day,
              emotion,
              COUNT(*) AS count
       FROM memories
       WHERE user_id = ? AND emotion IS NOT NULL AND datetime(created_at) >= datetime(?)
       GROUP BY day, emotion
       ORDER BY day ASC`
    ).bind(userId, since).all();

    // 6. 近 N 天每日消息量（趋势）
    const daily = await env.DB.prepare(
      `SELECT date(datetime(created_at, '+8 hours')) AS day,
              COUNT(*) AS count
       FROM chat_history
       WHERE user_id = ? AND (kind IS NULL OR kind != 'director') AND datetime(created_at) >= datetime(?)
       GROUP BY day
       ORDER BY day ASC`
    ).bind(userId, since).all();

    return json({
      days,
      totals: {
        total_messages: totals?.total_messages || 0,
        total_days: totals?.total_days || 0,
      },
      perContact: perContact.results || [],
      hourly: hourly.results || [],
      emotionDistribution: emotionDist.results || [],
      emotionTrend: emotionTrend.results || [],
      daily: daily.results || [],
    });
  } catch (err) {
    console.error('GET /api/stats 错误:', err);
    return json({ error: '统计查询失败' }, 500);
  }
}
