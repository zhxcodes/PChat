// functions/api/messages/stream.js
// GET /api/messages/stream?token=xxx&lastId=0
// SSE 实时推送新消息（EventSource 无法带 Authorization 头，token 走查询参数）。
// 每 2 秒轮询一次 D1，推送 id 大于 lastId 的新消息，最长保持 25 秒后断开（浏览器自动重连）。

import { json, getUserId } from '../../_lib.js';

export async function onRequestGet({ request, env, data }) {
  const userId = getUserId(data);
  if (!userId) return json({ error: '未登录' }, 401);

  const url = new URL(request.url);
  let lastId = parseInt(url.searchParams.get('lastId') || '0') || 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch (_) {}
      };

      const deadline = Date.now() + 25000;
      try {
        while (Date.now() < deadline) {
          const rows = await env.DB.prepare(
            `SELECT id, username, content, created_at, contact_type, contact_id
             FROM messages
             WHERE user_id = ? AND id > ?
             ORDER BY id ASC
             LIMIT 20`
          ).bind(userId, lastId).all();

          for (const msg of rows.results || []) {
            send(msg);
            if (msg.id > lastId) lastId = msg.id;
          }

          await new Promise((r) => setTimeout(r, 2000));
        }
        try { controller.close(); } catch (_) {}
      } catch (err) {
        console.error('SSE 流错误:', err);
        try { controller.error(err); } catch (_) {}
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
