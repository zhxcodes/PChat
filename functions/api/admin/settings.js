// functions/api/admin/settings.js
// ============================================================
// 运行级配置（功能开关）—— 管理端读写 app_settings
// ------------------------------------------------------------
// GET /api/admin/settings
//   → { settings }  // 跳过 KV 缓存，读 D1 最新值
// PUT /api/admin/settings  { settings: { key: '1' | '0', ... } }
//   → { success, updated }  // 只允许写下方白名单里的功能开关
//
// 权限：/api/admin/* 由中间件强制管理员，这里再用 requireAdminRole 防御一次。
// 审计：更新成功后写 admin_logs（action='settings.update'，target 记录每个开关的最终值）。
// ============================================================

import {
  json,
  getAppSettings,
  setAppSettings,
  requireAdminRole,
  logAdminAction,
  getClientIp,
} from '../../_lib.js';

// 只允许管理页「功能开关」修改这些键；限流、日志保留天数等运行参数需专用接口，
// 避免误把 system_key_rate_limit 之类写成 '0'/'1'。
const WRITABLE_SETTINGS = new Set([
  'allow_register',
  'invite_required',
  'user_api_key_enabled',
  'system_api_key_enabled',
  'memory_enabled',
  'memory_extract_enabled',
  'favorites_enabled',
  'reactions_enabled',
  'commitments_enabled',
  'insights_enabled',
  'stats_enabled',
  'replay_enabled',
  'search_enabled',
  'export_enabled',
  'import_enabled',
]);

function normalizeSwitchValue(value) {
  if (typeof value === 'boolean') return value ? '1' : '0';
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (s === '1' || s === '0') return s;
  return null;
}

export async function onRequestGet({ env, data }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  const settings = await getAppSettings(env, { skipCache: true });
  return json({ settings });
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

  const input = body && body.settings;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return json({ error: 'settings 必须是 { key: value } 对象' }, 400);
  }

  const updates = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (!WRITABLE_SETTINGS.has(key)) {
      return json({ error: `不支持的配置项：${key}` }, 400);
    }
    const value = normalizeSwitchValue(rawValue);
    if (value === null) {
      return json({ error: `配置项 ${key} 的值只能是 '1' 或 '0'` }, 400);
    }
    updates[key] = value;
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return json({ error: '没有要更新的配置' }, 400);
  }

  try {
    const updated = await setAppSettings(env, updates);
    // 审计只记录开关名与最终值（非敏感），不记录请求体原文
    await logAdminAction(env, {
      adminId: data.userId,
      action: 'settings.update',
      target: keys.map((key) => `${key}=${updates[key]}`).join(',').slice(0, 500),
      ip: getClientIp(request),
    });
    return json({ success: true, updated });
  } catch (err) {
    console.error('PUT /api/admin/settings 错误:', err);
    return json({ error: '保存功能开关失败' }, 500);
  }
}
