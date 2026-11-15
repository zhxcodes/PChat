// functions/api/user/api-key.js
// ============================================================
// 用户自备 AI API Key（多用户安全架构 Phase 3）
// ------------------------------------------------------------
// GET    /api/user/api-key   -> { configured: boolean }（只回是否已配置，绝不回明文/密文）
// PUT    /api/user/api-key   -> { api_key }：AES-GCM 加密后写入 user_secrets
// DELETE /api/user/api-key   -> 删除已保存的 Key（幂等，未配置时也返回成功）
//
// 安全约定：
// - 总开关 app_settings.user_api_key_enabled：关闭时三个方法一律 403；
// - 密文由 _lib.encryptSecret 生成（主密钥 env.SECRET_MASTER_KEY），只在服务端解密，
//   客户端永远拿不到已保存的 Key；
// - 缺 SECRET_MASTER_KEY 时 PUT 明确失败，绝不存明文、绝不降级；
// - 存表只存密文，日志里不打印 Key。
// 认证由 /api/_middleware.js 统一处理（data.userId）。
// ============================================================

import {
  json,
  getUserId,
  getAppSettings,
  isSettingEnabled,
  encryptSecret,
  USER_API_KEY_NAME,
} from '../../_lib.js';

const API_KEY_MIN = 8;
const API_KEY_MAX = 512;

// 功能总开关（读失败时 getAppSettings 回退默认值 = 开启）
async function isApiKeyFeatureEnabled(env) {
  const settings = await getAppSettings(env);
  return isSettingEnabled(settings, 'user_api_key_enabled');
}

function featureDisabled() {
  return json({ error: '自定义 API Key 功能已被管理员关闭' }, 403);
}

// GET：只回答「有没有配置」，不返回任何密钥内容
export async function onRequestGet({ env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);
  if (!(await isApiKeyFeatureEnabled(env))) return featureDisabled();

  const row = await env.DB.prepare(
    'SELECT 1 AS configured FROM user_secrets WHERE user_id = ? AND name = ? LIMIT 1'
  ).bind(userId, USER_API_KEY_NAME).first();

  return json({ configured: !!row });
}

// PUT：加密保存（重复保存 = 覆盖，updated_at 同时刷新）
export async function onRequestPut({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);
  if (!(await isApiKeyFeatureEnabled(env))) return featureDisabled();

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }

  const raw = body && (body.api_key !== undefined ? body.api_key : body.key);
  const apiKey = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!apiKey) return json({ error: '请输入 API Key' }, 400);
  if (apiKey.length < API_KEY_MIN || apiKey.length > API_KEY_MAX) {
    return json({ error: `API Key 长度需为 ${API_KEY_MIN}~${API_KEY_MAX} 个字符` }, 400);
  }
  if (/[\u0000-\u001f\u007f]/.test(apiKey)) {
    return json({ error: 'API Key 包含非法字符' }, 400);
  }

  let ciphertext;
  try {
    ciphertext = await encryptSecret(env, apiKey);
  } catch (e) {
    console.error('加密用户 API Key 失败:', e.message);
    return json({ error: '服务端未配置加密主密钥，暂时无法保存 API Key' }, 500);
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO user_secrets (user_id, name, ciphertext, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`
  ).bind(userId, USER_API_KEY_NAME, ciphertext, now).run();

  // 不回显 Key，也不回显密文
  return json({ success: true, configured: true });
}

// DELETE：删除已保存的 Key（幂等）
export async function onRequestDelete({ env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);
  if (!(await isApiKeyFeatureEnabled(env))) return featureDisabled();

  await env.DB.prepare('DELETE FROM user_secrets WHERE user_id = ? AND name = ?')
    .bind(userId, USER_API_KEY_NAME).run();

  return json({ success: true, configured: false });
}
