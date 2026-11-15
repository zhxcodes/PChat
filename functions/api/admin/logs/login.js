// functions/api/admin/logs/login.js
// GET /api/admin/logs/login?days=7&limit=200 —— 登录日志（带保留天数）
// PUT /api/admin/logs/login { retention_days } —— 修改保留天数，并立即清理超期记录
// 权限：/api/admin/* 由中间件强制要求管理员，这里再做一次防御性校验。

import {
  json,
  getClientIp,
  getAppSettings,
  setAppSetting,
  logAdminAction,
  requireAdminRole,
} from '../../../_lib.js';

const RETENTION_MIN = 1;
const RETENTION_MAX = 3650;

function normalizeRetention(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < RETENTION_MIN || n > RETENTION_MAX) return null;
  return Math.floor(n);
}

export async function onRequestGet({ request, env, data }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  const url = new URL(request.url);
  const rawDays = parseInt(url.searchParams.get('days') || '7', 10);
  const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 7, 1), 365);
  const rawLimit = parseInt(url.searchParams.get('limit') || '200', 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 200, 1), 500);

  const settings = await getAppSettings(env);
  const retention = normalizeRetention(settings.login_log_retention_days) || 30;

  try {
    const rows = await env.DB.prepare(
      `SELECT l.id, l.user_id, COALESCE(u.username, '') AS username,
              l.ip, l.user_agent, l.status, l.reason, l.created_at
         FROM login_logs l
         LEFT JOIN users u ON u.id = l.user_id
        WHERE datetime(l.created_at) >= datetime('now', ?)
        ORDER BY l.id DESC
        LIMIT ?`
    ).bind(`-${days} days`, limit).all();

    return json({ logs: rows.results || [], days, retention_days: retention });
  } catch (err) {
    console.error('GET /api/admin/logs/login 错误:', err);
    return json({ error: '读取登录日志失败' }, 500);
  }
}

export async function onRequestPut({ request, env, data }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  const retention = normalizeRetention(body && body.retention_days);
  if (!retention) {
    return json({ error: `保留天数需为 ${RETENTION_MIN}~${RETENTION_MAX} 的整数` }, 400);
  }

  try {
    await setAppSetting(env, 'login_log_retention_days', String(retention));
    const res = await env.DB.prepare(
      "DELETE FROM login_logs WHERE datetime(created_at) < datetime('now', ?)"
    ).bind(`-${retention} days`).run();
    const deleted = (res && res.meta && res.meta.changes) || 0;

    await logAdminAction(env, {
      adminId: data && data.userId,
      action: 'login_logs.retention',
      target: `${retention}d`,
      ip: getClientIp(request),
    });

    return json({ success: true, retention_days: retention, deleted });
  } catch (err) {
    console.error('PUT /api/admin/logs/login 错误:', err);
    return json({ error: '更新登录日志保留天数失败' }, 500);
  }
}
