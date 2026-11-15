// functions/api/ai/export-all.js
// ============================================================
// 0.12.0 新增：完整备份导出（GET /api/ai/export-all）
// ------------------------------------------------------------
// 与「导出对话」不同，这里一次导出**全部角色**的对话，用于备份 / 迁移：
//   { app: 'pchat', schema: 1, exported_at, counts: {...},
//     contacts: [ { contact_id, display_name, contact_type, messages: [
//       { role, content, created_at } ] } ] }
//
// 导入端（/api/ai/import）接受其中单个角色的片段，也接受整包（前端拆开逐个导入）。
// 限制：单角色最多 5000 条、整体最多 20000 条、最多 50 个角色。
// 认证由 /api/_middleware.js 统一处理（data.userId）
// ============================================================

import { json, getUserId, requireFeature } from '../../_lib.js';

const MAX_CONTACTS = 50;
const MAX_PER_CONTACT = 5000;
const MAX_TOTAL = 20000;

export async function onRequestGet({ env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'export_enabled');
  if (denied) return denied;

  try {
    const contactRows = await env.DB.prepare(
      `SELECT contact_id, display_name, contact_type
       FROM contacts
       WHERE user_id = ?
       ORDER BY id ASC
       LIMIT ?`
    ).bind(userId, MAX_CONTACTS).all();

    const contacts = [];
    let totalMessages = 0;

    for (const c of contactRows.results || []) {
      if (totalMessages >= MAX_TOTAL) break;
      const remain = MAX_TOTAL - totalMessages;
      const limit = Math.min(MAX_PER_CONTACT, remain);
      const rows = await env.DB.prepare(
        `SELECT role, content, created_at
         FROM chat_history
         WHERE user_id = ? AND contact_id = ? AND (kind IS NULL OR kind != 'director')
         GROUP BY role, content, created_at
         ORDER BY created_at ASC, id ASC
         LIMIT ?`
      ).bind(userId, c.contact_id, limit).all();

      const messages = (rows.results || []).map((m) => ({
        role: m.role,
        content: m.content,
        created_at: m.created_at,
      }));
      totalMessages += messages.length;
      contacts.push({
        contact_id: c.contact_id,
        display_name: c.display_name,
        contact_type: c.contact_type,
        message_count: messages.length,
        messages,
      });
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const body = JSON.stringify(
      {
        app: 'pchat',
        schema: 1,
        exported_at: new Date().toISOString(),
        counts: {
          contacts: contacts.length,
          messages: totalMessages,
        },
        contacts,
      },
      null,
      2
    );

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="pchat-backup_${stamp}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('GET /api/ai/export-all 错误:', err);
    return json({ error: '备份导出失败' }, 500);
  }
}
