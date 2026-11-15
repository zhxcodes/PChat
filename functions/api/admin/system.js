// functions/api/admin/system.js
// GET /api/admin/system —— 系统初始化状态（只返回布尔值，绝不返回密钥内容）
// 供 admin.html 的「系统初始化」卡片展示：主密钥 / 管理员环境变量 / 系统 Key / 功能开关。
// 权限：/api/admin/* 由中间件强制要求管理员，这里再做一次防御性校验。

import {
  json,
  getAppSettings,
  isSettingEnabled,
  hasSecretMasterKey,
  requireAdminRole,
} from '../../_lib.js';

export async function onRequestGet({ env, data }) {
  const denied = requireAdminRole(data);
  if (denied) return denied;

  const settings = await getAppSettings(env);
  const retention = Number(settings.login_log_retention_days);

  return json({
    secret_master_key_configured: hasSecretMasterKey(env),
    admin_env_configured: !!(env.ADMIN_USERNAME && env.ADMIN_PASSWORD),
    system_api_key_configured: !!env.DEEPSEEK_API_KEY,
    user_api_key_enabled: isSettingEnabled(settings, 'user_api_key_enabled'),
    system_api_key_enabled: isSettingEnabled(settings, 'system_api_key_enabled'),
    allow_register: isSettingEnabled(settings, 'allow_register'),
    invite_required: isSettingEnabled(settings, 'invite_required'),
    allowed_origins_configured: !!(env.ALLOWED_ORIGINS && String(env.ALLOWED_ORIGINS).trim()),
    login_log_retention_days: Number.isFinite(retention) && retention > 0 ? Math.floor(retention) : 30,
  });
}
