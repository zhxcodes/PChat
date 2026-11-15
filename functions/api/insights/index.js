// functions/api/insights/index.js
// ============================================================
// 0.10.0 新增：会话洞察（GET /api/insights?contact=<contact_id>）
// ------------------------------------------------------------
// 只读聚合接口：不写库、不改 KV，失败也只返回错误码，不影响聊天主链路。
// 前端：static/js/enhance.js → openInsights()（命令面板 / 设置面板入口）
//
// 返回：
//   {
//     today: '2026-10-24',                  // 北京时间今天
//     global:  { messages, days, first_day, known_days, streak_current, streak_longest, today, chars },
//     contact: { ...同上 } | null,           // contact 参数为空时为 null
//     daily:   [{ day:'2026-10-24', count: 12 }, ...],   // 最近 14 天（含 0 值补齐）
//     hours:   [{ hour: 22, count: 120 }, ...],          // 最活跃的几个时段
//     emotions:[{ emotion:'开心', count: 8 }, ...]        // 记忆里的情绪标签
//   }
//
// 时区：统一按 Asia/Shanghai（UTC+8）聚合，与 /api/stats 保持一致。
// 认证由 /api/_middleware.js 统一处理（data.userId）。
// ============================================================

import { json, getUserId, requireFeature } from '../../_lib.js';

// SQL 里的「北京时间的日期」表达式（D1/SQLite 语法）
const DAY_EXPR = "date(datetime(created_at, '+8 hours'))";
const HOUR_EXPR = "CAST(strftime('%H', datetime(created_at, '+8 hours')) AS INTEGER)";
// 排除导演词行（kind='director' 只存在于前端展示，这里做防御性过滤）
const NOT_DIRECTOR = "(kind IS NULL OR kind != 'director')";

const DAILY_DAYS = 14;      // 趋势图天数
const MAX_DAY_SCAN = 800;   // 连续天数最多回溯这么多天，避免超长历史拖慢查询

// 北京时间的今天（YYYY-MM-DD）
function todayInShanghai() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function dayToUTC(day) {
  return Date.parse(day + 'T00:00:00Z');
}

// 两个日期字符串相差的天数（dayB - dayA）
function dayDiff(dayA, dayB) {
  return Math.round((dayToUTC(dayB) - dayToUTC(dayA)) / 86400000);
}

// 由「活跃日列表（任意顺序）」计算连续天数
//   streak_current：以最近一个活跃日结尾的连续天数；最近活跃日不是今天/昨天则视为已中断 → 0
//   streak_longest：历史最长连续
function computeStreak(days, today) {
  const uniq = [...new Set(days.filter(Boolean))].sort();
  if (uniq.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < uniq.length; i++) {
    if (dayDiff(uniq[i - 1], uniq[i]) === 1) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > longest) longest = run;
  }

  const last = uniq[uniq.length - 1];
  const gap = dayDiff(last, today);
  let current = 0;
  if (gap === 0 || gap === 1) {
    current = 1;
    for (let i = uniq.length - 1; i > 0; i--) {
      if (dayDiff(uniq[i - 1], uniq[i]) === 1) current += 1;
      else break;
    }
  }
  return { current, longest };
}

// 补齐成连续的 N 天（用于趋势图：没有消息的日子也要有 0）
function fillDaily(rows, today) {
  const map = new Map();
  (rows || []).forEach((r) => map.set(String(r.day), Number(r.count) || 0));
  const out = [];
  const todayMs = dayToUTC(today);
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const day = new Date(todayMs - i * 86400000).toISOString().slice(0, 10);
    out.push({ day, count: map.get(day) || 0 });
  }
  return out;
}

// 汇总一个范围（全局 / 单个联系人）：totals + 活跃日
async function collectScope(env, userId, contactId) {
  const where = contactId
    ? `user_id = ? AND contact_id = ? AND ${NOT_DIRECTOR}`
    : `user_id = ? AND ${NOT_DIRECTOR}`;
  const binds = contactId ? [userId, contactId] : [userId];

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS messages,
            COUNT(DISTINCT ${DAY_EXPR}) AS days,
            MIN(${DAY_EXPR}) AS first_day,
            COALESCE(SUM(LENGTH(content)), 0) AS chars
     FROM chat_history
     WHERE ${where}`
  ).bind(...binds).first();

  const today = todayInShanghai();
  const todayRow = await env.DB.prepare(
    `SELECT COUNT(*) AS count
     FROM chat_history
     WHERE ${where} AND ${DAY_EXPR} = ?`
  ).bind(...binds, today).first();

  const dayRows = await env.DB.prepare(
    `SELECT DISTINCT ${DAY_EXPR} AS day
     FROM chat_history
     WHERE ${where}
     ORDER BY day DESC
     LIMIT ${MAX_DAY_SCAN}`
  ).bind(...binds).all();

  const days = (dayRows.results || []).map((r) => String(r.day)).filter(Boolean);
  const streak = computeStreak(days, today);
  const firstDay = totals?.first_day || null;
  const knownDays = firstDay ? Math.max(1, dayDiff(firstDay, today) + 1) : 0;

  return {
    messages: totals?.messages || 0,
    days: totals?.days || 0,
    chars: totals?.chars || 0,
    first_day: firstDay,
    known_days: knownDays,
    today: todayRow?.count || 0,
    streak_current: streak.current,
    streak_longest: streak.longest,
  };
}

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'insights_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const rawContact = (url.searchParams.get('contact') || '').trim();
  // 只允许正常长度的 contact_id，避免异常长参数
  const contactId = rawContact && rawContact.length <= 64 ? rawContact : '';
  // 0.12.0：?heatmap=1 额外返回最近 371 天的每日消息量（年度热力图用）
  const wantHeatmap = url.searchParams.get('heatmap') === '1';

  try {
    const today = todayInShanghai();

    const global = await collectScope(env, userId, '');
    const contact = contactId ? await collectScope(env, userId, contactId) : null;

    // 近 14 天趋势（全局）
    const since = new Date(dayToUTC(today) - (DAILY_DAYS - 1) * 86400000).toISOString().slice(0, 10);
    const dailyRows = await env.DB.prepare(
      `SELECT ${DAY_EXPR} AS day, COUNT(*) AS count
       FROM chat_history
       WHERE user_id = ? AND ${NOT_DIRECTOR} AND ${DAY_EXPR} >= ?
       GROUP BY day
       ORDER BY day ASC`
    ).bind(userId, since).all();

    // 最活跃时段
    const hourRows = await env.DB.prepare(
      `SELECT ${HOUR_EXPR} AS hour, COUNT(*) AS count
       FROM chat_history
       WHERE user_id = ? AND ${NOT_DIRECTOR}
       GROUP BY hour
       ORDER BY count DESC
       LIMIT 6`
    ).bind(userId).all();

    // 记忆里的情绪标签
    const emotionRows = await env.DB.prepare(
      `SELECT emotion, COUNT(*) AS count
       FROM memories
       WHERE user_id = ? AND emotion IS NOT NULL AND emotion != ''
       GROUP BY emotion
       ORDER BY count DESC
       LIMIT 8`
    ).bind(userId).all();

    // 年度热力图：最近 371 天（53 周）每天的消息量，只返回有消息的日子
    let heatmap = null;
    if (wantHeatmap) {
      const heatSince = new Date(dayToUTC(today) - 370 * 86400000).toISOString().slice(0, 10);
      const heatRows = await env.DB.prepare(
        `SELECT ${DAY_EXPR} AS day, COUNT(*) AS count
         FROM chat_history
         WHERE user_id = ? AND ${NOT_DIRECTOR} AND ${DAY_EXPR} >= ?
         GROUP BY day
         ORDER BY day ASC`
      ).bind(userId, heatSince).all();
      heatmap = (heatRows.results || []).map((r) => ({
        day: String(r.day),
        count: Number(r.count) || 0,
      }));
    }

    return json({
      today,
      global,
      contact,
      daily: fillDaily(dailyRows.results, today),
      hours: (hourRows.results || []).map((r) => ({ hour: Number(r.hour) || 0, count: Number(r.count) || 0 })),
      emotions: (emotionRows.results || []).map((r) => ({ emotion: r.emotion, count: Number(r.count) || 0 })),
      heatmap,
    });
  } catch (err) {
    console.error('GET /api/insights 错误:', err);
    return json({ error: '洞察统计失败' }, 500);
  }
}
