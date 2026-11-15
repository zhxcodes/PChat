// functions/api/ai/export.js
// GET /api/ai/export?contact=xxx&format=json|md|txt[&start=ISO&end=ISO]
// 对话导出（第 26 项）：生成文件流下载，支持按时间段过滤。
// 认证由 /api/_middleware.js 统一处理（data.userId）

import { json, getUserId, LIMITS, requireFeature } from '../../_lib.js';

const FORMATS = ['json', 'md', 'txt'];
const MAX_EXPORT = 5000;

// 文件名安全化：去掉路径分隔符与引号
function safeName(s) {
  return String(s || 'chat').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60);
}

// RFC 5987 回退名：非 ASCII 字符（中文联系人名等）替换为 _，供不理解 filename* 的客户端使用
function asciiFallbackName(s) {
  return String(s || 'chat').replace(/[^\x20-\x7E]/g, '_');
}

// RFC 5987 的 attr-char 不含 ' ( ) *，encodeURIComponent 会保留它们，需额外转义
function encodeRfc5987(s) {
  return encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function toMd(contactId, rows) {
  const lines = [`# 对话导出 · ${contactId}`, '', `导出时间：${new Date().toISOString()}`, `消息条数：${rows.length}`, ''];
  for (const m of rows) {
    lines.push(`## ${m.role === 'user' ? '我' : 'AI'} · ${m.created_at || ''}`);
    lines.push('');
    lines.push(m.content || '');
    lines.push('');
  }
  return lines.join('\n');
}

function toTxt(rows) {
  return rows.map((m) => {
    const who = m.role === 'user' ? '我' : 'AI';
    return `[${m.created_at || ''}] ${who}:\n${m.content || ''}\n`;
  }).join('\n');
}

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const denied = await requireFeature(env, 'export_enabled');
  if (denied) return denied;

  const url = new URL(request.url);
  const contact = (url.searchParams.get('contact') || '').slice(0, LIMITS.contact);
  const format = (url.searchParams.get('format') || 'txt').toLowerCase();
  const start = url.searchParams.get('start') || '';
  const end = url.searchParams.get('end') || '';

  if (!contact) return json({ error: '缺少 contact 参数' }, 400);
  if (!FORMATS.includes(format)) return json({ error: '不支持的格式（json/md/txt）' }, 400);

  // 时间段过滤（ISO 字符串，按 created_at 比较）
  let sql = `SELECT id, role, content, created_at
             FROM chat_history
             WHERE user_id = ? AND contact_id = ? AND (kind IS NULL OR kind != 'director')`;
  const args = [userId, contact];
  if (/^\d{4}-\d{2}-\d{2}/.test(start)) { sql += ' AND created_at >= ?'; args.push(start); }
  if (/^\d{4}-\d{2}-\d{2}/.test(end)) { sql += ' AND created_at <= ?'; args.push(end); }
  sql += ' ORDER BY id ASC LIMIT ?';
  args.push(MAX_EXPORT);

  const rows = (await env.DB.prepare(sql).bind(...args).all()).results || [];

  const stamp = new Date().toISOString().slice(0, 10);
  const base = safeName(contact);
  let body;
  let mime;
  let ext;
  if (format === 'json') {
    body = JSON.stringify({ contact_id: contact, exported_at: new Date().toISOString(), count: rows.length, messages: rows }, null, 2);
    mime = 'application/json; charset=utf-8';
    ext = 'json';
  } else if (format === 'md') {
    body = toMd(contact, rows);
    mime = 'text/markdown; charset=utf-8';
    ext = 'md';
  } else {
    body = toTxt(rows);
    mime = 'text/plain; charset=utf-8';
    ext = 'txt';
  }

  // 文件名：filename 用 ASCII 回退名（老客户端），filename* 用 UTF-8 百分号编码（RFC 5987/6266，中文名不乱码）
  const fileName = `${base}_${stamp}.${ext}`;
  const fallbackName = asciiFallbackName(fileName);
  const encodedName = encodeRfc5987(fileName);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodedName}`,
      'Cache-Control': 'no-store',
    },
  });
}
