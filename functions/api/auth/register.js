// functions/api/auth/register.js
// ============================================================
// 注册（多用户安全架构 Phase 2）
// ------------------------------------------------------------
// - 总开关：app_settings.allow_register（默认关闭；管理端在 app_settings 表里打开）。
// - 邀请码：app_settings.invite_required（默认开启）时，校验 invite_codes：
//   存在、未被使用、未过期；创建账号后用条件 UPDATE 原子核销（一码一人），
//   并发抢码失败时回滚刚创建的账号。
// - 保留名：禁止注册 env.ADMIN_USERNAME（大小写不敏感），避免冒充环境变量管理员。
// - 角色固定为 'user'：注册永远不产生管理员，避免配置写错导致提权。
// - 密码 PBKDF2-SHA256 存储（与登录一致）；Turnstile 与登录同口径（配置了
//   TURNSTILE_SECRET 才校验）。
// 本接口为公开路径，已在 functions/api/_middleware.js 的 PUBLIC_PATHS 中放行。
// ============================================================

import {
  json,
  createPBKDF2Hash,
  getAppSettings,
  isSettingEnabled,
  verifyTurnstile,
  isTurnstileActive,
  getClientIp,
} from '../../_lib.js';

const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const INVITE_CODE_MAX = 128;

// 用户名：去首尾空白后 3~32 个字符，不允许空白与控制字符（允许中文）
function validateUsername(raw) {
  const username = String(raw === null || raw === undefined ? '' : raw).trim();
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return { error: `用户名长度需为 ${USERNAME_MIN}~${USERNAME_MAX} 个字符` };
  }
  if (/\s/.test(username)) return { error: '用户名不能包含空白字符' };
  if (/[\u0000-\u001f\u007f]/.test(username)) return { error: '用户名包含非法字符' };
  return { username };
}

// 密码：8~128 个字符（登录侧同样限制 128）
function validatePassword(raw) {
  const password = String(raw === null || raw === undefined ? '' : raw);
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { error: `密码长度需为 ${PASSWORD_MIN}~${PASSWORD_MAX} 个字符` };
  }
  return { password };
}

// 是否与环境变量管理员同名（大小写不敏感；env 未配置时不限制）
function isReservedUsername(env, username) {
  const admin = (env && env.ADMIN_USERNAME) ? String(env.ADMIN_USERNAME).trim() : '';
  return !!admin && username.toLowerCase() === admin.toLowerCase();
}

// 查询邀请码状态：expired 由 SQLite 统一按 UTC 计算，兼容
// 'YYYY-MM-DD HH:MM:SS' 与 ISO 'YYYY-MM-DDTHH:MM:SSZ' 两种存量格式；
// 无法解析的时间按「已过期」处理（fail closed）。
async function findInvite(env, code) {
  return env.DB.prepare(
    `SELECT code, used_by, expires_at,
            CASE
              WHEN expires_at IS NULL THEN 0
              WHEN datetime(expires_at) IS NULL THEN 1
              WHEN datetime(expires_at) <= datetime('now') THEN 1
              ELSE 0
            END AS expired
     FROM invite_codes
     WHERE code = ?`
  ).bind(code).first();
}

// 原子核销：只有「未使用且未过期」时才会更新成功（返回 true）
async function consumeInvite(env, code, userId) {
  const res = await env.DB.prepare(
    `UPDATE invite_codes
     SET used_by = ?
     WHERE code = ?
       AND used_by IS NULL
       AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`
  ).bind(userId, code).run();
  return !!(res && res.meta && res.meta.changes === 1);
}

export async function onRequestPost({ request, env }) {
  try {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: '请求体不是有效的 JSON' }, 400);
    }
    if (!body || typeof body !== 'object') {
      return json({ error: '请求体格式不正确' }, 400);
    }

    // ---------- 1. 注册总开关（读取失败时 getAppSettings 回退默认值 = 关闭） ----------
    const settings = await getAppSettings(env);
    if (!isSettingEnabled(settings, 'allow_register')) {
      return json({ error: '注册功能未开放' }, 403);
    }

    // ---------- 2. 入参校验 ----------
    const nameCheck = validateUsername(body.username);
    if (nameCheck.error) return json({ error: nameCheck.error }, 400);
    const username = nameCheck.username;

    const pwdCheck = validatePassword(body.password);
    if (pwdCheck.error) return json({ error: pwdCheck.error }, 400);
    const password = pwdCheck.password;

    if (isReservedUsername(env, username)) {
      return json({ error: '该用户名不可用' }, 403);
    }

    // Turnstile：与登录同口径（两把密钥都配置 + 运行级开关打开才校验）
    if (await isTurnstileActive(env, settings)) {
      const token = typeof body.turnstile_token === 'string' ? body.turnstile_token : '';
      const tv = await verifyTurnstile(env, token, getClientIp(request));
      if (!tv.ok) return json({ error: tv.error || '人机验证失败' }, 403);
    }

    // ---------- 3. 邀请码校验（先查一次，给出明确错误；核销在建号后原子完成） ----------
    const inviteRequired = isSettingEnabled(settings, 'invite_required');
    let inviteCode = '';
    if (inviteRequired) {
      const rawCode = body.invite_code !== undefined ? body.invite_code : body.invite;
      inviteCode = String(rawCode === null || rawCode === undefined ? '' : rawCode).trim();
      if (!inviteCode) return json({ error: '需要邀请码' }, 400);
      if (inviteCode.length > INVITE_CODE_MAX) return json({ error: '邀请码无效' }, 400);

      const invite = await findInvite(env, inviteCode);
      if (!invite) return json({ error: '邀请码无效' }, 400);
      if (invite.used_by) return json({ error: '邀请码已被使用' }, 400);
      if (invite.expired) return json({ error: '邀请码已过期' }, 400);
    }

    // ---------- 4. 用户名占用检查 ----------
    const dup = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
    if (dup) return json({ error: '用户名已被占用' }, 409);

    // ---------- 5. 建号（角色固定 user，状态 active） ----------
    const passwordHash = await createPBKDF2Hash(password);
    let createdId = null;
    try {
      const ins = await env.DB.prepare(
        "INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, 'user', 'active')"
      ).bind(username, passwordHash).run();
      createdId = ins && ins.meta ? ins.meta.last_row_id : null;
    } catch (e) {
      // 并发注册同名账号时由 UNIQUE 约束兜底
      if (/UNIQUE|constraint/i.test(String(e && e.message))) {
        return json({ error: '用户名已被占用' }, 409);
      }
      throw e;
    }
    if (!createdId) throw new Error('创建用户失败：未返回 users.id');

    // ---------- 6. 核销邀请码（失败则回滚账号，保证一码一人） ----------
    if (inviteRequired) {
      const consumed = await consumeInvite(env, inviteCode, createdId);
      if (!consumed) {
        try {
          await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(createdId).run();
        } catch (e) {
          console.error('回滚注册账号失败，需人工清理 users.id =', createdId, e.message);
        }
        return json({ error: '邀请码已被使用' }, 400);
      }
    }

    return json({
      success: true,
      user: { id: createdId, username, role: 'user' },
    }, 201);
  } catch (err) {
    console.error('注册错误:', err);
    return json({ error: '服务器错误，请稍后重试' }, 500);
  }
}
