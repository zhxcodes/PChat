// functions/api/admin/usage.js
// GET /api/admin/usage?days=30 —— 用户用量统计（来自 user_usage，按 Asia/Shanghai 切天）
// 返回：区间总量 / 今日总量 / 每用户汇总 / 每日汇总。
// 权限：/api/admin/* 由中间件强制要求管理员，这里再做一次防御性校验。

import { json, chinaDateKey, requireAdminRole } from '../../_lib.js';

export async function onRequestGet({ request, env, data }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  const url = new URL(request.url);
  const rawDays = parseInt(url.searchParams.get('days') || '30', 10);
  const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 30, 1), 365);
  const today = chinaDateKey();
  const since = chinaDateKey(new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000));

  try {
    const totals = await env.DB.prepare(
      `SELECT COALESCE(SUM(tokens_used), 0) AS tokens,
              COUNT(DISTINCT user_id) AS users
         FROM user_usage
        WHERE date >= ?`
    ).bind(since).first();

    const todayTotals = await env.DB.prepare(
      `SELECT COALESCE(SUM(tokens_used), 0) AS tokens,
              COUNT(DISTINCT user_id) AS users
         FROM user_usage
        WHERE date = ?`
    ).bind(today).first();

    const dailyRows = await env.DB.prepare(
      `SELECT date, SUM(tokens_used) AS tokens
         FROM user_usage
        WHERE date >= ?
        GROUP BY date
        ORDER BY date ASC`
    ).bind(since).all();

    const perUser = await env.DB.prepare(
      `SELECT u.id, u.username, u.role, u.status,
              COALESCE(SUM(x.tokens_used), 0) AS tokens_used,
              MAX(x.date) AS last_date
         FROM users u
         LEFT JOIN user_usage x ON x.user_id = u.id AND x.date >= ?
        GROUP BY u.id
        HAVING tokens_used > 0
        ORDER BY tokens_used DESC
        LIMIT 100`
    ).bind(since).all();

    return json({
      days,
      since,
      today,
      totals: {
        tokens: (totals && totals.tokens) || 0,
        users: (totals && totals.users) || 0,
      },
      today_totals: {
        tokens: (todayTotals && todayTotals.tokens) || 0,
        users: (todayTotals && todayTotals.users) || 0,
      },
      per_user: (perUser.results || []).map((row) => ({
        id: row.id,
        username: row.username,
        role: row.role,
        status: row.status,
        tokens_used: Number(row.tokens_used) || 0,
        last_date: row.last_date || null,
      })),
      daily: (dailyRows.results || []).map((row) => ({
        date: row.date,
        tokens: Number(row.tokens) || 0,
      })),
    });
  } catch (err) {
    console.error('GET /api/admin/usage 错误:', err);
    return json({ error: '读取用量统计失败' }, 500);
  }
}
