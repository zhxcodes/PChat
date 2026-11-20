// functions/api/ai/stream.js
// POST /api/ai/stream —— 真正流式 AI 对话（SSE）
// 直接在 Pages Function 内调用 DeepSeek API，不再依赖独立的 Worker / Service Binding。
// 历史记录：统一走 _lib.loadChatHistory（KV 热缓存优先 → D1 回源 → 回填，含完整性校验与去重），
//          与 history.js 同口径；回复完成后双写 D1 + KV。
// 性能：联系人参数、历史记录、系统提示词三项并行加载；fullReply 累积设上限。
// 安全：消息/联系人长度受限，AI 参数范围钳制，按用户做 KV 频率限制（防滥用烧钱），
//       错误响应不泄露内部信息（detail 只写服务端日志）。

import { json, clamp, getUserId, LIMITS, loadChatHistory, loadRecentMemories, loadPendingCommitments, maybeExtractMemory, resolveAiBase, DEFAULT_AI_MODEL, updateMoodAndIntimacy, writeEvent, verifyTurnstile, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_DEFAULT, buildSystemPrompt, saveChatTurn, getAppSettings, isSettingEnabled, isEnvFlagEnabled, decryptSecret, USER_API_KEY_NAME, chinaDateKey } from '../../_lib.js';

const MAX_REPLY_CHARS = 200000; // fullReply 累积上限（防御性，避免极端长回复占用内存）

// AI 频率限制：每用户每分钟最多 30 次请求（KV 近似计数，失败放行）
const AI_RATE_LIMIT_MAX = 30;
const AI_RATE_LIMIT_WINDOW_MS = 60 * 1000;

// 频率限制：基于 KV 的滑动窗口近似计数；KV 异常时放行
async function checkAiRateLimit(env, userId) {
  try {
    const key = `rl_ai_${userId}`;
    const now = Date.now();
    const raw = await env.PROMPTS_KV.get(key, { type: 'json' });
    let rec = (raw && typeof raw.count === 'number') ? raw : { count: 0, first: now };
    if (now - rec.first > AI_RATE_LIMIT_WINDOW_MS) {
      rec = { count: 0, first: now };
    }
    if (rec.count >= AI_RATE_LIMIT_MAX) {
      return { limited: true, retryAfter: Math.ceil((rec.first + AI_RATE_LIMIT_WINDOW_MS - now) / 1000) };
    }
    rec.count += 1;
    await env.PROMPTS_KV.put(key, JSON.stringify(rec), {
      expirationTtl: Math.ceil(AI_RATE_LIMIT_WINDOW_MS / 1000),
    });
    return { limited: false };
  } catch (e) {
    return { limited: false };
  }
}

// ============================================================
// Phase 3：AI Key 解析 / 系统 Key 限流 / token 用量
// ------------------------------------------------------------
// Key 优先级：
//   1) 用户自备 Key（app_settings.user_api_key_enabled 开启 + user_secrets 有值 + 能解密）
//   2) 系统 Key（env.USE_SYSTEM_API_KEY 未显式关闭 + app_settings.system_api_key_enabled 开启
//      + env.DEEPSEEK_API_KEY 已配置）
//   两者都不可用 → 503。
// 只有使用系统 Key 时才额外做「每用户每分钟 N 次」的 KV 限流，并把 token 消耗累计进
// user_usage；用户自备 Key 的消耗不计入系统账。
// ============================================================
const SYSTEM_KEY_RATE_WINDOW_MS = 60 * 1000;
const SYSTEM_KEY_RATE_DEFAULT = 10;
const SYSTEM_KEY_RATE_MAX = 1000;

// 系统 Key 每分钟上限：环境变量优先（便于运维临时调整）→ app_settings → 默认 10；0 = 不限制
function getSystemKeyRateLimit(env, settings) {
  const candidates = [env && env.SYSTEM_KEY_RATE_LIMIT, settings && settings.system_key_rate_limit];
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.min(Math.floor(n), SYSTEM_KEY_RATE_MAX);
  }
  return SYSTEM_KEY_RATE_DEFAULT;
}

// 系统 Key 限流（KV 近似计数，KV 异常时放行，避免锁死用户）
async function checkSystemKeyRateLimit(env, userId, limit) {
  if (!limit || limit <= 0) return { limited: false };
  try {
    const key = `rl_syskey_${userId}`;
    const now = Date.now();
    const raw = await env.PROMPTS_KV.get(key, { type: 'json' });
    let rec = (raw && typeof raw.count === 'number') ? raw : { count: 0, first: now };
    if (now - rec.first > SYSTEM_KEY_RATE_WINDOW_MS) {
      rec = { count: 0, first: now };
    }
    if (rec.count >= limit) {
      return {
        limited: true,
        retryAfter: Math.max(1, Math.ceil((rec.first + SYSTEM_KEY_RATE_WINDOW_MS - now) / 1000)),
      };
    }
    rec.count += 1;
    await env.PROMPTS_KV.put(key, JSON.stringify(rec), {
      expirationTtl: Math.ceil(SYSTEM_KEY_RATE_WINDOW_MS / 1000),
    });
    return { limited: false };
  } catch (e) {
    return { limited: false };
  }
}

// 解析本次请求可用的 AI Key。返回 { source: 'user'|'system', apiKey } 或 { error, status }。
async function resolveAiCredentials(env, userId, settings) {
  // 1) 用户自备 Key（功能关闭时忽略库里已有的 Key）
  if (isSettingEnabled(settings, 'user_api_key_enabled')) {
    let row = null;
    try {
      row = await env.DB.prepare(
        'SELECT ciphertext FROM user_secrets WHERE user_id = ? AND name = ?'
      ).bind(userId, USER_API_KEY_NAME).first();
    } catch (e) {
      console.warn('读取用户 API Key 失败（回退系统 Key）:', e.message);
    }
    if (row && row.ciphertext) {
      const plaintext = await decryptSecret(env, row.ciphertext);
      if (plaintext) return { source: 'user', apiKey: plaintext };
      console.warn('用户 API Key 解密失败（主密钥可能已更换），回退系统 Key');
    }
  }

  // 2) 系统 Key：环境变量与 app_settings 必须同时允许，且确实配置了 Key
  const systemAllowed = isEnvFlagEnabled(env.USE_SYSTEM_API_KEY, true)
    && isSettingEnabled(settings, 'system_api_key_enabled');
  if (systemAllowed) {
    if (env.DEEPSEEK_API_KEY) return { source: 'system', apiKey: String(env.DEEPSEEK_API_KEY) };
    console.error('系统 AI Key 已启用，但 env.DEEPSEEK_API_KEY 未配置');
  }

  return {
    source: null,
    error: '当前没有可用的 AI 密钥：请在设置中保存自己的 API Key，或联系管理员开启系统密钥',
    status: 503,
  };
}

// token 估算（上游未返回 usage 时的兜底）：中文约 1.5 字/token、英文约 4 字符/token，取折中 3
function estimateTokens(promptChars, replyChars) {
  return Math.max(1, Math.ceil(promptChars / 3) + Math.ceil(replyChars / 3));
}

export async function onRequestPost({ request, env, data, ctx }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  let message, contact, config, continueMode, regenerateMode, provider, director, replyTo, regenerateInstruction, turnstileToken;
  try {
    const body = await request.json();
    message = body.message;
    contact = body.contact;
    config = body.config;
    // “继续”模式：只保存 assistant 续写，不额外落库“继续”这条用户消息
    continueMode = body.continue === true;
    // “重新生成”模式：以最后一条用户消息重新提问，只新增一条 assistant 回复（旧回复保留在历史中）
    regenerateMode = body.regenerate === true;
    // 自定义模型接口（全局设置）：{ apiBase?, model? }（apiKey 不再由客户端传递）
    provider = (body.provider && typeof body.provider === 'object') ? body.provider : null;
    // 导演词（临时 AI 提示词，仅本次对话生效）
    director = (typeof body.director === 'string' && body.director.trim()) ? body.director.trim().slice(0, 2000) : '';
    // 消息引用/回复（第 21 项）：被引用消息 id
    const rp = parseInt(body.reply_to, 10);
    replyTo = Number.isInteger(rp) && rp > 0 ? rp : null;
    // 自定义指令重新生成（第 22 项）：仅对本次生成生效
    regenerateInstruction = (typeof body.regenerate_instruction === 'string' && body.regenerate_instruction.trim())
      ? body.regenerate_instruction.trim().slice(0, 500)
      : '';
    // Turnstile 令牌（第 9 项）
    turnstileToken = (typeof body.turnstile_token === 'string') ? body.turnstile_token : '';
  } catch (e) {
    return json({ error: '请求体不是有效的 JSON' }, 400);
  }
  if (!contact) {
    return json({ error: '缺少参数' }, 400);
  }
  if (!regenerateMode) {
    // 普通消息必填；但“单独发送导演词”时允许没有普通消息（director 非空即可）
    const hasMessage = typeof message === 'string' && message.trim().length > 0;
    if (!hasMessage && !director) {
      return json({ error: '消息内容不能为空' }, 400);
    }
    if (typeof message === 'string' && message.length > LIMITS.message) {
      return json({ error: `消息长度不能超过 ${LIMITS.message} 字符` }, 400);
    }
    message = hasMessage ? message.trim() : '';
  }
  if (String(contact).length > LIMITS.contact) {
    return json({ error: 'contact 参数过长' }, 400);
  }

  const rate = await checkAiRateLimit(env, userId);
  if (rate.limited) {
    return json({ error: `请求过于频繁，请 ${rate.retryAfter} 秒后再试` }, 429);
  }

  // ---------- Phase 3：AI Key 解析（用户 Key 优先，其次系统 Key）与系统 Key 限流 ----------
  const settings = await getAppSettings(env);
  const credentials = await resolveAiCredentials(env, userId, settings);
  if (!credentials.apiKey) {
    return json({ error: credentials.error }, credentials.status || 503);
  }
  if (credentials.source === 'system') {
    const sysRate = await checkSystemKeyRateLimit(env, userId, getSystemKeyRateLimit(env, settings));
    if (sysRate.limited) {
      return json({ error: `系统密钥请求过于频繁，请 ${sysRate.retryAfter} 秒后再试` }, 429);
    }
  }

  /* Turnstile 人机验证（第 9 项）：未配置 TURNSTILE_SECRET 时自动跳过
  if (env.TURNSTILE_SECRET) {
    const tv = await verifyTurnstile(env, turnstileToken, request.headers.get('CF-Connecting-IP'));
    if (!tv.ok) return json({ error: tv.error || '人机验证失败' }, 403);
  }
*/
  try {
    // ---------- 1+2+3. 并行加载：联系人参数 / 历史记录 / 系统提示词 / 角色元数据 ----------
    // 历史记录统一走 _lib.loadChatHistory（KV 优先、D1 回源、完整性校验、去重），
    // 与 history.js 完全同口径，杜绝两处缓存逻辑不一致导致的碎片化。
    // 角色元数据 meta_${userId}_${contact} 里保存了“回复格式要求”（format），必须拼进系统提示词，
    // 否则 AI 完全看不到这条规则（此前只用了不带 userId 的 prompt_ 键，format 一直未生效）。
    // KV key 带 userId：不同用户拥有相同 contact_id 时，设定互不覆盖。
    const [contactRow, historyLoaded, promptRaw, metaRaw, userPreference, userSafeword] = await Promise.all([
      env.DB.prepare(
        'SELECT temperature, top_p, max_tokens, frequency_penalty, presence_penalty, memory_window, context_window, mood, intimacy FROM contacts WHERE user_id = ? AND contact_id = ?'
      ).bind(userId, contact).first().catch((e) => {
        console.warn('读取联系人参数失败，使用默认值:', e.message);
        return null;
      }),
      loadChatHistory(env, userId, contact),
      env.PROMPTS_KV.get(`prompt_${userId}_${contact}`).catch((e) => {
        console.warn('读取提示词失败:', e.message);
        return null;
      }),
      env.PROMPTS_KV.get(`meta_${userId}_${contact}`).catch((e) => {
        console.warn('读取角色元数据失败:', e.message);
        return null;
      }),
      // 用户偏好（第 12 项）
      env.PROMPTS_KV.get(`preference_${userId}`).catch(() => null),
      // 安全词（第 15 项）
      env.PROMPTS_KV.get(`safeword_${userId}`).catch(() => null),
    ]);

    // 联系人 AI 参数（数据库优先，请求体兜底，范围钳制）
    let temperature = clamp(config?.temperature, 0, 2, 0.7);
    let top_p = clamp(config?.top_p, 0, 1, 0.9);
    let max_tokens = Math.round(clamp(config?.max_tokens, 256, 8192, 2048));
    let frequency_penalty = clamp(config?.frequency_penalty, -2, 2, 0);
    let presence_penalty = clamp(config?.presence_penalty, -2, 2, 0);
    let context_window = Math.round(clamp(config?.context_window, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_DEFAULT));
    if (contactRow) {
      if (config?.temperature === undefined && contactRow.temperature !== null) temperature = clamp(contactRow.temperature, 0, 2, 0.7);
      if (config?.top_p === undefined && contactRow.top_p !== null) top_p = clamp(contactRow.top_p, 0, 1, 0.9);
      if (config?.max_tokens === undefined && contactRow.max_tokens !== null) max_tokens = Math.round(clamp(contactRow.max_tokens, 256, 8192, 2048));
      if (config?.frequency_penalty === undefined && contactRow.frequency_penalty !== null) frequency_penalty = clamp(contactRow.frequency_penalty, -2, 2, 0);
      if (config?.presence_penalty === undefined && contactRow.presence_penalty !== null) presence_penalty = clamp(contactRow.presence_penalty, -2, 2, 0);
      if (config?.context_window === undefined && contactRow.context_window !== null) context_window = Math.round(clamp(contactRow.context_window, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_DEFAULT));
    }

    // 历史记录（最近 50 条，时间升序）
    const historyArray = historyLoaded.messages;

    // 系统提示词拼接（安全词分支 / meta / 记忆 / 承诺 / 时间 / 重新生成指令）
    // 已抽到 _lib.buildSystemPrompt；此处只负责检测与加载数据，拼接顺序与文案原样保持不变。

    // ---- 安全词检测（第 15 项）：命中则中止角色扮演，改用冷静中性语气 ----
    const safeword = (typeof userSafeword === 'string') ? userSafeword.trim() : '';
    const safewordTriggered = !!(safeword && !regenerateMode && typeof message === 'string' && message.includes(safeword));

    // 解析角色 meta（回复格式要求 / 当前场景 / 外貌）
    let meta = null;
    if (typeof metaRaw === 'string' && metaRaw) {
      try { meta = JSON.parse(metaRaw); } catch (e) { meta = null; }
    }

    // 长期记忆（第 7 项：当前用户消息作为语义检索 query；安全词触发时不查询、不注入）
    // 未完成的承诺（第 18 项）：安全词触发时不查询、不注入（与原实现一致）
    const recentMemories = safewordTriggered ? [] : await loadRecentMemories(env, userId, contact, message || '');
    const pendingCommitments = safewordTriggered ? [] : await loadPendingCommitments(env, userId, contact);

    // 系统提示词（拼接逻辑见 _lib.buildSystemPrompt，行为与抽取前完全一致）
    const systemPrompt = await buildSystemPrompt(env, userId, contact, {
      promptRaw,
      meta,
      memories: recentMemories,
      pendingCommitments,
      contactRow,
      userPreference,
      safewordTriggered,
      regenerateInstruction,
    });

    // 消息引用/回复（第 21 项）：把被引用消息原文作为一条前置 user 消息插入
    // （只对本次请求生效，不写进系统提示词，避免被永久固化）
    let replyContext = null;
    if (replyTo) {
      try {
        const quoted = await env.DB.prepare(
          "SELECT content FROM chat_history WHERE id = ? AND user_id = ? AND contact_id = ? AND (kind IS NULL OR kind != 'director')"
        ).bind(replyTo, userId, contact).first();
        if (quoted && quoted.content) {
          replyContext = {
            role: 'user',
            content: '【用户正在回复以下消息】' + String(quoted.content).slice(0, 1000),
          };
        }
      } catch (e) {
        console.warn('读取被引用消息失败（忽略）:', e.message);
      }
    }

    // ---------- 上下文与消息构造（支持 continue / regenerate / 导演词） ----------
    // 导演词：作为 kind='director' 的用户消息入库并显示为特别气泡；
    // 发送给 AI 时加【导演词】前缀，让 AI 把它当作导演指令而非普通提问。
    const skipUserSave = continueMode || regenerateMode;
    let contextMessages = historyArray;
    let finalUserMessage = message;
    // 本次新增的用户侧行，顺序 = [普通消息, 导演词]（显示上导演词在普通消息下方）
    let newRows = [];
    if (director) newRows.push({ role: 'user', kind: 'director', content: director });
    if (message) newRows.unshift({ role: 'user', kind: 'normal', content: message });

    if (regenerateMode) {
      // 找到最后一条“普通”用户消息，以其重新提问（跳过导演词行）
      let lastUserIdx = -1;
      for (let i = historyArray.length - 1; i >= 0; i--) {
        if (historyArray[i].role === 'user' && historyArray[i].kind !== 'director') { lastUserIdx = i; break; }
      }
      if (lastUserIdx === -1) {
        return json({ error: '没有可重新生成的消息' }, 400);
      }
      finalUserMessage = historyArray[lastUserIdx].content;
      contextMessages = historyArray.slice(0, lastUserIdx);
      newRows = [];
    } else if (newRows.length > 0) {
      // 最后一行作为“最终用户消息”，其余拼进上下文
      const lastNew = newRows[newRows.length - 1];
      finalUserMessage = (lastNew.kind === 'director' ? '【导演词】' : '') + lastNew.content;
      newRows = newRows.slice(0, -1);
    }

    const toApiContent = (row) => (row.kind === 'director' ? '【导演词】' : '') + row.content;
    // 安全词触发 → 清空角色扮演上下文（不带历史、不带头像设定，只发当前消息）
    const apiContext = safewordTriggered
      ? [{ role: 'user', content: finalUserMessage }]
      : [
          // 上下文长度：发送最近 context_window 条（AI 参数，默认 20）
          ...contextMessages.slice(-context_window).map((h) => ({
            role: h.role,
            content: (h.kind === 'director' ? '【导演词】' : '') + h.content,
          })),
          ...newRows.map((r) => ({ role: 'user', content: toApiContent(r) })),
          // 被引用消息：位于历史之后、本次用户消息之前（第 21 项）
          ...(replyContext ? [replyContext] : []),
          { role: 'user', content: finalUserMessage },
        ];

    // token 用量估算用：系统提示词 + 本次上下文的总字符数（上游没回 usage 时兜底）
    const promptChars = systemPrompt.length
      + apiContext.reduce((sum, m) => sum + String(m && m.content ? m.content : '').length, 0);

    // ---------- 4. 调用大模型 API（流式） ----------
    // Key 来源已由 resolveAiCredentials 确定（用户自备 Key 优先，其次系统 Key）；
    // 请求体里的 apiKey 永远不会被采用（客户端无法指定密钥）。
    // 地址：用户 Key 允许客户端自填 apiBase；系统 Key 只走 AI_GATEWAY_URL / 直连 DeepSeek。
    const apiKey = credentials.apiKey;
    const keySource = credentials.source;

    // 安全：客户端自定义 apiBase 只对「用户自己的 Key」生效。
    // 使用系统 Key 时忽略客户端地址，否则任何登录用户都能把 apiBase 指向自己的服务器，
    // 在 Authorization 头里拿到系统 Key（密钥外泄）。系统 Key 只走管理员配置的地址。
    const apiBase = (keySource === 'user')
      ? resolveAiBase(env, provider?.apiBase)
      : resolveAiBase(env, '');

    // cf-aig-authorization 只在请求确实发往「管理员配置的 AI Gateway」时携带，
    // 避免把 Gateway Token 泄露给客户端指定的第三方地址。
    const gatewayBase = (env.AI_GATEWAY_URL ? String(env.AI_GATEWAY_URL).trim().replace(/\/+$/, '') : '');
    const requestHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    if (gatewayBase && apiBase === gatewayBase && env.CF_AIG_TOKEN) {
      requestHeaders['cf-aig-authorization'] = `Bearer ${env.CF_AIG_TOKEN}`;
    }
    const model = (provider?.model && String(provider.model).trim())
      ? String(provider.model).trim()
      : DEFAULT_AI_MODEL;

    const apiResponse = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...apiContext,
        ],
        stream: true,
        temperature,
        top_p,
        max_tokens,
        frequency_penalty,
        presence_penalty,
      }),
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error(`DeepSeek API 错误 ${apiResponse.status}:`, errText.slice(0, 500));
      return json({ error: 'AI 服务暂时不可用，请稍后重试' }, 502);
    }

    // ---------- 5. TransformStream 透传 + 边转发边累积 ----------
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const reader = apiResponse.body.getReader();
    const decoder = new TextDecoder();
    let fullReply = '';
    let streamClosed = false;
    let usageFromApi = null; // DeepSeek 流式响应的最后一个 chunk 会带 usage

    // 安全词触发标记：先于模型输出下发一个自定义 SSE 事件，前端据此提示"安全词已触发"
    if (safewordTriggered) {
      try {
        await writer.write(new TextEncoder().encode('data: {"dsh_safeword":true}\n\n'));
      } catch (_) {}
    }

    const safeCloseWriter = async () => {
      if (!streamClosed) {
        streamClosed = true;
        try { await writer.close(); } catch (_) {}
      }
    };

    // 处理 AI 输出的“删除记忆”指令：删除对应记忆，并把标记从回复中剥离
    // （记忆编号即系统提示词【长期记忆】列表前的数字 = memories 表 id）
    // 安全：只有本次真正注入给 AI 的记忆 id 才允许删除（白名单），
    //       防止 AI 幻觉出不存在的编号，误删手工添加的记忆。
    const injectedMemoryIds = new Set(recentMemories.map((m) => Number(m.id)));
    const processMemoryDeletions = async (reply) => {
      let cleaned = reply;
      const markers = reply.match(/【删除记忆[:：]\s*\d+】/g);
      if (markers && markers.length > 0) {
        for (const mk of markers) {
          const num = mk.match(/\d+/);
          if (!num) continue;
          const memId = Number(num[0]);
          if (!injectedMemoryIds.has(memId)) {
            console.warn('忽略非本次注入的记忆删除请求:', memId);
            continue;
          }
          try {
            await env.DB.prepare('DELETE FROM memories WHERE id = ? AND user_id = ? AND contact_id = ?')
              .bind(memId, userId, contact).run();
          } catch (e) { console.warn('删除记忆失败:', e.message); }
        }
        // 无论是否删除成功，标记都从回复中剥离（避免展示给用户）
        cleaned = reply.replace(/【删除记忆[:：]\s*\d+】/g, '').trim();
      }
      return cleaned;
    };

    // 回复完成后：双写 D1 + KV（INSERT 顺序 = 普通消息 → AI 回复；
    // continue / regenerate 模式下跳过用户消息的落库）
    // 导演词不落库（仅本次生效、仅前端当前会话展示），避免下次加载时又被拼回上下文
    const saveHistory = async (reply) => {
      if (!reply) return;
      // 先处理记忆删除指令（若 AI 在回复中要求删除记忆）
      // ⚠️ 必须留在 saveChatTurn 之前：白名单 injectedMemoryIds 来自本次请求实际注入的记忆，
      //    若搬进 _lib 会丢失白名单，AI 幻觉出的编号就会误删手工添加的记忆。
      const cleanedReply = await processMemoryDeletions(reply);

      // 双写 D1 + KV（SQL / 字段顺序 / KV key 与抽取前完全一致，见 _lib.saveChatTurn）
      await saveChatTurn(env, userId, contact, {
        userMessage: message,
        assistantReply: cleanedReply,
        replyTo,
        skipUserSave,
        historyArray,
      });

      // 自动提取记忆：攒够 memory_window 条 → 提炼为一条记忆（尽力而为）
      try {
        await maybeExtractMemory(env, userId, contact);
      } catch (e) {
        console.warn('记忆提取触发失败（忽略）:', e.message);
        writeEvent(env, { type: 'memory_extract_fail', userId, contactId: contact, detail: e.message });
      }

      // 第 8 项：Analytics Engine 埋点（未绑定时静默跳过）
      writeEvent(env, {
        type: 'ai_reply',
        userId,
        contactId: contact,
        value: cleanedReply.length,
        detail: `ctx=${context_window}`,
      });

      // 心情 / 亲密度更新（第 13、14 项）：异步执行，不阻塞响应流关闭
      // 安全词触发的轮次不更新情绪与亲密度
      if (!safewordTriggered) {
        const moodInput = [
          ...(message ? [{ role: 'user', content: message }] : []),
          { role: 'assistant', content: cleanedReply },
        ];
        const task = updateMoodAndIntimacy(env, userId, contact, moodInput);
        try {
          if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
          else await task;
        } catch (e) {
          console.warn('心情/亲密度更新调度失败（忽略）:', e.message);
        }
      }
    };

    // ---------- 6. Token 用量统计（仅系统 Key） ----------
    // 上游 usage 优先，缺失时按字符数估算；用户自备 Key 的消耗不计入系统 user_usage。
    // 在流结束的 finally 里调用：无论成功/异常/客户端断开，系统 Key 的成本都已发生。
    const recordSystemUsage = async () => {
      if (keySource !== 'system') return;

      const total = Number(usageFromApi && usageFromApi.total_tokens);
      const promptTokens = Number(usageFromApi && usageFromApi.prompt_tokens);
      const completionTokens = Number(usageFromApi && usageFromApi.completion_tokens);

      let tokens = 0;
      if (Number.isFinite(total) && total > 0) {
        tokens = Math.round(total);
      } else if (Number.isFinite(promptTokens) || Number.isFinite(completionTokens)) {
        tokens = Math.max(1, Math.round(
          (Number.isFinite(promptTokens) ? promptTokens : 0)
          + (Number.isFinite(completionTokens) ? completionTokens : 0)
        ));
      } else {
        tokens = estimateTokens(promptChars, fullReply.length);
      }
      if (!tokens) return;

      try {
        const date = chinaDateKey();
        await env.DB.prepare(
          `INSERT INTO user_usage (user_id, date, tokens_used) VALUES (?, ?, ?)
           ON CONFLICT(user_id, date) DO UPDATE SET tokens_used = tokens_used + excluded.tokens_used`
        ).bind(userId, date, tokens).run();
        writeEvent(env, {
          type: 'ai_tokens',
          userId,
          contactId: contact,
          value: tokens,
          detail: 'system_key',
        });
      } catch (e) {
        console.warn('记录 token 用量失败（忽略）:', e.message);
      }
    };

    const processStream = async () => {
      // 事件缓冲：SSE 以「空行」分隔事件（\r\n\r\n 或 \n\n）。事件本身可能被网络分块切断在
      // JSON 中间，也可能把 CRLF 的 \r 与 \n 拆到两个 chunk 里。因此这里只消费「已经出现完整
      // 空行」的整段事件，最后一个不完整的事件留在缓冲里等下一块补齐 —— 分隔符不完整就匹配不到，
      // 不会漏解析，也不会拿半行去 JSON.parse。
      let eventBuffer = '';

      // 解析一段完整事件文本中的 data: 行，把增量累积到 fullReply
      const consumeEventText = (text) => {
        if (!text) return;
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6);
          try {
            const parsed = JSON.parse(payload);
            // 最后一个 chunk 携带整轮 token 用量（prompt + completion），先于 delta 判断保存
            if (parsed && parsed.usage && typeof parsed.usage === 'object') {
              usageFromApi = parsed.usage;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta && fullReply.length < MAX_REPLY_CHARS) {
              fullReply += delta;
            }
          } catch (e) {
            // 上游格式异常（含预期的 data: [DONE]）不中断流，只 debug 前 100 字符便于排查
            console.debug('[ai/stream] 无法解析的 SSE 数据行（前 100 字符）:', String(payload).slice(0, 100));
          }
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // 1. 原样转发数据块；客户端已断开时 write 会抛错 → 静默跳过，继续读完上游
          //    （不让「客户端断开」中断 processStream，否则本轮回复不会落库）
          try {
            await writer.write(value);
          } catch (_) { /* 客户端断开，静默忽略 */ }

          // 2. 解析并累积文本（stream:true 保证多字节 UTF-8 跨块不乱码；带上限防极端长回复）
          eventBuffer += decoder.decode(value, { stream: true });

          // 末尾若只剩一个孤立的 \r，它的 \n 可能在下一块，先留着不参与归一化
          let pendingCR = '';
          if (eventBuffer.endsWith('\r')) {
            pendingCR = '\r';
            eventBuffer = eventBuffer.slice(0, -1);
          }
          // \r\n / 孤立 \r 统一成 \n（此时缓冲尾部已不含「可能被拆开的 \r」）
          const normalized = eventBuffer.replace(/\r\n?/g, '\n');
          // 只切到最后一个完整事件分隔符（\n\n）为止，其后是不完整尾巴
          const cut = normalized.lastIndexOf('\n\n');
          if (cut === -1) {
            eventBuffer = normalized + pendingCR;
          } else {
            consumeEventText(normalized.slice(0, cut));
            eventBuffer = normalized.slice(cut + 2) + pendingCR;
          }
        }

        // 冲刷解码器，处理最后一个没有空行结尾的事件
        eventBuffer += decoder.decode();
        if (eventBuffer.trim()) {
          consumeEventText(eventBuffer.replace(/\r\n?/g, '\n'));
        }

        // 流结束，保存历史（客户端中途断开时也照常落库）
        await saveHistory(fullReply);
      } catch (err) {
        console.error('流处理错误:', err);
        try {
          await writer.write(new TextEncoder().encode('data: [ERROR]\n\n'));
        } catch (_) {}
      } finally {
        // 先记用量（系统 Key 的成本已经发生），再关流
        await recordSystemUsage();
        await safeCloseWriter();
        try { await reader.cancel(); } catch (_) {}
      }
    };

    processStream();

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    console.error('AI 流式接口错误:', err);
    return json({ error: '服务器内部错误' }, 500);
  }
}
