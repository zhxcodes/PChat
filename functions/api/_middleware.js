// functions/api/_middleware.js —— /api/* 的统一认证 + CORS + 管理员拦截中间件
// ============================================================
// 安全要点：
// - 跨域白名单来自环境变量 ALLOWED_ORIGINS（逗号 / 空白分隔），不再硬编码：
//     * 同源请求（Origin 与请求 URL 的 origin 相同，或没有 Origin）永远放行；
//     * 跨域请求只认白名单，未配置白名单时跨域一律拒绝（fail closed，而不是放开）；
//     * 不支持 '*' 通配，避免一个字符的误配置把接口开放给任意站点。
// - 严格 Origin 校验：带 Origin 且不被允许的请求一律 403（防 CSRF / 跨站调用）
// - 仅对允许的 Origin 返回 CORS 头（错误响应同样带上，前端才能读到错误信息）
// - 认证通过后注入 context.data.userId / context.data.userRole
// - session 查询 JOIN users 取 role，并拒绝 status != 'active' 的账号
// - 所有 /api/admin/* 路由强制要求 userRole === 'admin'，否则 403
// - 错误响应不携带 detail / 堆栈（避免泄露内部信息，详情只写服务端日志）
// ============================================================

import { json } from '../_lib.js';

// 公开路径（精确匹配；新增公开接口必须显式加进这里）
const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/register',
]);

// 规范化 Origin：去空白、去末尾斜杠、转成 URL.origin（小写主机 + 省略默认端口）。
// 空串与 '*' 返回 ''（不支持通配）；无法解析的值按小写原样返回（永远匹配不上浏览器 Origin）。
function normalizeOrigin(value) {
  const raw = String(value === null || value === undefined ? '' : value)
    .trim().replace(/\/+$/, '');
  if (!raw || raw === '*') return '';
  try {
    return new URL(raw).origin;
  } catch (e) {
    return raw.toLowerCase();
  }
}

// 读取 ALLOWED_ORIGINS（逗号或空白分隔）
function parseAllowedOrigins(env) {
  const raw = (env && env.ALLOWED_ORIGINS) ? String(env.ALLOWED_ORIGINS) : '';
  const list = [];
  for (const part of raw.split(/[\s,]+/)) {
    const origin = normalizeOrigin(part);
    if (origin) list.push(origin);
  }
  return list;
}

// /api/admin 与 /api/admin/...（不会误伤 /api/administrator）
function isAdminPath(pathname) {
  return pathname === '/api/admin' || pathname.startsWith('/api/admin/');
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const originHeader = request.headers.get('Origin') || '';
  const requestOrigin = normalizeOrigin(originHeader);
  const allowedOrigins = parseAllowedOrigins(env);

  // 同源放行；跨域只认白名单；未配置白名单 = 只允许同源
  const corsAllowed = !!requestOrigin
    && (requestOrigin === normalizeOrigin(url.origin) || allowedOrigins.includes(requestOrigin));

  // 跨域但不被允许 → 直接 403（预检也一样）
  if (originHeader && !corsAllowed) {
    return json({ error: '来源不被允许' }, 403);
  }

  // 允许的跨域请求在错误响应上也带上 CORS 头，否则浏览器前端读不到错误信息
  const corsHeaders = corsAllowed
    ? { 'Access-Control-Allow-Origin': requestOrigin, 'Vary': 'Origin' }
    : {};
  const fail = (payload, status) => json(payload, status, corsHeaders);

  // OPTIONS 预检
  if (request.method === 'OPTIONS') {
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
      ...corsHeaders,
    };
    return new Response(null, { status: 204, headers });
  }

  // ---------- 认证：session JOIN users 取角色 ----------
  const isPublic = PUBLIC_PATHS.has(url.pathname);
  let userId = null;
  let userRole = null;

  if (!isPublic) {
    if (!env.DB) {
      console.error('❌ env.DB 未定义，请检查 wrangler.toml 中的 [[d1_databases]] 绑定名称');
      return fail({ error: '数据库未配置' }, 500);
    }

    // EventSource(SSE) 无法携带 Authorization 头，允许通过 ?token= 传递
    const authHeader = request.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '').trim() || url.searchParams.get('token') || '';
    if (!token) {
      return fail({ error: '未登录' }, 401);
    }

    try {
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const session = await env.DB.prepare(
        `SELECT s.user_id AS user_id, u.role AS role, u.status AS status
           FROM sessions s
           JOIN users u ON u.id = s.user_id
          WHERE s.token = ? AND s.expires_at > ?`
      ).bind(token, now).first();

      if (!session) {
        return fail({ error: '登录已过期' }, 401);
      }
      if (session.status !== 'active') {
        return fail({ error: '账号已被停用' }, 403);
      }

      userId = session.user_id;
      userRole = session.role === 'admin' ? 'admin' : 'user';
    } catch (err) {
      console.error('❌ 验证 session 时出错（若提示缺列，请先执行 migrations/002_security_and_audit.sql）:', err);
      return fail({ error: '认证失败' }, 500);
    }
  }

  // ---------- 管理员路由强制拦截（/api/admin/*） ----------
  if (isAdminPath(url.pathname) && userRole !== 'admin') {
    return fail({ error: '需要管理员权限' }, 403);
  }

  // 注入身份信息
  context.data = context.data || {};
  context.data.userId = userId;
  context.data.userRole = userRole;

  try {
    const response = await next(request);
    const newHeaders = new Headers(response.headers);
    if (corsAllowed) {
      newHeaders.set('Access-Control-Allow-Origin', requestOrigin);
      newHeaders.set('Vary', 'Origin');
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (err) {
    console.error('❌ 中间件执行错误:', err);
    return fail({ error: '服务器内部错误' }, 500);
  }
}
