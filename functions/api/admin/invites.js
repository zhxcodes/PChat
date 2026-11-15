// functions/api/admin/invites.js
// ============================================================
// 邀请码管理（管理端）
// ------------------------------------------------------------
// GET  /api/admin/invites?page=1&page_size=20
//   → { invites, total, page, page_size }
//   invites: { id, code, used_by, used_by_username, expires_at, created_at, expired }
// POST /api/admin/invites  { count: 1, expire_days: 7 }
//   → { success, count, invites: [{ code, expires_at }] }
//
// 权限：/api/admin/* 由中间件强制管理员，这里再用 requireAdminRole 防御一次。
// 审计：生成成功后写 admin_logs（action='invites.create'）。
// ============================================================

import {
  json,
  requireAdminRole,
  logAdminAction,
  getClientIp,
} from '../../_lib.js';

const PAGE_SIZE_MAX = 100;
const COUNT_MAX = 50;
const EXPIRE_DAYS_MAX = 3650;

// 去掉容易混淆的 I / O / 0 / 1，仍然是“大写字母 + 数字”
const CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateInviteCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let raw = '';
  for (let i = 0; i < 12; i++) {
    raw += CODE_CHARSET[bytes[i] % CODE_CHARSET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

export async function onRequestGet({ request, env, data }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  const url = new URL(request.url);
  const page = Math.min(Math.max(toInt(url.searchParams.get('page'), 1) || 1, 1), 100000);
  const pageSize = Math.min(
    Math.max(toInt(url.searchParams.get('page_size'), 20) || 20, 1),
    PAGE_SIZE_MAX
  );
  const offset = (page - 1) * pageSize;

  try {
    const totalRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM invite_codes').first();

    const rows = await env.DB.prepare(
      `SELECT i.rowid AS id,
              i.code,
              i.used_by,
              COALESCE(u.username, '') AS used_by_username,
              i.expires_at,
              i.created_at,
              CASE
                WHEN i.expires_at IS NULL THEN 0
                WHEN datetime(i.expires_at) IS NULL THEN 1
                WHEN datetime(i.expires_at) <= datetime('now') THEN 1
                ELSE 0
              END AS expired
         FROM invite_codes i
         LEFT JOIN users u ON u.id = i.used_by
        ORDER BY i.rowid DESC
        LIMIT ? OFFSET ?`
    ).bind(pageSize, offset).all();

    return json({
      invites: rows.results || [],
      total: totalRow ? totalRow.c : 0,
      page,
      page_size: pageSize,
    });
  } catch (err) {
    console.error('GET /api/admin/invites 错误:', err);
    return json({ error: '读取邀请码失败' }, 500);
  }
}

export async function onRequestPost({ request, env, data }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }

  const count = toInt(body && body.count, 1);
  const expireDays = toInt(body && body.expire_days, 7);
  if (!Number.isInteger(count) || count < 1 || count > COUNT_MAX) {
    return json({ error: `生成数量需为 1~${COUNT_MAX} 的整数` }, 400);
  }
  if (!Number.isInteger(expireDays) || expireDays < 1 || expireDays > EXPIRE_DAYS_MAX) {
    return json({ error: `有效天数需为 1~${EXPIRE_DAYS_MAX} 的整数` }, 400);
  }

  const expiresAt = new Date(Date.now() + expireDays * 24 * 60 * 60 * 1000).toISOString();
  const created = [];
  let attempts = 0;

  try {
    // 顺序插入 + 冲突重试：count 最多 50，冲突概率极低
    while (created.length < count && attempts < count * 5 + 10) {
      attempts += 1;
      const code = generateInviteCode();
      if (created.some((item) => item.code === code)) continue;
      const res = await env.DB.prepare(
        'INSERT OR IGNORE INTO invite_codes (code, created_by, expires_at) VALUES (?, ?, ?)'
      ).bind(code, data.userId, expiresAt).run();
      if (res && res.meta && res.meta.changes === 1) {
        created.push({ code, expires_at: expiresAt });
      }
    }

    if (created.length === 0) {
      return json({ error: '生成邀请码失败，请重试' }, 500);
    }

    await logAdminAction(env, {
      adminId: data.userId,
      action: 'invites.create',
      target: `count=${created.length},days=${expireDays}`,
      ip: getClientIp(request),
    });

    return json({ success: true, count: created.length, invites: created }, 201);
  } catch (err) {
    console.error('POST /api/admin/invites 错误:', err);
    return json({ error: '生成邀请码失败' }, 500);
  }
}
