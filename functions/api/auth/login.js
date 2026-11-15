// functions/api/auth/login.js
// ============================================================
// 登录（多用户安全架构 Phase 2）
// ------------------------------------------------------------
// - 环境变量管理员：username === env.ADMIN_USERNAME 时只认 env.ADMIN_PASSWORD
//   （明文比对，恒定时间实现，不走密码哈希）；首次登录自动建号：
//   password_hash = 'ENV_ADMIN_PROTECTED'、role = 'admin'。
//   同名的存量账号会被认领为管理员，并把密码哈希替换为占位值（旧密码立即失效）。
// - 普通用户：PBKDF2-SHA256 校验（旧无盐 SHA-256 登录后自动升级）；
//   命中 'ENV_ADMIN_PROTECTED' 占位账号一律拒绝，账号 status != 'active' 拒绝。
// - 暴力破解防护：同一 IP 15 分钟内最多 10 次（KV 近似计数，KV 异常时放行，避免锁死）。
// - 登录审计：成功 / 失败 / 拦截写入 login_logs（表缺失或写入失败时静默降级）。
// ============================================================

import {
  json,
  createPBKDF2Hash,
  verifyPassword,
  verifyTurnstile,
  writeEvent,
  getClientIp,
  logLoginAttempt,
  constantTimeEqual,
  ENV_ADMIN_PROTECTED_HASH,
} from '../../_lib.js';

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 分钟
const RATE_LIMIT_MAX = 10;                   // 最大尝试次数
const PASSWORD_MAX = 128;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 会话 7 天

// 登录频率限制（基于 KV 的近似计数；KV 异常时放行，避免锁死用户）
async function getLoginRateRecord(env, request) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = `rl_login_${ip}`;
    const now = Date.now();
    const raw = await env.PROMPTS_KV.get(key, { type: 'json' });
    let rec = (raw && typeof raw.count === 'number') ? raw : { count: 0, first: now };
    if (now - rec.first > RATE_LIMIT_WINDOW_MS) {
      rec = { count: 0, first: now };
    }
    return { key, rec, now };
  } catch (e) {
    return null;
  }
}

async function recordLoginFailure(env, rate) {
  if (!rate) return;
  try {
    rate.rec.count += 1;
    await env.PROMPTS_KV.put(rate.key, JSON.stringify(rate.rec), {
      expirationTtl: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
  } catch (e) { /* 忽略 */ }
}

async function clearLoginRate(env, rate) {
  if (!rate) return;
  try { await env.PROMPTS_KV.delete(rate.key); } catch (e) { /* 忽略 */ }
}

// 登录审计（旁路能力，失败不影响登录）
async function logLogin(env, request, entry) {
  await logLoginAttempt(env, {
    userId: entry && entry.userId,
    status: entry && entry.status,
    reason: entry && entry.reason,
    ip: getClientIp(request),
    userAgent: request.headers.get('User-Agent') || '',
  });
}

// 环境变量管理员用户名（去首尾空白；未配置时为空串）
function envAdminUsername(env) {
  return (env && env.ADMIN_USERNAME) ? String(env.ADMIN_USERNAME).trim() : '';
}

// 环境变量管理员是否已完整配置（用户名或密码缺一不可）
function envAdminConfigured(env) {
  return !!envAdminUsername(env) && !!(env && env.ADMIN_PASSWORD);
}

// 确保环境变量管理员在 users 表中有对应账号（role = admin、状态正常、密码哈希为占位值）。
// 已存在同名账号时直接认领：覆盖 role/status/password_hash，使该账号只能用环境变量密码登录。
async function ensureEnvAdminUser(env, username) {
  const selectSql = 'SELECT id, username, avatar, role, status, password_hash FROM users WHERE username = ?';
  const existing = await env.DB.prepare(selectSql).bind(username).first();

  if (existing) {
    if (existing.role !== 'admin'
      || existing.status !== 'active'
      || existing.password_hash !== ENV_ADMIN_PROTECTED_HASH) {
      await env.DB.prepare(
        "UPDATE users SET role = 'admin', status = 'active', password_hash = ? WHERE id = ?"
      ).bind(ENV_ADMIN_PROTECTED_HASH, existing.id).run();
    }
    return {
      id: existing.id,
      username: existing.username,
      avatar: existing.avatar,
      role: 'admin',
      status: 'active',
    };
  }

  try {
    const ins = await env.DB.prepare(
      "INSERT INTO users (username, password_hash, role, status) VALUES (?, ?, 'admin', 'active')"
    ).bind(username, ENV_ADMIN_PROTECTED_HASH).run();
    return {
      id: ins && ins.meta ? ins.meta.last_row_id : null,
      username,
      avatar: null,
      role: 'admin',
      status: 'active',
    };
  } catch (e) {
    // 并发首登：另一个请求已经插入成功 → 重新读取
    const row = await env.DB.prepare(selectSql).bind(username).first();
    if (row) return row;
    throw e;
  }
}

// 生成新会话（沿用原逻辑：同一用户只保留一个有效 token）
async function createSession(env, userId) {
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    .toISOString().replace('T', ' ').slice(0, 19);
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, userId, expiresAt).run();
  return token;
}

export async function onRequestPost({ request, env }) {
  try {
    const rate = await getLoginRateRecord(env, request);
    if (rate && rate.rec.count >= RATE_LIMIT_MAX) {
      return json({ error: '尝试过于频繁，请 15 分钟后再试' }, 429);
    }

    let username, password, turnstileToken;
    try {
      const body = await request.json();
      username = body.username;
      password = body.password;
      turnstileToken = typeof body.turnstile_token === 'string' ? body.turnstile_token : '';
    } catch (e) {
      return json({ error: '请求体不是有效的 JSON' }, 400);
    }

    if (!username || !password) {
      return json({ error: '请输入用户名和密码' }, 400);
    }
    if (String(username).length > 100 || String(password).length > PASSWORD_MAX) {
      return json({ error: '用户名或密码格式不正确' }, 400);
    }

    // Turnstile 人机验证（第 9 项）：未配置 TURNSTILE_SECRET 时自动跳过
    if (env.TURNSTILE_SECRET) {
      const tv = await verifyTurnstile(env, turnstileToken, getClientIp(request));
      if (!tv.ok) return json({ error: tv.error || '人机验证失败' }, 403);
    }

    // ---------- 环境变量管理员：只认 ADMIN_PASSWORD，不查哈希 ----------
    const adminUsername = envAdminUsername(env);
    if (envAdminConfigured(env) && String(username) === adminUsername) {
      if (!constantTimeEqual(String(password), String(env.ADMIN_PASSWORD))) {
        await recordLoginFailure(env, rate);
        await logLogin(env, request, { status: 'failed', reason: 'bad_admin_password' });
        return json({ error: '用户名或密码错误' }, 401);
      }

      const user = await ensureEnvAdminUser(env, adminUsername);
      if (!user || !user.id) {
        throw new Error('环境变量管理员账号创建失败（users.id 缺失）');
      }

      await clearLoginRate(env, rate);
      const token = await createSession(env, user.id);
      await logLogin(env, request, { userId: user.id, status: 'success', reason: 'env_admin' });
      writeEvent(env, { type: 'login', userId: user.id, detail: user.username, value: 1 });

      return json({
        success: true,
        user: { id: user.id, username: user.username, avatar: user.avatar || null, role: 'admin' },
        token,
      });
    }

    // ---------- 普通用户 ----------
    const user = await env.DB.prepare(
      'SELECT id, username, avatar, password_hash, role, status FROM users WHERE username = ?'
    ).bind(username).first();

    if (!user) {
      await recordLoginFailure(env, rate);
      await logLogin(env, request, { status: 'failed', reason: 'user_not_found' });
      return json({ error: '用户名或密码错误' }, 401);
    }

    // 环境变量管理员的占位账号：永远不接受密码登录（即使有人猜中占位字符串）
    if (user.password_hash === ENV_ADMIN_PROTECTED_HASH) {
      await recordLoginFailure(env, rate);
      await logLogin(env, request, { userId: user.id, status: 'failed', reason: 'env_admin_protected' });
      return json({ error: '用户名或密码错误' }, 401);
    }

    const { valid, needsUpgrade } = await verifyPassword(password, user.password_hash);
    if (!valid) {
      await recordLoginFailure(env, rate);
      await logLogin(env, request, { userId: user.id, status: 'failed', reason: 'bad_password' });
      return json({ error: '用户名或密码错误' }, 401);
    }

    // 密码正确后才告知「已停用」，避免未认证请求被用来枚举账号状态
    if (user.status !== 'active') {
      await clearLoginRate(env, rate);
      await logLogin(env, request, {
        userId: user.id,
        status: 'blocked',
        reason: `account_${String(user.status || 'unknown').slice(0, 32)}`,
      });
      return json({ error: '账号已被停用，请联系管理员' }, 403);
    }

    // 旧哈希 → 自动升级为 PBKDF2
    if (needsUpgrade) {
      try {
        const newHash = await createPBKDF2Hash(password);
        await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
          .bind(newHash, user.id).run();
      } catch (e) {
        console.error('密码哈希升级失败（不影响登录）:', e.message);
      }
    }

    await clearLoginRate(env, rate);
    const token = await createSession(env, user.id);
    await logLogin(env, request, { userId: user.id, status: 'success', reason: '' });
    writeEvent(env, { type: 'login', userId: user.id, detail: user.username, value: 1 });

    return json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        role: user.role === 'admin' ? 'admin' : 'user',
      },
      token,
    });
  } catch (err) {
    console.error('登录错误:', err);
    return json({ error: '服务器错误，请稍后重试' }, 500);
  }
}
